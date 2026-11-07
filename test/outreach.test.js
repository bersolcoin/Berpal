/**
 * Customer outreach: PromptPay payloads, ERPNext PDF/upload plumbing, the consent gate, the
 * send_invoice / send_payment_reminder / set_payment_settings tools, the reminders + cleanup jobs.
 * Multi-turn consent flows run through the real conversation.handle() with a scripted OpenAI stub
 * (each turn = one tool-call round + a final reply), so arming is conversation.js's, not ours.
 * ERPNext is the in-memory fake (download_pdf + upload_file via its `methods` hook), Postgres
 * is pg-mem, Twilio is a stub that records what would have gone out.
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;
delete process.env.ERPNEXT_INVOICE_PRINT_FORMAT;
delete process.env.TWILIO_INVOICE_CONTENT_SID;
delete process.env.TWILIO_REMINDER_CONTENT_SID;
delete process.env.TWILIO_INVOICE_TEMPLATE_TEXT;
delete process.env.TWILIO_REMINDER_TEMPLATE_TEXT;

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const erpnext = require('../src/erpnext');
const { executeTool } = require('../src/tools');
const promptpay = require('../src/outreach/promptpay');
const { normalizePhone } = require('../src/outreach/phone');
const remindersJob = require('../src/jobs/reminders.job');
const cleanupJob = require('../src/jobs/cleanup.job');
const conversation = require('../src/conversation');
const twilioClient = require('../src/twilio-client');

const erp = new FakeErpNext();
let user;
const PDF_MAGIC = '%PDF-1.4';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// What "went out" over WhatsApp, what got uploaded to / deleted from ERPNext.
let sent = [];
let templates = [];
let uploads = [];
let deletedFiles = [];
let pdfRequests = [];
let payloads = [];
let pdfBody = null; // override what download_pdf returns (non-PDF test)
let mediaResult = null; // override sendMedia's result (failure tests)
let sidSeq = 0; // Twilio SIDs are unique across the whole run, like the real thing
const twilioStub = {
  async sendMedia(to, body, urls) {
    sent.push({ to, body, urls });
    if (mediaResult) return mediaResult;
    sidSeq++;
    return { sids: urls.map((_, i) => `SM${sidSeq}-${i}`), errors: [] };
  },
};

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Single tool calls (fresh draft, never armed) ──
let draft = {};
async function tool(name, args = {}) {
  const ctx = { user, draft, saved: null, cancelled: false, confirmationRequested: false };
  const result = await executeTool(name, args, ctx);
  draft = ctx.draft;
  return { result, ctx };
}

// ── Real conversation turns through conversation.handle() ──
let script = [];
let lastRequest = null;
const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const openaiStub = {
  chat: {
    completions: {
      async create(params) {
        lastRequest = params;
        return script.shift() || reply('ok');
      },
    },
  },
};
/** One user message; the "model" makes `calls` ([name, args] pairs) then replies. Returns tool results. */
async function say(text, calls = []) {
  script = [];
  if (calls.length) {
    script.push({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], i) => ({
      id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } }] });
  }
  script.push(reply('ok'));
  await conversation.handle(user, text);
  // Tool messages only exist for this turn (history keeps user/assistant text).
  return lastRequest.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
}
async function storedPreview() {
  const c = await conversation.loadConversation(user.id);
  return (c.draft_transaction ? JSON.parse(c.draft_transaction) : {}).outreach_preview;
}
/** preview turn → user says yes → confirm turn: the happy path. */
async function previewThenConfirm(name, args) {
  const [preview] = await say('send it', [[name, args]]);
  assert.equal(preview.needs_confirmation, true, JSON.stringify(preview));
  const [result] = await say('yes', [[name, { ...args, confirmed: true }]]);
  return { preview, result };
}

function seedInvoice(name, { customer, currency = 'THB', total, outstanding = total, due, company = COMPANY, extra = {} }) {
  erp._put('Sales Invoice', {
    name, customer, customer_name: erp.get('Customer', customer).customer_name, company,
    docstatus: 1, currency, grand_total: total, outstanding_amount: outstanding, conversion_rate: currency === 'THB' ? 1 : 32.5,
    party_account_currency: currency, posting_date: addDays(TODAY, -30), due_date: due, ...extra,
  });
}

/** EMVCo TLV → { tag: value } (one level; tag 29 left nested). */
function parseTlv(s) {
  const out = {};
  for (let i = 0; i < s.length;) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/**
 * The fake's fetch speaks JSON only: it JSON.parses request bodies and exposes just text().
 * Adapt it for the binary paths — multipart bodies are held aside for the upload_file hook,
 * arrayBuffer() decodes the bytes download_pdf returns as base64 — and handle File deletes.
 */
function installFetch() {
  erp.install();
  const jsonFetch = global.fetch;
  let pendingForm = null;
  erp.methods['frappe.utils.print_format.download_pdf'] = (u) => {
    pdfRequests.push(Object.fromEntries(u.searchParams));
    const bytes = pdfBody || Buffer.from(`${PDF_MAGIC} ${u.searchParams.get('name')}`);
    return { __binary: bytes.toString('base64') };
  };
  erp.methods.upload_file = () => {
    const form = pendingForm;
    const filename = form.get('file_name');
    uploads.push({
      filename, file: form.get('file'), is_private: form.get('is_private'),
      doctype: form.get('doctype'), docname: form.get('docname'),
    });
    return { message: { name: `FILE-${filename}`, file_url: `/files/${filename}` } };
  };
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'DELETE' && url.includes('/api/resource/File/')) {
      deletedFiles.push(decodeURIComponent(url.split('/api/resource/File/')[1]));
      return { ok: true, status: 202, text: async () => '{}' };
    }
    const isForm = opts.body instanceof FormData;
    pendingForm = isForm ? opts.body : null;
    const res = await jsonFetch(url, isForm ? { ...opts, body: undefined } : opts);
    return {
      ...res,
      arrayBuffer: async () => Buffer.from(JSON.parse(await res.text()).__binary, 'base64'),
    };
  };
}

before(async () => {
  installFetch();
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ('+66000', $1, 'k', 's', 'THB', 'THB', 'TH', $2, $2) RETURNING *`,
    [COMPANY, now]
  );
  // UTC so the user's local date matches the fake ERPNext's TODAY at any hour.
  user = (await db.query(`UPDATE users SET timezone = 'UTC', promptpay_id = '0812345678' WHERE id = $1 RETURNING *`, [r.rows[0].id])).rows[0];

  const contact = (name, phone, customer) => db.query(
    `INSERT INTO counterparty_cache (owner_user_id, name, phone, erpnext_customer, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`, [user.id, name, phone, customer, now]
  );
  // Jameel: ERPNext mobile_no differs — only the user's own contact cache counts.
  erp._put('Customer', { name: 'Jameel', customer_name: 'Jameel Crest Gems', mobile_no: '+66 81 111 2222' });
  await contact('Jameel Crest Gems', '089-999-9999', 'Jameel');
  erp._put('Customer', { name: 'Beta', customer_name: 'Beta Traders' });
  await contact('Beta Traders', '+66 81 222 3333', 'Beta');
  // Phone only in ERPNext (Customers are shared across tenants) → must NOT be used.
  erp._put('Customer', { name: 'ErpOnly', customer_name: 'ERP Only Ltd', mobile_no: '081-222-3333' });
  erp._put('Customer', { name: 'NoPhone', customer_name: 'No Phone Co' });
  erp._put('Customer', { name: 'Gamma', customer_name: 'Gamma Gems' });
  await contact('Gamma Gems', '+66 86 333 4444', 'Gamma');

  // Far-future due dates keep these out of the reminders job's window.
  seedInvoice('ACC-SINV-2026-00001', { customer: 'Jameel', total: 12000, outstanding: 10000, due: addDays(TODAY, 20) });
  seedInvoice('ACC-SINV-2026-00002', { customer: 'Jameel', currency: 'USD', total: 500, due: addDays(TODAY, 20) });
  seedInvoice('ACC-SINV-2026-00003', { customer: 'NoPhone', total: 700, due: addDays(TODAY, 20) });
  seedInvoice('ACC-SINV-2026-00004', { customer: 'Jameel', total: 900, due: addDays(TODAY, 20), company: 'Other Co' });
  seedInvoice('ACC-SINV-2026-00005', { customer: 'Jameel', total: 500, due: addDays(TODAY, 20), extra: { is_return: 1 } });
  seedInvoice('ACC-SINV-2026-00006', { customer: 'Jameel', total: 300, outstanding: 0, due: addDays(TODAY, -1) });
  seedInvoice('ACC-SINV-2026-00007', { customer: 'ErpOnly', total: 800, due: addDays(TODAY, 20) });
  // USD invoice booked against a THB debtors account: outstanding is THB → QR allowed.
  seedInvoice('ACC-SINV-2026-00008', { customer: 'Jameel', currency: 'USD', total: 100, outstanding: 3250, due: addDays(TODAY, 20), extra: { party_account_currency: 'THB' } });

  conversation._setOpenAIForTests(openaiStub);
  const realBuild = promptpay.buildPayload;
  promptpay.buildPayload = (...a) => {
    const p = realBuild(...a);
    payloads.push(p);
    return p;
  };
});

beforeEach(async () => {
  await db.query('DELETE FROM conversations');
  sent = [];
  templates = [];
  uploads = [];
  deletedFiles = [];
  pdfRequests = [];
  payloads = [];
  pdfBody = null;
  mediaResult = null;
  draft = {};
  twilioClient.sendMedia = twilioStub.sendMedia;
});

// ── PromptPay ───────────────────────────────────────────────────────────

test('promptpay: CRC-16/CCITT-FALSE matches the catalogue check value', () => {
  // The standard check value for this CRC (poly 0x1021, init 0xFFFF, no reflect/xorout)
  // over ASCII "123456789" is 0x29B1 — pins poly, init and bit order in one go.
  assert.equal(promptpay.crc16('123456789'), '29B1');
  assert.equal(promptpay.crc16(''), 'FFFF', 'empty input leaves the init value');
});

test('promptpay: mobile number, static QR (tag 01, POI 11)', () => {
  // 0812345678 → drop the 0, prefix 66, left-pad to 13 → 0066812345678.
  //   000201 | 010211 | 29 37 [0016 A000000677010111 | 0113 0066812345678] | 5802TH | 5303764 | 6304 + CRC
  const body = '000201' + '010211' + '2937' + '0016A000000677010111' + '01130066812345678' + '5802TH' + '5303764' + '6304';
  const payload = promptpay.buildPayload('0812345678');
  assert.equal(payload, body + promptpay.crc16(body));
  for (const alt of ['+66 81-234-5678', '66812345678', '+66 0812345678']) {
    assert.equal(promptpay.buildPayload(alt), payload, alt);
  }
});

test('promptpay: fixed amount → POI 12 + tag 54; matches the promptpay-qr reference vector', () => {
  // Published example from the promptpay-qr library README (target 000-000-0000, amount 4.22).
  assert.equal(
    promptpay.buildPayload('000-000-0000', { amount: 4.22 }),
    '00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469'
  );
  const p = promptpay.buildPayload('0812345678', { amount: 1500 });
  assert.match(p, /^000201010212/);
  assert.equal(parseTlv(p)['54'], '1500.00');
  assert.equal(p.slice(-4), promptpay.crc16(p.slice(0, -4)));
  assert.match(promptpay.buildPayload('0812345678', { amount: 0 }), /^000201010211/, 'zero → static');
});

test('promptpay: bad amounts throw', () => {
  for (const amount of [NaN, -1, 'abc', '1e3', Infinity, 1e13, 1e20, 1e21]) {
    assert.throws(() => promptpay.buildPayload('0812345678', { amount }), /PromptPay amount/, String(amount));
  }
  assert.equal(parseTlv(promptpay.buildPayload('0812345678', { amount: '99.5' }))['54'], '99.50');
});

test('promptpay: 13-digit tax id (tag 02, wins over the 0066 mobile heuristic) and 15-digit e-wallet (tag 03)', () => {
  const tax = promptpay.buildPayload('0-1055-36000-12-3', { amount: 99.5 });
  const taxBody = '000201' + '010212' + '2937' + '0016A000000677010111' + '02130105536000123'
    + '5802TH' + '5303764' + '540599.50' + '6304';
  assert.equal(tax, taxBody + promptpay.crc16(taxBody));
  assert.deepEqual(promptpay.parseTarget('0066812345678'), { type: 'tax_id', value: '0066812345678' });

  const ew = promptpay.buildPayload('123456789012345');
  assert.ok(ew.includes('2939' + '0016A000000677010111' + '0315123456789012345'));
  assert.equal(promptpay.parseTarget('12345'), null);
  assert.throws(() => promptpay.buildPayload('12345'), /invalid PromptPay id/);
});

test('promptpay: renders a PNG', async () => {
  const png = await promptpay.renderPng(promptpay.buildPayload('0812345678', { amount: 10 }));
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC));
});

// ── ERPNext client: binary + multipart ─────────────────────────────────

test('erpnext.getPdf returns raw bytes (binary-safe), builds the print URL, sets a timeout', async () => {
  const saved = global.fetch;
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.from([0x00, 0xff, 0xfe, 0x80])]);
  let seen;
  global.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  try {
    const client = erpnext.forUser(user);
    const pdf = await client.getPdf('Sales Invoice', 'ACC-SINV-2026-00009', { format: 'Thai Invoice' });
    assert.ok(pdf.equals(bytes), 'non-UTF-8 bytes survive');
    const u = new URL(seen.url);
    assert.equal(u.pathname, '/api/method/frappe.utils.print_format.download_pdf');
    assert.equal(u.searchParams.get('doctype'), 'Sales Invoice');
    assert.equal(u.searchParams.get('name'), 'ACC-SINV-2026-00009');
    assert.equal(u.searchParams.get('format'), 'Thai Invoice');
    assert.equal(u.searchParams.get('no_letterhead'), '0');
    assert.equal(seen.opts.headers.Authorization, 'token k:s');
    assert.ok(seen.opts.signal instanceof AbortSignal, 'PDF render must not hang forever');

    global.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ exception: 'DoesNotExistError' }) });
    await assert.rejects(client.getPdf('Sales Invoice', 'NOPE'), (err) => err.status === 404 && /DoesNotExistError/.test(err.message));
  } finally {
    global.fetch = saved;
  }
});

test('erpnext.getPdf refuses a 200 that is not a PDF, with readable (tag-stripped) text', async () => {
  const saved = global.fetch;
  const html = Buffer.from('<html><head><style>b{}</style></head><body><h1>wkhtmltopdf</h1> <p>not installed</p></body></html>');
  global.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => html });
  try {
    await assert.rejects(erpnext.forUser(user).getPdf('Sales Invoice', 'X'), (err) => {
      assert.match(err.message, /did not return a PDF: wkhtmltopdf not installed$/);
      return true;
    });
    global.fetch = async () => ({ ok: false, status: 502, text: async () => '<html><body><h1>502 Bad Gateway</h1></body></html>' });
    await assert.rejects(erpnext.forUser(user).getPdf('Sales Invoice', 'X'), /502 Bad Gateway$/);
  } finally {
    global.fetch = saved;
  }
});

test('erpnext.uploadFile posts multipart with is_private and attachment target', async () => {
  const saved = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { name: 'abc123', file_url: '/files/x.pdf' } }) };
  };
  try {
    const r = await erpnext.forUser(user).uploadFile({
      buffer: Buffer.from('hello'), filename: 'x.pdf', contentType: 'application/pdf',
      isPrivate: false, doctype: 'Sales Invoice', docname: 'ACC-SINV-2026-00001',
    });
    assert.deepEqual(r, { file_url: '/files/x.pdf', name: 'abc123' });
    assert.equal(seen.url, 'http://erp.test/api/method/upload_file');
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers['Content-Type'], undefined, 'fetch must set the multipart boundary itself');
    const form = seen.opts.body;
    assert.equal(form.get('is_private'), '0');
    assert.equal(form.get('doctype'), 'Sales Invoice');
    assert.equal(form.get('docname'), 'ACC-SINV-2026-00001');
    const file = form.get('file');
    assert.equal(file.name, 'x.pdf');
    assert.equal(file.type, 'application/pdf');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'hello');
  } finally {
    global.fetch = saved;
  }
});

// ── Phones ─────────────────────────────────────────────────────────────

test('phone normalisation: strict table incl. refusals', () => {
  const ok = [
    ['081-234-5678', 'TH', '+66812345678'],
    ['081.234.5678', 'TH', '+66812345678'],
    ['+66 81 234 5678', 'TH', '+66812345678'],
    ['+66 0812345678', 'TH', '+66812345678'],
    ['0066812345678', 'TH', '+66812345678'],
    ['whatsapp:+6591234567', 'TH', '+6591234567'],
    ['+44 (0)7911 123456', 'TH', '+447911123456'],
    ['07911 123456', 'GB', '+447911123456'],
    ['+1 (415) 555-0100', 'TH', '+14155550100'],
  ];
  for (const [raw, country, e164] of ok) {
    const r = normalizePhone(raw, country);
    assert.equal(r.ok, true, `${raw}: ${r.error}`);
    assert.equal(r.e164, e164, raw);
    assert.equal(r.address, `whatsapp:${e164}`);
  }
  const bad = [
    ['66812345678', 'TH', /no country code/], // bare digits: country code or local? refuse
    ['0812345678', 'XX', /calling code for country XX/],
    ['0812345678', null, /calling code/],
    ['02-123-4567', 'TH', /not a Thai mobile/], // Bangkok landline
    ['+66 81 234 567', 'TH', /not a Thai mobile/],
    ['+66 71 234 5678', 'TH', /not a Thai mobile/],
    ['081 234 5678 ext 12', 'TH', /extension/],
    ['+66 81 234 5678 x12', 'TH', /extension/],
    ['+12', 'TH', /wrong length/],
    ['+0812345678', 'TH', /not 0/],
    ['', 'TH', /no phone/],
    [null, 'TH', /no phone/],
  ];
  for (const [raw, country, re] of bad) {
    const r = normalizePhone(raw, country);
    assert.equal(r.ok, false, String(raw));
    assert.match(r.error, re, String(raw));
  }
});


test('erpnext: every JSON request carries a timeout signal, combined with the caller\'s', async () => {
  const saved = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(opts.signal);
    return { ok: true, status: 200, text: async () => '{"data":[]}' };
  };
  try {
    const client = erpnext.forUser(user);
    await client.listResource('Customer');
    assert.ok(seen[0] instanceof AbortSignal);
    assert.equal(seen[0].aborted, false);
    const ac = new AbortController();
    ac.abort();
    await client._fetch('GET', '/api/resource/Customer', null, { signal: ac.signal });
    assert.equal(seen[1].aborted, true, "the scheduler's signal reaches fetch");
  } finally {
    global.fetch = saved;
  }
});

// ── send_invoice + consent gate ────────────────────────────────────────

test('gate: confirmed:true cold (no preview) is refused and only stores an unarmed preview', async () => {
  const { result } = await tool('send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.needs_confirmation, true);
  assert.match(result.error, /no preview/);
  assert.equal(draft.outreach_preview.tool, 'send_invoice');
  assert.equal(draft.outreach_preview.armed, undefined);
  assert.equal(sent.length + uploads.length + pdfRequests.length, 0);
  assert.equal((await db.query('SELECT * FROM outreach_log')).rows.length, 0);
});

test('gate: preview and confirm in the SAME turn is refused (real handle turn)', async () => {
  const [, confirm] = await say('send ACC-SINV-2026-00001 to Jameel', [
    ['send_invoice', { ref: 'ACC-SINV-2026-00001' }],
    ['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }],
  ]);
  assert.equal(confirm.needs_confirmation, true);
  assert.match(confirm.error, /NEW message/);
  assert.equal(sent.length, 0);
});

test('gate: preview → yes → confirm sends exactly the previewed message, logged, preview cleared', async () => {
  const { preview, result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00001' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, 'sent');
  assert.equal(await storedPreview(), undefined, 'one yes, one send');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'whatsapp:+66899999999');
  assert.equal(sent[0].body, preview.preview.message);
  assert.equal(sent[0].body, [
    `Invoice ACC-SINV-2026-00001 from ${COMPANY}`,
    'Amount due: THB 10,000.00',
    `Due: ${addDays(TODAY, 20)}`,
    'Scan the QR to pay THB 10,000.00 by PromptPay.',
  ].join('\n'));

  assert.deepEqual(pdfRequests, [{ doctype: 'Sales Invoice', name: 'ACC-SINV-2026-00001', no_letterhead: '0' }]);
  assert.equal(uploads.length, 2);
  for (const up of uploads) {
    assert.equal(up.is_private, '0', 'Twilio must be able to fetch it');
    assert.equal(up.docname, 'ACC-SINV-2026-00001');
  }
  assert.match(uploads[0].filename, /^ACC-SINV-2026-00001-[0-9a-f]{16}\.pdf$/, 'unguessable public name');
  assert.match(uploads[1].filename, /^ACC-SINV-2026-00001-promptpay-[0-9a-f]{16}\.png$/);
  assert.deepEqual(sent[0].urls, uploads.map((u) => `http://erp.test/files/${u.filename}`));

  // The QR encodes the user's PromptPay id and the outstanding amount, and the PNG is that payload.
  assert.equal(payloads.length, 1);
  const tlv = parseTlv(payloads[0]);
  assert.equal(tlv['54'], '10000.00');
  assert.equal(tlv['01'], '12');
  assert.ok(tlv['29'].endsWith('01130066812345678'));
  const png = Buffer.from(await uploads[1].file.arrayBuffer());
  assert.ok(png.equals(await promptpay.renderPng(payloads[0])));

  const log = (await db.query('SELECT * FROM outreach_log')).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'invoice');
  assert.equal(log[0].reference, 'ACC-SINV-2026-00001');
  assert.equal(log[0].customer, 'Jameel');
  assert.equal(log[0].counterparty_phone, '+66899999999');
  assert.equal(log[0].status, 'sent');
  assert.match(log[0].message_sid, /^SM\d+-0$/);
  assert.equal(log[0].sent_local_date, TODAY);
  assert.deepEqual(JSON.parse(log[0].files), uploads.map((u) => `FILE-${u.filename}`));

  // Replaying the yes doesn't resend.
  const [again] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(again.needs_confirmation, true);
  assert.equal(sent.length, 1);
});

test('gate: preview → "no wait" → confirm is refused (one-turn window)', async () => {
  await say('send ACC-SINV-2026-00001', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  assert.equal((await storedPreview()).armed, true);
  await say('no wait');
  assert.equal(await storedPreview(), undefined, 'expired after one turn');
  const [r] = await say('ok send it now', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.equal(sent.length, 0);
});

test('gate: a forged outreach_preview via update_draft is ignored', async () => {
  await say('send ACC-SINV-2026-00001', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  const real = await storedPreview(); // armed, correct hash — the best forgery possible
  await db.query('DELETE FROM conversations');
  const [, r] = await say('yes', [
    ['update_draft', { outreach_preview: real }],
    ['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }],
  ]);
  assert.equal(r.needs_confirmation, true);
  assert.match(r.error, /no preview/);
  assert.equal(sent.length, 0);
  const prompt = lastRequest.messages[0].content;
  assert.doesNotMatch(prompt, /outreach_preview/, 'hidden from CURRENT DRAFT');
});

test('gate: plan drift (payment landed between preview and yes) refuses and re-previews', async () => {
  await say('send it', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 2500;
  let [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.match(r.error, /something changed/);
  assert.match(r.preview.message, /THB 2,500\.00/);
  assert.equal(sent.length, 0);

  [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.ok, true, 'the re-preview armed for one more turn');
  assert.match(sent[0].body, /THB 2,500\.00/);
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 10000;
});

test('gate: phone or PromptPay payee changed between preview and yes refuses', async () => {
  await say('send it', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  await db.query(`UPDATE counterparty_cache SET phone = '+66 82 222 2222' WHERE erpnext_customer = 'Jameel'`);
  let [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.equal(r.preview.phone, '+66822222222');
  await db.query(`UPDATE counterparty_cache SET phone = '089-999-9999' WHERE erpnext_customer = 'Jameel'`);

  await db.query('DELETE FROM conversations');
  await say('send it', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  user.promptpay_id = '0899990000';
  [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  user.promptpay_id = '0812345678';
  assert.equal(r.needs_confirmation, true);
  assert.ok(r.preview.attachments.some((a) => a.endsWith('payee ••••0000')));
  assert.equal(sent.length, 0);
});

test("gate: another tool's armed preview doesn't authorise this one", async () => {
  await say('remind them', [['send_payment_reminder', { ref: 'ACC-SINV-2026-00001' }]]);
  const [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.equal(sent.length, 0);
});

test('send_invoice: preview shows message, masked payee, message count, notes; non-boolean confirmed never sends', async () => {
  for (const confirmed of [undefined, false, 'true', 1]) {
    const { result } = await tool('send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed });
    assert.equal(result.needs_confirmation, true);
    assert.equal(result.preview.to, 'Jameel Crest Gems');
    assert.equal(result.preview.phone, '+66899999999', 'contact cache, not ERPNext mobile_no');
    assert.match(result.preview.message, /Amount due: THB 10,000\.00/);
    assert.deepEqual(result.preview.attachments, [
      'invoice PDF ACC-SINV-2026-00001', 'PromptPay QR for THB 10,000.00 → payee ••••5678',
    ]);
    assert.equal(result.preview.whatsapp_messages, 2);
    assert.ok(result.notes.some((n) => /line-item descriptions/.test(n)));
    assert.ok(result.notes.some((n) => /one attachment per message/.test(n)));
    assert.ok(result.notes.some((n) => /24 hours/.test(n)));
    assert.doesNotMatch(JSON.stringify(result), /transaction/i, 'a preview is not a transaction');
    // The ready-to-show text the prompt says to send verbatim: recipient + number, body, attachments, count.
    assert.match(result.preview_text, /^Send to Jameel Crest Gems \(\+66899999999\):\n/);
    assert.ok(result.preview_text.includes(result.preview.message));
    assert.match(result.preview_text, /\+ invoice PDF ACC-SINV-2026-00001, PromptPay QR for THB 10,000\.00 → payee ••••5678 — 2 WhatsApp messages/);
    assert.match(result.preview_text, /Note: .*24 hours[\s\S]*\n\nSend\?$/);
  }
  assert.equal(sent.length + uploads.length, 0);
});

test('send_invoice: refuses other-company, return, paid, unknown — and drops a stale preview', async () => {
  const cases = [
    ['ACC-SINV-2026-00004', /not found/], // another tenant's invoice looks missing
    ['ACC-SINV-2026-00005', /credit note/],
    ['ACC-SINV-2026-00006', /already paid/],
    ['ACC-SINV-2026-09999', /not found/],
  ];
  for (const [ref, re] of cases) {
    const { result } = await tool('send_invoice', { ref });
    assert.equal(result.ok, false, ref);
    assert.equal(result.needs_confirmation, undefined, ref);
    assert.match(result.error, re, ref);
  }
  await tool('send_invoice', { ref: 'ACC-SINV-2026-00001' });
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 0;
  await tool('send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true });
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 10000;
  assert.equal(draft.outreach_preview, undefined);
});

test('send_invoice: phone only in ERPNext (shared Customer) or none → clear error, nothing uploaded', async () => {
  for (const [ref, who] of [['ACC-SINV-2026-00007', 'ERP Only Ltd'], ['ACC-SINV-2026-00003', 'No Phone Co']]) {
    const { result } = await tool('send_invoice', { ref });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`No WhatsApp number on file for ${who} — ask the user .*create_contact`));
  }
  assert.equal(uploads.length + sent.length, 0);
});

test('send_invoice: amounts labelled in the party account currency; QR only when that is THB', async () => {
  let { result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00002' });
  assert.equal(result.ok, true, result.error);
  assert.match(sent[0].body, /Amount due: USD 500\.00/);
  assert.doesNotMatch(sent[0].body, /PromptPay/);
  assert.equal(sent[0].urls.length, 1);

  sent = [];
  ({ result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00008' }));
  assert.match(sent[0].body, /Amount due: THB 3,250\.00/);
  assert.equal(parseTlv(payloads.at(-1))['54'], '3250.00');
});

test('send_invoice: partial Twilio failure (QR message) is recorded with the Twilio code', async () => {
  mediaResult = { sids: ['SMok'], errors: [{ index: 1, code: 63019, message: 'Media failed to download' }] };
  const { result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00001' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'partial');
  const row = (await db.query(`SELECT * FROM outreach_log WHERE status = 'partial'`)).rows[0];
  assert.equal(row.error, '63019: Media failed to download');
  assert.equal(row.message_sid, 'SMok');

  mediaResult = { sids: [], errors: [{ index: 0, code: 21211, message: "Invalid 'To' Phone Number" }] };
  const r2 = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00001' });
  assert.equal(r2.result.ok, false);
  assert.match(r2.result.error, /21211/);
  const failed = (await db.query(`SELECT * FROM outreach_log WHERE status = 'failed'`)).rows;
  assert.equal(failed.length, 1);
  assert.ok(failed[0].files, 'uploaded files are still recorded for cleanup');
});

test('send_invoice: a non-PDF print response fails the send without messaging anyone', async () => {
  pdfBody = Buffer.from('<html><body>Print Format not found</body></html>');
  const { result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00001' });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return a PDF: Print Format not found/);
  assert.equal(sent.length, 0);
});

test('template mode: invoice — approved wording in the preview, {{4}} is exactly one PDF URL, QR follows', async () => {
  process.env.TWILIO_INVOICE_CONTENT_SID = 'HXinvoice';
  process.env.TWILIO_INVOICE_TEMPLATE_TEXT = 'Hi {{1}}, your invoice for {{2}} is due {{3}}.\\nView it: {{4}}';
  twilioClient.sendTemplate = async (to, sid, vars) => {
    templates.push({ to, sid, vars });
    return 'SMtpl';
  };
  try {
    const { preview, result } = await previewThenConfirm('send_invoice', { ref: 'ACC-SINV-2026-00001' });
    assert.equal(preview.preview.message,
      `Hi Jameel Crest Gems, your invoice for THB 10,000.00 is due ${addDays(TODAY, 20)}.\nView it: <link to the invoice PDF>`);
    assert.ok(!preview.notes.some((n) => /24 hours/.test(n)));
    assert.equal(result.ok, true, result.error);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].sid, 'HXinvoice');
    assert.equal(templates[0].to, 'whatsapp:+66899999999');
    assert.equal(templates[0].vars[1], 'Jameel Crest Gems');
    assert.equal(templates[0].vars[4], `http://erp.test/files/${uploads[0].filename}`);
    assert.doesNotMatch(templates[0].vars[4], /\s/, 'one URL');
    assert.deepEqual(sent.map((m) => m.urls), [[`http://erp.test/files/${uploads[1].filename}`]]);
    assert.equal((await db.query(`SELECT message_sid FROM outreach_log WHERE message_sid = 'SMtpl'`)).rows.length, 1);
  } finally {
    delete process.env.TWILIO_INVOICE_CONTENT_SID;
    delete process.env.TWILIO_INVOICE_TEMPLATE_TEXT;
    delete twilioClient.sendTemplate;
  }
});

test('twilio-client.sendMedia reports { sids, errors } when not configured', async () => {
  const real = require.cache[require.resolve('../src/twilio-client')].exports;
  // Our stub replaced the export; re-load the module fresh to hit the real function.
  delete require.cache[require.resolve('../src/twilio-client')];
  const fresh = require('../src/twilio-client');
  require.cache[require.resolve('../src/twilio-client')].exports = real;
  const r = await fresh.sendMedia('+66812345678', 'hi', ['http://x/y.pdf']);
  assert.deepEqual(r.sids, []);
  assert.equal(r.errors[0].code, 'not_configured');
});

// ── Reminders ──────────────────────────────────────────────────────────

const jobDeps = (date, extra = {}) => ({
  erp: erpnext.forUser(user), twilio: twilioStub,
  now: new Date(`${date}T09:00:00Z`), clock: { date, time: '09:00', timezone: 'UTC' }, ...extra,
});

test('reminders job: disabled → { skipped: true, note }; enabled(user) hook for the scheduler', async () => {
  seedInvoice('ACC-SINV-2026-00010', { customer: 'Jameel', total: 3000, due: addDays(TODAY, -5) });
  seedInvoice('ACC-SINV-2026-00015', { customer: 'Jameel', total: 1200, due: addDays(TODAY, -1) });
  seedInvoice('ACC-SINV-2026-00011', { customer: 'Beta', total: 4500, due: addDays(TODAY, 2) });
  seedInvoice('ACC-SINV-2026-00012', { customer: 'Beta', total: 800, due: addDays(TODAY, 10) });
  for (let i = 0; i < 4; i++) seedInvoice(`ACC-SINV-2026-0002${i}`, { customer: 'Gamma', total: 100, due: addDays(TODAY, -3) });

  const r = await remindersJob.run({ ...user, reminders_enabled: 0 }, jobDeps(TODAY));
  assert.deepEqual(r, { skipped: true, note: 'reminders disabled' });
  assert.equal(sent.length, 0);
  assert.equal(remindersJob.name, 'reminders');
  assert.equal(remindersJob.defaultTime, '09:00');
  assert.equal(remindersJob.enabled({ reminders_enabled: 1 }), true);
  assert.equal(remindersJob.enabled({ reminders_enabled: '1' }), true);
  assert.equal(remindersJob.enabled({ reminders_enabled: 0 }), false);
  assert.equal(remindersJob.enabled({}), false);
});

test('reminders job: one message per customer, wording, one QR for the THB total, max 3 PDFs', async () => {
  const on = { ...user, reminders_enabled: 1 };
  const r = await remindersJob.run(on, jobDeps(TODAY));
  assert.equal(r.sent, 7);
  assert.equal(r.messages, 3);
  assert.equal(r.failed, 0);
  assert.equal(r.note, 'sent 7, skipped 0, failed 0');
  assert.equal(sent.length, 3, 'grouped per customer');

  const jameel = sent.find((m) => m.to === 'whatsapp:+66899999999');
  assert.equal(jameel.body, [
    `Payment reminder from ${COMPANY}`,
    `Invoice ACC-SINV-2026-00010: THB 3,000.00 — 5 days overdue (due ${addDays(TODAY, -5)})`,
    `Invoice ACC-SINV-2026-00015: THB 1,200.00 — 1 day overdue (due ${addDays(TODAY, -1)})`,
    'Total outstanding: THB 4,200.00',
    'Scan the QR to pay THB 4,200.00 by PromptPay.',
  ].join('\n'));
  assert.equal(jameel.urls.length, 3, 'two PDFs + one QR');

  const beta = sent.find((m) => m.to === 'whatsapp:+66812223333');
  assert.match(beta.body, new RegExp(`Invoice ACC-SINV-2026-00011: THB 4,500\\.00 — due in 2 days \\(${addDays(TODAY, 2)}\\)`));
  assert.doesNotMatch(beta.body, /overdue|Total/);

  // 4 invoices: refs listed in the text, no PDFs, just the QR for the total.
  const gamma = sent.find((m) => m.to === 'whatsapp:+66863334444');
  assert.equal(gamma.body.match(/ACC-SINV-2026-0002\d/g).length, 4);
  assert.equal(gamma.urls.length, 1);
  assert.match(gamma.urls[0], /promptpay/);
  assert.deepEqual(payloads.map((p) => parseTlv(p)['54']).sort(), ['400.00', '4200.00', '4500.00']);
});

test('reminders job: dedupe per customer by calendar day — skip day 0..2 (even a new invoice), send on day 3', async () => {
  seedInvoice('ACC-SINV-2026-00017', { customer: 'Jameel', total: 70, due: addDays(TODAY, -1) });
  const on = { ...user, reminders_enabled: 1 };
  for (const d of [0, 1, 2]) {
    const r = await remindersJob.run(on, jobDeps(addDays(TODAY, d)));
    assert.equal(r.sent, 0, `day ${d}`);
    assert.equal(r.skipped, 8, `day ${d}`);
  }
  assert.equal(sent.length, 0);
  const r = await remindersJob.run(on, jobDeps(addDays(TODAY, 3)));
  assert.equal(r.sent, 8);
  assert.equal(r.messages, 3);
  // Day 3 relabels with the job's own date: 00011 was due in 2 → now 1 day overdue.
  assert.match(sent.find((m) => m.to === 'whatsapp:+66812223333').body, /ACC-SINV-2026-00011: THB 4,500\.00 — 1 day overdue/);
});

test('reminders job: undeliverable customers fail without stopping the rest', async () => {
  seedInvoice('ACC-SINV-2026-00014', { customer: 'NoPhone', total: 100, due: addDays(TODAY, -1) });
  const on = { ...user, reminders_enabled: 1 };
  const r = await remindersJob.run(on, jobDeps(addDays(TODAY, 4)));
  assert.equal(r.sent, 0, 'the others were reminded on day 3');
  assert.equal(r.skipped, 8);
  assert.equal(r.failed, 1);
  assert.equal(r.failures[0].ref, 'ACC-SINV-2026-00014');
  assert.match(r.note, /failed 1/);
  erp.get('Sales Invoice', 'ACC-SINV-2026-00014').outstanding_amount = 0;
});

test('reminders job: 5-attempt cap per customer counts undelivered sends; the 50 cap applies after dedupe', async () => {
  const on = { ...user, reminders_enabled: 1 };
  const day = addDays(TODAY, 8);
  const log = (customer, ref, sid, status, date) => db.query(
    `INSERT INTO outreach_log (user_id, customer, kind, reference, sent_at, sent_local_date, status, message_sid)
     VALUES ($1, $2, 'reminder', $3, $4, $5, $6, $7)`,
    [user.id, customer, ref, new Date().toISOString(), date, status, sid]
  );
  // Beta: 2 real reminders (day 0, day 3) + 3 accepted-but-undelivered (63016) → 5 → capped.
  for (let i = 0; i < 3; i++) await log('Beta', 'ACC-SINV-2026-00011', `SMund${i}`, 'failed', addDays(TODAY, -30 - i));
  // Jameel: failures that never reached Twilio (no SID) don't count.
  for (let i = 0; i < 3; i++) await log('Jameel', 'ACC-SINV-2026-00010', null, 'failed', addDays(TODAY, -30 - i));
  // 55 customers with long-overdue invoices, all reminded yesterday → deduped, and listed first.
  for (let i = 0; i < 55; i++) {
    const name = `Bulk${i}`;
    erp._put('Customer', { name, customer_name: name });
    seedInvoice(`ACC-SINV-2026-1${String(i).padStart(4, '0')}`, { customer: name, total: 10, due: addDays(TODAY, -60) });
    await log(name, `ACC-SINV-2026-1${String(i).padStart(4, '0')}`, `SMbulk${i}`, 'sent', addDays(day, -1));
  }
  const r = await remindersJob.run(on, jobDeps(day));
  assert.deepEqual(r.capped, ['Beta']);
  assert.match(r.note, /5-reminder cap: Beta/);
  const refsSent = sent.flatMap((m) => m.body.match(/ACC-SINV-2026-\d+/g)).sort();
  assert.deepEqual(refsSent, ['ACC-SINV-2026-00010', 'ACC-SINV-2026-00015', 'ACC-SINV-2026-00017',
    'ACC-SINV-2026-00020', 'ACC-SINV-2026-00021', 'ACC-SINV-2026-00022', 'ACC-SINV-2026-00023']);
  assert.equal(r.sent, 7);
  assert.equal(r.skipped, 55 + 2);
});

test('cleanup job: deletes old public Files for every user, once each, regardless of reminders', async () => {
  assert.equal(cleanupJob.name, 'cleanup');
  assert.equal(cleanupJob.defaultTime, '03:00');
  assert.equal(cleanupJob.window, 180);
  assert.equal(cleanupJob.enabled, undefined, 'no opt-in: runs for everyone');
  const before = (await db.query('SELECT files FROM outreach_log WHERE files IS NOT NULL')).rows;
  assert.ok(before.length > 0);
  const expected = new Set(before.flatMap((x) => JSON.parse(x.files)));

  // Too young: nothing goes.
  let r = await cleanupJob.run({ ...user, reminders_enabled: 0 }, { erp: erpnext.forUser(user), now: new Date() });
  assert.equal(r.skipped, true);
  assert.equal(deletedFiles.length, 0);

  r = await cleanupJob.run({ ...user, reminders_enabled: 0 }, { erp: erpnext.forUser(user), now: new Date(Date.now() + 3 * 86400000) });
  assert.deepEqual(new Set(deletedFiles), expected);
  assert.equal(deletedFiles.length, expected.size, 'each File deleted once');
  assert.equal(r.deleted, expected.size);
  assert.equal((await db.query('SELECT 1 FROM outreach_log WHERE files IS NOT NULL')).rows.length, 0);
});

test('cleanup job: purges this user\'s receipt blobs past RETENTION_DAYS even when nobody uploads', async () => {
  const { RETENTION_DAYS } = require('../src/media/store');
  const now = new Date();
  const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 86400000).toISOString();
  const fresh = new Date(now.getTime() - 3600000).toISOString();
  const otherUser = (await db.query(
    `INSERT INTO users (phone, default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ('+66900009999', 'THB', 'THB', 'TH', $1, $1) RETURNING id`, [now.toISOString()])).rows[0];
  for (const [uid, at] of [[user.id, old], [user.id, fresh], [otherUser.id, old]]) {
    await db.query(
      `INSERT INTO media_blobs (user_id, content_type, filename, bytes, created_at) VALUES ($1, 'image/jpeg', 'r.jpg', $2, $3)`,
      [uid, Buffer.from('x'), at]
    );
  }
  const r = await cleanupJob.run({ ...user, reminders_enabled: 0 }, { erp: erpnext.forUser(user), now });
  assert.equal(r.receipts, 1, 'only the stale blob of this user');
  const left = (await db.query('SELECT user_id, created_at FROM media_blobs ORDER BY user_id')).rows;
  assert.equal(left.length, 2);
  assert.ok(left.some((b) => b.user_id === user.id && b.created_at === fresh), 'fresh blob kept');
  assert.ok(left.some((b) => b.user_id === otherUser.id), 'other tenant untouched');
  await db.query('DELETE FROM media_blobs');
});

test('template mode: grouped reminder = one statement template, no PDFs, QR as follow-up; preview says so', async () => {
  process.env.TWILIO_REMINDER_CONTENT_SID = 'HXrem';
  twilioClient.sendTemplate = async (to, sid, vars) => {
    templates.push({ to, sid, vars });
    return 'SMrem';
  };
  try {
    const { preview, result } = await previewThenConfirm('send_payment_reminder', { counterparty_id: 1, scope: 'overdue' });
    const p = preview.previews[0];
    assert.match(p.message, /^\[The approved WhatsApp template HXrem will be used, with \{\{1\}\}=Jameel Crest Gems; \{\{2\}\}=THB 4,270\.00; \{\{3\}\}=ACC-SINV-2026-00010/);
    assert.deepEqual(p.attachments, ['PromptPay QR for THB 4,270.00 → payee ••••5678']);
    assert.equal(p.whatsapp_messages, 2);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(templates.length, 1);
    assert.deepEqual(Object.keys(templates[0].vars).sort(), ['1', '2', '3']);
    assert.equal(pdfRequests.length, 0, 'no PDFs in a statement template');
    assert.equal(sent.length, 1);
    assert.match(sent[0].urls[0], /promptpay/);
  } finally {
    delete process.env.TWILIO_REMINDER_CONTENT_SID;
    delete twilioClient.sendTemplate;
  }
});

test('send_payment_reminder: scope preview → yes → sends exactly the previewed refs; new invoice in between re-previews', async () => {
  let [r] = await say('who is due soon? remind them', [['send_payment_reminder', { scope: 'due_soon' }]]);
  assert.equal(r.needs_confirmation, true);
  assert.deepEqual(r.previews.map((p) => p.refs), [['ACC-SINV-2026-00011']]);
  assert.match(r.previews[0].message, /due in 2 days/);

  [r] = await say('remind Jameel about overdue ones', [['send_payment_reminder', { scope: 'overdue', counterparty_id: 1 }]]);
  assert.deepEqual(r.previews.map((p) => p.refs), [['ACC-SINV-2026-00010', 'ACC-SINV-2026-00015', 'ACC-SINV-2026-00017']]);
  assert.equal(r.previews[0].whatsapp_messages, 4, '3 PDFs + QR');
  // preview_text: one block per customer, with recipient + number, the exact body, attachments and count.
  const p0 = r.previews[0];
  assert.ok(r.preview_text.startsWith(`Send to ${p0.to} (${p0.phone}):\n${p0.message}\n+ ${p0.attachments.join(', ')} — 4 WhatsApp messages`), r.preview_text);
  assert.match(r.preview_text, /\n\nSend\?$/);
  // A new overdue invoice appears between preview and yes → not what the user approved.
  seedInvoice('ACC-SINV-2026-00016', { customer: 'Jameel', total: 50, due: addDays(TODAY, -2) });
  [r] = await say('yes', [['send_payment_reminder', { scope: 'overdue', counterparty_id: 1, confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.match(r.error, /changed/);
  assert.equal(r.previews[0].whatsapp_messages, 1, '4 invoices: refs in text, QR only');
  assert.ok(r.notes.some((n) => /refs are listed in the text/.test(n)));
  assert.equal(sent.length, 0);

  [r] = await say('yes', [['send_payment_reminder', { scope: 'overdue', counterparty_id: 1, confirmed: true }]]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.sent.map((s) => s.refs), [['ACC-SINV-2026-00010', 'ACC-SINV-2026-00016', 'ACC-SINV-2026-00015', 'ACC-SINV-2026-00017']]);
  assert.equal(sent.length, 1);

  [r] = await say('remind', [['send_payment_reminder', {}]]);
  assert.match(r.error, /ref, counterparty_id or scope/);
});

test('send_payment_reminder: cold confirm refused; problems listed per ref', async () => {
  let { result } = await tool('send_payment_reminder', { ref: 'ACC-SINV-2026-00011', confirmed: true });
  assert.equal(result.needs_confirmation, true);
  assert.equal(sent.length, 0);

  ({ result } = await tool('send_payment_reminder', { ref: 'ACC-SINV-2026-00006' }));
  assert.equal(result.ok, false);
  assert.match(result.cannot_send[0].error, /already paid/);
});

// ── Settings + prompt ──────────────────────────────────────────────────

test('set_payment_settings: strict boolean, validation, clear + disable apply at once', async () => {
  for (const v of ['true', 1, 'yes']) {
    const { result } = await tool('set_payment_settings', { reminders_enabled: v });
    assert.equal(result.ok, false, String(v));
    assert.match(result.error, /true or false/);
  }
  let { result } = await tool('set_payment_settings', { promptpay_id: '12345' });
  assert.equal(result.ok, false);

  ({ result } = await tool('set_payment_settings', { promptpay_id: '', reminders_enabled: false }));
  assert.deepEqual(result, { ok: true, promptpay_id: null, reminders_enabled: false });
});

test('set_payment_settings: a new PromptPay payee is two-step through the gate (masked in the preview)', async () => {
  let { result } = await tool('set_payment_settings', { promptpay_id: '+66 89 000 1111', confirmed: true });
  assert.equal(result.needs_confirmation, true, 'cold confirm refused');
  assert.match(result.preview, /pay PromptPay ••••1111 \(mobile number\)/);
  assert.doesNotMatch(result.preview, /0890001111/);
  let row = (await db.query('SELECT promptpay_id FROM users WHERE id = $1', [user.id])).rows[0];
  assert.equal(row.promptpay_id, null);

  await say('set my promptpay to 0890001111', [['set_payment_settings', { promptpay_id: '0890001111' }]]);
  // The model can't swap in a different id on the yes: the hash binds the full id.
  [result] = await say('yes', [['set_payment_settings', { promptpay_id: '0890002222', confirmed: true }]]);
  assert.equal(result.needs_confirmation, true);
  [result] = await say('yes', [['set_payment_settings', { promptpay_id: '0890002222', confirmed: true }]]);
  assert.deepEqual(result, { ok: true, promptpay_id: '0890002222', reminders_enabled: false });
  row = (await db.query('SELECT promptpay_id FROM users WHERE id = $1', [user.id])).rows[0];
  assert.equal(row.promptpay_id, '0890002222');
});

test('set_payment_settings: enabling reminders is two-step through the gate', async () => {
  let [result] = await say('turn on reminders', [['set_payment_settings', { reminders_enabled: true, confirmed: true }]]);
  assert.equal(result.needs_confirmation, true, 'cold confirm refused');
  assert.match(result.preview, /message your customers automatically at 09:00 for overdue invoices.*Confirm\?/s);
  let row = (await db.query('SELECT reminders_enabled FROM users WHERE id = $1', [user.id])).rows[0];
  assert.equal(row.reminders_enabled, 0);

  [result] = await say('yes', [['set_payment_settings', { reminders_enabled: true, confirmed: true }]]);
  assert.deepEqual(result, { ok: true, promptpay_id: '0890002222', reminders_enabled: true });
  row = (await db.query('SELECT reminders_enabled FROM users WHERE id = $1', [user.id])).rows[0];
  assert.equal(row.reminders_enabled, 1);
  assert.equal(await storedPreview(), undefined);

  ({ result } = await tool('set_payment_settings', { reminders_enabled: false }));
  assert.equal(result.reminders_enabled, false, 'turning off needs no confirmation');
});

test('outreach prompt section: preview, end turn, next-message yes; masked payee', () => {
  const section = require('../src/prompt/30-outreach');
  const text = section({ user: { promptpay_id: '0812345678', reminders_enabled: 1 } });
  assert.match(text, /Never call confirmed:true in the same turn as the preview/);
  assert.match(text, /VERY NEXT message/);
  assert.match(text, /never automatically after save_transaction/);
  assert.match(text, /Send it to <customer>\?/);
  assert.match(text, /PromptPay set \(••••5678\); automatic reminders ON/);
  assert.doesNotMatch(text, /0812345678/);
});

// ── Final review: preview identity, payee hashing, job timeout, Twilio rejections ──

test('gate: every stored preview gets its own random preview_id (no same-millisecond collisions)', async () => {
  await say('send it', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  const a = await storedPreview();
  assert.match(a.preview_id, /^[0-9a-f-]{36}$/);
  // Re-preview (drift) in the next turn: a different id, and it stays armed for one more turn.
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 9000;
  await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  const b = await storedPreview();
  assert.notEqual(b.preview_id, a.preview_id);
  const [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.ok, true, JSON.stringify(r));
  erp.get('Sales Invoice', 'ACC-SINV-2026-00001').outstanding_amount = 10000;
});

test('gate: a different PromptPay id with the same last 4 digits still counts as a change', async () => {
  user.promptpay_id = '0812345678';
  await say('send it', [['send_invoice', { ref: 'ACC-SINV-2026-00001' }]]);
  user.promptpay_id = '0822345678'; // masked identically: ••••5678
  const [r] = await say('yes', [['send_invoice', { ref: 'ACC-SINV-2026-00001', confirmed: true }]]);
  assert.equal(r.needs_confirmation, true);
  assert.match(r.error, /changed/);
  assert.equal(sent.length, 0);
});

test('deliver: re-validates the phone before uploading anything', async () => {
  const { deliver } = require('../src/outreach/send-invoice');
  const msg = {
    kind: 'invoice', customer: 'Bad', customerId: 'Bad', to: 'whatsapp:+0123', phone: '+0123',
    refs: ['ACC-SINV-2026-00001'], pdfRefs: ['ACC-SINV-2026-00001'], qrAmount: 100, template: null, body: 'x',
  };
  const r = await deliver(user, erpnext.forUser(user), msg, { twilio: twilioStub, today: TODAY });
  assert.equal(r.ok, false);
  assert.equal(pdfRequests.length + uploads.length + sent.length, 0);
});

// A second tenant (own Company, own contacts) so these runs don't depend on the history above.
let user2;
async function makeUser2() {
  if (user2) return user2;
  const now = new Date().toISOString();
  user2 = (await db.query(
    `INSERT INTO users (phone, erpnext_company, erpnext_api_key, erpnext_api_secret, default_currency,
       reporting_currency, country, timezone, reminders_enabled, created_at, updated_at)
     VALUES ('+66001', 'Other Co', 'k2', 's2', 'THB', 'THB', 'TH', 'UTC', 1, $1, $1) RETURNING *`,
    [now]
  )).rows[0];
  for (const [name, phone] of [['Delta', '+66 81 444 0001'], ['Echo', '+66 81 444 0002']]) {
    erp._put('Customer', { name, customer_name: `${name} Co` });
    await db.query(
      `INSERT INTO counterparty_cache (owner_user_id, name, phone, erpnext_customer, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`, [user2.id, `${name} Co`, phone, name, now]
    );
  }
  seedInvoice('ACC-SINV-2026-30001', { customer: 'Delta', total: 100, due: addDays(TODAY, -2), company: 'Other Co' });
  seedInvoice('ACC-SINV-2026-30002', { customer: 'Echo', total: 200, due: addDays(TODAY, -1), company: 'Other Co' });
  // The old Other Co invoice from the top of the file belongs to Jameel, who has no contact here.
  erp.get('Sales Invoice', 'ACC-SINV-2026-00004').outstanding_amount = 0;
  return user2;
}
const deps2 = (date, extra = {}) => ({
  erp: erpnext.forUser(user2), twilio: twilioStub,
  now: new Date(`${date}T09:00:00Z`), clock: { date, time: '09:00', timezone: 'UTC' }, ...extra,
});

test('reminders job: timeoutMs export; an aborted signal stops before the next customer, no false failures', async () => {
  await makeUser2();
  assert.equal(remindersJob.timeoutMs, 15 * 60 * 1000);

  const pre = new AbortController();
  pre.abort();
  let r = await remindersJob.run(user2, deps2(TODAY, { signal: pre.signal }));
  assert.equal(r.aborted, true);
  assert.equal(r.sent + r.failed, 0);
  assert.equal(sent.length, 0);

  // Abort while the first customer's message is going out: it completes, the second isn't started.
  const mid = new AbortController();
  const twilio = { async sendMedia(...a) { mid.abort(); return twilioStub.sendMedia(...a); } };
  r = await remindersJob.run(user2, deps2(TODAY, { signal: mid.signal, twilio }));
  assert.equal(sent.length, 1);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.aborted, true);
  assert.match(r.note, /stopped early/);
  await db.query('DELETE FROM outreach_log WHERE user_id = $1', [user2.id]);
});

test('reminders job: synchronous Twilio rejections (no SID) count toward dedupe and the 5-cap', async () => {
  await makeUser2();
  mediaResult = { sids: [], errors: [{ index: 0, code: 21211, message: "Invalid 'To' Phone Number" }] };
  let r = await remindersJob.run(user2, deps2(TODAY));
  assert.equal(r.failed, 2);
  const rows = (await db.query('SELECT error, message_sid FROM outreach_log WHERE user_id = $1', [user2.id])).rows;
  assert.ok(rows.every((x) => x.message_sid === null && /^21211: /.test(x.error)));

  // Next day: rejected attempts dedupe like real sends — no new uploads, no new tries.
  uploads = [];
  r = await remindersJob.run(user2, deps2(addDays(TODAY, 1)));
  assert.equal(r.skipped, 2);
  assert.equal(uploads.length, 0);

  // Every 3 days → attempts 2..5, then capped for good.
  for (const d of [3, 6, 9, 12]) await remindersJob.run(user2, deps2(addDays(TODAY, d)));
  sent = [];
  r = await remindersJob.run(user2, deps2(addDays(TODAY, 15)));
  assert.deepEqual(r.capped.sort(), ['Delta', 'Echo']);
  assert.equal(sent.length, 0);

  // A failure before Twilio (render error, no code) is NOT an attempt.
  await db.query('DELETE FROM outreach_log WHERE user_id = $1', [user2.id]);
  mediaResult = null;
  pdfBody = Buffer.from('<html>boom</html>');
  r = await remindersJob.run(user2, deps2(TODAY));
  assert.equal(r.failed, 2);
  pdfBody = null;
  r = await remindersJob.run(user2, deps2(addDays(TODAY, 1)));
  assert.equal(r.sent, 2, 'retried the next day');
});

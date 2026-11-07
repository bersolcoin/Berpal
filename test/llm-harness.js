/**
 * LLM conversation harness — does GPT actually pick the right tools?
 *
 * Runs scripted WhatsApp conversations through conversation.handle() with the REAL OpenAI
 * model, while ERPNext (test/fake-erpnext.js) and Postgres (pg-mem) stay in memory.
 * Frankfurter FX lookups are stubbed to a fixed rate so runs are deterministic.
 *
 *   npm run test:llm            needs OPENAI_API_KEY in .env; costs a few cents (gpt-4o-mini)
 *   VERBOSE=1 npm run test:llm  also prints the bot's internal tool logs
 *
 * Not part of `npm test`: it needs network + a paid key, and model output is not fully
 * deterministic. Treat a failure as "look at the transcript", not as a red build.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ERPNEXT_URL = 'http://erp.test';
// Free-form outreach (sendMedia): no approved templates in the harness.
delete process.env.TWILIO_INVOICE_CONTENT_SID;
delete process.env.TWILIO_REMINDER_CONTENT_SID;

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to .env and rerun.');
  process.exit(2);
}

const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');

// Quiet the bot's own logging unless asked for.
const realLog = console.log;
if (!process.env.VERBOSE) {
  console.log = (...a) => {
    if (typeof a[0] === 'string' && (a[0].startsWith('• [') || a[0].startsWith('['))) return;
    realLog(...a);
  };
}

// ── Observe tool calls: patch the registry BEFORE conversation.js captures executeTool ──
const toolsModule = require('../src/tools');
const calls = [];
const origExecute = toolsModule.executeTool;
toolsModule.executeTool = async (name, args, ctx) => {
  const result = await origExecute(name, args, ctx);
  calls.push({ name, args, result });
  return result;
};
const conversation = require('../src/conversation');
const store = require('../src/media/store');
const twilioClient = require('../src/twilio-client');

const FX_RATE = 32.5;
const erp = new FakeErpNext();
erp.install();
const erpFetch = global.fetch;

// Binary ERPNext paths (same adapter as test/outreach.test.js): multipart bodies are held aside
// for the upload_file hook; download_pdf returns base64 that arrayBuffer() decodes.
const uploads = [];
let pendingForm = null;
erp.methods['frappe.utils.print_format.download_pdf'] = (u) => ({ __binary: Buffer.from(`%PDF-1.4 ${u.searchParams.get('name')}`).toString('base64') });
erp.methods.upload_file = () => {
  const form = pendingForm;
  const filename = form.get('file_name');
  uploads.push({ filename, doctype: form.get('doctype'), docname: form.get('docname'), is_private: form.get('is_private') });
  return { message: { name: `FILE-${uploads.length}`, file_url: `/files/${filename}` } };
};

// Outbound WhatsApp to customers: recorded, never sent.
const twilioSent = [];
twilioClient.sendMedia = async (to, body, urls) => {
  twilioSent.push({ to, body, urls });
  return { sids: (urls && urls.length ? urls : [null]).map((_, i) => `SMharness${twilioSent.length}-${i}`), errors: [] };
};

global.fetch = async (url, opts = {}) => {
  if (String(url).includes('frankfurter')) {
    const u = new URL(url);
    const from = u.searchParams.get('from') || u.searchParams.get('base') || 'USD';
    const to = (u.searchParams.get('to') || u.searchParams.get('symbols') || 'THB').split(',')[0];
    const body = { amount: 1, base: from, date: TODAY, rates: { [to]: FX_RATE } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  const isForm = opts.body instanceof FormData;
  pendingForm = isForm ? opts.body : null;
  const res = await erpFetch(url, isForm ? { ...opts, body: undefined } : opts);
  return { ...res, arrayBuffer: async () => Buffer.from(JSON.parse(await res.text()).__binary, 'base64') };
};

let user;
async function setup() {
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, display_name, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ('+66000', 'Harness', $1, 'k', 's', 'THB', 'THB', 'TH', $2, $2) RETURNING *`,
    [COMPANY, now]
  );
  // VAT-registered (the VAT bill scenario needs it); UTC so the user's local date = the fake's TODAY.
  user = (await db.query(`UPDATE users SET vat_registered = 1, timezone = 'UTC' WHERE id = $1 RETURNING *`, [r.rows[0].id])).rows[0];
}

// ── Scenario runner ─────────────────────────────────────────────────────
const failures = [];
let turnCount = 0;

function check(label, ok, detail = '') {
  realLog(`      ${ok ? '✔' : '✖'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * step: { say, expect: { tools?: [names that must be called], noTools?: true,
 *         confirmation?: bool, reply?: RegExp, after?: (result) => void | Promise<void> } }
 * `say` may be a function of the previous reply, for answering pickers.
 */
async function scenario(title, steps) {
  realLog(`\n■ ${title}`);
  let lastReply = '';
  for (const step of steps) {
    // step.voice: a voice note as whatsapp.js would pass it (transcript line + the voice flag).
    const text = step.voice ? `[voice note] ${step.voice}` : typeof step.say === 'function' ? step.say(lastReply) : step.say;
    calls.length = 0;
    turnCount++;
    let result;
    try {
      result = await conversation.handle(user, text, step.voice ? { voiceTranscript: step.voice } : {});
    } catch (err) {
      realLog(`   › ${text}\n   ✖ handle() threw: ${err.message}`);
      failures.push(`${title}: handle threw`);
      return;
    }
    if (typeof result === 'string') result = { text: result, isConfirmation: false };
    lastReply = result.text;
    replies.push(result);
    const toolNames = calls.map((c) => c.name);
    const shown = calls.map((c) => (c.name === 'update_draft' ? `update_draft${JSON.stringify(c.args)}` : c.name));
    realLog(`   › ${text}`);
    realLog(`     tools: ${shown.length ? shown.join(' → ') : '(none)'}${result.isConfirmation ? '   [confirmation card]' : ''}`);
    realLog(`     « ${result.text.replace(/\n/g, '\n       ')}`);
    const failed = calls.filter((c) => c.result && c.result.ok === false);
    for (const f of failed) realLog(`     ⚠ ${f.name} returned error: ${f.result.error || f.result.reason}`);

    const e = step.expect || {};
    for (const t of e.tools || []) check(`called ${t}`, toolNames.includes(t), `got ${toolNames.join(', ') || 'none'}`);
    if (e.noTools) check('no tools called', toolNames.length === 0, toolNames.join(', '));
    if (e.confirmation != null) check(`confirmation card ${e.confirmation ? 'sent' : 'not sent'}`, result.isConfirmation === e.confirmation);
    if (e.reply) check(`reply matches ${e.reply}`, e.reply.test(result.text));
    if (e.after) {
      // Awaited: an async `after` (one that reads Postgres) must land its checks before the run
      // is scored, and a throw inside it must count as a failure rather than an unhandled rejection.
      try {
        await e.after(result);
      } catch (err) {
        check(err.message, false);
      }
    }
  }
}

function assertEq(label, actual, expected) {
  check(`${label} = ${JSON.stringify(expected)}`, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const yes = 'Confirm';
// Every bot reply this run, for checks that don't care which turn produced it.
const replies = [];
const lastText = () => replies[replies.length - 1]?.text || '';
const receiptCardSeen = () => replies.some((r) => r.isConfirmation && /\b185(\.00)?\b/.test(r.text) && /Starbucks|coffee|latte/i.test(r.text));
const usdBank = () => erp.all('Account').find((a) => a.account_type === 'Bank' && a.account_currency === 'USD');

(async () => {
  await setup();
  const t0 = Date.now();

  await scenario('Chitchat does not touch the draft', [
    { say: 'hello', expect: { noTools: true, confirmation: false } },
    { say: "what's the weather like", expect: { noTools: true, reply: /bookkeeping|transaction|books/i } },
  ]);

  await scenario('Add wallets by name', [
    { say: 'add wallet BBL Savings THB', expect: { tools: ['create_user_account'], confirmation: false, reply: /BBL/ } },
    { say: 'add new bank DBS USD', expect: { tools: ['create_user_account'],
      after: () => check('a USD bank account exists in ERPNext', !!usdBank()) } },
  ]);

  await scenario('Opening balance for a new wallet', [
    { say: 'I have KBank with 20000 baht in it', expect: { tools: ['create_user_account'], confirmation: true, reply: /20,000/ } },
    { say: yes, expect: { tools: ['save_transaction'], reply: /Saved/,
      after: () => {
        assertEq('KBank balance', erp.balanceOn('KBank - TC', TODAY), 20000);
        assertEq('Opening Balance Equity', erp.balanceOn('3300 - Opening Balance Equity - TC', TODAY), -20000);
      } } },
  ]);

  await scenario('Cash expense picks a wallet, then saves a journal entry', [
    { say: 'paid 850 for lunch', expect: { tools: ['update_draft', 'list_user_accounts'] } },
    // Either it asked which wallet (answer "cash") or it already picked one and sent the card.
    { say: (r) => (/which wallet|\b1\./i.test(r) ? 'cash' : yes),
      expect: { after: () => {} } },
    { say: (r) => (/Saved/.test(r) ? 'thanks' : yes),
      expect: { after: () => {
        assertEq('Entertainment Expenses', erp.balanceOn('5204 - Entertainment Expenses - TC', TODAY), 850);
      } } },
  ]);

  await scenario('USD sale on terms to a new customer', [
    { say: 'sold ruby 7.68ct to Jameel Crest Gems for 45000 USD net 30',
      expect: { tools: ['update_draft', 'lookup_counterparty'], confirmation: false, reply: /contact|number|phone|skip/i } },
    // The server fetches the rate itself; the card must show the real one, not a guess.
    { say: 'skip', expect: { tools: ['request_confirmation'], confirmation: true, reply: /45,000 USD/,
      after: (r) => check('card shows the fetched rate 32.50', /@ 32\.50?\b/.test(r.text), r.text.split('\n').find((l) => l.startsWith('Amount'))) } },
    { say: yes, expect: { tools: ['save_transaction'], reply: /ACC-SINV/,
      after: () => {
        const inv = erp.all('Sales Invoice')[0];
        check('sales invoice exists', !!inv);
        if (inv) {
          assertEq('invoice currency', inv.currency, 'USD');
          assertEq('debit_to', inv.debit_to, 'Debtors USD - TC');
          assertEq('conversion_rate', inv.conversion_rate, FX_RATE);
          assertEq('description', inv.items[0].description.toLowerCase().includes('ruby'), true);
        }
      } } },
  ]);

  await scenario('Query open receivables', [
    { say: "what's outstanding?", expect: { tools: ['query_open_invoices'], confirmation: false, reply: /45,000|45000/ } },
    { say: 'how much does Jameel owe me?', expect: { tools: ['lookup_counterparty', 'query_balance_with_counterparty'], reply: /45,000|45000/ } },
  ]);

  await scenario('Customer pays the invoice into the USD bank', [
    { say: 'Jameel paid 45000 USD into DBS', expect: { tools: ['query_open_invoices'] } },
    { say: (r) => (/which|reply with a number|1\./i.test(r) && !/Choose below/i.test(r) ? '1' : yes), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes),
      expect: { after: () => {
        const pe = erp.all('Payment Entry')[0];
        check('payment entry exists', !!pe);
        assertEq('invoice outstanding', erp.all('Sales Invoice')[0]?.outstanding_amount, 0);
        assertEq('USD bank balance', usdBank() ? erp.balanceOn(usdBank().name, TODAY) : null, 45000);
      } } },
    { say: 'how much does Jameel owe me now?', expect: { tools: ['query_balance_with_counterparty'], reply: /nothing|0|settled|no outstanding/i } },
  ]);

  await scenario('Bill from a supplier', [
    { say: 'got a bill from Acme Supplies for 12000 baht for stones, due in 15 days, their ref ACME-77',
      expect: { tools: ['update_draft'], reply: /contact|number|phone|skip|12,000 THB/i } },
    // Either it asked for the supplier's contact (give it) or it already sent the card (confirm).
    { say: (r) => (/Choose below/.test(r) ? yes : '+66 81 234 5678'), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes), expect: {} },
    // A real user would tap Confirm again if the card came back; allow one retry.
    { say: (r) => (/Saved|Anytime|Done/.test(r) ? 'ok' : yes),
      expect: { after: () => {
        const bill = erp.all('Purchase Invoice')[0];
        check('purchase invoice exists', !!bill);
        if (bill) assertEq('bill_no', bill.bill_no, 'ACME-77');
      } } },
    { say: "what's due this month?", expect: { tools: ['query_upcoming'], reply: /Acme/ } },
  ]);

  await scenario('Cancel mid-draft', [
    { say: 'paid 300 for taxi', expect: { tools: ['update_draft'] } },
    { say: 'never mind, cancel that', expect: { tools: ['cancel_transaction'], reply: /cancel/i } },
    { say: 'how much have I spent this year?', expect: { tools: ['query_transaction_summary'], reply: /12,850|12850/ } },
  ]);

  await scenario('Cash position', [
    { say: 'how much money do I have?', expect: { tools: ['query_cash_bank_balance'], reply: /KBank/ } },
  ]);

  // ── New-feature scenarios. Synthetic lines are injected directly: the harness bypasses
  // whatsapp.js / src/media, so "[receipt scanned]" and "[voice note]" arrive as they would
  // after intake. Every expense scenario runs after 'Cancel mid-draft' (its 12,850 total).

  const receiptId = await store.saveBlob(user.id, { contentType: 'image/jpeg', filename: 'receipt.jpg', bytes: Buffer.from('fake-jpeg-bytes') });
  const scanLine = `[receipt scanned] ${JSON.stringify({
    media_id: receiptId, type: 'receipt', merchant: 'Starbucks', date: TODAY, total: 185, currency: 'THB',
    vat_amount: 12.1, vat_rate: 7, vat_claimable: true, paid_by: 'cash', items: '2 lattes', confidence: 0.93,
  })}`;
  const pickCash = (r) => {
    if (/Choose below/i.test(r)) return yes;
    const line = r.split('\n').find((l) => /^\s*\d+\.\s*Cash\b/i.test(l));
    return line ? line.trim().match(/^(\d+)/)[1] : 'Cash';
  };
  await scenario('Receipt photo → wallet → card with the scanned total → save attaches the image', [
    { say: `coffee with client\n${scanLine}`, expect: { tools: ['update_draft'],
      after: () => {
        const upd = calls.filter((c) => c.name === 'update_draft');
        check('receipt_media_id set from the scan line', upd.some((c) => Number(c.args.receipt_media_id) === receiptId),
          JSON.stringify(upd.map((c) => c.args)));
      } } },
    { say: pickCash, expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes),
      expect: { after: () => {} } },
    { say: (r) => (/Saved/.test(r) ? 'thanks' : yes), expect: { after: () => {
      const att = uploads.find((u) => u.filename === 'receipt.jpg');
      check('receipt uploaded to ERPNext', !!att, JSON.stringify(uploads));
      if (att) {
        assertEq('attached to doctype', att.doctype, 'Journal Entry');
        check('attached to a saved JE', !!erp.get('Journal Entry', att.docname), att.docname);
        assertEq('private file', att.is_private, '1');
      }
    } } },
  ]);
  // The card turn is whichever turn sent the card; check its total separately so it's reported once.
  check('receipt card showed the scanned total 185', receiptCardSeen(), 'no card with 185 THB');

  await scenario('Voice note goes through the normal flow', [
    { voice: 'paid 300 for taxi', expect: { tools: ['update_draft'],
      after: (r) => check('echoes what it heard', /heard/i.test(r.text), r.text.split('\n')[0]) } },
    { say: pickCash, expect: {} },
    // Card → confirm; picker again → pick again; saved → done. One extra turn for a recovery.
    { say: (r) => (/Saved/.test(r) ? 'ok' : pickCash(r)), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : pickCash(r)), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'thanks' : pickCash(r)), expect: { after: () => {
      assertEq('Travel Expenses', erp.balanceOn('5216 - Travel Expenses - TC', TODAY), 300);
    } } },
  ]);

  let siamCard = '';
  await scenario('VAT-registered user: bill incl VAT with 3% WHT', [
    { say: 'got a bill from Siam Services for 10,700 incl VAT with 3% WHT, PND53, due in 30 days',
      expect: { tools: ['update_draft'], reply: /contact|number|phone|skip|10,700/i } },
    { say: (r) => (/Choose below/.test(r) ? yes : 'skip'),
      expect: { after: (r) => { if (r.isConfirmation) siamCard = r.text; } } },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes),
      expect: { after: (r) => { if (!siamCard && r.isConfirmation) siamCard = r.text; } } },
    { say: (r) => (/Saved|Anytime|Done/.test(r) ? 'ok' : yes), expect: { after: () => {
      const bill = erp.all('Purchase Invoice').find((b) => /Siam/.test(b.supplier));
      check('Siam bill exists', !!bill);
      if (bill) assertEq('bill outstanding (gross − WHT)', bill.outstanding_amount, 10400);
    } } },
  ]);
  siamCard = [...replies].reverse().find((r) => r.isConfirmation && /Siam/.test(r.text))?.text || siamCard;
  check('card shows Net 10,000', /Net:?\s*10,?000(\.00)?\b/.test(siamCard), siamCard);
  check('card shows VAT 700', /VAT[^\n]*?700(\.00)?\b/.test(siamCard), siamCard);
  check('card shows WHT 300', /WHT[^\n]*?\b300(\.00)?\b/.test(siamCard), siamCard);
  check('card shows pay 10,400', /10,?400/.test(siamCard), siamCard);

  // Jameel's WhatsApp number (outreach only uses this user's contacts) and the nickname the user
  // calls him by — "sold PA2293 to Jameel" then matches the existing contact exactly.
  await toolsModule.executeTool('create_contact', { name: 'Jameel Crest Gems', nickname: 'Jameel', phone: '+66 81 234 5678' },
    { user, draft: {}, saved: null, cancelled: false, confirmationRequested: false });
  const bin = (code) => erp.all('Bin').find((b) => String(b.item_code).startsWith(code));
  await scenario('Stock: buy a coded stone, sell it, ask what is in stock', [
    { say: 'bought ruby PA2293 from Gem Source for 50,000 THB cash', expect: { tools: ['update_draft'] } },
    // New supplier → contact ask (skip); a re-ask of the supplier → answer; a card → confirm; a payment follow-up → decline.
    { say: (r) => (/Choose below/.test(r) ? yes : /contact|number|phone/i.test(r) ? 'skip' : /who/i.test(r) ? 'Gem Source' : yes), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'no thanks' : yes), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'no thanks' : /Choose below/.test(r) ? yes : 'ok'), expect: { after: () => {
      const b = bin('PA2293');
      check('PA2293 received into stock', !!b && b.actual_qty === 1, JSON.stringify(b || null));
    } } },
    { say: 'sold PA2293 to Jameel for 80,000 USD net 30', expect: { tools: ['update_draft'] } },
    { say: (r) => (/Choose below/.test(r) ? yes : /who/i.test(r) ? 'Jameel Crest Gems' : /which|\b1\./i.test(r) ? '1' : yes), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes), expect: { after: () => {
      const inv = erp.all('Sales Invoice').find((i) => i.currency === 'USD' && i.grand_total === 80000);
      check('USD 80,000 sales invoice exists', !!inv);
      if (inv) assertEq('update_stock', inv.update_stock, 1);
      const b = bin('PA2293');
      assertEq('PA2293 on hand after the sale', b ? b.actual_qty : null, 0);
    } } },
    { say: "what's in stock?", expect: { tools: ['query_stock'], confirmation: false } },
  ]);

  await scenario('Outreach: preview, yes, sent once; "send it again" needs its own yes', [
    { say: 'send it to Jameel', expect: { tools: ['send_invoice'], confirmation: false,
      after: () => {
        check('preview only — nothing sent yet', twilioSent.length === 0, `${twilioSent.length} sent`);
        check('preview names the number', /\+?66\s?81\s?234\s?5678|\+66812345678/.test(lastText()), lastText());
      } } },
    { say: 'yes', expect: { tools: ['send_invoice'], after: () => {
      assertEq('Twilio messages after yes', twilioSent.length, 1);
      if (twilioSent[0]) assertEq('sent to', twilioSent[0].to, 'whatsapp:+66812345678');
    } } },
    { say: 'send it again', expect: { after: () => assertEq('nothing re-sent without a new yes', twilioSent.length, 1) } },
    { say: 'yes', expect: { after: () => assertEq('second send after its own yes', twilioSent.length, 2) } },
  ]);

  await scenario('Settings: digest time and VAT registration', [
    { say: 'send my digest at 7:30', expect: { tools: ['set_schedule_preferences'], after: async () => {} } },
    { say: "I'm VAT registered", expect: { tools: ['set_tax_settings'] } },
  ]);
  const prefs = (await db.query('SELECT job_prefs, vat_registered FROM users WHERE id = $1', [user.id])).rows[0];
  check('digest time stored as 07:30', /"07:30"/.test(prefs.job_prefs || ''), prefs.job_prefs);
  assertEq('vat_registered', Number(prefs.vat_registered), 1);

  // Every document saved above is awaiting review; the first ACC-JV in the queue is the one we name.
  const queue = async () => (await db.query(
    "SELECT erpnext_name FROM trust_fingerprints WHERE user_id = $1 AND review_status = 'pending' ORDER BY transaction_date, id", [user.id]
  )).rows.map((r) => r.erpnext_name);
  const firstJv = (await queue()).find((n) => /^ACC-JV-/.test(n)) || '';
  await scenario('Accountant review queue: list, mark one, mark all (count guard)', [
    { say: "what's waiting for my accountant?", expect: { tools: ['list_review_queue'], confirmation: false,
      reply: new RegExp(firstJv.replace(/[-]/g, '\\-') || 'ACC-'),
      after: (r) => check('no ⚠ on items without warnings, one line per item', !/⚠.*⚠/.test(r.text.split('\n').find((l) => l.includes(firstJv)) || ''), r.text) } },
    { say: `mark ${firstJv} reviewed`, expect: { tools: ['mark_reviewed'], confirmation: false, reply: new RegExp(firstJv.replace(/[-]/g, '\\-')),
      after: async () => {
        const row = (await db.query('SELECT review_status, reviewed_by FROM trust_fingerprints WHERE user_id = $1 AND erpnext_name = $2', [user.id, firstJv])).rows[0];
        assertEq(`${firstJv} status`, row && row.review_status, 'reviewed');
        assertEq('reviewer label', row && row.reviewed_by, 'owner via whatsapp');
      } } },
    // "all reviewed" right after the list: expected_count must be the total it just saw (the list is stale by one).
    { say: 'the accountant has checked everything, all reviewed', expect: { tools: ['mark_reviewed'], confirmation: false,
      after: async (r) => {
        const mr = calls.filter((c) => c.name === 'mark_reviewed');
        check('mark_reviewed(all=true, expected_count)', mr.some((c) => c.args.all === true && Number.isFinite(Number(c.args.expected_count))), JSON.stringify(mr.map((c) => c.args)));
        // Either the count matched and the queue is empty, or the guard tripped and the bot showed the
        // current queue (count_changed carries it) and asked with the new total.
        const left = await queue();
        const asked = new RegExp(`all ${left.length}[^?]*\\?`, 'i').test(r.text);
        const shown = left.every((name) => r.text.includes(name));
        check('queue empty, or re-shown and asked with the new total', left.length === 0 || (asked && shown), `left ${left.length}; asked ${asked}; shown ${shown}`);
      } } },
  ]);

  realLog(`\n${turnCount} turns in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length) {
    realLog(`\n✖ ${failures.length} check(s) failed:`);
    for (const f of failures) realLog(`  - ${f}`);
    process.exit(1);
  }
  realLog('\n✔ all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});

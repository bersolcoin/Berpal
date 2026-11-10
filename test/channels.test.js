/**
 * The channel layer (src/channels): addresses, the registry's address routing, the Twilio
 * adapter's inbound conversion, and — with a fake 'line' channel registered in place of the real
 * one — that replies, onboarding and the digest follow the user's address to their channel.
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;
delete process.env.TWILIO_DIGEST_CONTENT_SID;
process.env.ONBOARDING_MODE = 'open';
delete process.env.ONBOARDING_INVITE_CODES;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const db = require('../src/db');
const channels = require('../src/channels');
const address = require('../src/channels/address');
const twilioAdapter = require('../src/channels/twilio');
const download = require('../src/media/download');
const users = require('../src/users');
const onboarding = require('../src/onboarding');
const M = require('../src/onboarding/messages');
const conversation = require('../src/conversation');
const { processIncomingMessage } = require('../src/whatsapp');
const scheduler = require('../src/jobs/scheduler');
const digest = require('../src/jobs/digest.job');
const { localClock } = require('../src/jobs');
const { FakeErpNext, COMPANY } = require('./fake-erpnext');

const LINE_USER = 'line:U1';
const TW = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media';

/** A recording channel; `name` 'line' (no templates) or 'whatsapp' (templates). */
function fakeChannel(name, { supportsTemplates = name !== 'line' } = {}) {
  const sent = [];
  let n = 0;
  const rec = (kind) => async (to, ...args) => {
    sent.push({ kind, to, args });
    n++;
    return `${name}-${n}`;
  };
  return {
    name,
    webhookPath: name === 'line' ? '/line/webhook' : '/webhook',
    supportsTemplates,
    sent,
    isConfigured: () => true,
    sendText: rec('text'),
    sendConfirmation: rec('confirmation'),
    sendMedia: async (to, text, urls) => { sent.push({ kind: 'media', to, args: [text, urls] }); return { sids: ['m'], errors: [] }; },
    sendTemplate: supportsTemplates ? rec('template') : async () => { throw new Error(`${name}: no templates`); },
    downloadMedia: async () => ({ bytes: Buffer.from('x'), contentType: 'image/jpeg' }),
    webhookHandler: () => (_req, res) => res.status(200).end(),
  };
}

// The real adapters stay registered for the address/registry tests; the fakes replace them only
// inside withChannels() and are always put back.
const realLine = channels.get('line');
const realWhatsapp = channels.get('whatsapp');
async function withChannels(fakes, fn) {
  for (const f of fakes) channels.register(f);
  try {
    return await fn();
  } finally {
    channels.register(realWhatsapp);
    if (realLine) channels.register(realLine);
  }
}

// ── address.js ──────────────────────────────────────────────────────

test('address: normalise both forms; whatsapp: prefix stripped, line: prefix canonical', () => {
  assert.equal(address.normalizeAddress('whatsapp:+66812345678'), '+66812345678');
  assert.equal(address.normalizeAddress(' WhatsApp:+66812345678 '), '+66812345678');
  assert.equal(address.normalizeAddress('+66812345678'), '+66812345678');
  assert.equal(address.normalizeAddress('LINE:Uabc123 '), 'line:Uabc123');
  assert.equal(address.normalizeAddress('line: Uabc123'), 'line:Uabc123');
  assert.equal(address.normalizeAddress(''), null);
  assert.equal(address.normalizeAddress(null), null);
  // users.normalizePhone is the same function under its old name.
  assert.equal(users.normalizePhone('whatsapp:+66812345678'), '+66812345678');
  assert.equal(users.normalizePhone('line:U1'), 'line:U1');
});

test('address: channelOf / channelIdOf / lineAddress', () => {
  assert.equal(address.channelOf('whatsapp:+66812345678'), 'whatsapp');
  assert.equal(address.channelOf('+66812345678'), 'whatsapp');
  assert.equal(address.channelOf('line:Uabc'), 'line');
  assert.equal(address.channelOf(''), null);
  assert.equal(address.channelIdOf('line:Uabc'), 'Uabc');
  assert.equal(address.channelIdOf('whatsapp:+6681'), '+6681');
  assert.equal(address.lineAddress(' Uabc '), 'line:Uabc');
});

test('address: masking keeps the last 4 characters only, for both forms', () => {
  assert.equal(address.maskAddress('+66812345678'), '…5678');
  assert.equal(address.maskAddress('whatsapp:+66812345678'), '…5678');
  assert.equal(address.maskAddress('line:U4af4980629abcd'), 'line:…abcd');
  // onboarding.maskPhone (operator logs) is built on it; empty stays '?'.
  assert.equal(onboarding.maskPhone('+66812345678'), '…5678');
  assert.equal(onboarding.maskPhone('line:U4af4980629abcd'), 'line:…abcd');
  assert.equal(onboarding.maskPhone(''), '?');
  assert.ok(!onboarding.maskPhone('line:U4af4980629abcd').includes('4af498'));
});

// ── registry ────────────────────────────────────────────────────────

test('registry: forAddress routes by address; unknown / invalid addresses throw', async () => {
  assert.equal(channels.forAddress('+66812345678').name, 'whatsapp');
  assert.equal(channels.forAddress('whatsapp:+66812345678').name, 'whatsapp');
  assert.equal(channels.get('whatsapp').webhookPath, '/webhook');
  assert.equal(channels.get('whatsapp').supportsTemplates, true);
  assert.throws(() => channels.forAddress(''), /no channel for address \(invalid\)/);

  const line = fakeChannel('line');
  await withChannels([line], () => {
    assert.equal(channels.forAddress(LINE_USER), line);
    assert.equal(channels.forAddress('+66812345678').name, 'whatsapp');
    assert.ok(channels.configured().includes(line));
  });
});

test('registry: the Twilio channel is configured only with SID + token + a sender', () => {
  const wa = channels.get('whatsapp');
  assert.equal(wa.isConfigured({}), false);
  assert.equal(wa.isConfigured({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' }), false);
  assert.equal(wa.isConfigured({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_NUMBER_SANDBOX: 'whatsapp:+1' }), true);
  assert.equal(wa.isConfigured({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_WHATSAPP_NUMBER: 'whatsapp:+1' }), false);
});

// ── Twilio inbound conversion ───────────────────────────────────────

test('twilio inbound: text only → normalised message, whatsapp: prefix stripped', async () => {
  const form = { From: 'whatsapp:+66812345678', Body: 'paid 50 for coffee', NumMedia: '0' };
  assert.deepEqual(await twilioAdapter.inboundFromTwilio(form), {
    channel: 'whatsapp', from: '+66812345678', body: 'paid 50 for coffee', media: [], contacts: [], raw: form,
  });
});

test('twilio inbound: a missing or blank From is dropped (null), never the address "unknown"', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (const form of [{}, { Body: 'hi', NumMedia: '0' }, { From: '', Body: 'hi' }, { From: '   ', Body: 'hi' }, { From: 'whatsapp:', Body: 'hi' }]) {
      assert.equal(await twilioAdapter.inboundFromTwilio(form), null, JSON.stringify(form));
    }
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 5, 'one line per dropped message');
  assert.ok(errors.every((e) => /no From address/.test(e)), errors.join('\n'));
});

test('twilio inbound: two media items keep order; content types normalised; ref = MediaUrl', async () => {
  const form = {
    From: 'whatsapp:+66812345678', Body: 'two receipts', NumMedia: '2',
    MediaContentType0: 'image/JPEG', MediaUrl0: `${TW}/ME0`,
    MediaContentType1: 'audio/ogg; codecs=opus', MediaUrl1: `${TW}/ME1`,
  };
  const m = await twilioAdapter.inboundFromTwilio(form);
  assert.deepEqual(m.media, [
    { contentType: 'image/jpeg', ref: `${TW}/ME0`, url: `${TW}/ME0` },
    { contentType: 'audio/ogg', ref: `${TW}/ME1`, url: `${TW}/ME1` },
  ]);
  assert.deepEqual(m.contacts, []);
});

test('twilio inbound: a vCard is downloaded, parsed into contacts and removed from media', async () => {
  const card = 'BEGIN:VCARD\nFN:Jameel Crest Gems\nTEL:+66 81 234 5678\nEMAIL:j@crest.example\nEND:VCARD';
  const fetched = [];
  download._setDownloaderForTests(async (url) => { fetched.push(url); return Buffer.from(url.endsWith('vcf') ? card : 'jpeg'); });
  try {
    const m = await twilioAdapter.inboundFromTwilio({
      From: 'whatsapp:+66812345678', Body: '', NumMedia: '2',
      MediaContentType0: 'image/jpeg', MediaUrl0: `${TW}/photo`,
      MediaContentType1: 'text/x-vcard', MediaUrl1: `${TW}/card.vcf`,
    });
    assert.deepEqual(fetched, [`${TW}/card.vcf`], 'only the vCard is fetched at conversion; photos wait for media intake');
    assert.deepEqual(m.media, [{ contentType: 'image/jpeg', ref: `${TW}/photo`, url: `${TW}/photo` }]);
    assert.deepEqual(m.contacts, [{ name: 'Jameel Crest Gems', phone: '+66812345678', email: 'j@crest.example', org: null }]);
  } finally {
    download._setDownloaderForTests(null);
  }
});

test('twilio channel downloadMedia: goes through the Twilio downloader, returns { bytes, contentType }', async () => {
  const seen = [];
  download._setDownloaderForTests(async (url) => { seen.push(url); return Buffer.from('abc'); });
  try {
    const r = await channels.get('whatsapp').downloadMedia({ contentType: 'image/png', ref: `${TW}/ME9` });
    assert.deepEqual(seen, [`${TW}/ME9`]);
    assert.equal(r.bytes.toString(), 'abc');
    assert.equal(r.contentType, 'image/png');
  } finally {
    download._setDownloaderForTests(null);
  }
});

test('twilio channel sends call through src/twilio-client at call time (test stubs intercept)', async () => {
  const twilioClient = require('../src/twilio-client');
  const real = twilioClient.sendText;
  const calls = [];
  twilioClient.sendText = async (to, text) => { calls.push([to, text]); return 'SMx'; };
  try {
    assert.equal(await channels.forAddress('+66812345678').sendText('+66812345678', 'hi'), 'SMx');
  } finally {
    twilioClient.sendText = real;
  }
  assert.deepEqual(calls, [['+66812345678', 'hi']]);
});

// ── routing through whatsapp.js / onboarding / jobs (fake LINE) ─────

const erp = new FakeErpNext();
let handled;

before(async () => {
  erp.install();
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  conversation.handle = async (u, text) => {
    handled.push(text);
    return { text: 'ok', isConfirmation: false };
  };
});

beforeEach(() => {
  handled = [];
});

after(() => {
  channels.register(realWhatsapp);
  if (realLine) channels.register(realLine);
});

async function makeUser(phone, extra = {}) {
  const now = new Date().toISOString();
  const cols = {
    phone, display_name: 'Line Co', erpnext_company: COMPANY, erpnext_api_key: 'k', erpnext_api_secret: 's',
    default_currency: 'THB', reporting_currency: 'THB', country: 'TH', created_at: now, updated_at: now, ...extra,
  };
  const keys = Object.keys(cols);
  const r = await db.query(
    `INSERT INTO users (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k])
  );
  return r.rows[0];
}

const lineMsg = (from, body) => ({ channel: 'line', from, body, media: [], contacts: [], raw: null });

test('unknown line:U1 goes through onboarding and every reply goes out via the LINE channel', async () => {
  const line = fakeChannel('line');
  const wa = fakeChannel('whatsapp');
  const logs = [];
  const realLog = console.log;
  await withChannels([line, wa], async () => {
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await processIncomingMessage(lineMsg(LINE_USER, 'hello'));
      await processIncomingMessage(lineMsg(LINE_USER, 'Siam Line Gems'));
    } finally {
      console.log = realLog;
    }
  });
  assert.equal(wa.sent.length, 0, 'nothing over WhatsApp');
  assert.deepEqual(line.sent.map((s) => [s.kind, s.to]), [['text', LINE_USER], ['text', LINE_USER]]);
  assert.ok(line.sent[0].args[0].startsWith(M.WELCOME));
  assert.ok(line.sent[1].args[0].startsWith(M.PROMPTS.country));

  const session = (await db.query('SELECT * FROM onboarding_sessions WHERE phone = $1', [LINE_USER])).rows[0];
  assert.equal(session.step, 'country');
  assert.equal(session.source, 'line', 'self-serve source = the channel they came in on');
  assert.equal((await db.query('SELECT msg_count FROM onboarding_rate_limits WHERE phone = $1', [LINE_USER])).rows[0].msg_count, 2);
  const started = logs.find((l) => l.includes('session started'));
  assert.ok(started.includes('phone=line:…U1'), started);
  assert.equal(handled.length, 0, 'no LLM turn during onboarding');
});

test('a registered LINE user: chitchat-free text reaches the conversation; reply + confirmation via LINE', async () => {
  const u = await makeUser('line:Uregistered01');
  const line = fakeChannel('line');
  conversation.handle = async (_u, text) => {
    handled.push(text);
    return { text: 'Confirm: paid 50 for coffee?', isConfirmation: true };
  };
  try {
    await withChannels([line], () => processIncomingMessage(lineMsg('line:Uregistered01', 'paid 50 for coffee')));
  } finally {
    conversation.handle = async (_u, text) => {
      handled.push(text);
      return { text: 'ok', isConfirmation: false };
    };
  }
  assert.deepEqual(handled, ['paid 50 for coffee']);
  assert.deepEqual(line.sent.map((s) => [s.kind, s.to, s.args[0]]), [['confirmation', 'line:Uregistered01', 'Confirm: paid 50 for coffee?']]);
  assert.ok(u.id);
});

test('scheduler: deps.channel follows the user address; digest for a line: user is a plain sendText push', async () => {
  const waUser = await makeUser('+66700');
  const lnUser = await makeUser('line:Udigest01');
  await db.query(`UPDATE users SET subscription_status = 'active' WHERE id IN ($1, $2)`, [waUser.id, lnUser.id]);
  // Something to report: one bank balance.
  erp.create('Account', { account_name: 'BBL Savings', parent_account: '1200 - Bank Accounts - TC', account_type: 'Bank' });
  erp.create('Journal Entry', {
    docstatus: 1, posting_date: '2026-01-01', accounts: [
      { account: 'BBL Savings - TC', debit_in_account_currency: 50000 },
      { account: '3300 - Opening Balance Equity - TC', credit_in_account_currency: 50000 },
    ],
  });
  // Window check would skip WhatsApp free-form; the template path is used there instead.
  process.env.TWILIO_DIGEST_CONTENT_SID = 'HXdigest';
  const line = fakeChannel('line');
  const wa = fakeChannel('whatsapp');
  const now = new Date();
  // Make the digest due right now in the users' (default Bangkok) timezone.
  const dueDigest = { ...digest, defaultTime: localClock(now, 'Asia/Bangkok').time };
  const seen = [];
  const probe = { name: 'probe', defaultTime: dueDigest.defaultTime, run: async (user, deps) => { seen.push([user.phone, deps.channel.name, deps.twilio === deps.channel]); return { skipped: true }; } };
  let out;
  try {
    out = await withChannels([line, wa], () => scheduler.runDue({ now, jobs: [probe, dueDigest] }));
  } finally {
    delete process.env.TWILIO_DIGEST_CONTENT_SID;
  }
  const mine = out.filter((r) => [waUser.id, lnUser.id].includes(r.user_id) && r.job === 'digest');
  assert.deepEqual(mine.map((r) => r.status), ['ok', 'ok'], JSON.stringify(out));
  assert.deepEqual(seen.filter(([p]) => ['+66700', 'line:Udigest01'].includes(p)), [
    ['+66700', 'whatsapp', true], ['line:Udigest01', 'line', true],
  ]);

  // (Other active users from earlier tests get their digest too; look at ours.)
  const toLine = line.sent.filter((s) => s.to === 'line:Udigest01');
  assert.deepEqual(toLine.map((s) => s.kind), ['text'], 'LINE: text push, no template');
  assert.match(toLine[0].args[0], /^Your books, /);
  assert.ok(line.sent.every((s) => s.kind === 'text'));
  assert.deepEqual(wa.sent.filter((s) => s.to === '+66700').map((s) => s.kind), ['template'], 'WhatsApp: the approved template');

  // job_runs: the LINE push is recorded as sent with its id.
  const row = (await db.query(`SELECT * FROM job_runs WHERE user_id = $1 AND job = 'digest'`, [lnUser.id])).rows[0];
  assert.equal(row.status, 'ok');
  assert.match(row.message_sid, /^line-\d+$/);
  assert.equal(JSON.parse(row.result).via, 'push');
});

test('reminders never use the owner\'s LINE channel: customer outreach is WhatsApp-only', async () => {
  const reminders = require('../src/jobs/reminders.job');
  const line = fakeChannel('line');
  const notConfigured = { ...fakeChannel('whatsapp'), isConfigured: () => false };
  const r = await withChannels([line, notConfigured], () => reminders.run(
    { id: 1, reminders_enabled: 1, phone: 'line:Uowner' },
    { erp: {}, channel: line, twilio: line, now: new Date() }
  ));
  assert.equal(r.skipped, true);
  assert.match(r.note, /WhatsApp channel not configured/);
  assert.equal(line.sent.length, 0);
});

// ── review hardening ────────────────────────────────────────────────

test('twilio: a LINE address never becomes "whatsapp:line:…" — normalizeWhatsappAddress refuses it', () => {
  const n = twilioAdapter.normalizeWhatsappAddress;
  assert.equal(n('+66812345678'), 'whatsapp:+66812345678');
  assert.equal(n('whatsapp:+66812345678'), 'whatsapp:+66812345678');
  for (const a of ['line:U1', 'LINE:U1', ' Line:U1 ', 'whatsapp:line:U1', 'WhatsApp:LINE:U1', '', null]) {
    assert.equal(n(a), null, String(a));
  }
  assert.equal(address.normalizeAddress('whatsapp:line:U1'), 'line:U1');
  assert.equal(address.normalizeAddress('LINE:U1'), 'line:U1');
  assert.equal(address.channelOf('whatsapp:line:U1'), 'line');
});

test('twilio sender: every send refuses a line: address before calling Twilio', async () => {
  // Credentials present (the SDK client is built, no network until messages.create).
  const s = twilioAdapter.createSender({
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_NUMBER_SANDBOX: 'whatsapp:+14155238886',
    TWILIO_CONFIRMATION_CONTENT_SID: 'HXconf',
  });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal(await s.sendText('line:U1', 'hi'), null);
    assert.equal(await s.sendText('whatsapp:line:U1', 'hi'), null);
    assert.equal(await s.sendConfirmation('line:U1', 'Confirm?'), null);
    const m = await s.sendMedia('LINE:U1', 'hi', ['https://x.example/a.pdf']);
    assert.deepEqual(m.sids, []);
    assert.equal(m.errors[0].code, 'not_whatsapp');
    await assert.rejects(s.sendTemplate('line:U1', 'HXdigest', {}), (e) => e.code === 'TWILIO_NOT_WHATSAPP');
  } finally {
    console.error = realError;
  }
  assert.equal(errors.filter((e) => /not a WhatsApp address/.test(e)).length, 4, errors.join('\n'));
  assert.ok(!errors.some((e) => /failed to send/.test(e)), 'messages.create was never reached');
});

test('twilio inbound: a From that normalises to a LINE address is dropped before any download', async () => {
  const fetched = [];
  download._setDownloaderForTests(async (url) => { fetched.push(url); return Buffer.from('BEGIN:VCARD\nFN:X\nEND:VCARD'); });
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(await twilioAdapter.inboundFromTwilio({
      From: 'whatsapp:line:U1', Body: 'hi', NumMedia: '1', MediaContentType0: 'text/vcard', MediaUrl0: `${TW}/c.vcf`,
    }), null);
    // And the webhook (unsigned dev mode) drops it: processMessage never runs.
    const processed = [];
    const handler = require('../src/webhook').webhookHandler({ processMessage: (m) => processed.push(m), url: null, production: false });
    const res = { set() { return this; }, send() { return this; }, status() { return this; } };
    await handler({ body: { From: 'whatsapp:LINE:U1', Body: 'hi', NumMedia: '0' } }, res);
    assert.deepEqual(processed, []);
  } finally {
    console.error = realError;
    download._setDownloaderForTests(null);
  }
  assert.deepEqual(fetched, []);
});

test('twilio inbound: an UNKNOWN sender\'s vCard on a non-Twilio host is never fetched (allowlist)', async () => {
  download._setDownloaderForTests(null); // the real downloader
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return new Response('BEGIN:VCARD\nFN:Evil\nEND:VCARD'); };
  const realError = console.error;
  console.error = () => {};
  try {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://attacker.example/x.vcf', 'https://api.twilio.com.evil.example/x', 'https://user:pw@api.twilio.com/x']) {
      const m = await twilioAdapter.inboundFromTwilio({
        From: 'whatsapp:+66999000111', Body: '', NumMedia: '1', MediaContentType0: 'text/x-vcard', MediaUrl0: url,
      });
      assert.deepEqual(m.contacts, [], url);
      assert.deepEqual(m.media, [], url);
    }
  } finally {
    global.fetch = realFetch;
    console.error = realError;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  }
  assert.deepEqual(calls, [], 'nothing was fetched');
  assert.equal(await users.findByPhone('+66999000111'), null);
});

test('LINE user over the REAL whatsapp channel: nothing reaches twilioClient (call count 0)', async () => {
  const twilioClient = require('../src/twilio-client');
  const saved = { ...twilioClient };
  const calls = [];
  for (const fn of ['sendText', 'sendConfirmation', 'sendMedia', 'sendTemplate']) {
    twilioClient[fn] = async (...a) => { calls.push([fn, ...a]); return 'SMx'; };
  }
  const line = fakeChannel('line');
  await makeUser('line:Ucount01');
  try {
    // Only the LINE fake is swapped in: 'whatsapp' stays the real adapter (calling twilioClient).
    await withChannels([line], async () => {
      await processIncomingMessage(lineMsg('line:Ucount01', 'paid 50 for coffee'));
      await processIncomingMessage(lineMsg('line:Unewcomer01', 'hello'));
    });
  } finally {
    Object.assign(twilioClient, saved);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(line.sent.map((s) => s.to), ['line:Ucount01', 'line:Unewcomer01']);
});

test('onboarding: a greeting mid-signup (LINE follow → "hi") re-asks instead of becoming the answer', async () => {
  const P = 'line:Ugreet01';
  const line = fakeChannel('line');
  await withChannels([line], async () => {
    await processIncomingMessage(lineMsg(P, 'hello'));
    for (const g of ['hi', 'Hello!', 'hey', 'สวัสดี']) await processIncomingMessage(lineMsg(P, g));
  });
  const session = (await db.query('SELECT * FROM onboarding_sessions WHERE phone = $1', [P])).rows[0];
  assert.equal(session.step, 'name');
  assert.equal(JSON.parse(session.answers).name, undefined);
  for (const s of line.sent.slice(1)) assert.ok(s.args[0].startsWith(M.PROMPTS.name), s.args[0]);
  // At a later step too.
  await withChannels([line], async () => {
    await processIncomingMessage(lineMsg(P, 'Greeting Gems'));
    await processIncomingMessage(lineMsg(P, 'hi'));
  });
  assert.equal((await db.query('SELECT step FROM onboarding_sessions WHERE phone = $1', [P])).rows[0].step, 'country');
  assert.ok(line.sent.at(-1).args[0].startsWith(M.PROMPTS.country));
});

test('onboarding on LINE: the consent notice names the LINE user ID, not a WhatsApp number; version records it', async () => {
  assert.ok(M.CONSENT_NOTICE.includes('your WhatsApp number'), 'the WhatsApp text is unchanged');
  assert.ok(M.consentNotice('line').includes('your LINE user ID'));
  assert.ok(!/WhatsApp/.test(M.consentNotice('line')));
  assert.ok(!/WhatsApp/.test(M.WELCOME));
  const P = 'line:Uconsent01';
  const line = fakeChannel('line');
  await withChannels([line], async () => {
    for (const b of ['hello', 'Consent Gems', 'skip', 'no', 'skip', 'skip']) await processIncomingMessage(lineMsg(P, b));
    assert.ok(line.sent.at(-1).args[0].startsWith(M.consentNotice('line')), line.sent.at(-1).args[0]);
    await processIncomingMessage(lineMsg(P, 'I agree'));
  });
  const u = await users.findByPhone(P);
  assert.equal(u.consent_version, `${M.CONSENT_VERSION}-line`);
  assert.equal(u.onboarding_source, 'line');
  assert.equal(M.consentVersion('whatsapp'), M.CONSENT_VERSION);
});

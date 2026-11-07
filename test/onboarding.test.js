/**
 * In-chat onboarding (src/onboarding), account replies for registered users, provisioning
 * (scripts/provision-user.js against test/fake-erpnext.js), and HEIC photo intake
 * (src/media/heic.js). Drives whatsapp.processIncomingMessage with Twilio sends,
 * conversation.handle and OpenAI stubbed, so nothing touches the network.
 *
 *   npm test
 */
delete process.env.OPENAI_API_KEY;
delete process.env.MEDIA_MAX_BYTES;
delete process.env.ONBOARDING_MODE;
delete process.env.ONBOARDING_INVITE_CODES;
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const db = require('../src/db');
const conversation = require('../src/conversation');
const twilioClient = require('../src/twilio-client');
const { processIncomingMessage } = require('../src/whatsapp');
const onboarding = require('../src/onboarding');
const M = require('../src/onboarding/messages');
const provision = require('../scripts/provision-user');
const { FakeErpNext, COMPANY } = require('./fake-erpnext');
const mediaIntake = require('../src/media');
const download = require('../src/media/download');
const heic = require('../src/media/heic');
const { _setClientForTests } = require('../src/media/openai-client');
const { RETENTION_DAYS } = require('../src/media/store');

/** An OpenAI stub that records every call: onboarding / account replies must never make one. */
let openaiCalls = 0;
function trapOpenAI() {
  openaiCalls = 0;
  const trap = async () => { openaiCalls++; throw new Error('OpenAI must not be called here'); };
  _setClientForTests({ chat: { completions: { create: trap } }, audio: { transcriptions: { create: trap } } });
}

/** Run fn with console.log captured; returns the captured lines. */
async function captureLogs(fn) {
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = realLog;
  }
  return logs;
}

let sent; // [{ to, text }]
let handled; // bodies that reached conversation.handle

before(async () => {
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  conversation.handle = async (u, text) => {
    handled.push(text);
    return { text: 'ok', isConfirmation: false };
  };
  twilioClient.sendText = async (to, text) => {
    sent.push({ to, text });
    return 'SM1';
  };
  twilioClient.sendConfirmation = twilioClient.sendText;
});

beforeEach(() => {
  sent = [];
  handled = [];
  trapOpenAI();
  process.env.ONBOARDING_MODE = 'open';
  delete process.env.ONBOARDING_INVITE_CODES;
});

/** Send one message from `phone`; the reply text, or null when the bot stayed silent. */
async function say(phone, body, raw = null) {
  const before = sent.length;
  await processIncomingMessage({ from: `whatsapp:${phone}`, body, raw: raw || { Body: body, NumMedia: '0' } });
  assert.ok(sent.length - before <= 1, 'at most one reply per message');
  return sent.length > before ? sent[sent.length - 1].text : null;
}

async function session(phone) {
  return (await db.query('SELECT * FROM onboarding_sessions WHERE phone = $1', [phone])).rows[0] || null;
}

async function userByPhone(phone) {
  return (await db.query('SELECT * FROM users WHERE phone = $1', [phone])).rows[0] || null;
}

async function insertUser(phone, extra = {}) {
  const now = new Date().toISOString();
  const cols = {
    phone, display_name: 'Existing Co', erpnext_company: COMPANY, erpnext_api_key: 'k', erpnext_api_secret: 's',
    default_currency: 'THB', reporting_currency: 'THB', country: 'TH', created_at: now, updated_at: now, ...extra,
  };
  const keys = Object.keys(cols);
  const r = await db.query(
    `INSERT INTO users (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k])
  );
  return r.rows[0];
}

// ── onboarding ────────────────────────────────────────────────────────

test('happy path: every step, retries on bad answers, users row pending_provisioning', async () => {
  const P = '+66810000001';
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    let r = await say(P, 'hi');
    assert.ok(r.startsWith(M.WELCOME), r);
    assert.ok(r.includes(M.PROMPTS.name));
    assert.equal((await session(P)).source, 'whatsapp');

    assert.ok((await say(P, 'Siam Gems Co., Ltd.')).startsWith(M.PROMPTS.country));
    assert.ok((await say(P, 'Atlantis')).startsWith(M.RETRY.country));
    assert.ok((await say(P, 'thailand')).startsWith(M.PROMPTS.vat));
    assert.ok((await say(P, 'maybe')).startsWith(M.RETRY.vat));
    assert.ok((await say(P, 'Yes')).startsWith(M.PROMPTS.tax_id_th));
    assert.ok((await say(P, '0105555012345')).startsWith(M.RETRY.tax_id_th), 'bad check digit is refused');
    assert.ok((await say(P, '0-1055-55012-34-8')).startsWith(M.PROMPTS.accountant_name));
    r = await say(P, 'Khun Somchai');
    assert.ok(r.startsWith(M.PROMPTS.accountant_phone('Khun Somchai')), r);
    assert.ok((await say(P, 'call me')).startsWith(M.RETRY.accountant_phone));
    r = await say(P, '089 765 4321');
    assert.ok(r.startsWith(M.CONSENT_NOTICE));
    assert.match(r, /delete my account/);
    assert.ok(r.includes(`deleted within ${RETENTION_DAYS} days`), 'notice states the real receipt retention');
    assert.doesNotMatch(r, /90 days/);
    assert.ok((await say(P, 'sure')).startsWith(M.RETRY.consent));
    assert.equal(await say(P, 'I agree'), M.COMPLETED);
  } finally {
    console.log = realLog;
  }

  assert.equal(await session(P), null, 'session removed on completion');
  const u = await userByPhone(P);
  assert.equal(u.display_name, 'Siam Gems Co., Ltd.');
  assert.equal(u.country, 'TH');
  assert.equal(u.default_currency, 'THB');
  assert.equal(u.reporting_currency, 'THB');
  assert.equal(u.timezone, 'Asia/Bangkok');
  assert.equal(Number(u.vat_registered), 1);
  assert.equal(u.tax_id, '0105555012348');
  assert.equal(u.subscription_status, 'pending_provisioning');
  assert.equal(u.subscription_expires_at, null);
  assert.equal(u.erpnext_company, null);
  assert.equal(u.accountant_name, 'Khun Somchai');
  assert.equal(u.accountant_phone, '+66897654321');
  assert.equal(u.consent_version, M.CONSENT_VERSION);
  assert.equal(M.CONSENT_VERSION, '2026-11-pdpa-v2');
  assert.ok(u.consent_at);
  assert.equal(u.onboarding_source, 'whatsapp');

  const line = logs.find((l) => l.includes('[onboarding] NEW USER pending provisioning'));
  assert.ok(line, 'operator log line');
  assert.match(line, new RegExp(`id=${u.id} name="Siam Gems Co\\., Ltd\\."`));
  assert.ok(line.includes('…0001'));
  assert.ok(!line.includes('66810000001'), 'no full phone in the operator line');

  // Tax ID and accountant answers never reach the log (inbound masked, prompts don't echo the name).
  const all = logs.join('\n');
  for (const secret of ['0105555012345', '0-1055-55012-34-8', '0105555012348', 'Somchai', '089 765 4321', '+66897654321', 'call me']) {
    assert.ok(!all.includes(secret), `${secret} not logged`);
  }
  assert.ok(logs.some((l) => l.startsWith('↓') && l.endsWith('[onboarding step 4 answer]')));
  assert.ok(logs.some((l) => l.startsWith('↓') && l.endsWith('[onboarding step 5 answer]')));
  assert.ok(logs.some((l) => l.startsWith('↓') && l.endsWith('Siam Gems Co., Ltd.')), 'other steps are logged as before');
  assert.ok(logs.some((l) => l.startsWith('↑') && l.includes("your accountant's phone number")));

  // Registered but not provisioned: fixed reply, never the LLM.
  assert.equal(await say(P, 'paid 500 for lunch'), M.PENDING_PROVISIONING);
  assert.equal(await say(P, '', { NumMedia: '1', MediaContentType0: 'image/jpeg', MediaUrl0: `${TW}/p1` }), M.PENDING_PROVISIONING);
  assert.deepEqual(handled, []);
  assert.equal(openaiCalls, 0, 'no OpenAI call for an unknown or pending user');
});

test('registered users: inbound bodies are still logged in full', async () => {
  const P = '+66810000013';
  await insertUser(P);
  const logs = await captureLogs(() => say(P, 'paid 77 for noodles'));
  assert.ok(logs.some((l) => l.startsWith('↓') && l.endsWith('paid 77 for noodles')));
});

test('names: length cap, < >, emoji-only and very long input are refused; SQL-ish text is stored as-is', async () => {
  const P = '+66810000014';
  await say(P, 'hi');
  for (const bad of ['x'.repeat(81), 'a'.repeat(5000), '<b>Shop</b>', '🍜🍜🍜', '!!', 'A']) {
    assert.ok((await say(P, bad)).startsWith(M.RETRY.name), bad.slice(0, 20));
  }
  assert.equal((await session(P)).step, 'name');
  const sqlish = "Bobby'); DROP TABLE users;--";
  assert.ok((await say(P, sqlish)).startsWith(M.PROMPTS.country));
  assert.equal(JSON.parse((await session(P)).answers).name, sqlish);
  assert.equal(onboarding.parseName('y'.repeat(80)), 'y'.repeat(80), '80 characters is the cap, inclusive');
  assert.equal(onboarding.parseName('ร้านทอง เยาวราช'), 'ร้านทอง เยาวราช');
  assert.equal(onboarding.parseName('🍜 Noodle 88'), '🍜 Noodle 88');
  // Accountant name has the same rules.
  await say(P, 'back'); await say(P, 'back');
  await say(P, 'Shop'); await say(P, 'TH'); await say(P, 'no'); await say(P, 'skip');
  assert.ok((await say(P, 'z'.repeat(81))).startsWith(M.RETRY.accountant_name));
  await say(P, 'cancel');
});

test('consent: only the agree tokens complete; a refusal ends the signup and keeps nothing', async () => {
  const P = '+66810000015';
  for (const m of ['hi', 'Refuser Co', 'TH', 'no', 'skip', 'skip']) await say(P, m);
  assert.equal((await session(P)).step, 'consent');
  for (const notYet of ['yes', 'ok', 'agreed?', 'I agree to nothing']) assert.ok((await say(P, notYet)).startsWith(M.RETRY.consent), notYet);
  assert.equal(await say(P, "I don't agree"), M.CONSENT_REFUSED);
  assert.equal(await session(P), null);
  assert.equal(await userByPhone(P), null);

  const P2 = '+66810000016';
  for (const m of ['hi', 'Agree Co', 'TH', 'no', 'skip', 'skip']) await say(P2, m);
  assert.equal(await say(P2, '  I Agree! '), M.COMPLETED);
  const u = await userByPhone(P2);
  assert.ok(Math.abs(Date.parse(u.consent_at) - Date.now()) < 60000);
  assert.equal(u.consent_version, M.CONSENT_VERSION);
});

test('an abandoned session expires: the next message starts over, the old answers are gone', async () => {
  const P = '+66810000017';
  for (const m of ['hi', 'Old Co', 'TH', 'yes', '0994000165315']) await say(P, m);
  assert.equal((await session(P)).step, 'accountant_name');
  const old = new Date(Date.now() - (onboarding.SESSION_TTL_DAYS + 1) * 86400000).toISOString();
  await db.query('UPDATE onboarding_sessions SET updated_at = $1 WHERE phone = $2', [old, P]);
  assert.ok((await say(P, 'hello again')).startsWith(M.WELCOME));
  const s2 = await session(P);
  assert.equal(s2.step, 'name');
  assert.equal(s2.answers, '{}');
});

test('other country: currency from the map, free-form tax number, skipping the accountant', async () => {
  const P = '+60120000002';
  await say(P, 'hello');
  await say(P, 'Kedai Runcit');
  assert.ok((await say(P, 'MY')).startsWith(M.PROMPTS.vat));
  assert.ok((await say(P, 'no')).startsWith(M.PROMPTS.tax_id_other));
  assert.ok((await say(P, '123')).startsWith(M.RETRY.tax_id_other));
  assert.ok((await say(P, ' 201901234567 ')).startsWith(M.PROMPTS.accountant_name));
  assert.ok((await say(P, 'skip')).startsWith(M.CONSENT_NOTICE), 'skipping the accountant skips the phone');
  assert.equal(await say(P, 'ตกลง'), M.COMPLETED);
  const u = await userByPhone(P);
  assert.deepEqual(
    [u.country, u.default_currency, u.reporting_currency, Number(u.vat_registered), u.tax_id, u.accountant_name, u.accountant_phone],
    ['MY', 'MYR', 'MYR', 0, '201901234567', null, null]
  );
});

test('back returns to the previous question; cancel wipes the session', async () => {
  const P = '+66810000003';
  await say(P, 'hi');
  assert.ok((await say(P, 'back')).startsWith(M.PROMPTS.name), 'back on the first step re-asks it');
  await say(P, 'First Name');
  assert.ok((await say(P, 'BACK')).startsWith(M.PROMPTS.name));
  await say(P, 'Second Name');
  await say(P, 'SG');
  assert.ok((await say(P, 'back')).startsWith(M.PROMPTS.country));
  await say(P, 'skip'); // → TH
  await say(P, 'no');
  await say(P, 'skip'); // tax id
  await say(P, 'skip'); // accountant → consent
  assert.ok((await say(P, 'back')).startsWith(M.PROMPTS.accountant_name), 'back from consent skips the unasked phone step');
  let s = await session(P);
  assert.equal(s.step, 'accountant_name');
  assert.deepEqual(JSON.parse(s.answers), { name: 'Second Name', country: 'TH', vat_registered: 0, tax_id: null, accountant_name: null, accountant_phone: null });

  assert.equal(await say(P, 'Cancel'), M.CANCELLED);
  assert.equal(await session(P), null);
  assert.equal(await userByPhone(P), null);

  // A fresh start afterwards.
  assert.ok((await say(P, 'hi')).startsWith(M.WELCOME));
  s = await session(P);
  assert.equal(s.step, 'name');
  assert.equal(s.answers, '{}');
});

test('closed mode: invite-only reply unless the message is an invite code (case-insensitive)', async () => {
  process.env.ONBOARDING_MODE = 'closed';
  process.env.ONBOARDING_INVITE_CODES = ' PILOT-2026 , Gems ';
  const P = '+66810000004';
  assert.equal(await say(P, 'hi'), M.INVITE_ONLY);
  assert.equal(await say(P, 'pilot'), M.INVITE_ONLY);
  assert.equal(await session(P), null);
  assert.ok((await say(P, 'gems')).startsWith(M.WELCOME));
  assert.equal((await session(P)).source, 'invite:Gems');
  // Once started, the session continues normally.
  assert.ok((await say(P, 'Gem Traders')).startsWith(M.PROMPTS.country));

  const P2 = '+66810000044';
  assert.ok((await say(P2, 'pilot-2026')).startsWith(M.WELCOME));
  assert.equal((await session(P2)).source, 'invite:PILOT-2026');
  // Sending the code again mid-flow re-asks the question instead of becoming the business name.
  assert.ok((await say(P2, ' PILOT-2026 ')).startsWith(M.PROMPTS.name));
  assert.equal((await session(P2)).step, 'name');

  // A code inside a sentence starts the signup too (whole word only).
  const P3 = '+66810000045';
  assert.equal(await say(P3, 'my code is gemstone'), M.INVITE_ONLY);
  assert.ok((await say(P3, 'Hi, my invite code is "GEMS".')).startsWith(M.WELCOME));
  assert.equal((await session(P3)).source, 'invite:Gems');
  // Mid-flow only the bare code is treated as a re-send: a name containing it is an answer.
  assert.ok((await say(P3, 'Gems Trading')).startsWith(M.PROMPTS.country));
});

test('default mode: closed in production, open otherwise', () => {
  const env = process.env.NODE_ENV;
  try {
    delete process.env.ONBOARDING_MODE;
    process.env.NODE_ENV = 'production';
    assert.equal(onboarding.mode(), 'closed');
    process.env.NODE_ENV = 'development';
    assert.equal(onboarding.mode(), 'open');
    process.env.ONBOARDING_MODE = 'OPEN';
    process.env.NODE_ENV = 'production';
    assert.equal(onboarding.mode(), 'open');
  } finally {
    if (env == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
});

test('rate limit: 20 messages per unknown phone per day, then silence', async () => {
  process.env.ONBOARDING_MODE = 'closed';
  const P = '+66810000005';
  for (let i = 0; i < onboarding.DAILY_LIMIT; i++) assert.equal(await say(P, `hello ${i}`), M.INVITE_ONLY);
  assert.equal(await say(P, 'hello?'), null);
  assert.equal(await say(P, 'anyone?'), null);
  // Other phones are unaffected.
  assert.equal(await say('+66810000055', 'hi'), M.INVITE_ONLY);
  // A new day resets the count (rows are keyed by UTC day).
  await db.query(`UPDATE onboarding_rate_limits SET day = '2000-01-01' WHERE phone = $1`, [P]);
  assert.equal(await say(P, 'hi again'), M.INVITE_ONLY);
  const days = (await db.query('SELECT day FROM onboarding_rate_limits WHERE phone = $1', [P])).rows.map((r) => r.day);
  assert.equal(days.length, 1, 'the old day was pruned');
  // Silence means no Twilio call at all.
  for (let i = 1; i < onboarding.DAILY_LIMIT; i++) await say(P, `again ${i}`);
  const before = sent.length;
  await processIncomingMessage({ from: `whatsapp:${P}`, body: 'still there?', raw: { Body: 'x', NumMedia: '0' } });
  assert.equal(sent.length, before);
  // Pruning on another phone's first message of the day keeps today's rows.
  await say('+66810000056', 'first today');
  const n = (await db.query('SELECT msg_count FROM onboarding_rate_limits WHERE phone = $1', [P])).rows[0].msg_count;
  assert.equal(Number(n), onboarding.DAILY_LIMIT + 1);
});

test('media from an unknown phone re-asks the current question', async () => {
  const P = '+66810000006';
  await say(P, 'hi');
  const r = await say(P, '', { NumMedia: '1', MediaContentType0: 'image/jpeg', MediaUrl0: 'https://api.twilio.com/x' });
  assert.ok(r.startsWith(M.PROMPTS.name));
});

// ── registered users ──────────────────────────────────────────────────

test('active users are unaffected; "delete my account" → DELETE closes the account', async () => {
  const P = '+66810000007';
  const u = await insertUser(P, { tax_id: '0994000165315', accountant_name: 'Acc', accountant_phone: '+66811111111' });
  assert.equal(await say(P, 'paid 50 for coffee'), 'ok');
  assert.deepEqual(handled, ['paid 50 for coffee']);

  // Anything but DELETE keeps the account, and is not sent to the LLM.
  assert.equal(await say(P, 'Delete my account'), M.DELETE_CONFIRM);
  assert.equal(await say(P, 'no wait'), M.DELETE_KEPT);
  assert.equal((await userByPhone(P)).subscription_status, 'active');
  assert.equal((await userByPhone(P)).delete_requested_at, null);
  assert.equal(handled.length, 1);

  await db.query(`INSERT INTO media_blobs (user_id, content_type, bytes, created_at) VALUES ($1, 'image/jpeg', $2, $3)`,
    [u.id, Buffer.from('x'), new Date().toISOString()]);
  // Someone else's receipt and messages must survive this user's deletion.
  const other = await insertUser('+66810000018');
  const addMsg = (id) => db.query(`INSERT INTO messages (user_id, direction, body, created_at) VALUES ($1, 'in', 'x', $2)`, [id, new Date().toISOString()]);
  await addMsg(u.id);
  await addMsg(other.id);
  await db.query(`INSERT INTO media_blobs (user_id, content_type, bytes, created_at) VALUES ($1, 'image/jpeg', $2, $3)`,
    [other.id, Buffer.from('y'), new Date().toISOString()]);
  const count = async (table, id) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`, [id])).rows[0].n);
  const otherMsgs = await count('messages', other.id);
  assert.ok(otherMsgs > 0);
  assert.ok((await count('messages', u.id)) > 0);
  assert.equal(await say(P, 'delete my account.'), M.DELETE_CONFIRM);
  assert.equal(await say(P, 'DELETE'), M.DELETE_DONE);
  assert.match(M.DELETE_DONE, /accountant retains/);
  const row = await userByPhone(P);
  assert.equal(row.subscription_status, 'deleted');
  assert.equal(row.tax_id, null);
  assert.equal(row.accountant_name, null);
  assert.equal(row.accountant_phone, null);
  assert.equal(row.erpnext_company, COMPANY, 'the ERPNext link is kept for the record');
  assert.equal(await count('media_blobs', u.id), 0);
  assert.equal(await count('messages', u.id), 0);
  assert.equal(await count('media_blobs', other.id), 1);
  assert.equal(await count('messages', other.id), otherMsgs);

  assert.equal(await say(P, 'hello?'), M.ACCOUNT_CLOSED);
  assert.equal(await say(P, 'delete my account'), M.ACCOUNT_CLOSED);
  assert.equal(handled.length, 1, 'only the active-user message reached the LLM');
});

test('a stale delete request lapses: DELETE after the window does nothing', async () => {
  const P = '+66810000008';
  const u = await insertUser(P);
  assert.equal(await say(P, 'delete my account'), M.DELETE_CONFIRM);
  await db.query('UPDATE users SET delete_requested_at = $1 WHERE id = $2', [new Date(Date.now() - 60 * 60 * 1000).toISOString(), u.id]);
  assert.equal(await say(P, 'DELETE'), 'ok', 'goes on to the normal flow');
  assert.equal((await userByPhone(P)).subscription_status, 'active');
});

// ── provisioning ──────────────────────────────────────────────────────

const ENV = { ERPNEXT_URL: 'http://erp.test', ERPNEXT_API_KEY: 'admin-key', ERPNEXT_API_SECRET: 'admin-secret' };

async function runProvision(args, env = ENV) {
  const lines = [];
  const code = await provision.run(args, { db, env, out: (s) => lines.push(s), twilio: twilioClient });
  return { code, out: lines.join('\n') };
}

test('provision-user: arguments, abbreviations', () => {
  assert.deepEqual(provision.parseArgs([]).errors, ['pass --user <id> or --list-pending']);
  assert.deepEqual(provision.parseArgs(['--user', 'x']).errors.length, 2);
  assert.equal(provision.parseArgs(['--user=12', '--dry-run']).user, 12);
  assert.equal(provision.deriveAbbr('Siam Gems Co., Ltd.'), 'SG');
  assert.equal(provision.deriveAbbr('Bersol'), 'BER');
  assert.equal(provision.deriveAbbr('ร้านทอง'), 'CO');
  assert.equal(provision.deriveAbbr('ร้านทอง', 'U12'), 'U12');
});

test('provision-user: --list-pending and --dry-run touch neither ERPNext nor the users row', async () => {
  const erp = new FakeErpNext();
  erp.install();
  const u = await insertUser('+66810000009', {
    display_name: 'Dry Run Co', subscription_status: 'pending_provisioning', erpnext_company: null, erpnext_api_key: null, erpnext_api_secret: null,
  });
  let r = await runProvision(['--list-pending']);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`id=${u.id}\\s+"Dry Run Co"`));
  assert.ok(!r.out.includes('66810000009'));

  const companies = erp.all('Company').length;
  r = await runProvision(['--user', String(u.id), '--dry-run', '--notify']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /abbr DR unless taken/);
  assert.equal(erp.calls.length, 0, 'no ERPNext request');
  assert.equal(erp.all('Company').length, companies, 'no Company created');
  assert.deepEqual(sent, [], 'no WhatsApp sent');
  const row = await userByPhone('+66810000009');
  assert.equal(row.subscription_status, 'pending_provisioning');
  assert.equal(row.erpnext_company, null);

  // Dry run works without the ERPNext env too (just says a real run would refuse).
  r = await runProvision(['--user', String(u.id), '--dry-run'], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /would refuse/);
});

test('provision-user: creates the Company, sets it up, activates the user; re-run is idempotent', async () => {
  const erp = new FakeErpNext();
  erp.install();
  // Start from a site without the Company record (its chart stays seeded: the fake is single-company).
  erp.docs.get('Company').delete(COMPANY);
  erp.docs.get('Item Group').delete('Products');
  const u = await insertUser('+66810000010', {
    display_name: COMPANY, subscription_status: 'pending_provisioning', erpnext_company: null, erpnext_api_key: null, erpnext_api_secret: null,
  });
  // The fake is single-company: another users row on COMPANY must block provisioning onto it.
  let r0 = await runProvision(['--user', String(u.id)]);
  assert.equal(r0.code, 2, r0.out);
  assert.match(r0.out, /already belongs to user \d+/);
  assert.equal(erp.calls.length, 0);
  await db.query('UPDATE users SET erpnext_company = NULL WHERE erpnext_company = $1', [COMPANY]);

  let r = await runProvision(['--user', String(u.id), '--abbr', 'tc', '--notify']);
  assert.equal(r.code, 0, r.out);
  const company = erp.get('Company', COMPANY);
  assert.equal(company.abbr, 'TC');
  assert.equal(company.default_currency, 'THB');
  assert.equal(company.country, 'Thailand');
  assert.equal(company.chart_of_accounts, provision.CHART_OF_ACCOUNTS);
  for (const name of ['Output VAT - TC', 'Input VAT - TC', 'WHT Payable - TC', 'Debtors USD - TC']) {
    assert.ok(erp.get('Account', name), `${name} created`);
  }
  assert.ok(erp.get('Item Group', 'Products'));
  assert.ok(erp.get('Item', 'GEN-SALE'));
  assert.ok(erp.get('Item', 'GEN-PURCHASE'));

  const row = await userByPhone('+66810000010');
  assert.equal(row.subscription_status, 'active');
  assert.equal(row.erpnext_company, COMPANY);
  assert.equal(row.erpnext_api_key, 'admin-key');
  assert.equal(row.erpnext_api_secret, 'admin-secret');
  const expected = new Date();
  expected.setUTCFullYear(expected.getUTCFullYear() + 1);
  assert.equal(row.subscription_expires_at, expected.toISOString().slice(0, 10));
  assert.match(r.out, /PILOT MODE/);
  assert.deepEqual(sent.map((s) => s.text), [M.BOOKS_READY]);

  // The user now reaches the normal flow.
  assert.equal(await say('+66810000010', 'paid 20 for tea'), 'ok');

  const posts = erp.calls.filter((c) => c.method === 'POST').length;
  // A re-run keeps a still-valid expiry rather than extending it.
  await db.query(`UPDATE users SET subscription_expires_at = '2099-01-01' WHERE id = $1`, [u.id]);
  r = await runProvision(['--user', String(u.id)]);
  assert.equal(r.code, 0, r.out);
  assert.equal((await userByPhone('+66810000010')).subscription_expires_at, '2099-01-01');
  assert.match(r.out, /\(existing\), 0 setup record\(s\) created/);
  assert.equal(erp.calls.filter((c) => c.method === 'POST').length, posts, 'nothing re-created');
});

test('provision-user: refuses deleted users and a currency mismatch', async () => {
  const erp = new FakeErpNext();
  erp.install();
  const gone = await insertUser('+66810000011', { subscription_status: 'deleted' });
  assert.equal((await runProvision(['--user', String(gone.id)])).code, 2);
  assert.equal((await runProvision(['--user', '999999'])).code, 2);

  const sgd = await insertUser('+66810000012', {
    subscription_status: 'pending_provisioning', erpnext_company: null, default_currency: 'SGD', reporting_currency: 'SGD', country: 'SG',
  });
  // Free the Company name in the users table so the ERPNext-side currency check is what refuses.
  await db.query('UPDATE users SET erpnext_company = NULL WHERE erpnext_company = $1', [COMPANY]);
  const r = await runProvision(['--user', String(sgd.id), '--company', COMPANY]);
  assert.equal(r.code, 2);
  assert.match(r.out, /currency THB/);
  assert.equal((await userByPhone('+66810000012')).subscription_status, 'pending_provisioning');
});

// ── HEIC intake ───────────────────────────────────────────────────────

// A real 32×32 HEIC (macOS `sips -s format heic`), small enough to inline.
const HEIC_BYTES = Buffer.from(
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA' +
  'AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVp' +
  'bmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAA' +
  'AAAAIAAAACAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//' +
  'A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAgwjiHuRZVNwICBgCogABAAlEAcBhcshEU2QAAAAZ' +
  'aXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAMWAAAAAW1kYXQAAAAAAAADJgAAAxIoAa+h' +
  'V/wO8a90Ck1wzGYn4jjwpvYr8CtYwTKi3/vlz7mePWiTX9cuHYgl28Obc+AapEyjpSWLGKn8VVYb6Xfqbj34L/9ERlQo1r2JIBeT' +
  'ZKNMeIEgkN0E1terFAX/q8QV6CFLZOvHzkEWZK/LWuFV8vqP17gSFw99vprpQlAJyAoOkMquFdhSTZkqeIV9XumgqR/DyVAiS9xl' +
  'eWeDis5OPTXnthBVHB0q/Jomdx+HFrqgRtPlgqKAs+/G4Tjj4tiNXldVCIPz5oUCKZ3IoNM8RrWRBt8CP7lg3I4cxTOkToSaHxl1' +
  'jC68kJWGet47vXHtuvsqmvJj0DxvJUzmHGXAb66wInFHZe/bmMi3Hp1N6BB+klIBP/oHvtiUo+TGaA31cPMuy2UaIbei16IAq30k' +
  'fANCKmq2u+j4np6L+vavaMoyFU674ipoA5cCbaXS4axvSIyScFSDPtoEYWB7jS4gva/RJ0nDgafxcTHQzFndKiNEUkykb+6AdEwn' +
  'u1GxhFkkT9K1U74AZFczq7WHGc++ZAi5Ni41LomS+4UPpsCpGa7Wc2UoH/gxRP1Hj+mKPhAgicYISbuIM9AZdCmO1u2cWSMoVHTz' +
  'aWO+HLDdPIdvHI1aJbEQ0+1U2+ygbxYEbmGBJ5jDmUukP9Ev/lsrL8JqKja/mbVh7+17Pi/gTRfSXQo19y37/zS/dpDhb7AD4Xu3' +
  'pyMTsvXcBrxNZTRje7W+SI6PkhUhhrezBGU+C42ZP4sHHZWh9cph1jhgH0wDW1MpZ8XdibR8NP1y+y9MunLmo3ivULDPBgNyZQ2D' +
  '3AxMicGBbBeqJIr0UhbQ6sdFFyN9ksP0HGXZXA7TwWD16tJj5I0hrenDxxme9b4IAnkQZuCKkoNtDY90OFddOdCs3IgDLp1DEWl/' +
  'eQrrWKARLr5ou878ReR5j7+xbMV/hhZvRgC7UHuj5kT+6peXlTnh7T3qiZqbMfHKCikz3Tp8CkTbYObAxHk6Qx7vlymZ6rS0tdSk' +
  '1jcxBfM5Qe4jejt5A+xXNVJQUEBEpTEF+L0UR/mTlXA=',
  'base64'
);
const TW = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media';
const SCAN = {
  document_type: 'receipt', merchant: 'Starbucks', date: '2026-11-02', total: 185, currency: 'THB',
  tax_amount: 12.1, tax_rate: 7, vat_claimable: true, invoice_number: null, due_date: null,
  payment_method: 'credit_card', items_summary: '2 lattes', confidence: 0.93,
};

function photo(phone, contentType, body = '') {
  return say(phone, body, { Body: body, NumMedia: '1', MediaContentType0: contentType, MediaUrl0: `${TW}/h1` });
}

let heicUser;
let visionCalls;
async function heicSetup() {
  if (!heicUser) heicUser = await insertUser('+66810000020');
  visionCalls = [];
  _setClientForTests({
    chat: { completions: { create: async (req) => { visionCalls.push(req); return { choices: [{ message: { content: JSON.stringify(SCAN) } }] }; } } },
  });
  download._setDownloaderForTests(async () => HEIC_BYTES);
  download._setMaxBytesForTests(null);
  heic._setConverterForTests(null);
}

test('HEIC: a real HEIC photo is converted and scanned/stored as a JPEG', async () => {
  await heicSetup();
  const r = await photo('+66810000020', 'image/heic', 'coffee');
  assert.equal(r, 'ok');
  assert.equal(handled.length, 1);
  assert.match(handled[0], /^coffee\n\[receipt scanned\] \{/);
  const url = visionCalls[0].messages.find((m) => Array.isArray(m.content)).content.find((p) => p.type === 'image_url').image_url.url;
  assert.ok(url.startsWith('data:image/jpeg;base64,/9j/'), 'JPEG data URL sent to vision');
  const blob = (await db.query('SELECT content_type FROM media_blobs WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [heicUser.id])).rows[0];
  assert.equal(blob.content_type, 'image/jpeg');
});

test('HEIF content type goes through the same conversion (stubbed converter)', async () => {
  await heicSetup();
  const seen = [];
  heic._setConverterForTests(async ({ buffer, format }) => {
    seen.push([buffer.length, format]);
    return Buffer.from('fake-jpeg-bytes');
  });
  assert.equal(await photo('+66810000020', 'image/heif'), 'ok');
  assert.deepEqual(seen, [[HEIC_BYTES.length, 'JPEG']]);
  assert.match(handled[0], /^\[receipt scanned\]/);
});

test('HEIC conversion failure falls back to the HEIC reply / marker', async () => {
  await heicSetup();
  heic._setConverterForTests(async () => { throw new Error('decoder exploded'); });
  assert.equal(await photo('+66810000020', 'image/heic'), mediaIntake.HEIC_REPLY);
  assert.equal(visionCalls.length, 0);
  assert.equal(await photo('+66810000020', 'image/heic', 'paid 200 lunch'), 'ok');
  assert.deepEqual(handled, ['paid 200 lunch\n[photo in HEIC format could not be read]']);

  // Not actually HEIC: the real decoder rejects it, same fallback.
  heic._setConverterForTests(null);
  download._setDownloaderForTests(async () => Buffer.from('not-a-heic'));
  assert.equal(await photo('+66810000020', 'image/heic'), mediaIntake.HEIC_REPLY);
});

test('HEIC: the size cap applies to the original download; conversion has a timeout', async () => {
  await heicSetup();
  let converted = 0;
  heic._setConverterForTests(async () => { converted++; return Buffer.from('x'); });
  download._setMaxBytesForTests(100);
  try {
    assert.equal(await photo('+66810000020', 'image/heic'), mediaIntake.TOO_LARGE_REPLY);
    assert.equal(converted, 0);
  } finally {
    download._setMaxBytesForTests(null);
  }

  heic._setConverterForTests(() => new Promise(() => {}));
  await assert.rejects(heic.heicToJpeg(HEIC_BYTES, { timeoutMs: 20 }), (err) => err.code === 'HEIC_CONVERT_FAILED' && /timed out/.test(err.message));
  heic._setConverterForTests(null);
  // The real decoder runs in a Worker that is terminated on timeout (the test would hang otherwise).
  await assert.rejects(heic.heicToJpeg(HEIC_BYTES, { timeoutMs: 1 }), (err) => err.code === 'HEIC_CONVERT_FAILED' && /timed out/.test(err.message));
  assert.match(mediaIntake.UNSUPPORTED_REPLY, /HEIC/);
});

/**
 * Daily jobs: the scheduler (injected clock + stub jobs), the morning digest (fake ERPNext,
 * stubbed Twilio), the Twilio status callback and the set_schedule_preferences tool.
 * Tests share state and run in order. Each scheduler test uses its own job name, because
 * "already ran" is tracked per (user, job).
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;
delete process.env.TWILIO_DIGEST_CONTENT_SID;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const twilioLib = require('twilio');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const scheduler = require('../src/jobs/scheduler');
const digest = require('../src/jobs/digest.job');
const { localClock, addDays, validTimezone, jobsDisabled, windowMinutes } = require('../src/jobs');
const { getOpenInvoices } = require('../src/erp-query/open-invoices');
const { executeTool } = require('../src/tools');
const erpnext = require('../src/erpnext');

const erp = new FakeErpNext();
const users = {};

async function makeUser(phone, extra = {}) {
  const now = new Date().toISOString();
  const cols = ['phone', 'erpnext_company', 'erpnext_api_key', 'erpnext_api_secret', 'created_at', 'updated_at', ...Object.keys(extra)];
  const vals = [phone, COMPANY, 'k', 's', now, now, ...Object.values(extra)];
  const r = await db.query(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function reload(user) {
  return (await db.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
}

async function runRow(user, job) {
  return (await db.query('SELECT * FROM job_runs WHERE user_id = $1 AND job = $2 ORDER BY run_date', [user.id, job])).rows;
}

/** Last inbound WhatsApp message time — what the digest checks for the 24h window. */
async function setLastMessage(user, iso) {
  const now = new Date().toISOString();
  const r = await db.query('UPDATE conversations SET last_message_at = $2 WHERE user_id = $1', [user.id, iso]);
  if (!r.rowCount) {
    await db.query(
      `INSERT INTO conversations (user_id, state, recent_messages, last_message_at, created_at, updated_at)
       VALUES ($1, 'idle', '[]', $2, $3, $3)`,
      [user.id, iso, now]
    );
  }
}

function stubTwilio() {
  const sent = [];
  return {
    sent,
    sendText: async (to, text) => { sent.push({ kind: 'text', to, text }); return `SMtext${sent.length}`; },
    sendTemplate: async (to, contentSid, variables) => { sent.push({ kind: 'template', to, contentSid, variables }); return `SMtpl${sent.length}`; },
  };
}

/** A stub job that records (user, run date, local time) for every run. */
function recorder(name, defaultTime = '08:00', extra = {}) {
  const calls = [];
  return {
    calls,
    job: { name, defaultTime, ...extra, run: async (user, { clock }) => { calls.push({ user: user.id, date: clock.run_date, local_date: clock.date, time: clock.time }); } },
  };
}

/** One scheduler pass at a fixed UTC instant; returns only the runs for `onlyUsers`. */
async function tick(iso, jobs, onlyUsers, opts = {}) {
  const ids = onlyUsers.map((u) => u.id);
  const out = await scheduler.runDue({ now: new Date(iso), jobs, twilio: stubTwilio(), erpFor: () => ({}), ...opts });
  return out.filter((r) => ids.includes(r.user_id));
}

const ctxFor = (user) => ({ user, draft: { wallet_options: [], confirmation_pending: true }, saved: null, cancelled: false, confirmationRequested: false });

before(async () => {
  erp.install();
  // noAstCoverageCheck: lets pg-mem re-run CREATE TABLE IF NOT EXISTS with constraints (a no-op
  // on real Postgres), so the migration re-run test below exercises the real file.
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  users.owner = await makeUser('+66100');
});

// ── migration ────────────────────────────────────────────────────────

test('migration: defaults, and 040-schedule.sql re-runs cleanly (it runs on every boot)', async () => {
  assert.equal(users.owner.timezone, 'Asia/Bangkok');
  assert.equal(users.owner.digest_enabled, 1);
  assert.equal(users.owner.job_prefs, null);
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/040-schedule.sql'), 'utf8');
  await db.query(sql); // second run (migrate() was the first)
  await db.query(sql); // third
  // Nothing that locks/rewrites/re-validates on every boot (one-offs live in comments).
  const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.doesNotMatch(code, /DROP\s+CONSTRAINT|ADD\s+CONSTRAINT|ALTER\s+COLUMN|\bTYPE\s+BIGINT|ALTER\s+SEQUENCE|DROP\s+INDEX/i);
  assert.deepEqual(code.match(/ALTER TABLE \w+ (\w+ \w+)/g).map((m) => m.split(' ').slice(3).join(' ')).filter((x) => x !== 'ADD COLUMN'), []);
  assert.match(code, /id BIGSERIAL PRIMARY KEY/);
  assert.match(code, /REFERENCES users\(id\) ON DELETE CASCADE/);
  // ON DELETE CASCADE really cascades, and the PRIMARY KEY is enforced.
  const tmp = await makeUser('+66999');
  await db.query(`INSERT INTO job_runs (id, user_id, job, run_date, started_at) VALUES (900001, $1, 'x', '2026-01-01', 'now')`, [tmp.id]);
  await assert.rejects(db.query(`INSERT INTO job_runs (id, user_id, job, run_date, started_at) VALUES (900001, $1, 'y', '2026-01-01', 'now')`, [tmp.id]));
  await db.query('DELETE FROM users WHERE id = $1', [tmp.id]);
  assert.deepEqual((await db.query('SELECT * FROM job_runs WHERE user_id = $1', [tmp.id])).rows, []);
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_runs'`
  )).rows.map((r) => r.column_name);
  for (const c of ['id', 'user_id', 'job', 'run_date', 'started_at', 'finished_at', 'status', 'error', 'message_sid', 'result']) {
    assert.ok(cols.includes(c), `job_runs.${c}`);
  }
});

// ── digest content ───────────────────────────────────────────────────

test('digest: empty books → nothing built, nothing sent', async () => {
  const user = users.owner;
  assert.equal(await digest.buildDigest(user, erpnext.forUser(user)), null);
  const twilio = stubTwilio();
  const res = await digest.run(user, { erp: erpnext.forUser(user), twilio, now: new Date() });
  assert.deepEqual(res, { skipped: true, note: 'nothing to report' });
  assert.equal(twilio.sent.length, 0);
});

test('digest: wallets + cards, overdue receivable, bill due in 3 days, yesterday\'s expense', async () => {
  const user = users.owner;
  const now = new Date();
  const yesterday = addDays(localClock(now, user.timezone).date, -1);

  erp.create('Account', { account_name: 'BBL Savings', parent_account: '1200 - Bank Accounts - TC', account_type: 'Bank' });
  erp.create('Account', { account_name: 'DBS USD', parent_account: '1200 - Bank Accounts - TC', account_type: 'Bank', account_currency: 'USD' });
  erp.create('Journal Entry', {
    docstatus: 1, posting_date: addDays(TODAY, -60), accounts: [
      { account: 'BBL Savings - TC', debit_in_account_currency: 50000 },
      { account: '3300 - Opening Balance Equity - TC', credit_in_account_currency: 50000 },
    ],
  });
  erp.create('Journal Entry', {
    docstatus: 1, multi_currency: 1, posting_date: addDays(TODAY, -60), accounts: [
      { account: 'DBS USD - TC', debit_in_account_currency: 500, exchange_rate: 32 },
      { account: '3300 - Opening Balance Equity - TC', credit_in_account_currency: 16000 },
    ],
  });
  // Credit card wallets are bot-created (no ERPNext account_type), via the normal tool.
  const card = await executeTool('create_user_account', { name: 'AmEx', parent_code: '2100', currency: 'THB' }, ctxFor(user));
  assert.equal(card.ok, true, card.error);
  erp.create('Journal Entry', {
    docstatus: 1, posting_date: addDays(TODAY, -10), accounts: [
      { account: '5216 - Travel Expenses - TC', debit_in_account_currency: 1200 },
      { account: 'AmEx - TC', credit_in_account_currency: 1200 },
    ],
  });
  erp.create('Item', { item_code: 'Goods', is_sales_item: 1, is_purchase_item: 1 });
  erp.create('Customer', { customer_name: 'Jameel Gems' });
  erp.create('Supplier', { supplier_name: 'Acme Supplies' });
  erp.create('Sales Invoice', {
    customer: 'Jameel Gems', currency: 'THB', docstatus: 1, set_posting_time: 1,
    posting_date: addDays(TODAY, -40), due_date: addDays(TODAY, -5),
    items: [{ item_code: 'Goods', qty: 1, rate: 10000, income_account: '4110 - Sales - TC' }],
  });
  erp.create('Purchase Invoice', {
    supplier: 'Acme Supplies', currency: 'THB', docstatus: 1, set_posting_time: 1,
    posting_date: addDays(TODAY, -10), due_date: addDays(TODAY, 3),
    items: [{ item_code: 'Goods', qty: 1, rate: 3000, expense_account: '5111 - Cost of Goods Sold - TC' }],
  });
  erp.create('Journal Entry', {
    docstatus: 1, posting_date: yesterday, accounts: [
      { account: '5204 - Entertainment Expenses - TC', debit_in_account_currency: 850 },
      { account: '1110 - Cash - TC', credit_in_account_currency: 850 },
    ],
  });

  // Pin the local date to the UTC date the fake ERPNext uses, so day counts are deterministic.
  const text = await digest.buildDigest(user, erpnext.forUser(user), { now, clock: { date: TODAY } });
  const lines = text.split('\n');
  assert.match(lines[0], /^Your books, \w{3} \d{1,2} \w{3}:$/);
  assert.doesNotMatch(text, /Good morning/);
  // Card excluded from cash totals; "DBS USD" isn't followed by a second "USD".
  assert.equal(lines[1], 'Cash: THB 49,150.00 · USD 500.00');
  assert.equal(lines[2], '  BBL Savings THB 50,000.00 · DBS USD 500.00 · Cash THB -850.00');
  assert.equal(lines[3], 'Owed on cards: AmEx THB 1,200.00');
  assert.equal(lines[4], 'Overdue (1):');
  assert.equal(lines[5], '- Jameel Gems owes you THB 10,000.00 (5d late)');
  assert.equal(lines[6], 'Due next 7 days (1):');
  assert.equal(lines[7], '- You owe Acme Supplies THB 3,000.00 (in 3d)');
  if (yesterday === addDays(TODAY, -1)) {
    assert.equal(lines[8], 'Yesterday: in THB 0.00 · out THB 850.00');
  }
  assert.ok(lines.length <= 12, 'digest stays short');
});

test('digest: cash section edge cases', async () => {
  const section = async (accounts) => {
    const fakeErp = { company: COMPANY };
    // Drive buildDigest's cash formatting through a stubbed wallet list.
    const wallets = require('../src/wallets');
    const orig = wallets.list;
    const bal = Object.fromEntries(accounts.map((a) => [a.erpnext_account, a.balance]));
    wallets.list = async () => accounts;
    fakeErp.getAccountBalance = async (acc) => ({ message: bal[acc] });
    fakeErp.listResource = async () => ({ data: [] });
    fakeErp.listAccounts = async () => ({ data: [] });
    try {
      return await digest.buildDigest(users.owner, fakeErp, { clock: { date: TODAY } });
    } finally {
      wallets.list = orig;
    }
  };
  const w = (name, type, currency, balance) => ({ id: name, name, type, currency, erpnext_account: name, balance });

  // Only a card owing money → no "Cash:" line at all.
  assert.equal(await section([w('AmEx', 'Credit Card', 'THB', -300), w('Cash', 'Cash', 'THB', 0)]),
    `Your books, ${localDateLabel(TODAY)}:\nOwed on cards: AmEx THB 300.00`);
  // Wallet named like its currency: "USD 5.00", not "USD USD 5.00".
  assert.match(await section([w('USD', 'Bank', 'USD', 5)]), /\n {2}USD 5\.00$/);
  // Balances netting to zero: the currency still shows as 0.00 so totals match the list.
  assert.match(await section([w('A', 'Bank', 'THB', 500), w('B', 'Cash', 'THB', -500), w('D', 'Bank', 'USD', 7)]),
    /\nCash: THB 0\.00 · USD 7\.00\n {2}A THB 500\.00 · B THB -500\.00 · D USD 7\.00$/);
  // A card in credit (positive) isn't "owed".
  assert.equal(await section([w('Visa', 'Credit Card', 'THB', 100)]), null);
});

function localDateLabel(iso) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`));
}

test('getOpenInvoices today option: Bangkok 00:30 local is already tomorrow', async () => {
  const instant = new Date(`${TODAY}T17:30:00Z`);
  const bkk = localClock(instant, 'Asia/Bangkok');
  assert.deepEqual([bkk.date, bkk.time], [addDays(TODAY, 1), '00:30']);

  const utc = await getOpenInvoices(users.owner, erpnext.forUser(users.owner), { direction: 'payable', limit: 50 });
  const local = await getOpenInvoices(users.owner, erpnext.forUser(users.owner), { direction: 'payable', limit: 50, today: bkk.date });
  assert.equal(utc.rows[0].days_until_due, 3, 'default unchanged: counts from the UTC date');
  assert.equal(local.rows[0].days_until_due, 2);

  // An item due "today" in UTC is 1 day late for the Bangkok user.
  const lateUtc = await getOpenInvoices(users.owner, erpnext.forUser(users.owner), { direction: 'receivable', due_within_days: -1, limit: 50 });
  const lateLocal = await getOpenInvoices(users.owner, erpnext.forUser(users.owner), { direction: 'receivable', due_within_days: -1, limit: 50, today: addDays(TODAY, 6) });
  assert.equal(lateUtc.total_count, 1);
  assert.equal(lateLocal.rows[0].overdue_days, 11);

  const text = await digest.buildDigest(users.owner, erpnext.forUser(users.owner), { clock: { date: bkk.date } });
  assert.match(text, /You owe Acme Supplies THB 3,000\.00 \(in 2d\)/);
  assert.match(text, /Jameel Gems owes you THB 10,000\.00 \(6d late\)/);
});

// ── digest delivery (24h window / template) ──────────────────────────

test('digest: outside the 24h window without a template → skipped, nothing sent', async () => {
  const user = users.owner;
  const now = new Date();
  let twilio = stubTwilio();
  let res = await digest.run(user, { erp: erpnext.forUser(user), twilio, now }); // no conversation yet
  assert.deepEqual(res, { skipped: true, note: 'outside 24h window; set TWILIO_DIGEST_CONTENT_SID' });
  assert.equal(twilio.sent.length, 0);

  await setLastMessage(user, new Date(now.getTime() - 25 * 3600 * 1000).toISOString());
  twilio = stubTwilio();
  res = await digest.run(user, { erp: erpnext.forUser(user), twilio, now });
  assert.equal(res.skipped, true);
  assert.equal(twilio.sent.length, 0);
});

test('digest: inside the window → free-form text with its SID', async () => {
  const user = users.owner;
  const now = new Date();
  await setLastMessage(user, new Date(now.getTime() - 3600 * 1000).toISOString());
  const twilio = stubTwilio();
  const res = await digest.run(user, { erp: erpnext.forUser(user), twilio, now });
  assert.deepEqual(res, { sent: 1, via: 'text', message_sid: 'SMtext1' });
  assert.equal(twilio.sent[0].to, 'whatsapp:+66100');
  assert.match(twilio.sent[0].text, /^Your books, /);
});

test('digest: TWILIO_DIGEST_CONTENT_SID → template, regardless of the window', async () => {
  const user = users.owner;
  await setLastMessage(user, '2020-01-01T00:00:00.000Z');
  process.env.TWILIO_DIGEST_CONTENT_SID = 'HXdigest';
  try {
    const twilio = stubTwilio();
    const now = new Date();
    const res = await digest.run(user, { erp: erpnext.forUser(user), twilio, now, clock: { date: TODAY } });
    assert.deepEqual(res, { sent: 1, via: 'template', message_sid: 'SMtpl1' });
    const { contentSid, variables } = twilio.sent[0];
    assert.equal(contentSid, 'HXdigest');
    assert.equal(variables[1], localDateLabel(TODAY));
    assert.doesNotMatch(variables[2], /[\n\t]| {4}/, 'WhatsApp rejects newlines/tabs in variables');
    assert.match(variables[2], /^Cash: THB 49,150\.00 · USD 500\.00 \| BBL Savings/);
  } finally {
    delete process.env.TWILIO_DIGEST_CONTENT_SID;
  }
});

test('template variables are flattened (tabs/CR/LF); sendTemplate errors carry Twilio\'s code', async () => {
  const v = digest.templateVariables('Your books, x:\r\nCash:\tTHB 1.00\r\n  A\tTHB    1.00\n\nOverdue (1):', '2026-11-03');
  assert.equal(v[1], 'Tue 3 Nov');
  assert.equal(v[2], 'Cash: THB 1.00 | A THB 1.00 | Overdue (1):');
  assert.doesNotMatch(v[2], /[\t\r\n]/);

  // The real client, unconfigured in tests, throws with a code instead of returning null.
  const real = require('../src/twilio-client');
  await assert.rejects(real.sendTemplate('whatsapp:+66100', 'HXx', {}), (e) => e.code === 'TWILIO_NOT_CONFIGURED');

  process.env.TWILIO_DIGEST_CONTENT_SID = 'HXdigest';
  try {
    const twilio = {
      sendTemplate: async () => {
        throw Object.assign(new Error('twilio template send failed (63112): template rejected'), { code: 63112 });
      },
    };
    const job = { ...digest, name: 'digesterr' };
    const now = new Date();
    const clock = localClock(now, 'Asia/Bangkok');
    const u = await makeUser('+66404', { job_prefs: JSON.stringify({ digesterr: { time: clock.time } }) });
    const r = await scheduler.runDue({ now, jobs: [job], twilio });
    const mine = r.filter((x) => x.user_id === u.id);
    assert.equal(mine[0].status, 'failed');
    assert.match((await runRow(u, 'digesterr'))[0].error, /63112/);
    await db.query(`UPDATE users SET subscription_status = 'expired' WHERE id = $1`, [u.id]);
  } finally {
    delete process.env.TWILIO_DIGEST_CONTENT_SID;
  }
});

test('digest: digest_enabled=0 skips without querying ERPNext or sending; failed send throws', async () => {
  const twilio = stubTwilio();
  const callsBefore = erp.calls.length;
  const res = await digest.run({ ...users.owner, digest_enabled: 0 }, { erp: erpnext.forUser(users.owner), twilio, now: new Date() });
  assert.equal(res.skipped, true);
  assert.equal(twilio.sent.length, 0);
  assert.equal(erp.calls.length, callsBefore);
  assert.equal(digest.enabled({ digest_enabled: 0 }), false);
  assert.equal(digest.enabled({ digest_enabled: 1 }), true);

  await setLastMessage(users.owner, new Date().toISOString());
  await assert.rejects(
    digest.run(users.owner, { erp: erpnext.forUser(users.owner), twilio: { sendText: async () => null }, now: new Date() }),
    /no message sid/
  );
});

test('digest through the scheduler: once per day, SID + result recorded; status callback marks it failed', async () => {
  const user = users.owner;
  const now = new Date();
  const clock = localClock(now, user.timezone);
  await setLastMessage(user, now.toISOString());
  // Real clock (the ERPNext queries use real dates): put the digest time at "now" → inside its window.
  await db.query('UPDATE users SET job_prefs = $2 WHERE id = $1', [user.id, JSON.stringify({ digest: { time: clock.time } })]);
  const twilio = stubTwilio();
  const jobs = scheduler.loadJobs().filter((j) => j.name === 'digest');

  let r = await scheduler.runDue({ now, jobs, twilio });
  assert.deepEqual(r.map((x) => [x.user_id, x.job, x.status]), [[user.id, 'digest', 'ok']]);
  r = await scheduler.runDue({ now, jobs, twilio });
  assert.equal(r.length, 0);
  assert.equal(twilio.sent.length, 1);

  const [row] = await runRow(user, 'digest');
  assert.equal(row.status, 'ok');
  assert.equal(row.message_sid, 'SMtext1');
  assert.deepEqual(JSON.parse(row.result), { sent: 1, via: 'text', message_sid: 'SMtext1' });

  // Twilio later reports the message undelivered (e.g. 63016 outside the window).
  const handler = scheduler.twilioStatusHandler({ authToken: 't', publicBaseUrl: 'https://x', validate: () => true });
  const res = fakeRes();
  await handler({ headers: {}, body: { MessageSid: 'SMtext1', MessageStatus: 'undelivered', ErrorCode: '63016' } }, res);
  assert.equal(res.statusCode, 204);
  const [after] = await runRow(user, 'digest');
  assert.equal(after.status, 'failed');
  assert.equal(after.error, 'twilio undelivered 63016');

  // Park the owner so later scheduler tests only see their own users.
  await db.query(`UPDATE users SET subscription_status = 'expired' WHERE id = $1`, [user.id]);
});

// ── Twilio status callback ───────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    send() { return this; },
    end() { return this; },
  };
}

test('status callback: signature validation, delivered is a no-op, outreach_log only if it has message_sid', async () => {
  const token = 'tok';
  const base = 'https://bot.example.com';
  const params = { MessageSid: 'SMx', MessageStatus: 'failed', ErrorCode: '30008' };
  const handler = scheduler.twilioStatusHandler({ authToken: token, publicBaseUrl: base }); // real twilio.validateRequest

  let res = fakeRes();
  await handler({ headers: { 'x-twilio-signature': 'forged' }, body: params }, res);
  assert.equal(res.statusCode, 403);

  const sig = twilioLib.getExpectedTwilioSignature(token, `${base}/twilio/status`, params);
  res = fakeRes();
  await handler({ headers: { 'x-twilio-signature': sig }, body: params }, res);
  assert.equal(res.statusCode, 204);

  // Missing config is a rejection, not an open door.
  res = fakeRes();
  await scheduler.twilioStatusHandler({ authToken: token, publicBaseUrl: '', validate: () => true })({ headers: { 'x-twilio-signature': sig }, body: params }, res);
  assert.equal(res.statusCode, 403);

  assert.deepEqual(await scheduler.recordDeliveryStatus({ sid: 'SMx', status: 'delivered' }), { job_runs: 0, outreach_log: 0 });
  // outreach_log (another lane's table) has no message_sid column yet → untouched, no error.
  assert.deepEqual(await scheduler.recordDeliveryStatus({ sid: 'SMx', status: 'failed', errorCode: '30008' }), { job_runs: 0, outreach_log: 0 });

  await db.query('ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS message_sid TEXT');
  await db.query(
    `INSERT INTO outreach_log (user_id, kind, reference, sent_at, status, message_sid) VALUES ($1, 'reminder', 'X', $2, 'sent', 'SMout')`,
    [users.owner.id, new Date().toISOString()]
  );
  assert.deepEqual(await scheduler.recordDeliveryStatus({ sid: 'SMout', status: 'undelivered', errorCode: '63016' }), { job_runs: 0, outreach_log: 1 });
  const o = (await db.query(`SELECT * FROM outreach_log WHERE message_sid = 'SMout'`)).rows[0];
  assert.deepEqual([o.status, o.error], ['failed', 'twilio undelivered 63016']);
});

// ── scheduler ────────────────────────────────────────────────────────

test('localClock / timezone validation / window parsing / DISABLE_JOBS', () => {
  const t = new Date('2026-11-03T13:00:00Z');
  assert.deepEqual(localClock(t, 'Asia/Bangkok'), { date: '2026-11-03', time: '20:00', timezone: 'Asia/Bangkok' });
  assert.deepEqual(localClock(t, 'America/New_York'), { date: '2026-11-03', time: '08:00', timezone: 'America/New_York' });
  assert.equal(localClock(new Date('2026-07-01T12:00:00Z'), 'America/New_York').time, '08:00'); // EDT
  assert.equal(localClock(t, 'Not/AZone').timezone, 'Asia/Bangkok', 'bad tz falls back to default');

  assert.equal(validTimezone('asia/singapore'), 'Asia/Singapore');
  assert.equal(validTimezone('utc'), 'UTC');
  for (const bad of ['Etc/GMT+7', 'EST', 'ICT', '+07:00', 'GMT+7', 'Singapore', 'US/Eastern', 'Mars/Base', '']) {
    assert.equal(validTimezone(bad), null, bad);
  }

  assert.equal(windowMinutes(30), 30);
  assert.equal(windowMinutes('1:30'), 90);
  assert.equal(windowMinutes('soon'), null);

  for (const on of ['1', 'true', 'TRUE', 'yes', 'On', ' true ']) assert.equal(jobsDisabled(on), true, on);
  for (const off of [undefined, '', '0', 'false', 'no', 'off', 'disabled']) assert.equal(jobsDisabled(off), false, String(off));
});

test('scheduler: runs once inside [time, time + 120 min); never before or after', async () => {
  users.a = await makeUser('+66201'); // Asia/Bangkok by default
  const { calls, job } = recorder('tick');
  const mine = () => calls.filter((c) => c.user === users.a.id).map((c) => c.date);

  assert.deepEqual(await tick('2026-11-03T00:59:00Z', [job], [users.a]), []); // 07:59
  const r = await tick('2026-11-03T01:00:00Z', [job], [users.a]); // 08:00
  assert.deepEqual(r, [{ user_id: users.a.id, job: 'tick', run_date: '2026-11-03', status: 'ok' }]);
  assert.deepEqual(await tick('2026-11-03T01:01:00Z', [job], [users.a]), []);
  // Next day, a deploy at 10:00 local (end of window) and 22:00 local: nothing — no late "good morning".
  assert.deepEqual(await tick('2026-11-04T03:00:00Z', [job], [users.a]), []);
  assert.deepEqual(await tick('2026-11-04T15:00:00Z', [job], [users.a]), []);
  // Day after: a restart at 09:59 local is still inside the window.
  await tick('2026-11-05T02:59:00Z', [job], [users.a]);
  assert.deepEqual(mine(), ['2026-11-03', '2026-11-05'], 'Nov 4 missed for good — no catch-up');

  const rows = await runRow(users.a, 'tick');
  assert.deepEqual(rows.map((x) => [x.run_date, x.status]), [['2026-11-03', 'ok'], ['2026-11-05', 'ok']]);
  assert.ok(rows[0].finished_at);
});

test('scheduler: a job\'s own window, and a window crossing midnight', async () => {
  const { calls, job } = recorder('short', '08:00', { window: 30 });
  assert.deepEqual(await tick('2026-11-03T01:30:00Z', [job], [users.a]), []); // 08:30 → outside 30 min
  await tick('2026-11-04T01:29:00Z', [job], [users.a]); // 08:29 → inside
  assert.deepEqual(calls.map((c) => c.date), ['2026-11-04']);

  assert.equal(scheduler.dueRunDate({ date: '2026-11-04', time: '00:30' }, { time: '23:30', window: 120 }), '2026-11-03');
  assert.equal(scheduler.dueRunDate({ date: '2026-11-04', time: '01:30' }, { time: '23:30', window: 120 }), null);
  const late = recorder('late', '23:30');
  const r = await tick('2026-11-03T17:30:00Z', [late.job], [users.a]); // 00:30 Nov 4 in Bangkok
  assert.deepEqual(r.map((x) => x.run_date), ['2026-11-03']);
  // The job sees the run date AND the real local date (what "today" means for due dates).
  assert.deepEqual(late.calls.find((c) => c.user === users.a.id), { user: users.a.id, date: '2026-11-03', local_date: '2026-11-04', time: '00:30' });
});

test('scheduler: Bangkok and New York users at the same UTC instants', async () => {
  users.ny = await makeUser('+12125550100', { timezone: 'America/New_York' });
  const { calls, job } = recorder('tz');
  const both = [users.a, users.ny];

  let r = await tick('2026-11-03T01:00:00Z', [job], both); // BKK 08:00 Nov 3; NY 20:00 Nov 2
  assert.deepEqual(r.map((x) => [x.user_id, x.run_date]), [[users.a.id, '2026-11-03']]);
  r = await tick('2026-11-03T12:59:00Z', [job], both); // NY 07:59
  assert.deepEqual(r, []);
  r = await tick('2026-11-03T13:00:00Z', [job], both); // NY 08:00; BKK 20:00
  assert.deepEqual(r.map((x) => [x.user_id, x.run_date]), [[users.ny.id, '2026-11-03']]);
  assert.deepEqual(calls.find((c) => c.user === users.ny.id), { user: users.ny.id, date: '2026-11-03', local_date: '2026-11-03', time: '08:00' });
});

test('scheduler: a timezone change never produces a second send', async () => {
  const u = await makeUser('+12125550101', { timezone: 'America/New_York' });
  const { calls, job } = recorder('tzchange');
  await tick('2026-11-03T13:00:00Z', [job], [u]); // 08:00 Nov 3 New York → runs
  await db.query(`UPDATE users SET timezone = 'Asia/Tokyo' WHERE id = $1`, [u.id]);
  // 10h later it's 08:00 Nov 4 in Tokyo: a "new" local day, but < 20h since the last run.
  assert.deepEqual(await tick('2026-11-03T23:00:00Z', [job], [u]), []);
  // Next Tokyo morning runs normally.
  await tick('2026-11-04T23:00:00Z', [job], [u]);
  assert.deepEqual(calls.filter((c) => c.user === u.id).map((c) => c.date), ['2026-11-03', '2026-11-05']);

  // Never claim a run_date earlier than one already recorded, even > 20h later.
  const v = await makeUser('+66202');
  await db.query(
    `INSERT INTO job_runs (user_id, job, run_date, started_at, status) VALUES ($1, 'tzback', '2026-11-05', '2026-11-03T00:00:00.000Z', 'ok')`,
    [v.id]
  );
  const back = recorder('tzback');
  assert.deepEqual(await tick('2026-11-04T01:00:00Z', [back.job], [v]), []); // 08:00 Nov 4 BKK < Nov 5
});

test('scheduler: two concurrent passes run a job once', async () => {
  const { calls, job } = recorder('race');
  const opts = { now: new Date('2026-11-03T01:00:00Z'), jobs: [job], twilio: stubTwilio(), erpFor: () => ({}) };
  const [r1, r2] = await Promise.all([scheduler.runDue(opts), scheduler.runDue(opts)]);
  const ran = [...r1, ...r2].filter((x) => x.user_id === users.a.id);
  assert.equal(ran.length, 1);
  assert.equal(calls.filter((c) => c.user === users.a.id).length, 1);
});

test('scheduler: throwing, timing-out and erroring jobs are recorded and don\'t stop others', async () => {
  users.b = await makeUser('+66203');
  const pair = [users.a, users.b];
  const boom = { name: 'boom', defaultTime: '08:00', run: async (user) => { if (user.id === users.a.id) throw new Error('ERPNext down'); } };
  // Overruns its 20ms budget, ignores the abort, and finishes with a real SID once released.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const signals = new Map();
  const hang = {
    name: 'hang', defaultTime: '08:00', timeoutMs: 20,
    run: (user, { signal }) => {
      signals.set(user.id, signal);
      return gate.then(() => ({ sent: 1, message_sid: `SMlate${user.id}` }));
    },
  };
  const badEnabled = { name: 'badenabled', defaultTime: '08:00', enabled: () => { throw new Error('bad prefs'); }, run: async () => {} };
  const { calls, job: after } = recorder('after');

  let r = await tick('2026-11-03T01:05:00Z', [boom, hang, badEnabled, after], pair);
  // While a user's job overruns, that user's later jobs don't start (after runs next tick).
  assert.deepEqual(r.map((x) => [x.user_id, x.job, x.status]), [
    [users.a.id, 'boom', 'failed'], [users.a.id, 'hang', 'failed'],
    [users.b.id, 'boom', 'ok'], [users.b.id, 'hang', 'failed'],
  ]);
  assert.equal(r[0].error, 'ERPNext down');
  assert.equal(r[1].error, 'timeout');
  assert.ok(pair.every((u) => signals.get(u.id) && signals.get(u.id).aborted), 'job got an AbortSignal, aborted at its timeout');
  assert.deepEqual((await runRow(users.a, 'hang')).map((x) => [x.status, x.error, x.message_sid]), [['failed', 'timeout', null]]);
  assert.deepEqual(await tick('2026-11-03T01:05:30Z', [after], pair), [], 'overrunning users are skipped');

  release();
  await scheduler.settled();
  // The overrun job's REAL outcome replaces the timeout record — its SID is kept for callbacks.
  const [late] = await runRow(users.a, 'hang');
  assert.deepEqual([late.status, late.message_sid, late.error], ['ok', `SMlate${users.a.id}`, 'finished after 20ms timeout']);

  r = await tick('2026-11-03T01:06:00Z', [boom, after], pair);
  assert.deepEqual(r.map((x) => [x.user_id, x.job]), [[users.a.id, 'after'], [users.b.id, 'after']]);
  assert.equal(calls.filter((c) => [users.a.id, users.b.id].includes(c.user)).length, 2);
  assert.deepEqual((await runRow(users.a, 'boom')).map((x) => [x.status, x.error]), [['failed', 'ERPNext down']]);
  // A failed run is not retried the same day (it may have half-sent).
  assert.deepEqual(await tick('2026-11-03T01:07:00Z', [boom, after], pair), []);
});

test('scheduler: job results — JSON summary, all-failed counts as failed, erpFor errors', async () => {
  const someFailed = { name: 'partial', defaultTime: '08:00', run: async () => ({ sent: 1, skipped: 1, failed: [{ ref: 'S1', error: 'no phone' }] }) };
  const allFailed = { name: 'allfail', defaultTime: '08:00', run: async () => ({ sent: 0, skipped: 2, failed: [{ ref: 'S1', error: 'no phone' }, { ref: 'S2', error: 'twilio' }] }) };
  const quiet = { name: 'quiet', defaultTime: '08:00', run: async () => ({ skipped: true, note: 'nothing to report' }) };
  const countFailed = { name: 'countfail', defaultTime: '08:00', run: async () => ({ sent: 0, skipped: 1, failed: 2 }) };
  const failuresList = { name: 'failures', defaultTime: '08:00', run: async () => ({ sent: 0, failures: [{ error: 'no phone' }] }) };
  const countOk = { name: 'countok', defaultTime: '08:00', run: async () => ({ sent: 3, failed: 1 }) };
  const r = await tick('2026-11-03T01:10:00Z', [someFailed, allFailed, quiet, countFailed, failuresList, countOk], [users.a]);
  assert.deepEqual(r.map((x) => [x.job, x.status]), [
    ['partial', 'ok'], ['allfail', 'failed'], ['quiet', 'skipped'], ['countfail', 'failed'], ['failures', 'failed'], ['countok', 'ok'],
  ]);
  assert.equal((await runRow(users.a, 'countfail'))[0].error, '2 failed');
  assert.equal((await runRow(users.a, 'failures'))[0].error, '1 failed: no phone');
  const [p] = await runRow(users.a, 'partial');
  assert.deepEqual(JSON.parse(p.result), { sent: 1, skipped: 1, failed: [{ ref: 'S1', error: 'no phone' }] });
  const [f] = await runRow(users.a, 'allfail');
  assert.equal(f.error, '2 failed: no phone; twilio');
  const [q] = await runRow(users.a, 'quiet');
  assert.deepEqual([q.status, q.error, q.result], ['skipped', 'nothing to report', null]);

  const { job } = recorder('creds');
  const out = await scheduler.runDue({
    now: new Date('2026-11-03T01:10:00Z'), jobs: [job], twilio: stubTwilio(),
    erpFor: (u) => { if (u.id === users.a.id) throw new Error('no base URL'); return {}; },
  });
  const status = Object.fromEntries(out.map((x) => [x.user_id, x.status]));
  assert.equal(status[users.a.id], 'failed');
  assert.equal(status[users.b.id], 'ok');
});

test('scheduler: disabled jobs claim nothing, so switching on later the same day still runs', async () => {
  const flag = { on: false };
  const { calls, job } = recorder('switch', '08:00', { enabled: () => flag.on });
  assert.deepEqual(await tick('2026-11-03T01:00:00Z', [job], [users.a]), []);
  assert.deepEqual(await runRow(users.a, 'switch'), []);
  flag.on = true;
  await tick('2026-11-03T01:30:00Z', [job], [users.a]);
  assert.equal(calls.filter((c) => c.user === users.a.id).length, 1);
});

test('scheduler: job_prefs time/enabled per user; inactive, credless and junk-prefs users', async () => {
  await db.query('UPDATE users SET job_prefs = $2 WHERE id = $1', [users.a.id, JSON.stringify({ early: { time: '06:00' } })]);
  await db.query('UPDATE users SET job_prefs = $2 WHERE id = $1', [users.ny.id, JSON.stringify({ early: { enabled: false } })]);
  users.expired = await makeUser('+66301', { subscription_status: 'expired' });
  users.nocreds = await makeUser('+66302', { erpnext_api_key: null });
  users.junk = await makeUser('+66303', { job_prefs: '{not json' });
  const { job } = recorder('early');
  const all = [users.a, users.ny, users.expired, users.nocreds, users.junk];

  let r = await tick('2026-11-03T23:00:00Z', [job], all); // BKK 06:00 Nov 4
  assert.deepEqual(r.map((x) => x.user_id), [users.a.id]);
  r = await tick('2026-11-04T01:00:00Z', [job], all); // BKK 08:00 — junk user on the default time
  assert.deepEqual(r.map((x) => x.user_id), [users.junk.id]);
  r = await tick('2026-11-04T13:00:00Z', [job], all); // NY 08:00, but disabled there
  assert.deepEqual(r, []);
});

test('scheduler: zero jobs is a no-op; auto-loads *.job.js, skipping malformed files', async () => {
  assert.deepEqual(await scheduler.runDue({ now: new Date(), jobs: [] }), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'berpal-jobs-'));
  try {
    fs.writeFileSync(path.join(dir, 'hello.job.js'),
      "module.exports = { name: 'hello', defaultTime: '09:30', window: 45, async run() { return { skipped: true }; } };\n");
    fs.writeFileSync(path.join(dir, 'odd.job.js'), "module.exports = { name: 'odd', defaultTime: '10:00', window: 'soon', run() {} };\n");
    fs.writeFileSync(path.join(dir, 'bad.job.js'), "module.exports = { name: 'bad', run() {} };\n");
    fs.writeFileSync(path.join(dir, 'broken.job.js'), 'module.exports = {;\n');
    fs.writeFileSync(path.join(dir, 'helper.js'), "module.exports = { name: 'helper', defaultTime: '01:00', run() {} };\n");
    const jobs = scheduler.loadJobs(dir);
    assert.deepEqual(jobs.map((j) => j.name), ['hello', 'odd']);
    assert.equal(scheduler.jobSetting({}, jobs[0]).window, 45);
    assert.equal(scheduler.jobSetting({}, jobs[1]).window, scheduler.DEFAULT_WINDOW_MIN, 'bad window → default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The real directory: the digest is always there; other lanes may add more.
  assert.ok(scheduler.loadJobs().some((j) => j.name === 'digest' && j.defaultTime === '08:00'));
});

test('scheduler: abandoned running rows are reaped; stop() waits for the in-flight tick', async () => {
  const at = new Date('2026-11-03T05:00:00Z');
  await db.query(
    `INSERT INTO job_runs (user_id, job, run_date, started_at, status) VALUES
       ($1, 'stale', '2026-11-03', '2026-11-03T04:00:00.000Z', 'running'),
       ($1, 'fresh', '2026-11-03', '2026-11-03T04:50:00.000Z', 'running')`,
    [users.b.id]
  );
  assert.equal(await scheduler.reapAbandoned(at), 1);
  assert.deepEqual((await runRow(users.b, 'stale')).map((x) => [x.status, x.error]), [['failed', 'abandoned']]);
  assert.equal((await runRow(users.b, 'fresh'))[0].status, 'running');

  const done = [];
  const slow = { name: 'slow', defaultTime: '08:00', run: async (user) => { await new Promise((r) => setTimeout(r, 30)); done.push(user.id); } };
  scheduler.start({ now: () => new Date('2026-12-01T01:00:00Z'), intervalMs: 5, jobs: [slow], twilio: stubTwilio(), erpFor: () => ({}) });
  await new Promise((r) => setTimeout(r, 5)); // let the first tick claim and start running
  await scheduler.stop();
  assert.ok(done.includes(users.a.id), 'stop() resolved only after the in-flight job finished');
  assert.equal((await runRow(users.a, 'slow'))[0].status, 'ok');
  // The tick in hand finished the user it was on but started no new user after stop().
  const slowUsers = (await db.query(`SELECT user_id FROM job_runs WHERE job = 'slow'`)).rows.map((x) => x.user_id);
  assert.deepEqual(slowUsers, [users.a.id]);
  await scheduler.stop(); // idempotent
});

// ── set_schedule_preferences ─────────────────────────────────────────

async function setPrefs(user, args) {
  const ctx = { user, draft: {} };
  const result = await executeTool('set_schedule_preferences', args, ctx);
  return { result, ctx };
}

test('set_schedule_preferences: validation', async () => {
  const user = await reload(users.a);
  let { result } = await setPrefs(user, {});
  assert.match(result.error, /Nothing to change/);
  ({ result } = await setPrefs(user, { time: '25:00' }));
  assert.match(result.error, /HH:MM/);
  ({ result } = await setPrefs(user, { time: '7:30pm' }));
  assert.match(result.error, /HH:MM/);
  for (const tz of ['Mars/Olympus_Mons', 'EST', 'Etc/GMT-8', '+08:00', 'Singapore']) {
    ({ result } = await setPrefs(user, { timezone: tz }));
    assert.match(result.error, /Unknown timezone/, tz);
  }
  ({ result } = await setPrefs(user, { job: 'payroll', time: '08:00' }));
  assert.match(result.error, /job must be one of/);
  ({ result } = await setPrefs(user, { enabled: 'no' }));
  assert.match(result.error, /true or false/);
  ({ result } = await setPrefs(user, { job: 'reminders', enabled: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /set_payment_settings/);
});

test('set_schedule_preferences: digest time, timezone, off/on', async () => {
  let user = await reload(users.a);
  let { result, ctx } = await setPrefs(user, { time: '7:30' });
  assert.equal(result.confirmation, 'Digest set for 07:30 Asia/Bangkok.');
  assert.equal(ctx.user.timezone, 'Asia/Bangkok');

  ({ result } = await setPrefs(user, { timezone: 'asia/singapore' }));
  assert.equal(result.confirmation, 'Digest set for 07:30 Asia/Singapore.');

  ({ result } = await setPrefs(user, { enabled: false }));
  assert.equal(result.confirmation, 'Digest turned off.');
  user = await reload(users.a);
  assert.equal(user.digest_enabled, 0);
  assert.equal(user.timezone, 'Asia/Singapore');
  assert.equal(scheduler.jobSetting(user, digest).enabled, false, 'scheduler won\'t claim a disabled digest');

  ({ result } = await setPrefs(user, { enabled: true }));
  assert.equal(result.confirmation, 'Digest set for 07:30 Asia/Singapore.');
  user = await reload(users.a);
  assert.deepEqual(scheduler.jobSetting(user, digest), { time: '07:30', window: 120, enabled: true });
});

test('set_schedule_preferences: reminders — time only; confirmation reflects users.reminders_enabled', async () => {
  let user = await reload(users.a);
  assert.equal(Number(user.reminders_enabled), 0);
  let { result } = await setPrefs(user, { job: 'reminders', time: '10:15', enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.confirmation, 'Customer payment reminders set for 10:15 Asia/Singapore (currently off).');
  assert.match(result.note, /set_payment_settings/);
  user = await reload(users.a);
  assert.equal(Number(user.reminders_enabled), 0, 'on/off is not changed here');
  assert.deepEqual(JSON.parse(user.job_prefs).reminders, { time: '10:15' });

  await db.query('UPDATE users SET reminders_enabled = 1 WHERE id = $1', [users.a.id]);
  ({ result } = await setPrefs(await reload(users.a), { job: 'reminders', time: '09:45' }));
  assert.equal(result.confirmation, 'Customer payment reminders set for 09:45 Asia/Singapore.');
  assert.equal(result.note, undefined);
});

test('prompt section reflects current settings and the job default time', () => {
  const render = require('../src/prompt/40-digest');
  assert.match(render({ user: { timezone: 'Asia/Tokyo', job_prefs: null, digest_enabled: 1 } }), /morning digest at 08:00, timezone Asia\/Tokyo/);
  assert.match(render({ user: { job_prefs: '{"digest":{"time":"07:30"}}', digest_enabled: 0 } }), /morning digest OFF/);
  assert.match(render({}), /set_payment_settings/);
});

// ── many items ───────────────────────────────────────────────────────

test('digest counts stay right with > 50 open items', async () => {
  // 54 more overdue invoices (55 total) push every due-soon row out of the 50-row page.
  for (let i = 0; i < 54; i++) {
    erp.create('Sales Invoice', {
      customer: 'Jameel Gems', currency: 'THB', docstatus: 1, set_posting_time: 1,
      posting_date: addDays(TODAY, -40), due_date: addDays(TODAY, -2),
      items: [{ item_code: 'Goods', qty: 1, rate: 100, income_account: '4110 - Sales - TC' }],
    });
  }
  erp.create('Purchase Invoice', {
    supplier: 'Acme Supplies', currency: 'THB', docstatus: 1, set_posting_time: 1,
    posting_date: addDays(TODAY, -10), due_date: addDays(TODAY, 5),
    items: [{ item_code: 'Goods', qty: 1, rate: 700, expense_account: '5111 - Cost of Goods Sold - TC' }],
  });
  const text = await digest.buildDigest(users.owner, erpnext.forUser(users.owner), { clock: { date: TODAY } });
  const lines = text.split('\n');
  const o = lines.indexOf('Overdue (55):');
  assert.ok(o > 0, text);
  assert.equal(lines[o + 4], '- …and 52 more');
  const d = lines.indexOf('Due next 7 days (2):');
  assert.ok(d > 0, 'due-soon section never vanishes');
  assert.equal(lines[d + 1], '- 2 items, ask me for the list');
  assert.ok(lines.length <= 14);
});

test('scheduler: each run gets its own ERPNext client carrying the run\'s timeout signal', async () => {
  const seen = [];
  const job = { name: 'erpsignal', defaultTime: '08:00', run: async (user, { erp, signal }) => { seen.push({ user: user.id, erp, signal }); } };
  const erpFor = (user, opts) => ({ forUser: user.id, opts });
  const u = await makeUser('+66999');
  await tick('2026-11-03T01:10:00Z', [job], [u], { erpFor });
  const mine = seen.find((s) => s.user === u.id);
  assert.ok(mine, 'job ran for the user');
  assert.ok(mine.signal instanceof AbortSignal);
  assert.equal(mine.erp.opts.signal, mine.signal, 'erpFor(user, { signal }) got this run\'s deps.signal');
});

test('erpnext.forUser(user, { signal }): the default signal reaches every request', async () => {
  const ac = new AbortController();
  const client = erpnext.forUser({ erpnext_api_key: 'k', erpnext_api_secret: 's', erpnext_company: COMPANY }, { signal: ac.signal });
  const real = global.fetch;
  const signals = [];
  global.fetch = async (url, opts) => {
    signals.push(opts.signal);
    return { ok: true, status: 200, text: async () => '{"data":[]}' };
  };
  try {
    await client.listResource('Customer');
    assert.equal(signals[0].aborted, false);
    ac.abort(new Error('timeout'));
    await client.listResource('Customer');
    assert.equal(signals[1].aborted, true, 'an aborted job signal aborts later ERPNext calls');
    // A per-call signal still works alongside it.
    const plain = erpnext.forUser({ erpnext_api_key: 'k', erpnext_api_secret: 's' });
    await plain.listResource('Customer');
    assert.equal(signals[2].aborted, false, 'no default signal → only the request timeout');
  } finally {
    global.fetch = real;
  }
});

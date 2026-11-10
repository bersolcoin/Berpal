/**
 * Accountant review queue (src/trust/review.js + list_review_queue / mark_reviewed): paging,
 * the "mark all" count guard, the reviewed Comment, retention, and the digest's trailing line.
 * Postgres (pg-mem) + in-memory ERPNext (test/fake-erpnext.js).
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const { executeTool } = require('../src/tools');
const review = require('../src/trust/review');
const duplicates = require('../src/trust/duplicates');
const digest = require('../src/jobs/digest.job');
const wallets = require('../src/wallets');

const erp = new FakeErpNext();
let phoneSeq = 0;
let nameSeq = 0;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isoDaysAgo = (now, days) => new Date(now.getTime() - days * 86400000).toISOString();

async function newUser(phone = `+6691000${++phoneSeq}`) {
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ($1, $2, 'k', 's', 'THB', 'THB', 'TH', $3, $3) RETURNING *`,
    [phone, COMPANY, now]
  );
  return r.rows[0];
}

/**
 * A pending row as markPosted would leave it, with the document itself in the fake ERPNext (a
 * Comment needs its reference to exist); `createdAt` lets a test age it.
 */
async function pending(user, { name = `ACC-JV-2026-${String(++nameSeq).padStart(5, '0')}`, date = TODAY, createdAt = null, ...rest } = {}) {
  if (!erp.get('Journal Entry', name)) erp._put('Journal Entry', { name, doctype: 'Journal Entry', docstatus: 1, posting_date: date });
  const row = await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: name, direction: 'expense',
    amount: 1200, currency: 'THB', baseAmount: 1200, transactionDate: date, counterpartyName: 'Foodland', ...rest,
  });
  if (createdAt) await db.query('UPDATE trust_fingerprints SET created_at = $2 WHERE id = $1', [row.id, createdAt]);
  return name;
}

async function statuses(user) {
  const r = await db.query('SELECT erpnext_name, review_status, reviewed_at, reviewed_by, review_note FROM trust_fingerprints WHERE user_id = $1 ORDER BY id', [user.id]);
  return r.rows;
}

const ctxFor = (user) => ({ user, draft: {}, saved: null, cancelled: false, confirmationRequested: false });
const tool = (user, name, args) => executeTool(name, args, ctxFor(user));
const reviewedComments = (name) => erp.all('Comment').filter((c) => c.reference_name === name && /reviewed by/.test(c.content));

before(async () => {
  erp.install();
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
});

// ── listPending / pendingSummary ─────────────────────────────────────

test('listPending: oldest first by document date, total is the whole queue, limit pages, olderThanDays filters', async () => {
  const user = await newUser();
  const now = new Date();
  const c = await pending(user, { name: 'ACC-JV-C', date: addDays(TODAY, -1) });
  const a = await pending(user, { name: 'ACC-JV-A', date: addDays(TODAY, -9), createdAt: isoDaysAgo(now, 20) });
  const b = await pending(user, { name: 'ACC-JV-B', date: addDays(TODAY, -9), createdAt: isoDaysAgo(now, 5) });
  await pending(await newUser(), { name: 'ACC-JV-OTHER', date: addDays(TODAY, -30) });

  const all = await review.listPending(user.id, { now });
  assert.equal(all.total, 3);
  // Same date → posting order (id) breaks the tie.
  assert.deepEqual(all.rows.map((r) => r.erpnext_name), [a, b, c]);
  assert.equal(all.rows[0].amount, 1200, 'amount is numeric');
  assert.deepEqual(all.rows[0].warnings, [], 'warnings parsed');

  const page = await review.listPending(user.id, { limit: 2, now });
  assert.equal(page.total, 3, 'total is not the page size');
  assert.deepEqual(page.rows.map((r) => r.erpnext_name), [a, b]);

  const old = await review.listPending(user.id, { olderThanDays: 10, now });
  assert.deepEqual([old.total, old.rows.map((r) => r.erpnext_name)], [1, [a]]);
  await assert.rejects(() => review.listPending(null), /userId/);
});

test('pendingSummary: count, oldest document date, stale = pending longer than 14 days', async () => {
  const user = await newUser();
  const now = new Date();
  assert.deepEqual(await review.pendingSummary(user.id, { now }), { count: 0, oldest: null, stale: 0 });
  await pending(user, { date: addDays(TODAY, -3), createdAt: isoDaysAgo(now, 15) });
  await pending(user, { date: addDays(TODAY, -40), createdAt: isoDaysAgo(now, 13) });
  await pending(user, { date: addDays(TODAY, -1) });
  const s = await review.pendingSummary(user.id, { now });
  assert.deepEqual(s, { count: 3, oldest: addDays(TODAY, -40), stale: 1 });
  assert.equal(review.STALE_REVIEW_DAYS, 14);
});

// ── markReviewed ─────────────────────────────────────────────────────

test('markReviewed by names: case-insensitive, not_found / already_reviewed, another tenant\'s same name untouched', async () => {
  const user = await newUser();
  const other = await newUser();
  await pending(user, { name: 'ACC-JV-2026-00100' });
  await pending(user, { name: 'ACC-JV-2026-00101' });
  await pending(other, { name: 'ACC-JV-2026-00100' });

  const r = await review.markReviewed(null, {
    user, names: [' acc-jv-2026-00100 ', 'ACC-JV-2026-00100', 'ACC-JV-2026-00999'], reviewer: 'owner via whatsapp', note: '  VAT fixed  ',
  });
  assert.deepEqual(r, {
    ok: true, marked: [{ erpnext_name: 'ACC-JV-2026-00100', doctype: 'Journal Entry' }],
    already_reviewed: [], not_found: ['acc-jv-2026-00999'], comment_failures: 0, pending_after: 1,
  });
  const rows = await statuses(user);
  assert.equal(rows[0].review_status, 'reviewed');
  assert.equal(rows[0].reviewed_by, 'owner via whatsapp');
  assert.equal(rows[0].review_note, 'VAT fixed', 'note trimmed');
  assert.match(rows[0].reviewed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rows[1].review_status, 'pending');
  assert.equal((await statuses(other))[0].review_status, 'pending', 'other tenant untouched');

  const again = await review.markReviewed(null, { user, names: ['ACC-JV-2026-00100', 'ACC-JV-2026-00101'], reviewer: 'owner via line' });
  assert.deepEqual(again.marked, [{ erpnext_name: 'ACC-JV-2026-00101', doctype: 'Journal Entry' }]);
  assert.deepEqual(again.already_reviewed, ['ACC-JV-2026-00100']);
  assert.equal((await statuses(user))[0].reviewed_by, 'owner via whatsapp', 'a second pass does not rewrite the first review');

  // Long notes are cut to 300 chars; a blank note is null; more than 50 names → only the first 50.
  const long = await newUser();
  await pending(long, { name: 'ACC-JV-LONG' });
  await review.markReviewed(null, { user: long, names: ['ACC-JV-LONG'], reviewer: 'owner via whatsapp', note: 'x'.repeat(400) });
  assert.equal((await statuses(long))[0].review_note.length, review.MAX_NOTE_CHARS);
  const blank = await newUser();
  await pending(blank, { name: 'ACC-JV-BLANK' });
  await review.markReviewed(null, { user: blank, names: ['ACC-JV-BLANK'], reviewer: 'owner via whatsapp', note: '   ' });
  assert.equal((await statuses(blank))[0].review_note, null);
  const many = await newUser();
  const names = [];
  for (let i = 0; i < 55; i++) names.push(await pending(many, { name: `ACC-JV-MANY-${i}` }));
  const capped = await review.markReviewed(null, { user: many, names, reviewer: 'owner via whatsapp' });
  assert.equal(capped.marked.length, review.MAX_NAMES);
  assert.equal((await review.listPending(many.id)).total, 5);
});

test('markReviewed all: expectedCount must match the queue, otherwise count_changed and nothing changes', async () => {
  const user = await newUser();
  await pending(user, { name: 'ACC-JV-ALL-1' });
  await pending(user, { name: 'ACC-JV-ALL-2' });
  const stale = await review.markReviewed(null, { user, all: true, expectedCount: 1, reviewer: 'owner via whatsapp' });
  assert.deepEqual([stale.ok, stale.reason, stale.pending], [false, 'count_changed', 2]);
  assert.match(stale.error, /2 pending now/);
  assert.deepEqual((await statuses(user)).map((r) => r.review_status), ['pending', 'pending']);
  const missing = await review.markReviewed(null, { user, all: true, reviewer: 'owner via whatsapp' });
  assert.equal(missing.reason, 'count_changed', 'no expectedCount never marks');

  const ok = await review.markReviewed(null, { user, all: true, expectedCount: 2, reviewer: 'owner via whatsapp' });
  assert.deepEqual(ok.marked.map((m) => m.erpnext_name), ['ACC-JV-ALL-1', 'ACC-JV-ALL-2']);
  assert.deepEqual((await statuses(user)).map((r) => r.review_status), ['reviewed', 'reviewed']);
  assert.deepEqual(await review.listPending(user.id), { total: 0, rows: [] });
});

test('markReviewed all: scoped to the tenant (other users\' pending rows are neither counted nor touched); names are ignored', async () => {
  const user = await newUser();
  const other = await newUser();
  await pending(user, { name: 'ACC-JV-2026-00001' });
  await pending(other, { name: 'ACC-JV-2026-00001' });
  await pending(other, { name: 'ACC-JV-2026-00002' });
  // expectedCount 3 would be "everything in the table": only this user's single row counts.
  const crossTenant = await review.markReviewed(null, { user, all: true, expectedCount: 3, reviewer: 'owner via whatsapp' });
  assert.deepEqual([crossTenant.ok, crossTenant.reason, crossTenant.pending], [false, 'count_changed', 1]);
  const r = await review.markReviewed(null, { user, all: true, expectedCount: 1, names: ['ACC-JV-2026-00002'], reviewer: 'owner via whatsapp' });
  assert.deepEqual(r.marked, [{ erpnext_name: 'ACC-JV-2026-00001', doctype: 'Journal Entry' }]);
  assert.deepEqual((await statuses(other)).map((x) => x.review_status), ['pending', 'pending'], 'other tenant untouched by all=true');
  // An empty queue with expectedCount 0 is a consistent (if pointless) call: ok, nothing marked.
  assert.deepEqual(await review.markReviewed(null, { user, all: true, expectedCount: 0, reviewer: 'owner via whatsapp' }), { ok: true, marked: [], already_reviewed: [], not_found: [], comment_failures: 0, pending_after: 0 });
});

test('markReviewed by names: a same-name twin within one tenant resolves to the pending row', async () => {
  const user = await newUser();
  await pending(user, { name: 'ACC-JV-TWIN' });
  await review.markReviewed(null, { user, names: ['ACC-JV-TWIN'], reviewer: 'owner via whatsapp' });
  await db.query(
    `INSERT INTO trust_fingerprints (user_id, doctype, erpnext_name, review_status, created_at) VALUES ($1, 'Sales Invoice', 'ACC-JV-TWIN', 'pending', $2)`,
    [user.id, new Date().toISOString()]
  );
  const r = await review.markReviewed(null, { user, names: ['ACC-JV-TWIN'], reviewer: 'owner via whatsapp' });
  assert.deepEqual(r.marked, [{ erpnext_name: 'ACC-JV-TWIN', doctype: 'Sales Invoice' }]);
  assert.deepEqual(r.already_reviewed, []);
  assert.deepEqual((await statuses(user)).map((x) => x.review_status), ['reviewed', 'reviewed']);
});

test('listPending: the interpolated LIMIT is always a sane integer', async () => {
  const user = await newUser();
  await pending(user);
  for (const limit of [Infinity, NaN, 'abc', 0, -3, 2.9, '1e999', 1e999]) {
    const r = await review.listPending(user.id, { limit });
    assert.equal(r.rows.length, 1, `limit ${String(limit)}`);
  }
});

test('markReviewed posts a Comment per marked document; a failing ERPNext neither throws nor undoes the review', async () => {
  const user = await newUser();
  await pending(user, { name: 'ACC-JV-CMT-1' });
  await pending(user, { name: 'ACC-JV-CMT-2' });
  const client = require('../src/erpnext').forUser(user);
  const r = await review.markReviewed(client, {
    user, names: ['ACC-JV-CMT-1', 'ACC-JV-CMT-2'], reviewer: 'owner via whatsapp', note: 'ok <b>&</b>',
  });
  assert.equal(r.comment_failures, 0);
  const today = new Date().toISOString().slice(0, 10);
  for (const name of ['ACC-JV-CMT-1', 'ACC-JV-CMT-2']) {
    const [c, ...more] = reviewedComments(name);
    assert.ok(c, `Comment on ${name}`);
    assert.equal(more.length, 0);
    assert.equal(c.comment_type, 'Comment');
    assert.equal(c.reference_doctype, 'Journal Entry');
    assert.equal(c.content, `Berpal: reviewed by owner via whatsapp on ${today}<br>Note: ok &lt;b&gt;&amp;&lt;/b&gt;`);
  }
  assert.equal(review.reviewedCommentText('owner via line', '2026-11-07T01:02:03Z', null), 'Berpal: reviewed by owner via line on 2026-11-07');

  const broken = await newUser();
  await pending(broken, { name: 'ACC-JV-CMT-3' });
  const failing = { createResource: async () => { throw new Error('ERPNext down'); } };
  const f = await review.markReviewed(failing, { user: broken, names: ['ACC-JV-CMT-3'], reviewer: 'owner via whatsapp' });
  assert.deepEqual(f.marked, [{ erpnext_name: 'ACC-JV-CMT-3', doctype: 'Journal Entry' }]);
  assert.equal(f.comment_failures, 1);
  assert.equal((await statuses(broken))[0].review_status, 'reviewed', 'DB change stands');
  assert.equal(reviewedComments('ACC-JV-CMT-3').length, 0);
});

test('retention: reviewed rows past 180 days are pruned on the next write, pending ones are kept', async () => {
  const user = await newUser();
  const now = new Date();
  const old = isoDaysAgo(now, duplicates.RETENTION_DAYS + 1);
  await pending(user, { name: 'ACC-JV-OLD-PENDING', createdAt: old });
  await pending(user, { name: 'ACC-JV-OLD-REVIEWED', createdAt: old });
  await review.markReviewed(null, { user, names: ['ACC-JV-OLD-REVIEWED'], reviewer: 'owner via whatsapp' });
  // recordFingerprint only touches created_at it reads, never reviewed_at: age is the posting age.
  assert.deepEqual((await statuses(user)).map((r) => r.erpnext_name), ['ACC-JV-OLD-PENDING', 'ACC-JV-OLD-REVIEWED']);
  await pending(user, { name: 'ACC-JV-NEW' });
  assert.deepEqual((await statuses(user)).map((r) => r.erpnext_name), ['ACC-JV-OLD-PENDING', 'ACC-JV-NEW']);
});

// ── tools ────────────────────────────────────────────────────────────

test('list_review_queue tool: plain items, days_pending, total vs shown, validation', async () => {
  const user = await newUser();
  const now = new Date();
  await pending(user, { name: 'ACC-JV-T-1', date: addDays(TODAY, -4), createdAt: isoDaysAgo(now, 3.5), warnings: ['New payee, first payment'] });
  await pending(user, { name: 'ACC-JV-T-2', date: addDays(TODAY, -2) });
  const r = await tool(user, 'list_review_queue', { limit: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.total, r.shown], [2, 1]);
  const { days_pending, ...item } = r.items[0];
  assert.deepEqual(item, {
    name: 'ACC-JV-T-1', doctype: 'Journal Entry', date: addDays(TODAY, -4), direction: 'expense', amount: 1200,
    currency: 'THB', counterparty: 'foodland', warnings: ['New payee, first payment'],
  });
  assert.equal(days_pending, 3);
  assert.deepEqual((await tool(user, 'list_review_queue', { older_than_days: 1 })).items.map((i) => i.name), ['ACC-JV-T-1']);
  assert.equal((await tool(user, 'list_review_queue', { limit: 500 })).shown, 2, 'limit is capped, not rejected');
  assert.equal((await tool(user, 'list_review_queue', { older_than_days: -1 })).ok, false);
  assert.deepEqual(await tool(await newUser(), 'list_review_queue', {}), { ok: true, total: 0, shown: 0, items: [] });
});

test('mark_reviewed tool: validation, reviewer from the channel, the count guard end to end', async () => {
  const user = await newUser();
  const lineUser = await newUser('line:U1234567890abcdef');
  await pending(user, { name: 'ACC-JV-M-1' });
  await pending(lineUser, { name: 'ACC-JV-M-L' });

  for (const args of [{}, { names: [] }, { names: [42, ''] }, { all: true }, { all: true, expected_count: 'two' }, { all: false }]) {
    const r = await tool(user, 'mark_reviewed', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, /names|expected_count/);
  }
  assert.equal((await statuses(user))[0].review_status, 'pending', 'rejected calls change nothing');
  assert.match((await tool(user, 'mark_reviewed', { names: Array.from({ length: 51 }, (_, i) => `X-${i}`) })).error, /At most 50/);

  const guard = await tool(user, 'mark_reviewed', { all: true, expected_count: 3 });
  assert.deepEqual([guard.ok, guard.reason, guard.pending], [false, 'count_changed', 1]);
  // count_changed carries the current queue so the model can re-show it and ask in the same turn.
  assert.deepEqual([guard.total, guard.shown, guard.items.map((i) => i.name)], [1, 1, ['ACC-JV-M-1']]);

  const ok = await tool(user, 'mark_reviewed', { names: ['acc-jv-m-1'], note: 'checked by K.' });
  assert.deepEqual(ok.marked, [{ erpnext_name: 'ACC-JV-M-1', doctype: 'Journal Entry' }]);
  assert.equal((await statuses(user))[0].reviewed_by, 'owner via whatsapp');
  assert.match(reviewedComments('ACC-JV-M-1')[0].content, /^Berpal: reviewed by owner via whatsapp on \d{4}-\d{2}-\d{2}<br>Note: checked by K\.$/);

  const line = await tool(lineUser, 'mark_reviewed', { all: true, expected_count: 1 });
  assert.equal(line.ok, true);
  const row = (await statuses(lineUser))[0];
  assert.equal(row.reviewed_by, 'owner via line');
  assert.ok(!JSON.stringify(row).includes('U1234567890abcdef'), 'no raw address stored');
  assert.ok(!JSON.stringify(line).includes('U1234567890abcdef'), 'no raw address in the tool result');
});

test('mark_reviewed tool: expected_count as the model may send it (string, float, negative, 0, NaN)', async () => {
  const user = await newUser();
  await pending(user, { name: 'ACC-JV-EC-1' });
  await pending(user, { name: 'ACC-JV-EC-2' });
  for (const expected_count of [2.5, -2, 0, '2.0001', 'NaN', '']) {
    const r = await tool(user, 'mark_reviewed', { all: true, expected_count });
    assert.equal(r.ok, false, `expected_count ${JSON.stringify(expected_count)}`);
    assert.deepEqual((await statuses(user)).map((x) => x.review_status), ['pending', 'pending'], `nothing marked for ${JSON.stringify(expected_count)}`);
  }
  // all=false with names, all given as a string: not "all", so the names path (nothing marked for an empty list).
  assert.equal((await tool(user, 'mark_reviewed', { all: 'true', names: [] })).ok, false);
  // The number a model would copy from the list, possibly as a string.
  const ok = await tool(user, 'mark_reviewed', { all: true, expected_count: '2' });
  assert.equal(ok.marked.length, 2);
});

test('review tools never touch the draft or the pinned confirmation card', async () => {
  const user = await newUser();
  await pending(user, { name: 'ACC-JV-CARD-1' });
  const draft = { amount: 500, currency: 'THB', direction: 'expense', confirmation_pending: 'sig-abc', confirmation_sig: 'sig-abc', trust_warnings: ['x'] };
  const ctx = { ...ctxFor(user), draft: { ...draft } };
  assert.equal((await executeTool('list_review_queue', {}, ctx)).total, 1);
  assert.equal((await executeTool('mark_reviewed', { names: ['ACC-JV-CARD-1'] }, ctx)).marked.length, 1);
  assert.deepEqual(ctx.draft, draft, 'draft (and confirmation_pending) unchanged');
  assert.deepEqual([ctx.saved, ctx.cancelled, ctx.confirmationRequested], [null, false, false]);
});

// ── digest ───────────────────────────────────────────────────────────

test('digest: "Awaiting accountant review" trails a digest that has content, and never stands alone', async () => {
  const user = await newUser();
  const now = new Date();
  // Drive the cash section through a stubbed wallet list (as test/jobs.test.js does).
  const build = async (accounts) => {
    const fakeErp = { company: COMPANY };
    const bal = Object.fromEntries(accounts.map((a) => [a.erpnext_account, a.balance]));
    const orig = wallets.list;
    wallets.list = async () => accounts;
    fakeErp.getAccountBalance = async (acc) => ({ message: bal[acc] });
    fakeErp.listResource = async () => ({ data: [] });
    fakeErp.listAccounts = async () => ({ data: [] });
    try {
      return await digest.buildDigest(user, fakeErp, { now, clock: { date: TODAY } });
    } finally {
      wallets.list = orig;
    }
  };
  const kbank = { id: 1, name: 'KBank', type: 'Bank', currency: 'THB', erpnext_account: 'KBank', balance: 500 };

  assert.equal(await build([]), null, 'empty books, empty queue');
  await pending(user, { name: 'ACC-JV-D-1', date: '2026-11-03' });
  await pending(user, { name: 'ACC-JV-D-2', date: '2026-11-05' });
  assert.equal(await build([]), null, 'the queue alone is not a digest');
  const text = await build([kbank]);
  assert.equal(text.split('\n').pop(), 'Awaiting accountant review: 2 (oldest 3 Nov)');
  await review.markReviewed(null, { user, all: true, expectedCount: 2, reviewer: 'owner via whatsapp' });
  assert.doesNotMatch(await build([kbank]), /Awaiting accountant review/, 'no line once the queue is empty');
});

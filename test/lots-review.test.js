/**
 * Stock entries of lot operations in the accountant's review queue (trust/review.markStockPosted,
 * list_review_queue, mark_reviewed), the open stock mismatches as the queue's second kind of
 * item, and the gem lines of the morning digest (src/lots/digest.js, jobs/digest.job.js).
 *
 * One gems user against one fake company; the tests build on each other in file order. The
 * last test is a general-ledger user: nothing here may change for them.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const store = require('../src/lots/store');
const undo = require('../src/lots/undo');
const reconcile = require('../src/lots/reconcile');
const custody = require('../src/lots/custody');
const lotsDigest = require('../src/lots/digest');
const review = require('../src/trust/review');
const duplicates = require('../src/trust/duplicates');
const digest = require('../src/jobs/digest.job');
const wallets = require('../src/wallets');
const tools = require('../src/tools');

const { N, TODAY } = h;
const erp = new FakeErpNext();
let user; let client;
let cut;      // { op, entry, reference }: R1 cut into C1
let memo;     // { op, entry, reference }: R2 sent out on memo, then taken back
let bill;     // a money document in the same queue
let issue;    // the Material Issue the accountant made outside Berpal

const lot = (code) => store.getLot(user.id, code);
const tool = (u, name, args = {}) => tools.executeTool(name, args, h.ctxFor(u));
const prints = (u = user) => db.query('SELECT * FROM trust_fingerprints WHERE user_id = $1 ORDER BY id', [u.id]).then((r) => r.rows);
const comments = (name) => erp.all('Comment').filter((c) => c.reference_name === name).map((c) => c.content.split('<br>'));
const day = () => new Date().toISOString().slice(0, 10);
const QUEUE_KEYS = ['name', 'doctype', 'date', 'direction', 'amount', 'currency', 'counterparty', 'warnings', 'days_pending'];

/** A posted Journal Entry with its pending queue row, as a money document leaves it. */
async function moneyDoc(u) {
  const je = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.MISC, debit_in_account_currency: 1200 }, { account: N.CASH, credit_in_account_currency: 1200 }],
  });
  await duplicates.recordFingerprint({
    userId: u.id, doctype: 'Journal Entry', erpnextName: je.data.name, direction: 'expense',
    amount: 1200, currency: 'THB', baseAmount: 1200, transactionDate: TODAY, counterpartyName: 'Foodland',
  });
  return je.data.name;
}

/** The digest for books with no money in them (as test/review-queue.test.js drives it). */
async function emptyBooksDigest(u, date = TODAY) {
  const fakeErp = { company: h.COMPANY, getAccountBalance: async () => ({ message: 0 }), listResource: async () => ({ data: [] }), listAccounts: async () => ({ data: [] }) };
  const orig = wallets.list;
  wallets.list = async () => [];
  try {
    return await digest.buildDigest(u, fakeErp, { now: new Date(), clock: { date } });
  } finally {
    wallets.list = orig;
  }
}

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  const r1 = await h.seedLot(user, client, { code: 'R1', carats: 100, cost: 50000, pieces: 20 });
  const r2 = await h.seedLot(user, client, { code: 'R2', carats: 40, cost: 20000 });

  // R1 cut into C1, fee 2,400 through the holding account, on both sides.
  const fee = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 2400 }, { account: N.CASH, credit_in_account_currency: 2400 }],
  });
  await client.createResource('Batch', { batch_id: 'C1-TC', item: N.CUT });
  const repack = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 100, s_warehouse: N.STORES, batch_no: 'R1-TC' }),
    h.valued({ item_code: N.CUT, qty: 25, t_warehouse: N.STORES, batch_no: 'C1-TC', basic_amount: 50000 }),
  ], { additional_costs: [{ expense_account: N.VALUATION, description: 'Cutting fee', amount: 2400 }] });
  const cutOp = h.resolvedOp({
    kind: 'transform', job: 'cutting', fee: { amount: 2400, capitalised: 2400, basis: 'fixed' }, yield_pct: 25, loss_carats: 75,
    note: 'rush & careful', warnings: ['Weight of C1 is estimated'],
    inputs: [h.input(r1)], outputs: [h.output({ code: 'C1', carats: 25, pieces: 30, cost: 52400, form: 'cut' })],
  });
  const cutDone = await h.recordPosted(user, cutOp, { docs: [{ doctype: 'Journal Entry', name: fee.data.name }, { doctype: 'Stock Entry', name: repack.name }] });
  cut = { op: cutOp, entry: repack.name, reference: cutDone.op.reference };

  // R2 sent out on memo, on both sides.
  const transfer = await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 40, s_warehouse: N.STORES, t_warehouse: N.MEMO, batch_no: 'R2-TC' })]);
  const memoOp = h.resolvedOp({
    kind: 'move', direction: 'out_memo', holder: N.CUSTOMER, due_date: '2026-12-01', memo_price_per_ct: 900,
    inputs: [h.input(r2)], outputs: [h.output({ lot: r2, carats: 40, cost: 20000, to: 'memo' })],
  });
  const memoDone = await h.recordPosted(user, memoOp, { docs: [{ doctype: 'Stock Entry', name: transfer.name }] });
  memo = { op: memoOp, entry: transfer.name, reference: memoDone.op.reference };
});

// ── markStockPosted ────────────────────────────────────────────────────

test('a saved operation: a pending queue row and a Comment that says what it did', async () => {
  const doc = { doctype: 'Stock Entry', erpnext_name: cut.entry };
  const r = await review.markStockPosted(client, { user, doc, op: cut.op, reference: cut.reference, warnings: ['Yield is low for cutting', 'Weight of C1 is estimated'] });
  const [row] = await prints();
  assert.equal(r.fingerprint.id, row.id);
  assert.deepEqual(
    [row.doctype, row.erpnext_name, row.direction, Number(row.amount), row.currency, row.base_amount, row.transaction_date, row.counterparty_name, row.receipt_hash, row.review_status],
    ['Stock Entry', cut.entry, 'stock', 52400, 'THB', null, TODAY, null, null, 'pending']
  );
  assert.deepEqual(JSON.parse(row.warnings), ['Weight of C1 is estimated', 'Yield is low for cutting']);
  assert.equal(r.comment.reference_name, cut.entry);
  assert.deepEqual(comments(cut.entry), [[
    'Berpal: posted from WhatsApp, awaiting accountant review',
    `Stock operation: cutting, ${TODAY} (Berpal ref ${cut.reference})`,
    'Lots in:',
    '- R1: 100 ct (the whole lot), 20 pcs, cost 50,000 THB',
    'Lots out:',
    '- C1: 25 ct, 30 pcs, cost 52,400 THB (new lot)',
    'Fee: 2,400 THB, included in the cost of the stones',
    'Yield: 25% (75 ct lost)',
    'Note: rush &amp; careful',
    'Warnings shown to the user:',
    '- Weight of C1 is estimated',
    '- Yield is low for cutting',
  ]]);

  // A second call for the same entry adds neither a row nor a Comment.
  const again = await review.markStockPosted(client, { user, doc, op: cut.op, reference: cut.reference });
  assert.deepEqual([again.fingerprint.id, again.comment], [row.id, null]);
  assert.equal((await prints()).length, 1);
  assert.equal(comments(cut.entry).length, 1);

  // Stock entries stay out of the duplicate guard and the amount medians.
  assert.deepEqual(await duplicates.medianByDirection(user.id, '2000-01-01'), {});
});

test('stones sent out: holder, due date and memo price are on the Comment; a part of a lot reads as a part', async () => {
  await review.markStockPosted(client, { user, doc: { doctype: 'Stock Entry', erpnext_name: memo.entry }, op: memo.op, reference: memo.reference });
  assert.deepEqual(comments(memo.entry), [[
    'Berpal: posted from WhatsApp, awaiting accountant review',
    `Stock operation: stones sent out on memo, ${TODAY} (Berpal ref ${memo.reference})`,
    'Lots in:',
    '- R2: 40 ct (the whole lot), cost 20,000 THB',
    'Lots out:',
    '- R2: 40 ct, cost 20,000 THB, out on memo',
    `With: ${N.CUSTOMER}, due 2026-12-01, memo price 900 per ct`,
  ]]);
  assert.equal(Number((await prints())[1].amount), 20000);

  // Never throws, whatever it is handed: no ERPNext, an ERPNext that refuses the Comment, no user.
  const other = await h.addUser();
  const c1 = await lot('C1');
  const part = h.resolvedOp({
    kind: 'write_off', reason: 'chipped', loss_carats: 1.5, inputs: [h.input(c1, { carats: 1.5, pieces: 2 })],
    fee: { amount: 300, capitalised: 100, basis: 'fixed' },
  });
  const refusing = Object.create(client);
  refusing.createResource = async () => { throw new Error('[erpnext POST /api/resource/Comment] 500'); };
  const a = await review.markStockPosted(refusing, { user: other, doc: { doctype: 'Stock Entry', erpnext_name: cut.entry }, op: part, reference: 'BPL-X' });
  assert.deepEqual([a.fingerprint.direction, Number(a.fingerprint.amount), a.comment], ['stock', 3144, null]);
  const b = await review.markStockPosted(null, { user: other, doc: { doctype: 'Stock Entry', erpnext_name: 'MAT-STE-NONE' }, op: null, reference: 'BPL-Y' });
  assert.deepEqual([Number(b.fingerprint.amount), b.comment], [0, null]);
  assert.deepEqual(await review.markStockPosted(client, { doc: { doctype: 'Stock Entry', erpnext_name: cut.entry }, op: part, reference: 'BPL-Z' }), { fingerprint: null, comment: null });
  // The part, in words (on the same entry, for the other user):
  await review.markStockPosted(client, { user: await h.addUser(), doc: { doctype: 'Stock Entry', erpnext_name: cut.entry }, op: part, reference: 'BPL-W' });
  assert.deepEqual(comments(cut.entry)[1], [
    'Berpal: posted from WhatsApp, awaiting accountant review',
    `Stock operation: write-off, ${TODAY} (Berpal ref BPL-W)`,
    'Lots in:',
    '- C1: 1.5 ct of 25 ct, 2 pcs, cost 3,144 THB',
    'Fee: 300 THB, of which 100 THB went into the cost of the stones',
    'Weight lost: 1.5 ct',
    'Reason: chipped',
  ]);
  assert.equal((await prints()).length, 2, 'nothing of this landed in our user\'s queue');
});

test('an operation taken back: a Comment on the cancelled entry, and its queue row says so and stays', async () => {
  const plan = await undo.resolve(user, { kind: 'undo', reference: memo.reference });
  assert.equal(plan.ok, true);
  const done = await undo.run(user, client, plan.op);
  assert.equal(done.ok, true);
  assert.equal(erp.get('Stock Entry', memo.entry).docstatus, 2);

  const doc = { doctype: 'Stock Entry', erpnext_name: memo.entry };
  const r = await review.markStockPosted(client, { user, doc, op: plan.op, undoing: true, reference: done.reference });
  assert.deepEqual(comments(memo.entry)[1], [
    'Berpal: taken back from WhatsApp (undo)',
    `Taken back on ${day()}: stones sent out on memo of ${TODAY} (Berpal ref ${memo.reference}). This stock entry is cancelled.`,
    'The lots afterwards:',
    '- R2: 40 ct, cost 20,000 THB',
  ]);
  const row = (await prints())[1];
  assert.equal(r.fingerprint.id, row.id);
  assert.equal(row.review_status, 'pending');
  assert.deepEqual(JSON.parse(row.warnings), [`Taken back on ${day()} (undo): the stock entry is cancelled`]);
  await review.markStockPosted(null, { user, doc, op: plan.op, undoing: true, reference: done.reference });
  assert.equal(JSON.parse((await prints())[1].warnings).length, 1, 'said once');

  // An entry that never was in the queue does not enter it by being taken back.
  const seed = (await lot('R2')).erpnext_batch && erp.all('Stock Entry').find((e) => e.docstatus === 1 && e.items.some((i) => i.batch_no === 'R2-TC'));
  const none = await review.markStockPosted(client, { user, doc: { doctype: 'Stock Entry', erpnext_name: seed.name }, op: { ...plan.op, removed: ['X1', 'X2'] }, undoing: true, reference: 'BPL-OLD' });
  assert.equal(none.fingerprint, null);
  assert.equal(comments(seed.name)[0].pop(), '- X1, X2: removed');
  assert.equal((await prints()).length, 2);
});

// ── the queue ──────────────────────────────────────────────────────────

test('list_review_queue: stock entries beside money documents, each naming its operation', async () => {
  bill = await moneyDoc(user);
  const q = await tool(user, 'list_review_queue');
  assert.deepEqual(Object.keys(q), ['ok', 'total', 'shown', 'items']);
  assert.deepEqual([q.total, q.shown], [3, 3]);
  const by = Object.fromEntries(q.items.map((i) => [i.name, i]));
  assert.deepEqual(by[cut.entry], {
    name: cut.entry, doctype: 'Stock Entry', date: TODAY, direction: 'stock', amount: 52400, currency: 'THB', counterparty: null,
    warnings: ['Weight of C1 is estimated', 'Yield is low for cutting'], days_pending: 0, operation: 'cutting', reference: cut.reference,
  });
  assert.deepEqual(
    [by[memo.entry].operation, by[memo.entry].reference, by[memo.entry].taken_back, by[memo.entry].warnings.length],
    ['stones sent out on memo', memo.reference, true, 1]
  );
  // A money document is exactly what it always was.
  assert.deepEqual(Object.keys(by[bill]), QUEUE_KEYS);
  assert.deepEqual([by[bill].direction, by[bill].amount, by[bill].counterparty], ['expense', 1200, 'foodland']);
  // The digest's count is the same queue.
  assert.equal((await review.pendingSummary(user.id)).count, 3);
});

test('open stock mismatches: the queue\'s second kind of item, apart from the documents', async () => {
  // Both sides agree: nothing to show.
  assert.deepEqual((await reconcile.run(user, client)).mismatches, []);
  assert.deepEqual(Object.keys(await tool(user, 'list_review_queue')), ['ok', 'total', 'shown', 'items']);

  issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.CUT, qty: 5, s_warehouse: N.STORES, batch_no: 'C1-TC' })]);
  assert.equal((await reconcile.run(user, client)).opened, 2);
  const open = await reconcile.open(user);

  const q = await tool(user, 'list_review_queue');
  assert.deepEqual(Object.keys(q), ['ok', 'total', 'shown', 'items', 'stock_mismatches_total', 'stock_mismatches', 'stock_mismatches_note']);
  assert.deepEqual([q.total, q.shown, q.items.length, q.stock_mismatches_total], [3, 3, 3, 2]);
  assert.deepEqual(q.stock_mismatches.map((m) => [m.type, m.name, m.kind, m.lot, m.berpal, m.erpnext, m.first_seen, m.days_open]), [
    ['stock_mismatch', `LOT-CHECK-${open[0].id}`, 'carats', 'C1', 25, 20, day(), 0],
    ['stock_mismatch', `LOT-CHECK-${open[1].id}`, 'value', 'C1', 52400, 41920, day(), 0],
  ]);
  assert.equal(q.stock_mismatches[0].detail, 'Lot C1: Berpal has 25 ct, ERPNext has 20 ct in batch C1-TC.');
  assert.match(q.stock_mismatches_note, /not documents: they cannot be marked reviewed/);

  // older_than_days asks the same of both kinds.
  assert.deepEqual(Object.keys(await tool(user, 'list_review_queue', { older_than_days: 5 })), ['ok', 'total', 'shown', 'items']);
});

test('mark_reviewed: documents only; an open mismatch cannot be marked away', async () => {
  const [m1, m2] = (await reconcile.open(user)).map((m) => `LOT-CHECK-${m.id}`);

  const only = await tool(user, 'mark_reviewed', { names: [m1.toLowerCase(), ` ${m2} `] });
  assert.equal(only.ok, false);
  assert.match(only.error, new RegExp(`^${m1}, ${m2}: an open difference .* not a document: it cannot be marked reviewed .* Nothing was marked\\.$`));
  assert.deepEqual(only.not_reviewable.map((x) => x.name), [m1, m2]);
  assert.equal((await reconcile.open(user)).length, 2);
  assert.equal((await prints()).filter((p) => p.review_status === 'pending').length, 3);

  const mixed = await tool(user, 'mark_reviewed', { names: [bill, m1, 'LOT-CHECK-99999'] });
  assert.deepEqual(
    [mixed.ok, mixed.marked, mixed.not_found, mixed.not_reviewable.map((x) => x.name), mixed.pending_after, mixed.stock_mismatches_open],
    [true, [{ erpnext_name: bill, doctype: 'Journal Entry' }], ['lot-check-99999'], [m1], 2, 2]
  );

  // "All reviewed" is about the documents: the count guard counts them alone.
  const wrong = await tool(user, 'mark_reviewed', { all: true, expected_count: 4 });
  assert.deepEqual([wrong.ok, wrong.reason, wrong.pending, wrong.total], [false, 'count_changed', 2, 2]);
  const all = await tool(user, 'mark_reviewed', { all: true, expected_count: 2 });
  assert.deepEqual([all.ok, all.marked.map((x) => x.erpnext_name).sort(), all.pending_after, all.stock_mismatches_open], [true, [cut.entry, memo.entry].sort(), 0, 2]);
  assert.match(comments(cut.entry).pop()[0], /^Berpal: reviewed by owner via /);

  const q = await tool(user, 'list_review_queue');
  assert.deepEqual([q.total, q.items, q.stock_mismatches_total, q.stock_mismatches.map((m) => m.name)], [0, [], 2, [m1, m2]]);

  // They go when the nightly check no longer finds them, and only then.
  await client.cancelDoc('Stock Entry', issue.name);
  assert.equal((await reconcile.run(user, client)).closed, 2);
  assert.deepEqual(await tool(user, 'list_review_queue'), { ok: true, total: 0, shown: 0, items: [] });
  const gone = await tool(user, 'mark_reviewed', { names: [m1] });
  assert.deepEqual([gone.ok, gone.marked, gone.not_found, Object.keys(gone).includes('not_reviewable')], [true, [], [m1.toLowerCase()], false]);
});

// ── the digest ─────────────────────────────────────────────────────────

test('digest lines: silent when clean; stones out too long, an operation not finished, open mismatches', async () => {
  assert.deepEqual(await lotsDigest.lines(user, { today: TODAY }), []);
  assert.equal(await emptyBooksDigest(user), null, 'clean stock in empty books is no digest');

  // Differences with ERPNext (the nightly job found them)
  issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.CUT, qty: 5, s_warehouse: N.STORES, batch_no: 'C1-TC' })]);
  await reconcile.run(user, client);
  assert.deepEqual(await lotsDigest.lines(user, { today: TODAY }), ['Stock check: 2 differences between your lots and the books, for the accountant (C1)']);

  // Stones out past their date (Berpal's own record is all the digest reads)
  const out = async (code, holder, due) => {
    const l = await lot(code);
    await h.recordPosted(user, h.resolvedOp({
      kind: 'move', direction: 'out_memo', holder, date: '2026-01-10', due_date: due,
      inputs: [h.input(l)], outputs: [h.output({ lot: l, carats: l.carats, cost: l.cost, to: 'memo' })],
    }));
  };
  await out('R2', 'Khun Lek', '2026-02-01');
  assert.deepEqual(await lotsDigest.lines(user, { today: '2026-02-01' }), ['Stock check: 2 differences between your lots and the books, for the accountant (C1)'], 'due today is not late');
  assert.deepEqual(await lotsDigest.lines(user, { today: '2026-02-02' }), [
    'Stones out too long: 1 lot (Khun Lek)',
    'Stock check: 2 differences between your lots and the books, for the accountant (C1)',
  ]);
  for (const [i, holder] of ['khun lek', 'Siam Jewels', 'A Trader With A Very Long Company Name Ltd', 'Dao', 'Fon'].entries()) {
    await h.recordPosted(user, h.resolvedOp({ kind: 'buy', date: '2026-01-05', counterparty: N.SUPPLIER, outputs: [h.output({ code: `M${i}`, carats: 2, cost: 100 })] }));
    await out(`M${i}`, holder, '2026-02-01');
  }
  assert.equal((await lotsDigest.lines(user, { today: TODAY }))[0], 'Stones out too long: 6 lots (Khun Lek, Siam Jewels, A Trader With A Very Lo… +2 more)');

  // An operation that is only partly saved
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'transform', job: 'heating', inputs: [h.input(await lot('C1'))] }) });
  const three = await lotsDigest.lines(user, { today: TODAY });
  assert.deepEqual(three, [
    'Stones out too long: 6 lots (Khun Lek, Siam Jewels, A Trader With A Very Lo… +2 more)',
    `Not finished: heating ${begun.reference} was only partly saved, say "retry" to finish it`,
    'Stock check: 2 differences between your lots and the books, for the accountant (C1)',
  ]);
  assert.ok(three.every((l) => l.length <= 100 && !/\n/.test(l)), 'three short lines at most');
  assert.ok(three.every((l) => !/ERPNext|undoing|partial|pending/i.test(l)), 'plain words, no statuses');

  // In the digest they are news: they make one in otherwise empty books, ahead of the review line.
  await moneyDoc(user);
  const text = await emptyBooksDigest(user);
  assert.deepEqual(text.split('\n').slice(1), [...three, `Awaiting accountant review: 1 (oldest ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${TODAY}T12:00:00Z`))})`]);
  assert.match(text, /^Your books, /);
  assert.ok(digest.templateVariables(text, TODAY)[2].length < 400);

  // A part that cannot be read costs its own line only; a digest never fails on the stones.
  const overdue = custody.overdue;
  custody.overdue = async () => { throw new Error('db down'); };
  try {
    assert.deepEqual(await lotsDigest.lines(user, { today: TODAY }), three.slice(1));
  } finally {
    custody.overdue = overdue;
  }
  const lines = lotsDigest.lines;
  lotsDigest.lines = async () => { throw new Error('boom'); };
  try {
    // With no stock lines the books are empty again, and the review line never stands alone.
    assert.equal(await emptyBooksDigest(user), null);
  } finally {
    lotsDigest.lines = lines;
  }
});

// ── a money document an undo cancelled ─────────────────────────────────

test('markCancelled: a fee document that an undo cancelled leaves the queue and the duplicate guard, with a Comment', async () => {
  const je = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 2400 }, { account: N.CASH, credit_in_account_currency: 2400 }],
  });
  const doc = { doctype: 'Journal Entry', erpnext_name: je.data.name };
  await duplicates.recordFingerprint({
    userId: user.id, doctype: doc.doctype, erpnextName: doc.erpnext_name, direction: 'expense', amount: 2400, currency: 'THB',
    baseAmount: 2400, transactionDate: TODAY, counterpartyName: 'Somchai Cutting', receiptHash: 'feehash', warnings: ['Looks new'],
  });
  const guard = (receiptHash) => duplicates.findDuplicates(user.id, { amount: 2400, currency: 'THB', transactionDate: TODAY, counterpartyName: 'Somchai Cutting', receiptHash });
  const pending = async () => (await review.pendingSummary(user.id)).count;
  const was = await pending();
  assert.ok((await guard('feehash')).sameReceipt, 'before: the receipt matches');
  assert.ok((await guard()).similar, 'and so does the amount with the party');
  assert.ok((await review.listPending(user.id)).rows.some((r) => r.erpnext_name === doc.erpnext_name));

  const plan = { target: { kind: 'transform', job: 'cutting', date: TODAY } };
  const r = await review.markCancelled(client, { user, doc, op: plan, reference: 'BPL-FEE' });
  assert.equal(r.fingerprint.review_status, 'cancelled');
  assert.deepEqual([r.fingerprint.receipt_hash, r.fingerprint.counterparty_name, r.fingerprint.base_amount], [null, null, null]);
  assert.deepEqual(JSON.parse(r.fingerprint.warnings), ['Looks new', `Taken back on ${day()} (undo): the document is cancelled`]);
  assert.equal(await pending(), was - 1, 'out of the queue and out of the digest count');
  assert.equal((await review.listPending(user.id)).rows.some((x) => x.erpnext_name === doc.erpnext_name), false);
  assert.deepEqual([await guard('feehash'), await guard()], [{ sameReceipt: null, similar: null }, { sameReceipt: null, similar: null }], 'the same fee can be entered again without a warning');
  assert.deepEqual(comments(doc.erpnext_name), [[
    'Berpal: taken back from WhatsApp (undo)',
    `Taken back on ${day()} (Berpal ref BPL-FEE): this Journal Entry was cancelled because the stock operation it belonged to (cutting of ${TODAY}) was undone.`,
  ]]);

  // Again (a retry that finishes the undo): neither a second line nor a second Comment.
  const again = await review.markCancelled(client, { user, doc, op: plan, reference: 'BPL-FEE' });
  assert.equal(again.fingerprint.id, r.fingerprint.id);
  assert.equal(again.comment, null);
  assert.equal(JSON.parse(again.fingerprint.warnings).length, 2);
  assert.equal(comments(doc.erpnext_name).length, 1);

  // A cancelled document is not there to be marked reviewed.
  const marked = await tool(user, 'mark_reviewed', { names: [doc.erpnext_name] });
  assert.deepEqual([marked.marked, marked.already_reviewed, marked.not_found], [[], [], [doc.erpnext_name.toLowerCase()]]);

  // markStockPosted with undoing: true for a document that is not a stock entry does the same, and never throws.
  const je2 = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 100 }, { account: N.CASH, credit_in_account_currency: 100 }],
  });
  await duplicates.recordFingerprint({ userId: user.id, doctype: 'Journal Entry', erpnextName: je2.data.name, direction: 'expense', amount: 100, currency: 'THB', baseAmount: 100, transactionDate: TODAY, counterpartyName: 'Somchai Cutting' });
  const via = await review.markStockPosted(client, { user, doc: { doctype: 'Journal Entry', erpnext_name: je2.data.name }, op: plan, undoing: true, reference: 'BPL-FEE2' });
  assert.equal(via.fingerprint.review_status, 'cancelled');
  assert.equal(await pending(), was - 1);
  const refusing = Object.create(client);
  refusing.createResource = async () => { throw new Error('[erpnext POST /api/resource/Comment] 500'); };
  assert.deepEqual(await review.markCancelled(refusing, { user, doc: { doctype: 'Journal Entry', erpnext_name: 'ACC-JV-NONE' }, reference: 'BPL-X' }), { fingerprint: null, comment: null });
  assert.deepEqual(await review.markCancelled(null, { doc: { doctype: 'Journal Entry', erpnext_name: 'ACC-JV-NONE' } }), { fingerprint: null, comment: null });

  // The digest line for an operation whose undo stopped half way: plain words, no status.
  const [stuck] = await store.unfinishedOps(user.id);
  await store.markUndoing(stuck.id);
  const line = (await lotsDigest.lines(user, { today: TODAY })).find((l) => /^Not finished/.test(l));
  assert.equal(line, `Not finished: taking back heating ${stuck.reference} stopped half way, say "retry" to finish it`);
  assert.doesNotMatch(line, /ERPNext|undoing|partial|pending/i);
});

// ── everyone else ──────────────────────────────────────────────────────

test('a user who is not a gem trader: the queue, mark_reviewed and the digest are as they were', async () => {
  const general = await h.addUser({ niche: null });
  // Even with rows of every kind in the lot tables' neighbourhood, nothing gem is read for them.
  await db.query(
    "INSERT INTO lot_mismatches (user_id, kind, subject, lot_code, berpal, erpnext, detail, status, first_seen, last_seen) VALUES ($1, 'carats', 'Z1', 'Z1', '1', '2', 'x', 'open', $2, $2)",
    [general.id, new Date().toISOString()]
  );
  const [stray] = (await db.query('SELECT id FROM lot_mismatches WHERE user_id = $1', [general.id])).rows;
  const doc = await moneyDoc(general);

  const q = await tool(general, 'list_review_queue');
  assert.deepEqual(Object.keys(q), ['ok', 'total', 'shown', 'items']);
  assert.deepEqual(Object.keys(q.items[0]), QUEUE_KEYS);

  const r = await tool(general, 'mark_reviewed', { names: [doc, `LOT-CHECK-${stray.id}`] });
  assert.deepEqual(Object.keys(r), ['ok', 'marked', 'already_reviewed', 'not_found', 'comment_failures', 'pending_after']);
  assert.deepEqual([r.marked.length, r.not_found], [1, [`lot-check-${stray.id}`]]);

  assert.deepEqual(await lotsDigest.lines(general, { today: TODAY }), []);
  assert.equal(await emptyBooksDigest(general), null);
  assert.deepEqual(await tool(general, 'query_custody'), { ok: false, error: 'Unknown tool: query_custody' });
  assert.equal(tools.toolsFor(general).some((t) => /custody/.test(JSON.stringify(t))), false);
});

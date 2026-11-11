/**
 * Lot tracking end to end, the way a trader's week runs it: every step is a chat draft that goes
 * through the tools the model calls (request_confirmation, save_transaction, retry_stock_op), so
 * through the confirmation gate (src/lots/gate.js). Nothing is seeded through the store.
 *
 * The worked example of docs/parcel-lot-stock-design.md section 6, to the satang:
 *   buy L12 → sort by value into L13 + L14 → L13 to the cutter → back cut as L15 (fee into the
 *   cost) → sort into L16 + L17 → L16 out on memo → 5.5 ct of it sold.
 * Then the three things that go wrong in real life: a save ERPNext never answered (finished by
 * "retry"), a mistake taken back (undo), and an account without lot tracking.
 *
 * Tests share the lots and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const lots = require('../src/lots');
const { executeTool } = require('../src/tools');
const store = require('../src/lots/store');
const reconcile = require('../src/lots/reconcile');
const digest = require('../src/lots/digest');
const custody = require('../src/lots/custody');
const { applyDefaults } = require('../src/tools/validate');
const { localClock } = require('../src/jobs');

const { N, WORKED: W } = h;
const erp = new FakeErpNext();
let user;
let client;
let other; // a general-ledger account: no lots

const BLUE = { variety: 'sapphire', colour: 'blue' };
const lot = (code) => store.getLot(user.id, code);
/** What a trader would read off a lot. */
const facts = async (code) => {
  const l = await lot(code);
  return l && [l.status, l.carats, l.pieces, l.cost, l.location, l.holder];
};
const statusOf = (reference) => db.query('SELECT status FROM lot_ops WHERE user_id = $1 AND reference = $2', [user.id, reference]).then((r) => r.rows[0] && r.rows[0].status);
const queue = () => db.query('SELECT doctype, erpnext_name, review_status FROM trust_fingerprints WHERE user_id = $1 ORDER BY id', [user.id]).then((r) => r.rows);
const qty = (code, warehouse) => lot(code).then((l) => h.batchQty(client, l.erpnext_batch, warehouse));
const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** A tool call the way the model makes it (no arguments: these three act on the draft). */
const tool = (name, ctx) => executeTool(name, {}, ctx);

/** One turn asks for the card, the user's "yes" arrives on the next (handle() promotes the signature), then the save. */
async function confirm(ctx) {
  const asked = await tool('request_confirmation', ctx);
  assert.equal(asked.ok, true, asked.error);
  assert.equal(ctx.saved, null, 'nothing is saved before the user has answered the card');
  ctx.draft.confirmation_pending = ctx.draft.confirmation_sig;
  return { asked, saved: await tool('save_transaction', ctx) };
}
/** A draft through the gate that must end saved. */
async function saved(draft) {
  const ctx = h.ctxFor(user, draft);
  const { asked, saved: out } = await confirm(ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(ctx.draft, {}, 'the draft is cleared once it is in the books');
  return { ...out, card: asked.card.lines };
}
const op = (stockOp, extra = {}) => ({ stock_op: stockOp, ...extra });
const party = { counterparty_contact_skipped: true, payment_terms: 'net_30', currency: 'THB' };

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  other = await h.addUser({ niche: null });
});

// ── the worked example ────────────────────────────────────────────────

test('nothing reaches the books without a card answered on a later turn', async () => {
  const ctx = h.ctxFor(user, { transaction_type: 'bill_received', counterparty_name: N.SUPPLIER, ...party,
    items: [{ lot: { code: 'L12', carats: 200, form: 'rough', ...BLUE, price: 1500, pricing_basis: 'per_ct' } }] });
  const early = await tool('save_transaction', ctx);
  assert.equal(early.ok, false);
  assert.match(early.error, /No confirmation card has been sent/);

  const asked = await tool('request_confirmation', ctx);
  assert.equal(asked.ok, true, asked.error);
  // The card was sent this turn; the model calling save in the same turn has no confirmation to show.
  const sameTurn = await tool('save_transaction', ctx);
  assert.equal(sameTurn.ok, false);

  // The user changes the weight after the card: the old "yes" does not cover it.
  ctx.draft.confirmation_pending = ctx.draft.confirmation_sig;
  ctx.draft.items[0].lot.carats = 210;
  ctx.draft.amount = 315000;
  const changed = await tool('save_transaction', ctx);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /changed after the confirmation card/);

  assert.equal(await lot('L12'), null);
  assert.equal(erp.all('Purchase Invoice').length, 0);
});

test('buy: 200 ct of rough at 1,500 per ct is lot L12 in Stores, and a bill in the review queue', async () => {
  const r = await saved({ transaction_type: 'bill_received', counterparty_name: N.SUPPLIER, ...party,
    items: [{ lot: { code: 'L12', carats: 200, form: 'rough', ...BLUE, price: 1500, pricing_basis: 'per_ct' } }] });
  assert.ok(r.card.includes('Amount: 300,000 THB'), r.card.join('\n'));
  assert.ok(r.card.some((l) => /^- L12 .*200 ct, cost 300,000 THB = 1,500 per ct/.test(l)), r.card.join('\n'));
  assert.deepEqual(r.documents.map((d) => d.doctype), ['Purchase Invoice']);
  assert.deepEqual(await facts('L12'), ['active', 200, null, 300000, 'stores', null]);
  assert.equal(await qty('L12', N.STORES), 200);
  assert.deepEqual((await queue()).map((q) => [q.doctype, q.review_status]), [['Purchase Invoice', 'pending']]);
});

test('sort by value: L13 takes 270,000 of the cost, L14 the other 30,000', async () => {
  const r = await saved(op({ kind: 'split', inputs: [{ lot: 'L12' }], outputs: [{ carats: 120, value_per_ct: 3000 }, { carats: 80, value_per_ct: 500 }] }));
  // The trader hears about the new lots, and that L12 is used up rather than "0 ct".
  assert.deepEqual(r.lots.map((l) => [l.code, l.carats, l.cost]), W.split1.map((p) => [p.code, p.carats, p.cost]));
  assert.deepEqual(r.used_up, ['L12']);
  assert.match(r.note, /used_up/);
  assert.equal((await lot('L12')).status, 'closed');
  assert.equal(await qty('L13', N.STORES), 120);
  assert.equal(await qty('L14', N.STORES), 80);
});

test('to the cutter: L13 is still ours, in the cutter\'s hands', async () => {
  await saved(op({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L13' }], holder: N.CUTTER }));
  assert.deepEqual(await facts('L13'), ['active', 120, null, 270000, 'work', N.CUTTER]);
  assert.equal(await qty('L13', N.WORK), 120);
  assert.equal(await qty('L13', N.STORES), 0);
});

test('back cut: 30 ct in 42 stones, and the 2,400 fee is in the cost of L15, not in expenses', async () => {
  const r = await saved(op(
    { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30, pieces: 42 }], fee_basis: 'per_ct', fee_rate: 80 },
    { transaction_type: 'cash', direction: 'expense', counterparty_name: N.CUTTER, counterparty_contact_skipped: true, wallet_skipped: true, currency: 'THB' }
  ));
  assert.ok(r.card.includes('Yield: 25.0% (90 ct lost)'), r.card.join('\n'));
  assert.ok(r.card.includes('Fee: 2,400 THB (80 × 30 ct)'), r.card.join('\n'));
  assert.ok(r.card.includes('The fee goes into the cost of the stones.'), r.card.join('\n'));
  assert.deepEqual(r.documents.map((d) => d.doctype), ['Journal Entry', 'Stock Entry']);
  assert.deepEqual(await facts('L15'), ['active', 30, 42, W.cut.cost, 'stores', null]);
  assert.equal((await lot('L15')).form, 'cut');
  assert.equal(await qty('L15', N.STORES), 30);
  assert.equal(await qty('L13', N.WORK), 0);
});

test('sort the cut stones: L16 the fine eight carats, L17 the commercial rest', async () => {
  const r = await saved(op({ kind: 'split', inputs: [{ lot: 'L15' }], outputs: [{ carats: 8, pieces: 6, value_per_ct: 25000 }, { carats: 22, pieces: 36, value_per_ct: 5000 }] }));
  assert.deepEqual(r.lots.map((l) => [l.code, l.carats, l.pieces, l.cost]), [['L16', 8, 6, 175741.94], ['L17', 22, 36, 96658.06]]);
  assert.deepEqual(r.used_up, ['L15']);
});

test('out on memo: L16 is with the broker for 14 days, still our stock', async () => {
  const due = dayPlus(14);
  await saved(op({ kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16' }], holder: N.CUSTOMER, due_date: due, memo_price_per_ct: 28000 }));
  assert.deepEqual(await facts('L16'), ['active', 8, 6, 175741.94, 'memo', N.CUSTOMER]);
  const out = await custody.out(user);
  assert.deepEqual(out.map((g) => [g.holder, g.purpose, g.carats, g.cost]), [[N.CUSTOMER, 'memo', 8, 175741.94]]);
  assert.deepEqual(out[0].rows.map((c) => [c.lot, c.due_date, c.memo_price_per_ct, c.overdue]), [['L16', due, 28000, false]]);
  assert.equal(await qty('L16', N.MEMO), 8);
});

test('sold off the memo: 4 stones, 5.5 ct at 27,000; 2.5 ct in 2 stones stay out', async () => {
  const r = await saved({ transaction_type: 'invoice_issued', counterparty_name: N.CUSTOMER, ...party,
    items: [{ lot: { code: 'L16', carats: 5.5, pieces: 4, price: 27000, pricing_basis: 'per_ct' } }] });
  assert.ok(r.card.includes('Amount: 148,500 THB'), r.card.join('\n'));
  assert.deepEqual(r.documents.map((d) => d.doctype), ['Sales Invoice']);
  assert.deepEqual(await facts('L16'), ['active', W.sale.left_carats, 2, W.sale.left_cost, 'memo', N.CUSTOMER]);
  assert.equal(await qty('L16', N.MEMO), 2.5);
});

test('after the week: Berpal and ERPNext agree lot by lot, and the accountant has every document to review', async () => {
  const active = (await store.listLots(user.id, {})).filter((l) => l.status === 'active');
  assert.deepEqual(active.map((l) => l.code).sort(), ['L14', 'L16', 'L17']);
  // Nothing was lost on the way: what was paid for the stones and the cutting, less what was sold.
  const held = active.reduce((s, l) => s + l.cost, 0);
  assert.equal(Math.round(held * 100) / 100, Math.round((300000 + W.cut.fee - W.sale.cogs) * 100) / 100);

  const r = await reconcile.run(user, client);
  assert.deepEqual(r.mismatches, [], JSON.stringify(r.mismatches));
  assert.equal(r.checked >= 3, true);

  const q = await queue();
  assert.equal(q.every((x) => x.review_status === 'pending'), true);
  assert.deepEqual([...new Set(q.map((x) => x.doctype))].sort(), ['Journal Entry', 'Purchase Invoice', 'Sales Invoice', 'Stock Entry']);
  const ops = await db.query('SELECT kind, status FROM lot_ops WHERE user_id = $1 ORDER BY id', [user.id]);
  assert.deepEqual(ops.rows.map((o) => `${o.kind} ${o.status}`), ['buy posted', 'split posted', 'move posted', 'transform posted', 'split posted', 'move posted', 'sell posted']);
});

// ── when it goes wrong ────────────────────────────────────────────────

let stuck; // the reference of the operation ERPNext never answered

test('ERPNext does not answer: the trader is told it is NOT saved, and nothing else may touch the lots', async () => {
  const ctx = h.ctxFor(user, op({ kind: 'split', inputs: [{ lot: 'L17' }], outputs: [{ carats: 12, pieces: 20, value_per_ct: 6000 }, { carats: 10, pieces: 16, value_per_ct: 3800 }] }));
  ctx.erp = Object.assign(Object.create(client), {
    createResource: async (doctype, ...rest) => {
      if (doctype === 'Stock Entry') throw Object.assign(new Error('[erpnext POST /api/resource/Stock Entry] 504 timeout'), { status: 504 });
      return client.createResource(doctype, ...rest);
    },
  });
  const { saved: out } = await confirm(ctx);
  assert.equal(out.ok, false);
  assert.equal(out.partial, true);
  assert.match(out.error, /It is not known whether this reached the books/);
  assert.match(out.error, /NOT saved yet/);
  assert.match(out.error, /"retry"/);
  stuck = out.reference;
  assert.equal(await statusOf(stuck), 'partial');
  assert.deepEqual(await facts('L17'), ['active', 22, 36, 96658.06, 'stores', null], 'the lot is as it was');
  assert.equal(ctx.saved, null);

  // Another operation while this one hangs is refused, with the way out.
  const next = await tool('request_confirmation', h.ctxFor(user, op({ kind: 'write_off', inputs: [{ lot: 'L14', carats: 1 }], reason: 'lost' })));
  assert.equal(next.ok, false);
  assert.match(next.error, new RegExp(`${stuck}.*only partly saved.*retry_stock_op`));

  // The morning digest says the same in the trader's words.
  const lines = await digest.lines(user, client);
  assert.ok(lines.some((l) => /Not finished/.test(l) && /retry/.test(l)), JSON.stringify(lines));
});

test('"retry" finishes it, once, from the confirmation already given', async () => {
  const before = erp.all('Stock Entry').length;
  const r = await tool('retry_stock_op', h.ctxFor(user, {}));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reference, stuck);
  assert.equal(await statusOf(stuck), 'posted');
  assert.equal(erp.all('Stock Entry').length, before + 1);
  assert.deepEqual(r.lots.map((l) => [l.code, l.carats, l.pieces]), [['L18', 12, 20], ['L19', 10, 16]]);

  const again = await tool('retry_stock_op', h.ctxFor(user, {}));
  assert.equal(again.nothing_to_finish, true);
  assert.equal(erp.all('Stock Entry').length, before + 1);
});

test('a mistake taken back: the undo has its own card, puts L17 back and tells the accountant', async () => {
  const ctx = h.ctxFor(user, op({ kind: 'undo', reference: stuck }));
  const { asked, saved: out } = await confirm(ctx);
  assert.match(asked.card.lines[0], /^Take back: split of /);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.undone, true);
  assert.deepEqual(out.removed, ['L18', 'L19']);
  assert.deepEqual(out.lots.map((l) => [l.code, l.carats, l.pieces, l.cost]), [['L17', 22, 36, 96658.06]]);
  assert.match(out.note, /is taken back/);
  assert.equal(await statusOf(stuck), 'undone');
  assert.equal(await lot('L18'), null);
  assert.equal(await qty('L17', N.STORES), 22);
  const entry = out.documents[0].name;
  assert.ok(erp.all('Comment').some((c) => c.reference_name === entry && /taken back/.test(c.content)), 'the cancelled stock entry says so');
  assert.deepEqual((await reconcile.run(user, client)).mismatches, []);
});

test('an invoice for stones is never cancelled from chat: the accountant does that first', async () => {
  const sale = await db.query("SELECT reference FROM lot_ops WHERE user_id = $1 AND kind = 'sell'", [user.id]);
  const asked = await tool('request_confirmation', h.ctxFor(user, op({ kind: 'undo', reference: sale.rows[0].reference })));
  assert.equal(asked.ok, false);
  assert.match(asked.error, /accountant/i);
  assert.deepEqual(await facts('L16'), ['active', 2.5, 2, W.sale.left_cost, 'memo', N.CUSTOMER]);
});

// ── the core stays the core ───────────────────────────────────────────

test('an account without lot tracking: lot drafts are refused, and its dates stay as they were', async () => {
  const stock = await tool('request_confirmation', h.ctxFor(other, op({ kind: 'split', inputs: [{ lot: 'L14' }], outputs: [{ carats: 40 }, { carats: 40 }] })));
  assert.equal(stock.ok, false);
  assert.match(stock.error, /Lot tracking is not switched on for this account/);
  assert.equal((await tool('retry_stock_op', h.ctxFor(other, {}))).ok, false);

  const utc = new Date().toISOString().slice(0, 10);
  const general = { transaction_type: 'cash', direction: 'expense', amount: 100, currency: 'THB' };
  await applyDefaults(other, general);
  assert.equal(general.transaction_date, utc);
  assert.equal(lots.today(other), utc);

  // A gem account dates by its own day (Asia/Bangkok unless it set a timezone).
  const gem = { transaction_type: 'cash', direction: 'expense', amount: 100, currency: 'THB' };
  await applyDefaults(user, gem);
  assert.equal(gem.transaction_date, localClock(new Date(), user.timezone).date);
});

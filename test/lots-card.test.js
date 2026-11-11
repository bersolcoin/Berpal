/**
 * The lot confirmation card (src/lots/card.js): the lines the trader reads before saying yes.
 * The first cards are built from a prepared draft and a ResolvedOp made here by hand (the resolver
 * has its own tests); the numbers are the worked example of docs/parcel-lot-stock-design.md. The
 * last ones take the op from resolveDraft, so the card is checked against what will be written.
 * Tests share the lots and run in order: what one card describes, the next ones find recorded.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const store = require('../src/lots/store');
const { prepare } = require('../src/lots/draft');
const { applyDefaults } = require('../src/tools/validate');
const { build } = require('../src/lots/card');
const { resolveDraft } = require('../src/lots/resolve');
const { localClock } = require('../src/jobs');

const erp = new FakeErpNext();
let user;
let client;

const W = h.WORKED;
const DAY = h.TODAY.replace(/-/g, '/');
const BLUE = { variety: 'sapphire', colour: 'blue' };
const lot = (code) => store.getLot(user.id, code);

/** A draft as the gate hands it to the card: prepared, defaults applied. */
async function ready(draft) {
  assert.equal(await prepare(user, draft), null);
  await applyDefaults(user, draft);
  return draft;
}
const card = async (draft, op) => (await build(user, draft, h.resolvedOp(op), () => client)).lines;
// prepare changes the operation in place (it marks a derived fee), so each draft gets its own copy.
const stockDraft = (stockOp, extra = {}) => ready({ stock_op: JSON.parse(JSON.stringify(stockOp)), ...extra });
/** The fee of a job, paid in cash to the cutter. */
const feeDraft = (stockOp, extra = {}) => stockDraft(stockOp, {
  transaction_type: 'cash', direction: 'expense', category_code: '5010', currency: 'THB', counterparty_name: 'Lek', ...extra,
});

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  await h.seedLot(user, client, { ...W.buy, attrs: { ...BLUE, description: 'blue sapphire rough' } });
  await h.seedLot(user, client, { ...W.split2[0], form: 'cut', attrs: { ...BLUE, description: 'blue sapphire cut' } });
  await h.seedLot(user, client, { ...W.split2[1], form: 'cut' });
});

test('buying a lot: the bill card with the lot on its own line, cost per carat and the price as said', async () => {
  const draft = await ready({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0',
    currency: 'THB', transaction_date: h.TODAY,
    items: [{ lot: { carats: 200, form: 'rough', ...BLUE, price: 7500, pricing_basis: 'per_g' } }],
  });
  const op = { kind: 'buy', counterparty: h.N.SUPPLIER, outputs: [h.output({ code: 'L12', carats: 200, cost: 300000, line: 0, attrs: BLUE })] };
  assert.deepEqual(await card(draft, op), [
    `Date: ${DAY}`,
    'Amount: 300,000 THB',
    '- L12 blue sapphire rough: 200 ct, cost 300,000 THB = 1,500 per ct (7,500 per g)',
    'Type: Bill Received',
    `Account: Inventory → Payable to ${h.N.SUPPLIER}`,
    `Counterparty: ${h.N.SUPPLIER}`,
    `Due: ${DAY} (Net 0)`,
  ]);
});

test('buying two lots: one line each, an estimated weight and a piece count shown', async () => {
  const draft = await ready({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0',
    currency: 'THB', transaction_date: h.TODAY,
    items: [
      { lot: { carats: 200, form: 'rough', ...BLUE, price: 1500, pricing_basis: 'per_ct' } },
      { lot: { carats: 50, pieces: 10, form: 'rough', variety: 'ruby', price: 100000, pricing_basis: 'total', weight_estimated: true } },
    ],
  });
  const lines = await card(draft, { kind: 'buy', outputs: [
    h.output({ code: 'L20', carats: 200, cost: 300000, line: 0, attrs: BLUE }),
    h.output({ code: 'L21', carats: 50, pieces: 10, cost: 100000, line: 1, weight_estimated: true, attrs: { variety: 'ruby' } }),
  ] });
  assert.equal(lines[1], 'Amount: 400,000 THB');
  assert.deepEqual(lines.slice(2, 4), [
    '- L20 blue sapphire rough: 200 ct, cost 300,000 THB = 1,500 per ct',
    '- L21 ruby rough: 50 ct (estimated), 10 pcs, cost 100,000 THB = 2,000 per ct',
  ]);
});

test('selling part of a lot: what is taken, of how much, at what price per carat', async () => {
  const draft = await ready({
    transaction_type: 'invoice_issued', counterparty_name: h.N.CUSTOMER, counterparty_contact_skipped: true, payment_terms: 'net_0',
    currency: 'THB', transaction_date: h.TODAY,
    items: [{ lot: { code: W.sale.from, carats: W.sale.carats, price: 27000, pricing_basis: 'per_ct' } }],
  });
  const lines = await card(draft, { kind: 'sell', counterparty: h.N.CUSTOMER, inputs: [h.input(await lot('L16'), { carats: W.sale.carats, cost: W.sale.cogs })] });
  assert.deepEqual(lines.slice(0, 4), [
    `Date: ${DAY}`,
    'Amount: 148,500 THB',
    '- L16 blue sapphire cut: 5.5 ct of 8 ct @ 27,000 per ct',
    'Type: Invoice Sent',
  ]);
  assert.ok(lines.includes(`Counterparty: ${h.N.CUSTOMER}`));
});

test('split: what goes in, the parts with their cost per carat, and how the cost was shared', async () => {
  const stockOp = { kind: 'split', inputs: [{ lot: 'L12' }], outputs: W.split1.map((p) => ({ carats: p.carats, value: p.value })) };
  const op = {
    kind: 'split', inputs: [h.input(await lot('L12'))],
    // The parts inherit what the lot says about itself, as the resolver hands them over.
    outputs: W.split1.map((p) => h.output({ code: p.code, carats: p.carats, cost: p.cost, attrs: { ...BLUE, description: 'blue sapphire rough' } })),
  };
  const lines = await card(await stockDraft(stockOp), op);
  assert.deepEqual(lines, [
    'Sort / split a lot',
    `Date: ${DAY}`,
    'From:',
    '- L12 blue sapphire rough: 200 ct, cost 300,000 THB',
    'To:',
    '- L13 blue sapphire rough: 120 ct, cost 270,000 THB = 2,250 per ct',
    '- L14 blue sapphire rough: 80 ct, cost 30,000 THB = 375 per ct',
    'Cost shared by value (your figures)',
  ]);
  assert.equal((await card(await stockDraft(stockOp), { ...op, method: 'weight' })).at(-1), 'Cost shared by weight');
  // Taking one part out of a lot shares nothing, and sorting loss is said.
  const part = await card(await stockDraft({ kind: 'split', inputs: [{ lot: 'L12', carats: 50 }], outputs: [{ carats: 49.5 }] }), {
    kind: 'split', loss_carats: 0.5, inputs: [h.input(await lot('L12'), { carats: 50 })], outputs: [h.output({ code: 'L13', carats: 49.5, cost: 75000 })],
  });
  assert.deepEqual(part.slice(2), [
    'From:', '- L12 blue sapphire rough: 50 ct of 200 ct, cost 75,000 THB',
    'To:', '- L13 rough: 49.5 ct, cost 75,000 THB = 1,515.15 per ct',
    'Weight difference: 0.5 ct lost',
  ]);
  await h.recordPosted(user, h.resolvedOp(op));
});

test('sending stones out for work: who has them and when they are due back', async () => {
  const l13 = await lot('L13');
  const op = {
    kind: 'move', direction: 'out_work', holder: 'Lek', due_date: '2027-01-15',
    inputs: [h.input(l13)], outputs: [h.output({ lot: l13, carats: 120, cost: 270000, to: 'work' })],
  };
  const lines = await card(await stockDraft({ kind: 'move', direction: 'out_work', inputs: ['L13'], holder: 'Lek', due_date: '2027-01-15' }), op);
  assert.deepEqual(lines, [
    'Send out for work',
    `Date: ${DAY}`,
    'To: Lek',
    '- L13 blue sapphire rough: 120 ct, cost 270,000 THB',
    'Due back: 2027/01/15',
  ]);
  await h.recordPosted(user, h.resolvedOp(op));
});

test('cutting: where the stones are, the yield, the fee as quoted and that it goes into the cost', async () => {
  const stockOp = { kind: 'transform', job: 'cutting', inputs: ['L13'], outputs: [{ carats: W.cut.carats, pieces: W.cut.pieces }], fee_basis: 'per_ct', fee_rate: 80 };
  const op = {
    kind: 'transform', job: 'cutting', holder: 'Lek', yield_pct: W.cut.yield_pct, loss_carats: 90, fee: { amount: W.cut.fee, capitalised: W.cut.fee, basis: 'per_ct' },
    inputs: [h.input(await lot('L13'))],
    outputs: [h.output({ code: W.cut.code, carats: W.cut.carats, pieces: W.cut.pieces, cost: W.cut.cost, form: 'cut', attrs: BLUE })],
  };
  const draft = await feeDraft(stockOp);
  assert.equal(draft.amount, W.cut.fee);
  assert.deepEqual(await card(draft, op), [
    'Cutting',
    `Date: ${DAY}`,
    'From:',
    `- L13 blue sapphire rough: 120 ct, cost 270,000 THB (out for work with Lek since ${DAY})`,
    'To:',
    '- L15 blue sapphire cut: 30 ct, 42 pcs, cost 272,400 THB = 9,080 per ct',
    'Yield: 25.0% (90 ct lost)',
    'Fee: 2,400 THB (80 × 30 ct)',
    'Type: Expense',
    'Account: Cash → Cutting & treatment fees (added to stone cost)',
    'Counterparty: Lek',
    'The fee goes into the cost of the stones.',
  ]);

  // Quoted per stone, with stones that broke.
  const perPiece = await feeDraft({ ...stockOp, outputs: [{ carats: 30, pieces: 42, damaged_pieces: 2 }], fee_basis: 'per_piece', fee_rate: 50 });
  const broke = await card(perPiece, { ...op, fee: { amount: 2100, capitalised: 2100, basis: 'per_piece' }, outputs: [{ ...op.outputs[0], damaged_pieces: 2, cost: 272100 }] });
  assert.equal(broke[5], '- L15 blue sapphire cut: 30 ct, 42 pcs, 2 pcs damaged, cost 272,100 THB = 9,070 per ct');
  assert.equal(broke[7], 'Fee: 2,100 THB (50 × 42 pcs)');

  // A fee said as one sum has nothing to show the working of.
  const lump = await feeDraft({ ...stockOp, fee_basis: 'fixed', fee_rate: undefined }, { amount: 2400 });
  assert.equal((await card(lump, op))[7], 'Fee: 2,400 THB');
});

test('cutting: a fee only partly in the cost, a fee outside it, and no fee at all', async () => {
  const stockOp = { kind: 'transform', job: 'cutting', inputs: ['L13'], outputs: [{ carats: 30, pieces: 42 }] };
  const op = {
    kind: 'transform', job: 'cutting', holder: 'Lek', yield_pct: 25, loss_carats: 90,
    inputs: [h.input(await lot('L13'))], outputs: [h.output({ code: 'L15', carats: 30, pieces: 42, cost: 272400, form: 'cut', attrs: BLUE })],
  };
  const paid = await feeDraft(stockOp, { amount: 2568 });
  assert.equal((await card(paid, { ...op, fee: { amount: 2568, capitalised: 2400, basis: null } })).at(-1), 'Into the cost of the stones: 2,400 THB of the fee');
  assert.equal((await card(paid, { ...op, fee: { amount: 2568, capitalised: 0, basis: null } })).at(-1), 'The fee does not go into the cost of the stones.');

  const free = await card(await stockDraft(stockOp), { ...op, outputs: [{ ...op.outputs[0], cost: 270000 }] });
  assert.deepEqual(free.slice(5), ['- L15 blue sapphire cut: 30 ct, 42 pcs, cost 270,000 THB = 9,000 per ct', 'Yield: 25.0% (90 ct lost)', 'Fee: none']);
});

test('heating into two grades says how the cost was shared; a re-weigh shows the difference, no yield, no fee', async () => {
  const l14 = await lot('L14');
  const heated = await card(
    await stockDraft({ kind: 'transform', job: 'heating', inputs: ['L14'], outputs: [{ carats: 50, value: 3, treatment: 'H' }, { carats: 28, value: 1, treatment: 'H' }] }),
    { kind: 'transform', job: 'heating', yield_pct: 97.5, loss_carats: 2, inputs: [h.input(l14)], outputs: [
      h.output({ code: 'L22', carats: 50, cost: 22500, attrs: { ...BLUE, treatment: 'H' } }), h.output({ code: 'L23', carats: 28, cost: 7500, attrs: { ...BLUE, treatment: 'H' } }),
    ] }
  );
  assert.deepEqual(heated.slice(0, 1).concat(heated.slice(4)), [
    'Heating',
    'To:',
    '- L22 blue sapphire rough: 50 ct, cost 22,500 THB = 450 per ct',
    '  Details: treatment H',
    '- L23 blue sapphire rough: 28 ct, cost 7,500 THB = 267.86 per ct',
    '  Details: treatment H',
    'Yield: 97.5% (2 ct lost)',
    'Cost shared by value (your figures)',
    'Fee: none',
  ]);

  const reweigh = (carats, loss) => stockDraft({ kind: 'transform', job: 'reweigh', inputs: ['L14'], outputs: [{ carats }] }).then((d) => card(d, {
    kind: 'transform', job: 'reweigh', yield_pct: Math.round(carats / 80 * 1000) / 10, loss_carats: loss,
    inputs: [h.input(l14)], outputs: [h.output({ lot: l14, carats, cost: 30000, revision: 1 })],
  }));
  assert.deepEqual(await reweigh(80.5, -0.5), [
    'Re-weigh',
    `Date: ${DAY}`,
    'From:',
    '- L14 blue sapphire rough: 80 ct, cost 30,000 THB',
    'To:',
    '- L14 blue sapphire rough: 80.5 ct, cost 30,000 THB = 372.67 per ct',
    'Weight difference: 0.5 ct more than went in',
  ]);
  assert.equal((await reweigh(79.2, 0.8)).at(-1), 'Weight difference: 0.8 ct lost');
});

test('merge: the lots that go in and the one that comes out', async () => {
  const [l16, l17] = [await lot('L16'), await lot('L17')];
  const lines = await card(await stockDraft({ kind: 'merge', inputs: ['L16', 'L17'] }), {
    kind: 'merge', inputs: [h.input(l16), h.input(l17)], outputs: [h.output({ code: 'L18', carats: 30, cost: 272400, form: 'cut', attrs: BLUE })],
  });
  assert.deepEqual(lines, [
    'Merge lots',
    `Date: ${DAY}`,
    'From:',
    '- L16 blue sapphire cut: 8 ct, cost 175,741.94 THB',
    '- L17 cut: 22 ct, cost 96,658.06 THB',
    'To:',
    '- L18 blue sapphire cut: 30 ct, cost 272,400 THB = 9,080 per ct',
  ]);
});

test('memo: part of a lot goes out as a new lot at an agreed price, and comes back', async () => {
  const l16 = await lot('L16');
  const out = {
    kind: 'move', direction: 'out_memo', holder: 'Jameel', due_date: '2027-01-31', memo_price_per_ct: 30000,
    inputs: [h.input(l16, { carats: 3, cost: 65903.23 })], outputs: [h.output({ code: 'L18', carats: 3, cost: 65903.23, to: 'memo', form: 'cut' })],
  };
  const sent = await card(await stockDraft({ kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16', carats: 3 }], holder: 'Jameel', due_date: '2027-01-31', memo_price_per_ct: 30000 }), out);
  assert.deepEqual(sent, [
    'Send out on memo',
    `Date: ${DAY}`,
    'To: Jameel',
    '- L16 blue sapphire cut: 3 ct of 8 ct, cost 65,903.23 THB → new lot L18',
    'Memo price: 30,000 per ct = 90,000 THB',
    'Due back: 2027/01/31',
  ]);
  await h.recordPosted(user, h.resolvedOp(out));

  const l18 = await lot('L18');
  const back = await card(await stockDraft({ kind: 'move', direction: 'return', inputs: ['L18'] }), {
    kind: 'move', direction: 'return', holder: 'Jameel', inputs: [h.input(l18)], outputs: [h.output({ lot: l18, carats: 3, cost: 65903.23, to: 'stores', form: 'cut' })],
  });
  assert.deepEqual(back, [
    'Stones returned',
    `Date: ${DAY}`,
    'From: Jameel',
    `- L18 cut: 3 ct, cost 65,903.23 THB (on memo with Jameel since ${DAY})`,
    'Back in stock.',
  ]);

  // Sold while still out on memo: the invoice card says where the stones are.
  const draft = await ready({
    transaction_type: 'invoice_issued', counterparty_name: h.N.CUSTOMER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB', transaction_date: h.TODAY,
    items: [{ lot: { code: 'L18', carats: 3, price: 30000, pricing_basis: 'per_ct' } }],
  });
  const sold = await card(draft, { kind: 'sell', inputs: [h.input(l18)] });
  assert.equal(sold[2], `- L18 cut: 3 ct (the whole lot, none left) @ 30,000 per ct (on memo with Jameel since ${DAY})`);
});

test('write-off: what leaves stock, why, and what it cost', async () => {
  const l14 = await lot('L14');
  const lines = await card(await stockDraft({ kind: 'write_off', inputs: [{ lot: 'L14', carats: 5 }], reason: 'broken in sorting' }), {
    kind: 'write_off', reason: 'broken in sorting', loss_carats: 5, inputs: [h.input(l14, { carats: 5, cost: 1875 })],
  });
  assert.deepEqual(lines, [
    'Write off stones',
    `Date: ${DAY}`,
    '- L14 blue sapphire rough: 5 ct of 80 ct, cost 1,875 THB',
    'Reason: broken in sorting',
    'Loss: 1,875 THB leaves stock',
  ]);
});

test('warnings show once, after everything else; a note has its own line; the same input gives the same card', async () => {
  const l14 = await lot('L14');
  const low = 'Yield 25% is low for cutting.';
  const op = {
    kind: 'transform', job: 'cutting', yield_pct: 25, loss_carats: 60, warnings: [low, 'Lot L14 has an estimated weight.'],
    inputs: [h.input(l14)], outputs: [h.output({ code: 'L24', carats: 20, cost: 30000, form: 'cut' })],
  };
  const draft = await stockDraft({ kind: 'transform', job: 'cutting', inputs: ['L14'], outputs: [{ carats: 20 }], note: 'for the Bangkok show' });
  // The gate puts the operation's warnings on the draft before the card is built.
  draft.trust_warnings = ['New payee, first payment', low];
  const lines = await card(draft, op);
  assert.deepEqual(lines.slice(-6), [
    'Fee: none',
    'Note: for the Bangkok show',
    '⚠ Please check before confirming:',
    '- New payee, first payment',
    `- ${low}`,
    '- Lot L14 has an estimated weight.',
  ]);
  assert.equal(lines.filter((l) => l.includes(low)).length, 1);
  assert.deepEqual(await card(draft, op), lines);
  assert.deepEqual((await build(user, draft, h.resolvedOp(op), () => client)).warning_lines, lines.slice(-4));

  // On a money card too: the bill's own ⚠ block is not repeated.
  const bill = await ready({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB', transaction_date: h.TODAY,
    items: [{ lot: { carats: 10, form: 'rough', variety: 'ruby', price: 1000, pricing_basis: 'per_ct', weight_estimated: true } }],
  });
  const est = 'Lot L25: the weight is an estimate.';
  bill.trust_warnings = [est];
  const bought = await card(bill, { kind: 'buy', warnings: [est], outputs: [h.output({ code: 'L25', carats: 10, cost: 10000, line: 0, weight_estimated: true, attrs: { variety: 'ruby' } })] });
  assert.deepEqual(bought.slice(-2), ['⚠ Please check before confirming:', `- ${est}`]);
  assert.equal(bought.filter((l) => l === '⚠ Please check before confirming:').length, 1);
});

// ── built from the resolver, not by hand ─────────────────────────────

/** The card of a draft the way the gate makes it: prepared, defaults, resolved, then built. */
async function cardOf(draft, { feeCapitalised = 0 } = {}) {
  await ready(draft);
  const r = await resolveDraft(user, draft, { feeCapitalised });
  assert.equal(r.ok, true, r.error);
  return { op: r.op, lines: (await build(user, draft, r.op, () => client)).lines };
}
const today = localClock(new Date()).date.replace(/-/g, '/');

test('buying a lot: every attribute that will be saved on the lot is on the card', async () => {
  const bought = await cardOf({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot: {
      carats: 10, form: 'rough', species: 'corundum', variety: 'sapphire', colour: 'blue', shape: 'oval', size: '5-7 mm', clarity: 'eye clean', origin: 'Mogok',
      grade: 'A', treatment: 'h-fh', treatment_source: 'seller', supplier_doc: true, vat_exempt: true, price: 1500, pricing_basis: 'per_ct',
    } }],
  });
  const code = bought.op.outputs[0].code;
  assert.deepEqual(bought.lines.slice(0, 4), [
    `Date: ${today}`,
    'Amount: 15,000 THB',
    `- ${code} blue sapphire rough: 10 ct, cost 15,000 THB = 1,500 per ct`,
    '  Details: species corundum, shape oval, size 5-7 mm, clarity eye clean, grade A, origin Mogok, treatment H-FH (source: seller), VAT-exempt purchase (uncut stones), supplier document: yes',
  ]);
  // What the card says is what the resolver will write: nothing the card leaves out is saved.
  const written = bought.op.outputs[0].attrs;
  for (const k of ['species', 'shape', 'size', 'clarity', 'grade', 'origin', 'treatment', 'treatment_source']) assert.ok(bought.lines[3].includes(String(written[k])), k);
  assert.equal(written.vat_exempt, true);
  assert.equal(written.supplier_doc, true);

  // A lot with nothing more to say has no details line; a description stands for the name, so colour and variety still show.
  const plain = await cardOf({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot: { carats: 5, form: 'rough', variety: 'ruby', price: 100000, pricing_basis: 'total', description: 'Mong Hsu parcel', colour: 'red', supplier_doc: false } }],
  });
  assert.equal(plain.lines[2], `- ${plain.op.outputs[0].code} Mong Hsu parcel: 5 ct, cost 100,000 THB = 20,000 per ct`);
  assert.equal(plain.lines[3], '  Details: colour red, variety ruby, form rough, supplier document: no');
  const bare = await cardOf({
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot: { carats: 5, form: 'rough', variety: 'ruby', price: 100, pricing_basis: 'per_ct' } }],
  });
  assert.ok(!bare.lines.some((l) => l.startsWith('  Details')));
});

test('selling: the whole lot says it is emptied; a total or a price per piece shows the price per carat worked out', async () => {
  await h.seedLot(user, client, { code: 'L30', carats: 10, pieces: 5, cost: 50000, form: 'cut', attrs: BLUE });
  const sale = (lot) => cardOf({
    transaction_type: 'invoice_issued', counterparty_name: h.N.CUSTOMER, counterparty_contact_skipped: true, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot }],
  }).then((r) => r.lines.slice(1, 3));

  assert.deepEqual(await sale({ code: 'L30', price: 7000, pricing_basis: 'per_ct' }), ['Amount: 70,000 THB', '- L30 blue sapphire cut: 10 ct (the whole lot, none left), 5 pcs @ 7,000 per ct']);
  assert.deepEqual(await sale({ code: 'L30', price: 70000, pricing_basis: 'total' }), ['Amount: 70,000 THB', '- L30 blue sapphire cut: 10 ct (the whole lot, none left), 5 pcs for 70,000 (7,000 per ct)']);
  assert.deepEqual(await sale({ code: 'L30', price: 14000, pricing_basis: 'per_piece' }), ['Amount: 70,000 THB', '- L30 blue sapphire cut: 10 ct (the whole lot, none left), 5 pcs @ 14,000 per piece (7,000 per ct)']);
  // Part of it: no "emptied" and the stated price is shown the same way.
  assert.deepEqual(await sale({ code: 'L30', carats: 4, pieces: 2, price: 30000, pricing_basis: 'total' }), ['Amount: 30,000 THB', '- L30 blue sapphire cut: 4 ct of 10 ct, 2 pcs for 30,000 (7,500 per ct)']);
});

test('a heating or a sort shows what the new lots will say: treatment, grade, shape', async () => {
  const heated = await cardOf({ stock_op: { kind: 'transform', job: 'heating', inputs: ['L14'], outputs: [{ carats: 78, treatment: 'H', grade: 'A', shape: 'oval' }] } });
  const code = heated.op.outputs[0].code;
  assert.deepEqual(heated.lines, [
    'Heating',
    `Date: ${today}`,
    'From:',
    '- L14 blue sapphire rough: 80 ct, cost 30,000 THB',
    'To:',
    `- ${code} blue sapphire rough: 78 ct, cost 30,000 THB = 384.62 per ct`,
    '  Details: shape oval, grade A, treatment H',
    'Yield: 97.5% (2 ct lost)',
    'Fee: none',
  ]);
  // A lot that gets a treatment says so; one that inherits nothing says nothing more.
  const reweigh = await cardOf({ stock_op: { kind: 'transform', job: 'reweigh', inputs: ['L14'], outputs: [{ carats: 80.5 }] } });
  assert.ok(!reweigh.lines.some((l) => l.startsWith('  Details')));
  const sorted = await cardOf({ stock_op: { kind: 'split', inputs: ['L14'], outputs: [{ carats: 50, value: 3, grade: 'A', shape: 'oval' }, { carats: 30, value: 1, grade: 'B' }] } });
  assert.deepEqual(sorted.lines.filter((l) => l.startsWith('  Details')), ['  Details: shape oval, grade A', '  Details: grade B']);
});

/**
 * Who holds what (src/lots/custody.js) and the query_custody tool: grouping by holder and
 * purpose, what is still out after a part came back or was sold, and what counts as late.
 * Berpal's side only: the operations are recorded through the store, ERPNext is not asked.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const store = require('../src/lots/store');
const custody = require('../src/lots/custody');
const tools = require('../src/tools');
const { localClock, addDays } = require('../src/jobs');

const { N } = h;
const erp = new FakeErpNext();
const TODAY = '2026-06-30';
let user;

const lot = (code) => store.getLot(user.id, code);

/** A lot bought into stock (Berpal's side only). */
async function buy(code, carats, cost, { pieces = null, form = 'rough' } = {}) {
  await h.recordPosted(user, h.resolvedOp({ kind: 'buy', date: '2026-03-01', counterparty: N.SUPPLIER, outputs: [h.output({ code, carats, cost, pieces, form })] }));
  return lot(code);
}

/** The whole lot sent out. */
async function send(code, direction, holder, date, extra = {}) {
  const l = await lot(code);
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction, holder, date, ...extra,
    inputs: [h.input(l)],
    outputs: [h.output({ lot: l, carats: l.carats, pieces: l.pieces, cost: l.cost, to: direction === 'out_memo' ? 'memo' : 'work', form: l.form })],
  }));
}

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user } = await h.setupGems());

  await buy('C1', 100, 50000, { pieces: 20 });
  await send('C1', 'out_work', N.CUTTER, '2026-05-01'); // 60 days, no date agreed: out too long
  await buy('C2', 40, 20000);
  await send('C2', 'out_work', N.CUTTER, '2026-06-20', { due_date: '2026-07-15' }); // not due yet
  await buy('C3', 25, 10000);
  await send('C3', 'out_work', N.CUTTER, '2026-04-01', { due_date: '2026-08-01' }); // 90 days, but a date was agreed
  await buy('C4', 8, 175741.94, { pieces: 10, form: 'cut' });
  await send('C4', 'out_memo', 'Broker Lek', '2026-06-01', { due_date: '2026-06-15', memo_price_per_ct: 30000 });
  await buy('C5', 12, 60000, { form: 'cut' });
  await send('C5', 'out_memo', 'Broker Lek', '2026-06-25', { memo_price_per_ct: 9000 }); // a memo with no date is never late
  await buy('C6', 5, 2500);
  await send('C6', 'out_memo', N.CUTTER, '2026-06-28', { due_date: TODAY }); // due today is not late yet
  await buy('C7', 30, 9000, { pieces: 6 });
  await send('C7', 'out_work', 'Heater Noi', '2026-06-01', { due_date: '2026-06-10' });
  await buy('C9', 15, 3000);
  await send('C9', 'out_work', 'Heater Noi', '2026-06-05');

  // 5.5 ct of the memo lot C4 are sold from the broker's hands.
  await h.recordPosted(user, h.resolvedOp({
    kind: 'sell', date: '2026-06-20', counterparty: N.CUSTOMER, inputs: [h.input(await lot('C4'), { carats: 5.5, pieces: 7, cost: 120822.58 })],
  }));
  // 10 ct of C7 come back from the heater as a lot of their own; C9 comes back whole.
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'return', holder: 'Heater Noi', date: '2026-06-22',
    inputs: [h.input(await lot('C7'), { carats: 10, pieces: 2 })], outputs: [h.output({ code: 'C8', carats: 10, pieces: 2, cost: 3000 })],
  }));
  const c9 = await lot('C9');
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'return', holder: 'Heater Noi', date: '2026-06-23',
    inputs: [h.input(c9)], outputs: [h.output({ lot: c9, carats: 15, cost: 3000, to: 'stores' })],
  }));
});

test('out: grouped by holder and purpose, oldest first, with what is still out', async () => {
  const groups = await custody.out(user, { today: TODAY });
  assert.deepEqual(groups.map((g) => [g.holder, g.purpose, g.carats, g.cost, g.rows.map((r) => r.lot)]), [
    [N.CUTTER, 'work', 165, 80000, ['C3', 'C1', 'C2']],
    ['Broker Lek', 'memo', 14.5, 114919.36, ['C4', 'C5']],
    ['Heater Noi', 'work', 20, 6000, ['C7']],
    [N.CUTTER, 'memo', 5, 2500, ['C6']],
  ]);
  const row = (code) => groups.flatMap((g) => g.rows).find((r) => r.lot === code);
  assert.deepEqual(row('C1'), {
    lot: 'C1', carats: 100, pieces: 20, cost: 50000, date_out: '2026-05-01', days_out: 60, due_date: null,
    overdue: true, overdue_reason: 'long_out', memo_price_per_ct: null, currency: null,
  });
  // A sale from memo: 8 sent, 5.5 sold, 2.5 ct and 3 pieces still with the broker.
  assert.deepEqual(row('C4'), {
    lot: 'C4', carats: 2.5, pieces: 3, cost: 54919.36, date_out: '2026-06-01', days_out: 29, due_date: '2026-06-15',
    overdue: true, overdue_reason: 'past_due', memo_price_per_ct: 30000, currency: 'THB',
  });
  // A part that came back: 30 sent, 10 returned.
  assert.deepEqual([row('C7').carats, row('C7').pieces, row('C7').cost, row('C7').overdue], [20, 4, 6000, true]);
  assert.equal(groups.flatMap((g) => g.rows).some((r) => r.lot === 'C9' || r.lot === 'C8'), false, 'what came back is not out');
});

test('overdue: past the due date, or out for work over 30 days with no date agreed', async () => {
  assert.equal(custody.WORK_LONG_DAYS, 30);
  const late = await custody.overdue(user, { today: TODAY });
  assert.deepEqual(late.map((r) => [r.lot, r.holder, r.purpose, r.overdue_reason]), [
    ['C1', N.CUTTER, 'work', 'long_out'],
    ['C4', 'Broker Lek', 'memo', 'past_due'],
    ['C7', 'Heater Noi', 'work', 'past_due'],
  ]);
  const flags = Object.fromEntries((await custody.out(user, { today: TODAY })).flatMap((g) => g.rows).map((r) => [r.lot, r.overdue]));
  assert.deepEqual(flags, { C3: false, C1: true, C2: false, C4: true, C5: false, C7: true, C6: false });

  // The 30 days are counted from the day the stones left: day 30 is fine, day 31 is long.
  assert.equal((await custody.overdue(user, { today: '2026-05-31', holder: N.CUTTER })).length, 0);
  assert.deepEqual((await custody.overdue(user, { today: '2026-06-01', holder: N.CUTTER })).map((r) => r.lot), ['C1']);
  // The day after its due date the memo with Somchai is late too.
  assert.deepEqual((await custody.overdue(user, { today: '2026-07-01', purpose: 'memo' })).map((r) => r.lot), ['C4', 'C6']);
});

test('filters: part of a holder name, a purpose; another user sees nothing; today defaults to the user\'s day', async () => {
  assert.deepEqual((await custody.out(user, { today: TODAY, holder: 'somch' })).map((g) => [g.holder, g.purpose]), [[N.CUTTER, 'work'], [N.CUTTER, 'memo']]);
  assert.deepEqual((await custody.out(user, { today: TODAY, purpose: 'memo' })).map((g) => g.holder), ['Broker Lek', N.CUTTER]);
  assert.deepEqual(await custody.out(user, { today: TODAY, holder: 'nobody' }), []);
  const other = await h.addUser();
  assert.deepEqual(await custody.out(other, { today: TODAY }), []);
  assert.deepEqual(await custody.overdue(other), []);
  const now = await custody.out(user);
  assert.equal(now.length, 4);
  assert.ok(now.every((g) => g.rows.every((r) => Number.isInteger(r.days_out) && r.days_out >= 0)));
});

test('query_custody: compact rows and totals for the model, for gem traders only', async () => {
  const mod = require('../src/tools/query-custody');
  assert.equal(mod.niche, 'gems');
  assert.deepEqual(Object.keys(mod.definition.parameters.properties), ['holder', 'purpose', 'overdue_only']);
  const names = (u) => tools.toolsFor(u).map((t) => t.function.name);
  assert.ok(names(user).includes('query_custody'));
  const general = await h.addUser({ niche: null });
  assert.equal(names(general).includes('query_custody'), false);
  assert.deepEqual(await tools.executeTool('query_custody', {}, h.ctxFor(general)), { ok: false, error: 'Unknown tool: query_custody' });

  const all = await tools.executeTool('query_custody', {}, h.ctxFor(user));
  assert.equal(all.ok, true);
  assert.deepEqual(all.holders.map((g) => [g.holder, g.purpose, g.lots, g.carats, g.cost]), [
    [N.CUTTER, 'work', 3, 165, 80000], ['Broker Lek', 'memo', 2, 14.5, 114919.36], ['Heater Noi', 'work', 1, 20, 6000], [N.CUTTER, 'memo', 1, 5, 2500],
  ]);
  assert.equal(all.totals.lots, 7);
  assert.equal(all.totals.carats, 204.5);
  assert.equal(all.totals.cost, 203419.36);
  assert.equal(all.totals.cost_currency, 'THB');
  // Empty fields are left out of the rows.
  const c5 = all.holders[1].rows.find((r) => r.lot === 'C5');
  assert.deepEqual(Object.keys(c5).sort(), ['carats', 'cost', 'currency', 'date_out', 'days_out', 'lot', 'memo_price_per_ct'].sort());

  const memo = await tools.executeTool('query_custody', { holder: 'lek', purpose: 'memo' }, h.ctxFor(user));
  assert.deepEqual(memo.holders.map((g) => g.rows.map((r) => r.lot)), [['C4', 'C5']]);
  assert.equal(memo.totals.lots, 2);

  // Whatever today is for the user, C4 and C7 are past their 2026 due dates and C1 has been out far too long.
  const late = await tools.executeTool('query_custody', { overdue_only: true }, h.ctxFor(user));
  const lateLots = late.holders.flatMap((g) => g.rows.map((r) => r.lot));
  for (const code of ['C1', 'C4', 'C7']) assert.ok(lateLots.includes(code), code);
  assert.equal(late.totals.overdue, late.totals.lots);
  assert.ok(late.holders.every((g) => g.rows.every((r) => r.overdue === true)));

  assert.deepEqual(await tools.executeTool('query_custody', { holder: 'nobody' }, h.ctxFor(user)), {
    ok: true, message: 'nothing_out', holders: [], totals: { lots: 0, carats: 0, cost: 0, cost_currency: 'THB', overdue: 0 },
  });
});

test('one holder typed two ways ("Khun  Lek", " Khun Lek ") is one holder, found by either', async () => {
  await buy('D1', 10, 1000);
  await send('D1', 'out_work', 'Khun  Lek', '2026-06-20', { due_date: '2026-07-20' });
  await buy('D2', 6, 600);
  await send('D2', 'out_work', ' Khun Lek ', '2026-06-21', { due_date: '2026-07-20' });
  await buy('D3', 4, 400);
  await send('D3', 'out_work', 'khun lek', '2026-06-22', { due_date: '2026-07-20' });

  const groups = (await custody.out(user, { today: TODAY })).filter((g) => /khun/i.test(g.holder));
  assert.equal(groups.length, 1, 'one group, not two or three');
  assert.deepEqual([groups[0].holder, groups[0].purpose, groups[0].carats, groups[0].rows.map((r) => r.lot)], ['Khun Lek', 'work', 20, ['D1', 'D2', 'D3']]);
  for (const holder of ['khun lek', 'Khun  Lek', ' khun  ', 'Khun']) {
    assert.deepEqual((await custody.out(user, { today: TODAY, holder })).flatMap((g) => g.rows.map((r) => r.lot)), ['D1', 'D2', 'D3'], `holder "${holder}"`);
  }
  const t = await tools.executeTool('query_custody', { holder: 'khun  lek' }, h.ctxFor(user));
  assert.deepEqual(t.holders.map((g) => [g.holder, g.lots]), [['Khun Lek', 3]]);
});

test('overdue on the real clock: the dates are worked out from today, not set by hand', async () => {
  // No `today` is passed anywhere below: the user's own calendar day decides.
  const today = localClock(new Date(), user.timezone).date;
  const ago = (n) => addDays(today, -n);
  const cases = [
    ['E1', 'out_work', ago(31), {}, 'long_out'],            // out for work 31 days, no date agreed
    ['E2', 'out_work', ago(30), {}, null],                  // day 30 is fine
    ['E3', 'out_memo', ago(40), { due_date: ago(1) }, 'past_due'],   // due yesterday
    ['E4', 'out_memo', ago(5), { due_date: today }, null],  // due today is not late
    ['E5', 'out_work', ago(90), { due_date: addDays(today, 1) }, null], // out long, but a date was agreed
    ['E6', 'out_memo', ago(100), {}, null],                 // a memo with no date is never late
    ['E7', 'out_work', today, {}, null],                    // sent today
  ];
  for (const [code, direction, date, extra] of cases) {
    await buy(code, 3, 300);
    await send(code, direction, 'Real Clock Co', date, extra);
  }
  const rows = (await custody.out(user, { holder: 'real clock' })).flatMap((g) => g.rows);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.lot, r.days_out])), { E1: 31, E2: 30, E3: 40, E4: 5, E5: 90, E6: 100, E7: 0 });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.lot, r.overdue_reason])), {
    E1: 'long_out', E2: null, E3: 'past_due', E4: null, E5: null, E6: null, E7: null,
  });
  assert.deepEqual((await custody.overdue(user, { holder: 'real clock' })).map((r) => r.lot), ['E3', 'E1'], 'oldest first (E3 left 40 days ago, E1 31)');
  const late = await tools.executeTool('query_custody', { holder: 'real clock', overdue_only: true }, h.ctxFor(user));
  assert.deepEqual(late.holders.flatMap((g) => g.rows.map((r) => r.lot)).sort(), ['E1', 'E3']);
});

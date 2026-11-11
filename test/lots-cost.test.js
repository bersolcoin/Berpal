/**
 * Lot arithmetic (src/lots/cost.js): pure functions, no database, no ERPNext.
 * The worked example of docs/parcel-lot-stock-design.md section 6 must come out to the satang.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cost = require('../src/lots/cost');
const { WORKED } = require('./lots-helpers');

const sum = (list) => Math.round(list.reduce((s, x) => s + x, 0) * 100) / 100;

test('share: 2 dp shares, the last line takes the remainder, the sum is the total', () => {
  assert.deepEqual(cost.share(100, [1, 1, 1]), [33.33, 33.33, 33.34]);
  assert.deepEqual(cost.share(300000, [360000, 40000]), [270000, 30000]);
  assert.deepEqual(cost.share(100, [5]), [100]);
  assert.deepEqual(cost.share(0, [1, 2]), [0, 0]);
  assert.deepEqual(cost.share(100, []), []);
  // A weight of zero takes nothing unless it is the last line (which takes what is left: nothing here).
  assert.deepEqual(cost.share(10, [0, 1, 0]), [0, 10, 0]);
  for (const [total, weights] of [[272400, [200000, 110000]], [1000.01, [3, 3, 3]], [0.05, [1, 1, 1, 1, 1, 1, 1]], [99.99, [0.001, 123.456, 7]]]) {
    const parts = cost.share(total, weights);
    assert.equal(sum(parts), total, `shares of ${total} sum to it`);
    assert.ok(parts.every((p) => Math.round(p * 100) === Number((p * 100).toFixed(6))), 'every share has 2 decimals');
  }
});

test('share: many small lines never push a share below zero', () => {
  const parts = cost.share(0.03, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(parts, [0.01, 0.01, 0.01, 0, 0, 0]);
  assert.ok(parts.every((p) => p >= 0));
});

test('outputCosts by value: value or value_per_ct × carats', () => {
  const perCt = cost.outputCosts({ total: 300000, method: 'value', outputs: [{ carats: 120, value_per_ct: 3000 }, { carats: 80, value_per_ct: 500 }] });
  assert.deepEqual(perCt, { ok: true, costs: [270000, 30000] });
  const total = cost.outputCosts({ total: 300000, method: 'value', outputs: [{ carats: 120, value: 360000 }, { carats: 80, value: 40000 }] });
  assert.deepEqual(total, { ok: true, costs: [270000, 30000] });
  const mixed = cost.outputCosts({ total: 300000, method: 'value', outputs: [{ carats: 120, value: 360000 }, { carats: 80, value_per_ct: 500 }] });
  assert.deepEqual(mixed, { ok: true, costs: [270000, 30000] });
});

test('outputCosts by value: an output without a value is an error that says what to ask', () => {
  const r = cost.outputCosts({ total: 300000, method: 'value', outputs: [{ code: 'L13', carats: 120, value_per_ct: 3000 }, { code: 'L14', carats: 80 }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /L14 \(80 ct\)/);
  assert.match(r.error, /Ask the trader what each part is worth/);
  assert.doesNotMatch(r.error, /L13/);
  const unnamed = cost.outputCosts({ total: 10, method: 'value', outputs: [{ carats: 1, value: 0 }, { carats: 2, value_per_ct: -5 }] });
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.error, /part 1 \(1 ct\), part 2 \(2 ct\)/);
});

test('outputCosts by weight: by carats, values ignored', () => {
  const r = cost.outputCosts({ total: 300000, method: 'weight', outputs: [{ carats: 120, value_per_ct: 3000 }, { carats: 80 }] });
  assert.deepEqual(r, { ok: true, costs: [180000, 120000] });
  const thirds = cost.outputCosts({ total: 100, method: 'weight', outputs: [{ carats: 1 }, { carats: 1 }, { carats: 1 }] });
  assert.deepEqual(thirds.costs, [33.33, 33.33, 33.34]);
  const light = cost.outputCosts({ total: 100, method: 'weight', outputs: [{ carats: 1 }, { code: 'L9', carats: 0 }] });
  assert.equal(light.ok, false);
  assert.match(light.error, /L9 \(0 ct\) has no weight/);
});

test('outputCosts: one output takes everything; no outputs or an unknown method is an error', () => {
  assert.deepEqual(cost.outputCosts({ total: 272400, method: 'value', outputs: [{ carats: 30 }] }), { ok: true, costs: [272400] });
  assert.deepEqual(cost.outputCosts({ total: 272400, method: 'weight', outputs: [{ carats: 30 }] }), { ok: true, costs: [272400] });
  assert.equal(cost.outputCosts({ total: 1, method: 'value', outputs: [] }).ok, false);
  assert.equal(cost.outputCosts().ok, false);
  const r = cost.outputCosts({ total: 1, method: 'fifo', outputs: [{ carats: 1 }, { carats: 2 }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /"fifo"/);
});

test('costOfTaking: a part at the average, the whole lot takes all of it', () => {
  const lot = { carats: 8, cost: 175741.94 };
  assert.equal(cost.costOfTaking(lot, 5.5), 120822.58);
  assert.equal(cost.costOfTaking(lot, 8), 175741.94);
  assert.equal(cost.costOfTaking(lot, 7.9997), 175741.94, 'what is left is under half a thousandth: the lot is emptied');
  assert.equal(cost.costOfTaking(lot, 9), 175741.94, 'never more than the lot holds');
  assert.equal(cost.costOfTaking(lot, 0), 0);
  assert.equal(cost.costOfTaking({ carats: 0, cost: 12.5 }, 1), 12.5, 'an empty lot gives up what cost it still carries');
  assert.equal(cost.costOfTaking({ carats: 3, cost: 100 }, 1), 33.33);
  assert.equal(cost.costOfTaking({ carats: '3', cost: '100.00' }, 2), 66.67, 'figures read as strings are taken as numbers');
});

test('weightTolerance: max(0.05 ct, 0.5 %), capped at 2 ct', () => {
  assert.equal(cost.weightTolerance(1), 0.05);
  assert.equal(cost.weightTolerance(10), 0.05);
  assert.equal(cost.weightTolerance(30), 0.15);
  assert.equal(cost.weightTolerance(200), 1);
  assert.equal(cost.weightTolerance(400), 2);
  assert.equal(cost.weightTolerance(5000), 2);
  assert.equal(cost.weightTolerance(0), 0.05);
});

test('yieldPct: 1 decimal, null when nothing went in', () => {
  assert.equal(cost.yieldPct(120, 30), 25);
  assert.equal(cost.yieldPct(3, 1), 33.3);
  assert.equal(cost.yieldPct(200, 200), 100);
  assert.equal(cost.yieldPct(0, 3), null);
  assert.equal(cost.yieldPct(null, 3), null);
});

test('yieldWarnings: only outside the usual range for the job, in plain words', () => {
  const w = (job, caratsIn, caratsOut) => cost.yieldWarnings({ job, caratsIn, caratsOut });
  assert.deepEqual(w('cutting', 120, 30), []);
  assert.deepEqual(w('cutting', 100, 5), []);
  assert.deepEqual(w('cutting', 100, 50), []);
  assert.match(w('cutting', 100, 4)[0], /^Yield is 4% \(4 ct from 100 ct\)\. That is low/);
  assert.match(w('cutting', 100, 60)[0], /^Yield is 60% \(60 ct from 100 ct\)\. That is high/);
  assert.deepEqual(w('recut', 10, 6), []);
  assert.match(w('recut', 10, 5.5)[0], /recut lost 45% of the weight/);
  for (const [job, word] of [['sawing', 'Sawing'], ['heating', 'Heating'], ['preform', 'Preforming']]) {
    assert.deepEqual(w(job, 100, 85), []);
    assert.match(w(job, 100, 80)[0], new RegExp(`^${word} lost 20% of the weight \\(80 ct from 100 ct\\)`));
  }
  assert.deepEqual(w('reweigh', 100, 90), [], 'a re-weigh corrects an estimate: an ordinary difference is fine');
  assert.deepEqual(w('reweigh', 100, 200), [], 'exactly the threshold is still fine');
  assert.deepEqual(w('reweigh', 100, 50), []);
  assert.deepEqual(w('reweigh', 100, 100), []);
  assert.equal(cost.REWEIGH_FACTOR, 2);
  assert.equal(w('reweigh', 100, 10000).length, 1);
  assert.match(w('reweigh', 100, 10000)[0], /^The re-weigh gives 10000 ct where 100 ct was on record: 100 times more\. That is a big change for a correction\. Check the weight \(1 gram = 5 carats\)\.$/);
  assert.match(w('reweigh', 100, 10)[0], /gives 10 ct where 100 ct was on record: 10 times less\./);
  assert.match(w('reweigh', 100, 201)[0], /: 2 times more\./);
  assert.deepEqual(w('reweigh', 0, 10), []);
  assert.deepEqual(w('reweigh', 10, 0), []);
  assert.deepEqual(w('cutting', 0, 10), []);
  assert.deepEqual(cost.yieldWarnings(), []);
});

test('the worked example of the design, to the satang', () => {
  // L12 (200 ct, 300,000) sorted by value into L13 at 3,000/ct and L14 at 500/ct.
  const split1 = cost.outputCosts({ total: WORKED.buy.cost, method: 'value', outputs: [{ carats: 120, value_per_ct: 3000 }, { carats: 80, value_per_ct: 500 }] });
  assert.deepEqual(split1.costs, WORKED.split1.map((p) => p.cost));
  // L13 cut, the fee of 2,400 goes into the stones: one output takes all of it.
  const cut = cost.outputCosts({ total: split1.costs[0] + WORKED.cut.fee, method: 'value', outputs: [{ carats: WORKED.cut.carats }] });
  assert.deepEqual(cut.costs, [WORKED.cut.cost]);
  assert.equal(cost.yieldPct(120, WORKED.cut.carats), WORKED.cut.yield_pct);
  assert.deepEqual(cost.yieldWarnings({ job: 'cutting', caratsIn: 120, caratsOut: 30 }), []);
  // L15 sorted by value: 8 ct at 25,000/ct and 22 ct at 5,000/ct.
  const split2 = cost.outputCosts({ total: cut.costs[0], method: 'value', outputs: [{ carats: 8, value_per_ct: 25000 }, { carats: 22, value_per_ct: 5000 }] });
  assert.deepEqual(split2.costs, WORKED.split2.map((p) => p.cost));
  assert.equal(sum(split2.costs), WORKED.cut.cost);
  // 5.5 ct of L16 sold: cost of goods sold at the lot's average, the rest stays.
  const cogs = cost.costOfTaking({ carats: 8, cost: split2.costs[0] }, WORKED.sale.carats);
  assert.equal(cogs, WORKED.sale.cogs);
  assert.equal(Math.round((split2.costs[0] - cogs) * 100) / 100, WORKED.sale.left_cost);
});

test('outputCosts: a stated value that rounds to nothing says so, instead of "no value was given"', () => {
  const tiny = cost.outputCosts({ total: 100, method: 'value', outputs: [{ code: 'L1', carats: 1, value_per_ct: 0.001 }, { code: 'L2', carats: 2, value_per_ct: 500 }] });
  assert.equal(tiny.ok, false);
  assert.match(tiny.error, /^The value given for L1 \(1 ct\) is under 0\.01 in all, which rounds to nothing\./);
  assert.doesNotMatch(tiny.error, /no value was given/);
  const given = cost.outputCosts({ total: 100, method: 'value', outputs: [{ code: 'L1', carats: 1, value: 0.004 }, { code: 'L2', carats: 2, value: 500 }] });
  assert.match(given.error, /value given for L1/);
  // 0.01 in all is the smallest value that counts.
  const ok = cost.outputCosts({ total: 100000, method: 'value', outputs: [{ carats: 1, value: 0.01 }, { carats: 2, value: 500 }] });
  assert.equal(ok.ok, true);
  assert.equal(sum(ok.costs), 100000);
  // A missing value is still reported as missing.
  assert.match(cost.outputCosts({ total: 1, method: 'value', outputs: [{ carats: 1, value: 5 }, { code: 'L3', carats: 2 }] }).error, /no value was given for L3 \(2 ct\)/);
});

test('outputCosts: a total that is not an amount is refused, whatever the number of outputs', () => {
  for (const total of [NaN, undefined, null, '', 'lots', Infinity, -5]) {
    for (const method of ['value', 'weight']) {
      const outputs = [{ carats: 1, value: 1 }, { carats: 2, value: 2 }];
      const r = cost.outputCosts({ total, method, outputs });
      assert.equal(r.ok, false, `${total} over two`);
      assert.match(r.error, /not a valid amount/);
      assert.equal(cost.outputCosts({ total, method, outputs: outputs.slice(0, 1) }).ok, false, `${total} over one`);
    }
  }
  assert.deepEqual(cost.outputCosts({ total: '100.50', method: 'weight', outputs: [{ carats: 1 }, { carats: 1 }] }), { ok: true, costs: [50.25, 50.25] });
  assert.deepEqual(cost.outputCosts({ total: 0, method: 'weight', outputs: [{ carats: 1 }, { carats: 3 }] }), { ok: true, costs: [0, 0] }, 'a lot that cost nothing: every output costs nothing');
});

test('outputCosts: a total too small to give every output a cent is refused, never a free output', () => {
  const r = cost.outputCosts({ total: 0.03, method: 'weight', outputs: Array.from({ length: 6 }, (_, i) => ({ code: `S${i + 1}`, carats: 1 })) });
  assert.equal(r.ok, false);
  assert.match(r.error, /^The cost to share, 0\.03, is too small to give every part at least 0\.01: S4 \(1 ct\), S5 \(1 ct\), S6 \(1 ct\) would carry no cost at all\. Ask the trader whether the weights are right\.$/);
  // By value a tiny part next to a huge one gets under a cent as well.
  const v = cost.outputCosts({ total: 1000, method: 'value', outputs: [{ code: 'BIG', carats: 10, value: 5000000 }, { code: 'TINY', carats: 1, value: 1 }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /TINY \(1 ct\) would carry no cost at all\. Ask the trader whether the weights and values are right/);
  assert.equal(cost.outputCosts({ total: 0.03, method: 'weight', outputs: [{ carats: 1 }, { carats: 1 }, { carats: 1 }] }).ok, true);
});

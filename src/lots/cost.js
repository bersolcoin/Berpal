/**
 * Lot arithmetic: sharing a cost over the lots that come out of an operation, weight tolerances,
 * yield. Pure functions, no database, no ERPNext.
 * Rules: docs/parcel-lot-stock-design.md (cost sharing, checks, worked example in section 6).
 */
const lots = require('./index');
const { round2 } = require('../erp-sync/common');

const EPS = 0.0005; // half a thousandth of a carat: below this a lot is empty (as in store.js)
/** A re-weigh that changes the weight by more than this factor, up or down, is more likely a slip than a correction. */
const REWEIGH_FACTOR = 2;
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
/** A figure for a card line: at most 3 decimals, no trailing zeros. */
const plain = (n) => String(lots.round3(n));

/**
 * Split `total` (2 dp) over lines in proportion to `weights`, each share rounded to 2 dp and the
 * LAST line taking the remainder, so the shares always sum to `total` exactly.
 * @param {number} total  @param {number[]} weights  all >= 0, at least one > 0
 * @returns {number[]}
 */
function share(total, weights) {
  const all = round2(total);
  const w = (weights || []).map(pos);
  const sum = w.reduce((s, x) => s + x, 0);
  let left = all;
  return w.map((x, i) => {
    let part = i === w.length - 1 ? left : sum > 0 ? round2(all * x / sum) : 0;
    // Many small lines can round up past what is left of a small total: no share goes below zero.
    if (all >= 0) part = Math.max(0, Math.min(part, left));
    left = round2(left - part);
    return part;
  });
}

/**
 * The cost each output takes.
 * @param {{total: number, method: 'value'|'weight',
 *   outputs: Array<{carats: number, value?: number|null, value_per_ct?: number|null}>}} args
 *   method 'value': by the trader's stated value (value, or value_per_ct × carats); 'weight': by carats.
 *   One output takes everything, whatever the method: there is nothing to share.
 * @returns {{ok: true, costs: number[]}|{ok: false, error: string}}  error e.g. when the method is
 *   'value' and an output has no stated value, a stated value is under 0.01 (it rounds to nothing),
 *   the total is not an amount, or a total above zero is so small that an output would carry nothing
 *   (a total of exactly 0 is fine: every output then costs 0)
 */
function outputCosts({ total, method, outputs } = {}) {
  const list = Array.isArray(outputs) ? outputs : [];
  if (!list.length) return { ok: false, error: 'There is no output to carry the cost.' };
  if (!lots.COST_METHODS.includes(method)) return { ok: false, error: `Unknown cost method "${method}": it is "value" or "weight".` };
  if (total == null || total === '' || !Number.isFinite(Number(total)) || Number(total) < 0) {
    return { ok: false, error: 'The cost to put on the new lots is not a valid amount, so it cannot be shared out.' };
  }
  const name = (o, i) => `${o.code || `part ${i + 1}`} (${plain(pos(o.carats))} ct)`;
  if (list.length === 1) return { ok: true, costs: [round2(total)] };

  const light = list.map((o, i) => (pos(o.carats) ? null : name(o, i))).filter(Boolean);
  let costs;
  if (method === 'weight') {
    if (light.length) return { ok: false, error: `Cost is shared by weight, and ${light.join(', ')} has no weight. Ask the trader how many carats it is.` };
    costs = share(total, list.map((o) => pos(o.carats)));
  } else {
    const stated = list.map((o) => pos(o.value) || pos(o.value_per_ct) * pos(o.carats));
    const missing = list.map((o, i) => (stated[i] > 0 ? null : name(o, i))).filter(Boolean);
    if (missing.length) {
      return {
        ok: false,
        error: `This user shares cost by value, and no value was given for ${missing.join(', ')}. `
          + 'Ask the trader what each part is worth, per carat or in total (value_per_ct or value on every output); it is their own estimate, not a sale price.',
      };
    }
    const tiny = list.map((o, i) => (round2(stated[i]) > 0 ? null : name(o, i))).filter(Boolean);
    if (tiny.length) {
      return {
        ok: false,
        error: `The value given for ${tiny.join(', ')} is under 0.01 in all, which rounds to nothing. `
          + 'Ask the trader again what each part is worth, per carat or in total.',
      };
    }
    costs = share(total, list.map((o) => pos(o.value) || round2(pos(o.value_per_ct) * pos(o.carats))));
  }
  const nothing = list.map((o, i) => (costs[i] > 0 ? null : name(o, i))).filter(Boolean);
  if (round2(total) > 0 && nothing.length) {
    return {
      ok: false,
      error: `The cost to share, ${round2(total)}, is too small to give every part at least 0.01: ${nothing.join(', ')} would carry no cost at all. `
        + `Ask the trader whether the weights${method === 'value' ? ' and values' : ''} are right.`,
    };
  }
  return { ok: true, costs };
}

/** Cost leaving a lot when `carats` of it are taken: all of it when the lot is emptied, else at its average (2 dp). */
function costOfTaking(lot, carats) {
  const held = pos(lot && lot.carats);
  const cost = round2((lot && lot.cost) || 0);
  const take = pos(carats);
  if (!held || lots.round3(held - take) < EPS) return cost;
  return Math.min(cost, round2(cost * take / held));
}

/** Carats in and out of a split / merge / move may differ by this much: max(0.05 ct, 0.5 %), capped at 2 ct. */
function weightTolerance(caratsIn) {
  return lots.round3(Math.min(2, Math.max(0.05, pos(caratsIn) * 0.005)));
}

/** carats out ÷ carats in × 100, 1 dp; null when caratsIn is 0. */
function yieldPct(caratsIn, caratsOut) {
  const cin = pos(caratsIn);
  if (!cin) return null;
  return Math.round(Number((pos(caratsOut) / cin * 1000).toFixed(6))) / 10;
}

/**
 * Advisory card lines for an unusual yield (they never block): cutting < 5 % or > 50 %; recut
 * losing > 40 %; sawing / heating / preform losing > 15 %; a re-weigh that moves the weight by
 * more than REWEIGH_FACTOR either way (100 ct becoming 10,000 ct is a typo until shown otherwise).
 * @returns {string[]}
 */
function yieldWarnings({ job, caratsIn, caratsOut } = {}) {
  const pct = yieldPct(caratsIn, caratsOut);
  if (pct == null) return [];
  const weights = `${plain(caratsOut)} ct from ${plain(caratsIn)} ct`;
  const lost = Math.round((100 - pct) * 10) / 10;
  if (job === 'reweigh') {
    const ratio = pos(caratsOut) / pos(caratsIn);
    if (!(ratio > REWEIGH_FACTOR || (ratio > 0 && ratio < 1 / REWEIGH_FACTOR))) return [];
    const times = Math.round((ratio > 1 ? ratio : 1 / ratio) * 10) / 10;
    return [`The re-weigh gives ${plain(caratsOut)} ct where ${plain(caratsIn)} ct was on record: ${times} times ${ratio > 1 ? 'more' : 'less'}. `
      + 'That is a big change for a correction. Check the weight (1 gram = 5 carats).'];
  }
  if (job === 'cutting') {
    if (pct < 5) return [`Yield is ${pct}% (${weights}). That is low: under 5% is unusual for cutting. Check the weights.`];
    if (pct > 50) return [`Yield is ${pct}% (${weights}). That is high: over 50% is unusual for cutting. Check the weights.`];
    return [];
  }
  if (job === 'recut' && lost > 40) return [`The recut lost ${lost}% of the weight (${weights}). More than 40% is unusual. Check the weights.`];
  if (['sawing', 'heating', 'preform'].includes(job) && lost > 15) {
    const what = { sawing: 'Sawing', heating: 'Heating', preform: 'Preforming' }[job];
    return [`${what} lost ${lost}% of the weight (${weights}). More than 15% is unusual. Check the weights.`];
  }
  return [];
}

module.exports = { REWEIGH_FACTOR, share, outputCosts, costOfTaking, weightTolerance, yieldPct, yieldWarnings };

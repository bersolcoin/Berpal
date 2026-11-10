/**
 * Anomaly flags for the confirmation card. Pure: everything that needs Postgres (the user's
 * medians, whether the wallet is cash, whether the payee is new) arrives in `stats`, built by
 * src/trust/index.js from the fingerprint table, so no ERPNext round-trip per card.
 *
 * Flags are advisory lines on the card; they never block a save.
 */
const { companyCurrency, round2 } = require('../erp-sync/common');
const { computeTotals } = require('../erp-sync/taxes');

const DEFAULT_LARGE_AMOUNT_FLOOR = 20000;
const LARGE_MULTIPLE = 10;
// A median from one or two postings says nothing about "typical".
const MIN_MEDIAN_SAMPLES = 3;
const ROUND_CASH_MIN = 10000;
const ROUND_CASH_STEP = 1000;
const STALE_DAYS = 90;

/** TRUST_LARGE_AMOUNT_FLOOR (reporting currency), read per call so tests and ops can change it. */
function largeAmountFloor() {
  const v = Number(process.env.TRUST_LARGE_AMOUNT_FLOOR);
  return Number.isFinite(v) && v >= 0 && String(process.env.TRUST_LARGE_AMOUNT_FLOOR).trim() !== ''
    ? v
    : DEFAULT_LARGE_AMOUNT_FLOOR;
}

function fmt(n) {
  const v = round2(Number(n) || 0);
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const cardDate = (iso) => String(iso).slice(0, 10).replace(/-/g, '/');

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`)) / 86400000);
}

/** The draft's gross in the reporting currency, or null when a foreign amount has no rate yet. */
function baseAmount(user, draft) {
  const gross = computeTotals(draft).gross;
  if (!draft.currency || draft.currency === companyCurrency(user)) return gross;
  const rate = Number(draft.exchange_rate);
  return rate > 0 ? round2(gross * rate) : null;
}

/** Money physically leaving a wallet (not a bill, invoice or transfer). */
function isOutgoing(draft) {
  const tt = draft.transaction_type || 'cash';
  return draft.direction === 'expense' && ['cash', 'payment', 'advance_given'].includes(tt);
}

/**
 * @param {object} user   users row (reporting_currency)
 * @param {object} draft  the draft about to be carded
 * @param {object} stats  {
 *   today: 'YYYY-MM-DD' (user-local),
 *   medians: { [direction]: { median, count } } over the last 90 days, reporting currency,
 *   walletIsCash: bool (no wallet, or a Cash-type wallet),
 *   newPayee: bool (counterparty never posted to before and new to the contact list),
 *   floor?: number (defaults to TRUST_LARGE_AMOUNT_FLOOR / 20000)
 * }
 * @returns {string[]} warning texts, most severe first (not truncated; index.js caps the card)
 */
function anomalies(user, draft, stats = {}) {
  const out = [];
  const floor = stats.floor != null ? Number(stats.floor) : largeAmountFloor();
  const rc = companyCurrency(user);
  const base = baseAmount(user, draft);
  const today = stats.today;
  const date = draft.transaction_date ? String(draft.transaction_date).slice(0, 10) : null;

  // Severity order: future date, unusually large, new payee, round cash, stale date.
  if (date && today && date > today) out.push(`Date is in the future: ${cardDate(date)}`);

  // Transfers move money between the user's own wallets: a big one (savings top-up) isn't a red flag.
  const m = draft.direction !== 'transfer' && stats.medians && stats.medians[draft.direction];
  if (base != null && base > floor && m && m.count >= MIN_MEDIAN_SAMPLES && m.median > 0 && base > LARGE_MULTIPLE * m.median) {
    out.push(`Unusually large: ${fmt(base)} ${rc} vs typical ${fmt(m.median)} ${rc}`);
  }

  if (stats.newPayee && isOutgoing(draft) && base != null && base >= floor) out.push('New payee, first payment');

  if (stats.walletIsCash && isOutgoing(draft) && base != null && base >= ROUND_CASH_MIN
      && Math.abs(base % ROUND_CASH_STEP) < 0.005) {
    out.push(`Large round cash amount: ${fmt(base)} ${rc}`);
  }

  if (date && today && daysBetween(date, today) > STALE_DAYS) out.push(`Date is over ${STALE_DAYS} days ago: ${cardDate(date)}`);
  return out;
}

module.exports = {
  anomalies, largeAmountFloor, baseAmount, isOutgoing, fmt, cardDate,
  DEFAULT_LARGE_AMOUNT_FLOOR, MIN_MEDIAN_SAMPLES, STALE_DAYS,
};

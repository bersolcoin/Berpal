/**
 * The gem lines of the morning digest (jobs/digest.job.js): at most three, each one line, each
 * something somebody has to act on. Nothing for a user who is not a gem trader, and nothing when
 * there is nothing late, stuck or different.
 *
 *   Stones out too long: 3 lots (Somchai, Lek)
 *   Not finished: cutting BPL-… was only partly saved, say "retry" to finish it
 *   Stock check: 2 differences between your lots and the books, for the accountant (L12, L15)
 * Plain words for the trader: no statuses, no names of ERPNext's documents.
 *
 * Read-only, Postgres only (the nightly lots-reconcile job has already asked ERPNext). A part
 * that cannot be read costs its own line, never the digest.
 */
const lots = require('./index');
const store = require('./store');
const custody = require('./custody');
const reconcile = require('./reconcile');
const { kindWords } = require('./undo');

const MAX_NAMES = 3;   // holders / lot codes named on a line
const MAX_NAME_CHARS = 24;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const short = (s) => (String(s).length > MAX_NAME_CHARS ? `${String(s).slice(0, MAX_NAME_CHARS - 1)}…` : String(s));

/** "A, B, C +2 more" from a list with repeats (first seen first, compared without case). */
function named(list) {
  const seen = new Map();
  for (const x of list.filter(Boolean)) if (!seen.has(String(x).toLowerCase())) seen.set(String(x).toLowerCase(), short(x));
  const all = [...seen.values()];
  if (!all.length) return '';
  return ` (${all.slice(0, MAX_NAMES).join(', ')}${all.length > MAX_NAMES ? ` +${all.length - MAX_NAMES} more` : ''})`;
}

/** Stones past their due date, or out for work for long with no date agreed (custody.overdue). The holders are named, first seen first. */
async function overdueLine(user, today) {
  const late = await custody.overdue(user, today ? { today } : {});
  if (!late.length) return null;
  return `Stones out too long: ${plural(late.length, 'lot', 'lots')}${named(late.map((r) => r.holder))}`;
}

/** The operation that is only partly saved (or partly taken back) and blocks every other one. */
async function unfinishedLine(user) {
  const [op] = await store.unfinishedOps(user.id);
  if (!op) return null;
  return op.status === 'undoing'
    ? `Not finished: taking back ${kindWords(op)} ${op.reference} stopped half way, say "retry" to finish it`
    : `Not finished: ${kindWords(op)} ${op.reference} was only partly saved, say "retry" to finish it`;
}

/** What the nightly check found different from ERPNext and has not seen put right. */
async function mismatchLine(user) {
  const open = await reconcile.open(user);
  if (!open.length) return null;
  const lotCodes = open.map((m) => m.lot);
  return `Stock check: ${plural(open.length, 'difference', 'differences')} between your lots and the books, for the accountant${named(lotCodes)}`;
}

/**
 * @param {object} user  @param {{today?: string}} [opts]  today: YYYY-MM-DD, the user's own day
 * @returns {Promise<string[]>} [] for a user without gem lots or with nothing to say; otherwise up
 *   to three short lines: stones out too long or past their date, an operation that is only partly
 *   saved (or partly taken back), differences between the lots and the books (reconcile)
 */
async function lines(user, opts = {}) {
  if (!lots.isGems(user)) return [];
  const out = [];
  for (const [what, line] of [
    ['overdue', () => overdueLine(user, opts.today)],
    ['unfinished', () => unfinishedLine(user)],
    ['mismatches', () => mismatchLine(user)],
  ]) {
    try {
      const text = await line();
      if (text) out.push(text);
    } catch (err) {
      console.error(`[lots] digest line failed (${what}, user ${user.id}):`, err.message);
    }
  }
  return out;
}

module.exports = { lines };

/**
 * Who holds what: stones out with a cutter, a heater or a broker on memo. Reads only
 * (store.listCustody); the rows change only when an operation posts. A holder's name is compared
 * and shown with its white space collapsed, so one person typed two ways is one holder.
 */
const lots = require('./index');
const store = require('./store');
const { round2 } = require('../erp-sync/common');
const { localClock } = require('../jobs');

/** Days stones may be out for work, with no date agreed, before they count as out too long. */
const WORK_LONG_DAYS = 30;

const DAY_MS = 86400000;
const daysBetween = (from, to) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)) / DAY_MS));
/** "Khun  Lek " and "Khun Lek" are one holder: inner runs of white space collapse, the ends go. */
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
/** The user's own calendar day. */
const todayOf = (user) => localClock(new Date(), user && user.timezone).date;

/** One open custody row as the trader sees it: what is still out, and whether it is late. */
function view(c, today) {
  const carats = lots.round3(c.carats_out - c.carats_returned - c.carats_sold);
  // A lot that is out is out as a whole (a part sent out becomes a lot of its own), so what is
  // still out is normally the lot itself; the proportion only covers rows that disagree.
  const whole = Math.abs(c.lot_carats - carats) < 0.0005;
  const days = daysBetween(c.date_out, today);
  const due = c.due_date ? String(c.due_date).slice(0, 10) : null;
  const why = due ? (due < today ? 'past_due' : null) : c.purpose !== 'memo' && days > WORK_LONG_DAYS ? 'long_out' : null;
  return {
    holder: cleanName(c.holder),
    purpose: c.purpose,
    lot: c.lot_code,
    carats,
    pieces: c.lot_location !== 'stores' ? c.lot_pieces : carats === c.carats_out ? c.pieces_out : null,
    cost: whole ? c.lot_cost : c.lot_carats > 0 ? round2((c.lot_cost * carats) / c.lot_carats) : 0,
    date_out: String(c.date_out).slice(0, 10),
    days_out: days,
    due_date: due,
    overdue: !!why,
    overdue_reason: why,
    memo_price_per_ct: c.purpose === 'memo' ? c.memo_price_per_ct : null,
    currency: c.purpose === 'memo' && c.memo_price_per_ct != null ? c.currency || null : null,
  };
}

/** Every row that still has stones out, oldest first. */
async function rowsOut(user, { today, holder, purpose } = {}) {
  const day = today || todayOf(user);
  // The holder filter is applied here, on the cleaned name: the store matches the raw text, so a
  // name typed with two spaces would never be found by one typed with one.
  const open = await store.listCustody(user.id, { purpose: purpose || undefined });
  const want = holder ? cleanName(holder).toLowerCase() : null;
  return open
    .filter((c) => !want || cleanName(c.holder).toLowerCase().includes(want))
    .map((c) => view(c, day))
    .filter((r) => r.carats > 0);
}

/**
 * Everything that is out, grouped by holder and by purpose (the same person can hold stones for
 * work and on memo). Groups and rows are oldest first.
 * @param {{today?: string, holder?: string, purpose?: 'work'|'memo'}} [opts]  today: YYYY-MM-DD
 *   (default the user's own day); holder: part of the name
 * @returns {Promise<Array<{holder: string, purpose: string, carats: number, cost: number, rows: Array<{lot: string,
 *   carats: number, pieces: number|null, cost: number, date_out: string, days_out: number, due_date: string|null,
 *   overdue: boolean, overdue_reason: 'past_due'|'long_out'|null, memo_price_per_ct: number|null,
 *   currency: string|null}>}>>}  carats = still out (sent, less what came back or was sold); cost in
 *   the company currency; currency = that of the memo price
 */
async function out(user, opts = {}) {
  const groups = new Map();
  for (const { holder, purpose, ...row } of await rowsOut(user, opts)) {
    const key = `${holder.toLowerCase()}|${purpose}`; // holder is already cleaned
    if (!groups.has(key)) groups.set(key, { holder, purpose, carats: 0, cost: 0, rows: [] });
    const g = groups.get(key);
    g.rows.push(row);
    g.carats = lots.round3(g.carats + row.carats);
    g.cost = round2(g.cost + row.cost);
  }
  return [...groups.values()];
}

/**
 * What is late: anything past its due date, and stones out for work with no date agreed for
 * longer than WORK_LONG_DAYS. Oldest first; each row also names its holder and purpose.
 * @param {{today?: string, holder?: string, purpose?: 'work'|'memo'}} [opts]
 */
async function overdue(user, opts = {}) {
  return (await rowsOut(user, opts)).filter((r) => r.overdue);
}

module.exports = { WORK_LONG_DAYS, out, overdue };

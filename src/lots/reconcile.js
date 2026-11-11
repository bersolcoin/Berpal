/**
 * The nightly comparison of Berpal's lot rows with ERPNext: per lot the carats, the place and
 * the value of its batch (Stock Ledger), the batches of the gem items that hold stones Berpal
 * has no lot for, and the valuation holding account, which must come back to zero.
 * It reports; it never corrects, on either side. ERPNext is right about carats and value.
 *
 * What it finds is kept in lot_mismatches (migration 110) for the digest and the accountant's
 * review queue: a finding stays one row for as long as it is found, and is closed by the first
 * run that checked it and no longer finds it. A run that could not check something (a lot ERPNext
 * did not answer for, a lot an operation is changing) leaves its findings as they were.
 */
const db = require('../db');
const lots = require('./index');
const lotsErp = require('./erp');
const store = require('./store');
const { round2, companyCurrency, resolveErpAccount, ts } = require('../erp-sync/common');
const { fmt } = require('../tools/card');

/** Lots read from ERPNext at the same time. */
const PARALLEL = 4;
/** Money differences up to this (in the company currency) are rounding, not a finding. */
const VALUE_TOLERANCE = 0.01;
const PLACE_WORDS = { stores: 'in stock', work: 'out for work', memo: 'out on memo' };

const ct = (n) => `${Number(lots.round3(n)).toLocaleString('en-US', { maximumFractionDigits: 3 })} ct`;
const sum = (rows, f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);

/** Every lot row of the user; the closed ones are needed to name a batch that should be empty. */
async function allLots(userId) {
  const { rows } = await db.query(
    'SELECT id, code, status, carats, cost, location, holder, erpnext_batch FROM lots WHERE user_id = $1 ORDER BY id', [userId]
  );
  return rows.map((r) => ({ ...r, carats: Number(r.carats), cost: Number(r.cost) }));
}

/** One lot against its batch: carats to 0.001, the warehouse it sits in, value to 0.01. */
async function compareLot(erp, lot, abbr, currency) {
  const code = lot.code;
  if (!lot.erpnext_batch) {
    return [{ lot: code, kind: 'carats', berpal: lot.carats, erpnext: 0, detail: `Lot ${code}: Berpal has ${ct(lot.carats)}, but the lot has no batch in ERPNext.` }];
  }
  const stock = await lotsErp.batchStock(erp, lot.erpnext_batch);
  const qty = lots.round3(sum(stock, 'qty'));
  const value = round2(sum(stock, 'value'));
  const found = [];
  if (qty !== lots.round3(lot.carats)) {
    found.push({ lot: code, kind: 'carats', berpal: lots.round3(lot.carats), erpnext: qty,
      detail: `Lot ${code}: Berpal has ${ct(lot.carats)}, ERPNext has ${ct(qty)} in batch ${lot.erpnext_batch}.` });
  }
  const holds = stock.filter((w) => w.qty > 0);
  const at = (w) => lotsErp.placeOf(w.warehouse, abbr) || w.warehouse;
  if (holds.some((w) => at(w) !== lot.location)) {
    found.push({ lot: code, kind: 'place', berpal: lot.location, erpnext: holds.map(at).join(' + '),
      detail: `Lot ${code}: Berpal has it ${PLACE_WORDS[lot.location] || lot.location}${lot.holder ? ` with ${lot.holder}` : ''}, `
        + `ERPNext holds ${holds.map((w) => `${ct(w.qty)} in ${w.warehouse}`).join(' and ')}.` });
  }
  if (Math.abs(round2(value - round2(lot.cost))) > VALUE_TOLERANCE) {
    found.push({ lot: code, kind: 'value', berpal: round2(lot.cost), erpnext: value,
      detail: `Lot ${code}: Berpal carries it at ${fmt(round2(lot.cost))} ${currency}, ERPNext values batch ${lot.erpnext_batch} at ${fmt(value)} ${currency}.` });
  }
  return found;
}

/**
 * Batches of the two gem items that hold stock in ERPNext without an active lot in Berpal: one
 * list read (Batch.batch_qty). A batch of a lot Berpal has closed is a carats finding of that
 * lot; a batch Berpal never heard of is a 'no_lot' finding.
 */
async function strayBatches(erp, all, abbr) {
  const items = [lotsErp.itemCode('rough', abbr), lotsErp.itemCode('cut', abbr)];
  const r = await erp.listResource('Batch', {
    filters: [['item', 'in', items], ['batch_qty', '>', 0]], fields: ['name', 'item', 'batch_qty'], limit: 10000,
  });
  const active = new Set(all.filter((l) => l.status === 'active').map((l) => l.erpnext_batch));
  const closed = new Map(all.filter((l) => l.status !== 'active' && l.erpnext_batch).map((l) => [l.erpnext_batch, l]));
  const found = [];
  for (const b of r.data || []) {
    if (active.has(b.name)) continue; // compared as a lot
    const qty = lots.round3(b.batch_qty);
    const lot = closed.get(b.name);
    if (lot) {
      found.push({ lot: lot.code, kind: 'carats', berpal: 0, erpnext: qty,
        detail: `Lot ${lot.code}: Berpal has nothing left of it, ERPNext still holds ${ct(qty)} in batch ${b.name}.` });
    } else {
      found.push({ lot: null, subject: b.name, kind: 'no_lot', berpal: 0, erpnext: qty,
        detail: `ERPNext holds ${ct(qty)} of ${b.item} in batch ${b.name}, which Berpal has no lot for.` });
    }
  }
  return found;
}

/** The holding account a fee passes through on its way into the stones: it must net to zero. */
async function holdingCheck(user, erp) {
  const currency = companyCurrency(user);
  const account = await resolveErpAccount(user, erp, lots.FEE_CATEGORY_CODE, currency);
  if (!account) return null;
  const r = await erp.getAccountBalance(account);
  const balance = round2(Number(r && r.message) || 0);
  if (balance === 0) return [];
  return [{ lot: null, subject: account, kind: 'holding', berpal: 0, erpnext: balance,
    detail: `${account} shows ${fmt(balance)} ${currency} and should be back at zero: a fee for work on stones was posted without going into their cost, or the other way round.` }];
}

const subjectOf = (m) => m.subject || m.lot;
const keyOf = (kind, subject) => `${kind}|${subject}`;

/**
 * Open what is new, refresh what is still there, close what was not found again. `skip(row)` says
 * which open findings were NOT checked this time (a lot ERPNext could not be asked about, a lot an
 * operation is changing, a list that could not be read): they are left open, as they were.
 */
async function keep(userId, found, skip) {
  const now = new Date().toISOString();
  return db.withTransaction(async (c) => {
    const { rows } = await c.query("SELECT id, kind, subject, lot_code FROM lot_mismatches WHERE user_id = $1 AND status = 'open'", [userId]);
    const open = new Map(rows.map((r) => [keyOf(r.kind, r.subject), r]));
    let opened = 0;
    let closed = 0;
    for (const m of found) {
      const key = keyOf(m.kind, subjectOf(m));
      const have = open.get(key);
      const figures = [String(m.berpal), String(m.erpnext), m.detail, now];
      if (have) {
        await c.query('UPDATE lot_mismatches SET berpal = $1, erpnext = $2, detail = $3, last_seen = $4 WHERE id = $5', [...figures, have.id]);
        open.delete(key);
      } else {
        await c.query(
          `INSERT INTO lot_mismatches (user_id, kind, subject, lot_code, berpal, erpnext, detail, status, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $8)`,
          [userId, m.kind, subjectOf(m), m.lot || null, ...figures]
        );
        opened++;
      }
    }
    for (const r of open.values()) {
      if (skip(r)) continue; // not checked tonight: it says nothing either way
      await c.query("UPDATE lot_mismatches SET status = 'closed', closed_at = $1 WHERE id = $2", [now, r.id]);
      closed++;
    }
    return { opened, closed };
  });
}

/** Codes of the lots the user's unfinished operations (partly saved, partly undone) are changing. */
async function busyLots(userId) {
  const codes = new Set();
  const ops = await store.unfinishedOps(userId);
  for (const o of ops) {
    const op = (o.plan && o.plan.op) || {};
    for (const x of [...(op.inputs || []), ...(op.outputs || [])]) if (x && x.code) codes.add(x.code);
  }
  return { busy: codes, any: ops.length > 0 };
}

const stateOf = (l) => `${l.status}|${l.carats}|${l.cost}|${l.location}|${l.holder || ''}`;

/**
 * Compare and keep the result. Reads ERPNext only; changes no lot. Throws when ERPNext cannot be
 * read at all (nothing is kept then, so no finding is closed by a run that saw nothing).
 *
 * A finding is closed only by a run that checked it. A lot whose batch could not be read tonight,
 * a lot an unfinished operation is changing (checked at the start and again at the end of the run),
 * and a lot that changed while the run was reading are left alone: their open findings stay open
 * and nothing new is opened for them. When anything changed meanwhile the two extra checks (stones
 * ERPNext holds without a lot, the holding account) are left alone too.
 * @param {object} user  @param {object} erp
 * @returns {Promise<{checked: number, mismatches: Array<{lot: string|null, kind: 'carats'|'place'|'value'|'holding'|'no_lot',
 *   berpal: number|string, erpnext: number|string, detail: string}>, opened: number, closed: number, unchecked?: string[]}>}
 *   checked = lots compared; berpal / erpnext are carats ('carats', 'no_lot'), money ('value',
 *   'holding') or places ('place': 'stores' | 'work' | 'memo', or the warehouse's own name);
 *   unchecked = codes of the lots not compared tonight (present only when there are some)
 */
async function run(user, erp) {
  const abbr = await lotsErp.abbr(erp);
  const currency = companyCurrency(user);
  const all = await allLots(user.id);
  const first = await busyLots(user.id);
  const active = all.filter((l) => l.status === 'active');
  const todo = active.filter((l) => !first.busy.has(l.code));

  const found = [];
  const unread = new Set();
  let firstError = null;
  for (let i = 0; i < todo.length; i += PARALLEL) {
    const part = await Promise.all(todo.slice(i, i + PARALLEL).map(async (l) => {
      try {
        return await compareLot(erp, l, abbr, currency);
      } catch (err) {
        firstError = firstError || err;
        unread.add(l.code);
        console.error(`• [lots] [${ts()}] reconcile user_id=${user.id}: lot ${l.code} not read: ${err.message}`);
        return [];
      }
    }));
    found.push(...part.flat());
  }
  // Not one lot could be read: ERPNext is not answering, which is not a night's finding.
  if (todo.length && unread.size === todo.length) throw firstError;

  const skipKinds = new Set();
  let closedLotsUnread = false;
  try {
    found.push(...await strayBatches(erp, all, abbr));
  } catch (err) {
    // An extra, not the comparison itself: without it the lots are still compared. What only that
    // list shows (stones of a lot Berpal has closed, batches without a lot) is left as it was.
    skipKinds.add('no_lot');
    closedLotsUnread = true;
    console.error(`• [lots] [${ts()}] reconcile user_id=${user.id}: batches without a lot not read: ${err.message}`);
  }
  let holding = null;
  try {
    holding = await holdingCheck(user, erp);
  } catch (err) {
    // As above: the lots are still compared, and what was open about the account stays open.
    console.error(`• [lots] [${ts()}] reconcile user_id=${user.id}: holding account not read: ${err.message}`);
  }
  if (holding) found.push(...holding);
  else skipKinds.add('holding');

  // The books may have moved while ERPNext was being read: an operation that started, or that
  // finished (lots changed or appeared) since the first look.
  const last = await busyLots(user.id);
  const now = await allLots(user.id);
  const before = new Map(all.map((l) => [l.code, stateOf(l)]));
  const moved = new Set(now.filter((l) => before.get(l.code) !== stateOf(l)).map((l) => l.code));
  for (const code of last.busy) moved.add(code);
  if (moved.size || last.any || first.any) {
    skipKinds.add('no_lot');
    skipKinds.add('holding');
  }
  const closedCodes = new Set(all.filter((l) => l.status !== 'active').map((l) => l.code));
  const left = new Set([...unread, ...first.busy, ...moved]); // lots not checked tonight
  const skip = (row) => skipKinds.has(row.kind) || (row.lot_code && left.has(row.lot_code))
    || (closedLotsUnread && row.kind === 'carats' && closedCodes.has(row.lot_code));
  const kept = found.filter((m) => !(m.lot && left.has(m.lot)) && !skipKinds.has(m.kind));

  const { opened, closed } = await keep(user.id, kept, skip);
  const compared = todo.filter((l) => !unread.has(l.code) && !moved.has(l.code));
  const unchecked = active.filter((l) => !compared.includes(l)).map((l) => l.code);
  return {
    checked: compared.length,
    mismatches: kept.map((m) => ({ lot: m.lot, kind: m.kind, berpal: m.berpal, erpnext: m.erpnext, detail: m.detail })),
    opened,
    closed,
    ...(unchecked.length ? { unchecked } : {}),
  };
}

const figure = (kind, v) => (kind === 'place' || v == null ? v : Number(v));

/**
 * The mismatches that are still open, oldest first.
 * @returns {Promise<Array<{id: number, lot: string|null, kind: string, berpal: number|string, erpnext: number|string,
 *   detail: string, first_seen: string, last_seen: string}>>}
 */
async function open(user) {
  const { rows } = await db.query("SELECT * FROM lot_mismatches WHERE user_id = $1 AND status = 'open' ORDER BY id", [user.id]);
  return rows.map((r) => ({
    id: r.id, lot: r.lot_code, kind: r.kind, berpal: figure(r.kind, r.berpal), erpnext: figure(r.kind, r.erpnext),
    detail: r.detail, first_seen: r.first_seen, last_seen: r.last_seen,
  }));
}

module.exports = { run, open };

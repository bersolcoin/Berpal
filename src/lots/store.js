/**
 * The lot tables (src/migrations/100-lots.sql). This is the ONLY module that writes them.
 *
 * An operation's life:
 *   beginOp      'pending'   written before anything is sent to ERPNext
 *   recordStep   'partial'   one ERPNext document of the operation is posted and remembered
 *   postOp       'posted'    every document is posted: the lot rows, lineage and custody change
 *                            HERE and nowhere else, in one transaction
 *   failOp       'failed'    ERPNext clearly refused and nothing is posted (blocks nothing)
 *   markPartial  'partial'   it stopped somewhere unclear, or after something was posted
 *   markUndoing  'undoing'   its documents are being cancelled
 *   unmarkUndoing 'posted'   the undo stopped before anything was cancelled: a fully posted
 *                'partial'   operation is simply still posted, one that never was is partial again
 *   reverseOp    'undone'    the lot rows are put back as they were (every document cancelled first)
 *
 * Because lots only change in postOp, an operation that is partly saved leaves them exactly as
 * the confirmation card showed them: resolving the same draft again gives the same operation.
 * One unfinished operation ('pending' | 'partial' | 'undoing') per user at a time: beginOp checks it
 * under a lock on the user's row, and src/migrations/105-lot-op-guards.sql backs it with a unique index.
 *
 * Two callers may finish or undo the same operation at once (a trader's retry, the nightly recovery
 * job). Each writer locks the operation row (FOR UPDATE) and guards its write by the status it
 * expects, so the second one finds the work done. `serial` adds the same order within this
 * process, which is also what makes the race testable on pg-mem (it has no row locks).
 */
const db = require('../db');
const lots = require('./index');
const { round2 } = require('../erp-sync/common');

const now = () => new Date().toISOString();
const num = (v) => (v == null ? null : Number(v));
const EPS = 0.0005; // half a thousandth of a carat: below this a lot is empty
const COST_ROUNDING = 0.02; // a cost may differ by this much from the books' figure before it is called drift

/** Columns a ResolvedOutput's attrs may write. */
const ATTRS = ['form', 'species', 'variety', 'shape', 'size', 'colour', 'clarity', 'origin', 'grade', 'description',
  'treatment', 'treatment_source', 'purchase_unit', 'pricing_basis', 'supplier', 'supplier_doc', 'vat_exempt'];
/** Columns postOp may change on an existing lot, so the ones reverseOp puts back from the snapshot. */
const RESTORED = ['status', 'erpnext_item', 'erpnext_batch', 'revision', 'carats', 'weight_estimated', 'pieces', 'cost',
  'location', 'holder', ...ATTRS, 'last_op_date'];
/** Columns the trader may edit without an operation (set_lot_details). Never carats, pieces or cost. */
const DETAILS = ['species', 'variety', 'shape', 'size', 'colour', 'clarity', 'origin', 'grade', 'description',
  'treatment', 'treatment_source', 'ask_per_ct', 'bottom_per_ct', 'price_currency', 'supplier_doc', 'vat_exempt'];
const UNFINISHED = ['pending', 'partial', 'undoing'];
/** Statuses an operation can start being undone from. */
const UNDOABLE = ['pending', 'partial', 'posted', 'undoing'];
/** Draft keys that mean nothing once the draft is stored with its operation. */
const NOT_STORED = ['confirmation_pending', 'confirmation_sig', 'wallet_options', 'outreach_preview'];

const marks = (list, from = 1) => list.map((_, i) => `$${i + from}`).join(', ');

/** An operation's status in words a trader would use (messages reach the chat). */
const STATUS_WORDS = {
  pending: 'not yet in the books', partial: 'only partly in the books', posted: 'done', failed: 'not saved',
  undoing: 'being undone', undone: 'undone',
};
const said = (status) => STATUS_WORDS[status] || status;
const kindWords = (kind) => String(kind || 'operation').replace(/_/g, ' ');

/** Run fn after every earlier call with the same key has finished (this process only). */
const chains = new Map();
function serial(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/** Thrown inside a transaction by a caller that lost a race: the work is rolled back and the winner's result stands. */
const LOST = Symbol('lost the race');
const isDuplicate = (err) => !!err && (err.code === '23505' || /duplicate key/i.test(String(err.message)));

/** Case-insensitive "contains". Done here, not with ILIKE, so a % _ or \ typed by the trader is only a character. */
const contains = (text, needle) => String(text == null ? '' : text).toLowerCase().includes(String(needle).trim().toLowerCase());

function parse(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function lotRow(r) {
  if (!r) return null;
  return {
    ...r,
    carats: Number(r.carats), cost: Number(r.cost), revision: Number(r.revision),
    pieces: r.pieces == null ? null : Number(r.pieces),
    ask_per_ct: num(r.ask_per_ct), bottom_per_ct: num(r.bottom_per_ct),
  };
}

function opRow(r) {
  if (!r) return null;
  return {
    ...r,
    plan: parse(r.plan, null), erpnext_docs: parse(r.erpnext_docs, []), before: parse(r.before, null),
    steps_done: Number(r.steps_done), fee_amount: num(r.fee_amount), yield_pct: num(r.yield_pct),
  };
}

const custodyRow = (r) => (r ? {
  ...r,
  carats_out: Number(r.carats_out), pieces_out: r.pieces_out == null ? null : Number(r.pieces_out),
  carats_returned: Number(r.carats_returned), carats_sold: Number(r.carats_sold), memo_price_per_ct: num(r.memo_price_per_ct),
} : null);

const brief = (l) => ({ code: l.code, carats: l.carats, pieces: l.pieces, cost: l.cost, location: l.location, status: l.status });

// ── lots: reads ──────────────────────────────────────────────────────

/** @returns {Promise<object|null>} the lot with this code (any status), numbers as numbers */
async function getLot(userId, code) {
  const c = lots.normCode(code);
  if (!c) return null;
  const { rows } = await db.query('SELECT * FROM lots WHERE user_id = $1 AND code = $2', [userId, c]);
  return lotRow(rows[0]);
}

/** @returns {Promise<Map<string, object>>} code → lot, for the codes that exist */
async function getLots(userId, codes) {
  const list = [...new Set((codes || []).map(lots.normCode).filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await db.query(`SELECT * FROM lots WHERE user_id = $1 AND code IN (${marks(list, 2)})`, [userId, ...list]);
  return new Map(rows.map((r) => [r.code, lotRow(r)]));
}

/** Every lot of this user that fits the filters, newest first, without a limit. */
async function lotsMatching(userId, { status = 'active', location, holder, species, form, search } = {}) {
  const where = ['user_id = $1'];
  const args = [userId];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (status && status !== 'all') add('status = ?', status);
  if (location) add('location = ?', location);
  if (form) add('form = ?', form);
  const { rows } = await db.query(`SELECT * FROM lots WHERE ${where.join(' AND ')} ORDER BY id DESC`, args);
  return rows.filter((r) => {
    if (holder && !contains(r.holder, holder)) return false;
    if (species && !contains(r.species, species)) return false;
    if (search && !['code', 'description', 'species', 'variety', 'colour', 'origin', 'supplier'].some((k) => contains(r[k], search))) return false;
    return true;
  }).map(lotRow);
}

/**
 * @param {{status?: 'active'|'closed'|'all', location?: string, holder?: string, species?: string, form?: string,
 *   search?: string, limit?: number}} [filter]  status defaults to 'active'; holder, species and search
 *   match anywhere in the text, upper or lower case
 * @returns {Promise<object[]>} newest first
 */
async function listLots(userId, { limit = 50, ...filter } = {}) {
  return (await lotsMatching(userId, filter)).slice(0, Math.max(1, Math.min(Number(limit) || 50, 500)));
}

/**
 * How many lots fit the filters of listLots (all of them, no limit), the carats they hold and what they cost.
 * @returns {Promise<{count: number, carats: number, cost: number}>}
 */
async function lotTotals(userId, filter = {}) {
  const { limit, ...rest } = filter || {};
  const rows = await lotsMatching(userId, rest);
  return {
    count: rows.length,
    carats: lots.round3(rows.reduce((t, r) => t + r.carats, 0)),
    cost: round2(rows.reduce((t, r) => t + r.cost, 0)),
  };
}

/**
 * The next n free codes of the form L<number>, continuing from the highest one this user has.
 * A code of six digits or more (a date, a bill number the trader used as a code) is not part of the
 * numbering: it must not drag every later lot up to L20260110. It still counts as taken.
 * @param {{taken?: string[]}} [opts]  codes already spoken for in the draft being resolved
 */
async function nextCodes(userId, n, { taken = [] } = {}) {
  const { rows } = await db.query('SELECT code FROM lots WHERE user_id = $1', [userId]);
  const used = new Set([...rows.map((r) => r.code), ...taken.map(lots.normCode).filter(Boolean)]);
  let max = 0;
  for (const code of used) {
    const m = /^L(\d{1,5})$/.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const out = [];
  while (out.length < n) {
    max += 1;
    if (!used.has(`L${max}`)) out.push(`L${max}`);
  }
  return out;
}

/** Edit descriptive fields only. Unknown keys are dropped. @returns the lot after, or null when it does not exist. */
async function setDetails(userId, code, fields) {
  const lot = await getLot(userId, code);
  if (!lot) return null;
  const keys = Object.keys(fields || {}).filter((k) => DETAILS.includes(k) && fields[k] !== undefined);
  if (!keys.length) return lot;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  await db.query(`UPDATE lots SET ${sets.join(', ')}, updated_at = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
    [...keys.map((k) => fields[k]), now(), lot.id]);
  return getLot(userId, code);
}

// ── certificates ─────────────────────────────────────────────────────

/** @param {{lab: string, report_no?: string, report_date?: string, stated_carats?: number, url?: string, media_id?: number}} cert */
async function addCertificate(userId, code, cert) {
  const lot = await getLot(userId, code);
  if (!lot) return null;
  const { rows } = await db.query(
    `INSERT INTO lot_certificates (lot_id, lab, report_no, report_date, stated_carats, url, media_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [lot.id, cert.lab, cert.report_no || null, cert.report_date || null, cert.stated_carats == null ? null : cert.stated_carats,
      cert.url || null, cert.media_id || null, now()]
  );
  return { ...rows[0], stated_carats: num(rows[0].stated_carats) };
}

async function listCertificates(lotId) {
  const { rows } = await db.query('SELECT * FROM lot_certificates WHERE lot_id = $1 ORDER BY id', [lotId]);
  return rows.map((r) => ({ ...r, stated_carats: num(r.stated_carats) }));
}

// ── operations: reads ────────────────────────────────────────────────

async function getOp(userId, reference) {
  const { rows } = await db.query('SELECT * FROM lot_ops WHERE user_id = $1 AND reference = $2', [userId, String(reference || '').trim().toUpperCase()]);
  return opRow(rows[0]);
}

async function getOpById(opId) {
  const { rows } = await db.query('SELECT * FROM lot_ops WHERE id = $1', [opId]);
  return opRow(rows[0]);
}

/** Operations that block every other lot operation, oldest first. `plan` and `erpnext_docs` are parsed. */
async function unfinishedOps(userId) {
  const { rows } = await db.query(
    `SELECT * FROM lot_ops WHERE user_id = $1 AND status IN (${marks(UNFINISHED, 2)}) ORDER BY id`, [userId, ...UNFINISHED]
  );
  return rows.map(opRow);
}

/** Every user's unfinished operations, oldest first (the recovery job). */
async function allUnfinishedOps() {
  const { rows } = await db.query(`SELECT * FROM lot_ops WHERE status IN (${marks(UNFINISHED)}) ORDER BY id`, UNFINISHED);
  return rows.map(opRow);
}

/**
 * @param {{status?: string|string[], kinds?: string[], since?: string, limit?: number}} [filter]
 *   status defaults to 'posted'; since is an op_date (YYYY-MM-DD, inclusive)
 * @returns {Promise<object[]>} newest first
 */
async function listOps(userId, { status = 'posted', kinds, since, limit = 50 } = {}) {
  const where = ['user_id = $1'];
  const args = [userId];
  const statuses = [].concat(status || []);
  if (statuses.length) { where.push(`status IN (${marks(statuses, args.length + 1)})`); args.push(...statuses); }
  if (kinds && kinds.length) { where.push(`kind IN (${marks(kinds, args.length + 1)})`); args.push(...kinds); }
  if (since) { args.push(since); where.push(`op_date >= $${args.length}`); }
  args.push(Math.max(1, Math.min(Number(limit) || 50, 500)));
  const { rows } = await db.query(`SELECT * FROM lot_ops WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${args.length}`, args);
  return rows.map(opRow);
}

async function countOps(userId, { kinds, status = 'posted' } = {}) {
  const where = ['user_id = $1'];
  const args = [userId];
  const statuses = [].concat(status || []);
  if (statuses.length) { where.push(`status IN (${marks(statuses, args.length + 1)})`); args.push(...statuses); }
  if (kinds && kinds.length) { where.push(`kind IN (${marks(kinds, args.length + 1)})`); args.push(...kinds); }
  const { rows } = await db.query(`SELECT COUNT(*) AS n FROM lot_ops WHERE ${where.join(' AND ')}`, args);
  return Number(rows[0].n);
}

const lineRow = (r) => ({
  ...r, carats: Number(r.carats), value: Number(r.value),
  pieces: r.pieces == null ? null : Number(r.pieces), damaged_pieces: r.damaged_pieces == null ? null : Number(r.damaged_pieces),
});

/** The lineage lines of one operation, inputs first. */
async function opLines(opId) {
  const { rows } = await db.query('SELECT * FROM lot_op_lines WHERE op_id = $1 ORDER BY id', [opId]);
  return rows.map(lineRow);
}

async function laterOpsWith(q, userId, lotIds, opId) {
  const ids = [...new Set(lotIds)];
  if (!ids.length) return [];
  const { rows } = await q(
    `SELECT o.id, o.reference, o.kind, o.job, o.op_date, l.lot_code
       FROM lot_ops o JOIN lot_op_lines l ON l.op_id = o.id
      WHERE o.user_id = $1 AND o.id > $2 AND o.status = 'posted' AND l.lot_id IN (${marks(ids, 3)})
      ORDER BY o.id`,
    [userId, opId, ...ids]
  );
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/** Posted operations newer than opId that touch any of these lots (they stand in the way of an undo). */
const laterOps = (userId, lotIds, opId) => laterOpsWith(db.query, userId, lotIds, opId);

/**
 * What happened to a lot, newest first: one entry per operation that touched it, with the lot's
 * own line(s) of that operation.
 * @param {{limit?: number, includeUndone?: boolean}} [opts]
 * @returns {Promise<Array<{reference, kind, job, direction, status, date, holder, note, fee_amount, yield_pct, docs,
 *   lines: Array<{role, carats, pieces, damaged_pieces, value, place}>}>>}
 */
async function history(userId, code, { limit = 20, includeUndone = false } = {}) {
  const lot = await getLot(userId, code);
  if (!lot) return [];
  const { rows } = await db.query(
    `SELECT o.id AS op_id, o.reference, o.kind, o.job, o.direction, o.status, o.op_date, o.holder, o.note, o.fee_amount,
            o.yield_pct, o.erpnext_docs, l.role, l.carats, l.pieces, l.damaged_pieces, l.value, l.place
       FROM lot_op_lines l JOIN lot_ops o ON o.id = l.op_id
      WHERE l.lot_id = $1 AND o.user_id = $2
      ORDER BY o.id DESC, l.id`,
    [lot.id, userId]
  );
  const byOp = new Map();
  for (const r of rows) {
    if (r.status !== 'posted' && !(includeUndone && r.status === 'undone')) continue;
    if (!byOp.has(r.op_id)) {
      byOp.set(r.op_id, {
        reference: r.reference, kind: r.kind, job: r.job, direction: r.direction, status: r.status, date: r.op_date,
        holder: r.holder, note: r.note, fee_amount: num(r.fee_amount), yield_pct: num(r.yield_pct),
        docs: parse(r.erpnext_docs, []), lines: [],
      });
    }
    const l = lineRow(r);
    byOp.get(r.op_id).lines.push({ role: l.role, carats: l.carats, pieces: l.pieces, damaged_pieces: l.damaged_pieces, value: l.value, place: l.place });
  }
  return [...byOp.values()].slice(0, Math.max(1, Number(limit) || 20));
}

/**
 * Where a lot came from and what became of it, through posted operations. An operation that only
 * moved the lot (the same lot in and out) links nothing.
 * @returns {Promise<{lot: object, ancestors: object[], descendants: object[]}|null>} each entry
 *   { code, depth, carats, value, via: { reference, kind, job, date } }, nearest first
 */
async function lineage(userId, code, { maxDepth = 20 } = {}) {
  const lot = await getLot(userId, code);
  if (!lot) return null;
  const walk = async (fromRole, toRole) => {
    const found = [];
    const seen = new Set([lot.id]);
    let frontier = [lot.id];
    for (let depth = 1; frontier.length && depth <= maxDepth; depth += 1) {
      const { rows } = await db.query(
        `SELECT a.lot_id AS from_id, b.lot_id, b.lot_code, b.carats, b.value, o.reference, o.kind, o.job, o.op_date
           FROM lot_op_lines a
           JOIN lot_ops o ON o.id = a.op_id
           JOIN lot_op_lines b ON b.op_id = a.op_id
          WHERE o.user_id = $1 AND o.status = 'posted' AND a.role = $2 AND b.role = $3 AND a.lot_id IN (${marks(frontier, 4)})
          ORDER BY o.id DESC, b.id`,
        [userId, fromRole, toRole, ...frontier]
      );
      frontier = [];
      for (const r of rows) {
        if (seen.has(r.lot_id)) continue;
        seen.add(r.lot_id);
        frontier.push(r.lot_id);
        found.push({ code: r.lot_code, depth, carats: Number(r.carats), value: Number(r.value), via: { reference: r.reference, kind: r.kind, job: r.job, date: r.op_date } });
      }
    }
    return found;
  };
  return { lot, ancestors: await walk('out', 'in'), descendants: await walk('in', 'out') };
}

// ── custody: reads ───────────────────────────────────────────────────

/**
 * Custody rows joined with their lot.
 * @param {{status?: 'out'|'returned'|'sold'|'lost'|'all', holder?: string, purpose?: 'work'|'memo'|'lab', lot?: string}} [filter]
 *   status defaults to 'out'
 * @returns {Promise<object[]>} oldest date_out first; each row carries lot_code, lot_carats, lot_pieces,
 *   lot_cost, lot_status, lot_location, lot_form, lot_species, lot_description
 */
async function listCustody(userId, { status = 'out', holder, purpose, lot } = {}) {
  const where = ['c.user_id = $1'];
  const args = [userId];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (status && status !== 'all') add('c.status = ?', status);
  if (purpose) add('c.purpose = ?', purpose);
  if (lot && lots.normCode(lot)) add('l.code = ?', lots.normCode(lot));
  const { rows } = await db.query(
    `SELECT c.*, l.code AS lot_code, l.carats AS lot_carats, l.pieces AS lot_pieces, l.cost AS lot_cost, l.status AS lot_status,
            l.location AS lot_location, l.form AS lot_form, l.species AS lot_species, l.description AS lot_description
       FROM lot_custody c JOIN lots l ON l.id = c.lot_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.date_out, c.id`,
    args
  );
  return rows.filter((r) => !holder || contains(r.holder, holder)).map((r) => ({
    ...custodyRow(r), lot_carats: Number(r.lot_carats), lot_cost: Number(r.lot_cost), lot_pieces: r.lot_pieces == null ? null : Number(r.lot_pieces),
  }));
}

// ── operations: writes ───────────────────────────────────────────────

const notFound = () => new Error('That stock operation is not on record.');
const busy = (reference) => new Error(`Stock operation ${reference} is not finished yet`);

/**
 * Open an operation, before ERPNext hears of it.
 * @param {object} user
 * @param {{op: object, draft?: object}} args  op: the ResolvedOp; draft: the confirmed chat draft
 *   (kept so the money document can still be built after a restart)
 * @returns {Promise<object>} the lot_ops row ('pending'), plan parsed
 * @throws when this user already has an unfinished operation (also when two begin at the same moment:
 *   the user's row is locked while the check and the insert run, and a unique index backs it up)
 */
async function beginOp(user, { op, draft = null }) {
  if (!op || !lots.OP_KINDS.includes(op.kind)) throw new Error('That is not something that can be done to stones, so it cannot be recorded.');
  const kept = draft ? { ...draft } : null;
  if (kept) for (const k of NOT_STORED) delete kept[k];
  return serial(`user:${user.id}`, async () => {
    try {
      return await db.withTransaction(async (c) => {
        await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
        const open = await c.query(`SELECT reference FROM lot_ops WHERE user_id = $1 AND status IN (${marks(UNFINISHED, 2)}) LIMIT 1`, [user.id, ...UNFINISHED]);
        if (open.rows.length) throw busy(open.rows[0].reference);
        const { rows } = await c.query(
          `INSERT INTO lot_ops (user_id, kind, job, direction, status, reference, op_date, plan, holder, note, created_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10) RETURNING *`,
          [user.id, op.kind, op.job || null, op.direction || null, lots.newReference(), op.date, JSON.stringify({ op, draft: kept }),
            op.holder || null, op.note || null, now()]
        );
        return opRow(rows[0]);
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      // The unique index caught what the check could not (another process): same answer.
      const open = await db.query(`SELECT reference FROM lot_ops WHERE user_id = $1 AND status IN (${marks(UNFINISHED, 2)}) LIMIT 1`, [user.id, ...UNFINISHED]);
      if (!open.rows.length) throw err;
      throw busy(open.rows[0].reference);
    }
  });
}

/**
 * One ERPNext document of the operation is posted. Recording the same step twice changes nothing.
 * @param {{step: number, doctype: string, name: string}} doc
 * @returns {Promise<object>} the lot_ops row after
 * @throws when the operation is no longer open for documents (done, being undone, undone)
 */
async function recordStep(opId, { step, doctype, name }) {
  return serial(`op:${opId}`, () => db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    const docs = o.erpnext_docs;
    const known = docs.some((d) => d.step === step && d.name === name);
    // 'failed' is open again here: it was dropped as failed while this document was on its way to the
    // books (the nightly check and a retry at the same moment), and a document that exists is never left unrecorded.
    if (!['pending', 'partial', 'failed'].includes(o.status)) {
      if (known) return o;
      throw new Error(`Stock operation ${o.reference} is ${said(o.status)}, so nothing more can be added to it.`);
    }
    if (!known) docs.push({ step, doctype, name });
    docs.sort((a, b) => a.step - b.step);
    const { rows } = await c.query("UPDATE lot_ops SET erpnext_docs = $1, steps_done = $2, status = 'partial' WHERE id = $3 RETURNING *",
      [JSON.stringify(docs), Math.max(o.steps_done, step), opId]);
    return opRow(rows[0]);
  }));
}

/**
 * undo: one document of the operation is cancelled in ERPNext.
 * @throws when the operation is not being undone, or has no such document
 */
async function markDocCancelled(opId, name) {
  return serial(`op:${opId}`, () => db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    if (o.status !== 'undoing') throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; its documents are only cancelled while it is being undone.`);
    if (!o.erpnext_docs.some((d) => d.name === name)) throw new Error(`Stock operation ${o.reference} has no document called ${name}.`);
    const docs = o.erpnext_docs.map((d) => (d.name === name ? { ...d, cancelled: true } : d));
    await c.query('UPDATE lot_ops SET erpnext_docs = $1 WHERE id = $2', [JSON.stringify(docs), opId]);
    return docs;
  }));
}

async function setStatus(opId, status, error, from, words) {
  const { rows } = await db.query(
    `UPDATE lot_ops SET status = $1, error = $2 WHERE id = $3 AND status IN (${marks(from, 4)}) RETURNING *`,
    [status, error == null ? null : String(error).slice(0, 1000), opId, ...from]
  );
  if (!rows.length) {
    const o = await getOpById(opId);
    if (!o) throw notFound();
    throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; it cannot be ${words}.`);
  }
  return opRow(rows[0]);
}

/** ERPNext clearly refused and no document of the operation exists: it is over and blocks nothing. */
async function failOp(opId, error) {
  // In line with recordStep, so a document recorded at the same moment is seen here.
  return serial(`op:${opId}`, () => db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    if (o.erpnext_docs.some((d) => !d.cancelled)) throw new Error(`Stock operation ${o.reference} is already in the books, so it cannot be dropped as failed. Undo it instead.`);
    if (!['pending', 'partial'].includes(o.status)) throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; it cannot be dropped as failed.`);
    const { rows } = await c.query("UPDATE lot_ops SET status = 'failed', error = $1 WHERE id = $2 RETURNING *",
      [error == null ? null : String(error).slice(0, 1000), opId]);
    return opRow(rows[0]);
  }));
}

/** It stopped after something was posted, or nobody knows whether it was: stays open for a retry or an undo. */
const markPartial = (opId, error) => setStatus(opId, 'partial', error, ['pending', 'partial'], 'left open');

/**
 * Its documents are about to be cancelled. From here only undo.run may continue it. A finished
 * operation cannot start being undone while another one of this user's is still open (that one
 * has to be finished or undone first).
 */
async function markUndoing(opId) {
  const first = await getOpById(opId);
  if (!first) throw notFound();
  return serial(`user:${first.user_id}`, () => db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    if (!UNDOABLE.includes(o.status)) throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; it cannot be undone.`);
    if (o.status === 'posted') {
      const open = await c.query(`SELECT reference FROM lot_ops WHERE user_id = $1 AND status IN (${marks(UNFINISHED, 2)}) LIMIT 1`, [o.user_id, ...UNFINISHED]);
      if (open.rows.length) throw new Error(`Stock operation ${open.rows[0].reference} is not finished yet. Finish it or undo it first.`);
    }
    const { rows } = await c.query(
      `UPDATE lot_ops SET status = 'undoing', error = NULL WHERE id = $1 AND status IN (${marks(UNDOABLE, 2)}) RETURNING *`,
      [opId, ...UNDOABLE]
    ).catch((err) => {
      // The unique index caught another operation of this user that is still open (begun in another process).
      if (isDuplicate(err)) throw new Error('Another stock operation of this account is not finished yet. Finish it or undo it first.');
      throw err;
    });
    if (!rows.length) throw new Error(`Stock operation ${o.reference} changed while it was being undone. Try again.`);
    return opRow(rows[0]);
  }));
}

/**
 * The undo stopped before it cancelled anything: the operation goes back to where it was. One
 * that postOp completed (every document recorded, the lots changed) is 'posted' again, as if the
 * undo had not begun; one that never was is 'partial' (a retry can finish it). The lots are not touched.
 * @returns {Promise<'posted'|'partial'|null>} the new status, or null when nothing was done: the
 *   operation is not being undone, a document of it is already cancelled (there is no way back
 *   then, only forward), or it does not exist
 */
async function unmarkUndoing(opId) {
  return serial(`op:${opId}`, () => db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o || o.status !== 'undoing') return null;
    if (o.erpnext_docs.some((d) => d.cancelled)) return null;
    // posted_at and the snapshot are written by postOp alone: without them the operation was never fully posted.
    const done = !!(o.posted_at && o.before);
    const { rows } = done
      ? await c.query("UPDATE lot_ops SET status = 'posted', error = NULL WHERE id = $1 AND status = 'undoing' RETURNING status", [opId])
      : await c.query("UPDATE lot_ops SET status = 'partial' WHERE id = $1 AND status = 'undoing' RETURNING status", [opId]);
    return rows.length ? rows[0].status : null;
  }));
}

/** Keep the reason an undo stopped, without changing where it stands. */
async function noteError(opId, error) {
  await db.query('UPDATE lot_ops SET error = $1 WHERE id = $2', [error == null ? null : String(error).slice(0, 1000), opId]);
}

const closeStatus = (kind) => (kind === 'sell' ? 'sold' : kind === 'write_off' ? 'lost' : 'returned');

/**
 * Every ERPNext document of the operation is posted: apply it to the lots. One transaction.
 * Inputs are taken first, then outputs added, so one lot may be both (a whole lot moved, a recut).
 *
 * @param {number} opId
 * @param {{actuals?: {inputs?: Object<string, {cost?: number}>,
 *                     outputs?: Object<string, {cost?: number, item?: string, batch?: string}>}}} [args]
 *   actuals, keyed by lot code, are what ERPNext really did (read back from its stock ledger):
 *   cost overrides the planned figure; item and batch are REQUIRED for every new lot and for an
 *   existing lot that takes a new batch (recut / re-weigh).
 * @returns {Promise<Array<{code, carats, pieces, cost, location, status}>>} the lots after, outputs first
 */
async function postOp(opId, { actuals = {} } = {}) {
  return serial(`op:${opId}`, async () => {
    try {
      return await postLocked(opId, actuals);
    } catch (err) {
      if (err !== LOST) throw err;
      // The other caller finished it first and this one's work was rolled back: the operation stands as it is now.
      const o = await getOpById(opId);
      return postedLots(db.query, o);
    }
  });
}

/** The lots a posted operation touched, outputs first, as the operation left them. */
async function postedLots(q, o) {
  const { rows } = await q("SELECT lot_id FROM lot_op_lines WHERE op_id = $1 ORDER BY CASE role WHEN 'out' THEN 0 ELSE 1 END, id", [o.id]);
  const out = [];
  for (const id of new Set(rows.map((r) => r.lot_id))) {
    const l = lotRow((await q('SELECT * FROM lots WHERE id = $1 AND user_id = $2', [id, o.user_id])).rows[0]);
    if (l) out.push(brief(l));
  }
  return out;
}

async function postLocked(opId, actuals) {
  return db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    const op = o.plan && o.plan.op;
    if (!op) throw new Error(`Stock operation ${o.reference} has no record of what it was to do, so it cannot be finished.`);
    const lotById = async (id) => lotRow((await c.query('SELECT * FROM lots WHERE id = $1 AND user_id = $2', [id, o.user_id])).rows[0]);
    const order = [];
    const touch = (id) => { if (!order.includes(id)) order.push(id); };
    const after = async () => {
      const out = [];
      for (const id of order) { const l = await lotById(id); if (l) out.push(brief(l)); }
      return out;
    };
    if (o.status === 'posted') return postedLots((sql, args) => c.query(sql, args), o);
    if (!['pending', 'partial'].includes(o.status)) throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; it cannot be finished.`);

    const t = now();
    const before = { lots: [], created: [], custody: [], certificates: [], uncounted: [] };
    const inputs = op.inputs || [];
    const outputs = op.outputs || [];
    const line = (role, lotId, code, carats, pieces, damaged, value, place) => c.query(
      `INSERT INTO lot_op_lines (op_id, role, lot_id, lot_code, carats, pieces, damaged_pieces, value, place)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [opId, role, lotId, code, carats, pieces, damaged, value, place]
    );

    // Existing lots this operation re-uses as outputs, as they are now (before the inputs change them).
    for (const out of outputs.filter((x) => !x.new)) {
      const { rows } = await c.query('SELECT * FROM lots WHERE id = $1 AND user_id = $2', [out.lot_id, o.user_id]);
      if (!rows.length) throw new Error(`Lot ${out.code} is no longer on record.`);
      if (!before.lots.some((l) => l.id === rows[0].id)) before.lots.push(rows[0]);
    }

    for (const inp of inputs) {
      const lot = await lotById(inp.lot_id);
      if (!lot) throw new Error(`Lot ${inp.code} is no longer on record.`);
      const left = lots.round3(lot.carats - inp.carats);
      if (left < -EPS) throw new Error(`Lot ${lot.code} holds ${lot.carats} ct, less than the ${inp.carats} ct this operation takes.`);
      const whole = !!inp.whole || left < EPS;
      const act = (actuals.inputs || {})[inp.code] || {};
      const value = round2(act.cost != null ? act.cost : inp.cost);
      const counted = lot.pieces != null;
      const taken = !counted ? null : whole ? lot.pieces : (inp.pieces == null ? null : Number(inp.pieces));
      // Part of a counted lot taken without a count: the count that is left is no longer known.
      if (counted && taken == null) before.uncounted.push({ id: lot.id, pieces: lot.pieces });
      const piecesLeft = !counted ? null : whole ? 0 : taken == null ? null : Math.max(0, lot.pieces - taken);
      // The books may value what was taken above what Berpal carries for the lot (the two drifted apart):
      // a rounding difference is absorbed, more than that is refused, never made up silently.
      const costLeft = round2(lot.cost - value);
      if (!whole && costLeft < -COST_ROUNDING) {
        throw new Error(`The books value the stones taken from lot ${lot.code} at ${value}, but the lot only carries ${lot.cost}. `
          + 'The two have drifted apart: have the value of this lot checked before going on.');
      }
      await c.query('UPDATE lots SET carats = $1, pieces = $2, cost = $3, status = $4, last_op_date = $5, updated_at = $6 WHERE id = $7',
        [whole ? 0 : left, piecesLeft, whole ? 0 : Math.max(0, costLeft), whole ? 'closed' : 'active', op.date, t, lot.id]);
      await line('in', lot.id, lot.code, inp.carats, taken, null, value, inp.from || lot.location);
      touch(lot.id);

      if (inp.from === 'work' || inp.from === 'memo') {
        const { rows } = await c.query("SELECT id, carats_out, pieces_out FROM lot_custody WHERE lot_id = $1 AND status = 'out' ORDER BY id DESC LIMIT 1", [lot.id]);
        const sold = op.kind === 'sell' ? inp.carats : 0;
        const returned = op.kind === 'sell' || op.kind === 'write_off' ? 0 : inp.carats;
        // Part of what is out is written off: it is no longer out (a whole lot closes its row as lost instead).
        const lost = op.kind === 'write_off' && !whole ? inp.carats : 0;
        const lostPieces = lost && taken != null && rows.length && rows[0].pieces_out != null ? Math.min(taken, Number(rows[0].pieces_out)) : 0;
        if (rows.length && (sold || returned || lost)) {
          await c.query(
            'UPDATE lot_custody SET carats_returned = carats_returned + $1, carats_sold = carats_sold + $2, carats_out = carats_out - $3 WHERE id = $4',
            [returned, sold, lost, rows[0].id]
          );
          if (lostPieces) await c.query('UPDATE lot_custody SET pieces_out = $1 WHERE id = $2', [Number(rows[0].pieces_out) - lostPieces, rows[0].id]);
          before.custody.push({ id: rows[0].id, returned, sold, lost, lostPieces });
        }
      }
    }

    const outIds = [];
    for (const out of outputs) {
      const act = (actuals.outputs || {})[out.code] || {};
      const value = round2(act.cost != null ? act.cost : out.cost);
      const attrs = ATTRS.filter((k) => out.attrs && out.attrs[k] !== undefined);
      let lotId;
      if (out.new) {
        if (!act.item || !act.batch) throw new Error(`New lot ${out.code} cannot be saved yet: the books did not say what item and batch hold its stones.`);
        const cols = ['user_id', 'code', 'status', 'erpnext_item', 'erpnext_batch', 'revision', 'carats', 'weight_estimated', 'pieces',
          'cost', 'location', 'holder', ...attrs, 'last_op_date', 'created_at', 'updated_at'];
        const vals = [o.user_id, out.code, 'active', act.item, act.batch, out.revision || 0, lots.round3(out.carats), !!out.weight_estimated,
          out.pieces == null ? null : Number(out.pieces), value, out.to || 'stores', out.to && out.to !== 'stores' ? op.holder || null : null,
          ...attrs.map((k) => out.attrs[k]), op.date, t, t];
        const { rows } = await c.query(`INSERT INTO lots (${cols.join(', ')}) VALUES (${marks(vals)}) RETURNING id`, vals);
        lotId = rows[0].id;
        before.created.push(lotId);
      } else {
        const lot = await lotById(out.lot_id);
        const empty = lot.carats < EPS;
        const pieces = empty ? (out.pieces == null ? null : Number(out.pieces))
          : lot.pieces != null && out.pieces != null ? lot.pieces + Number(out.pieces) : null;
        const batch = act.batch || lot.erpnext_batch;
        const sets = {
          status: 'active', carats: lots.round3(lot.carats + out.carats), pieces, cost: round2(lot.cost + value),
          location: out.to || lot.location, holder: (out.to || lot.location) === 'stores' ? null : op.holder || lot.holder || null,
          revision: out.revision == null ? lot.revision : out.revision, erpnext_batch: batch, erpnext_item: act.item || lot.erpnext_item,
          ...(out.weight_estimated == null ? {} : { weight_estimated: !!out.weight_estimated }),
          ...Object.fromEntries(attrs.map((k) => [k, out.attrs[k]])),
          last_op_date: op.date, updated_at: t,
        };
        const keys = Object.keys(sets);
        await c.query(`UPDATE lots SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => sets[k]), lot.id]);
        lotId = lot.id;
        // A lot that takes a new batch was recut or re-weighed: its lab reports describe the old stone.
        if (batch !== lot.erpnext_batch) {
          const certs = await c.query('SELECT id FROM lot_certificates WHERE lot_id = $1 AND outdated = FALSE', [lot.id]);
          for (const r of certs.rows) {
            await c.query('UPDATE lot_certificates SET outdated = TRUE WHERE id = $1', [r.id]);
            before.certificates.push(r.id);
          }
        }
      }
      await line('out', lotId, out.code, lots.round3(out.carats), out.pieces == null ? null : Number(out.pieces), out.damaged_pieces || null, value, out.to || 'stores');
      outIds.push(lotId);
    }
    // Outputs lead the list handed back; inputs that are not also outputs follow.
    order.splice(0, order.length, ...new Set([...outIds, ...order]));

    // Custody follows the lots: a lot that is out has exactly one open row, a lot that is not has none.
    const { rows: [u] } = await c.query('SELECT reporting_currency, default_currency FROM users WHERE id = $1', [o.user_id]);
    for (const id of order) {
      const lot = await lotById(id);
      const out = lot.status === 'active' && lot.location !== 'stores';
      const { rows: open } = await c.query("SELECT id, purpose FROM lot_custody WHERE lot_id = $1 AND status = 'out'", [id]);
      let kept = false;
      for (const row of open) {
        if (out && row.purpose === lot.location && !kept) { kept = true; continue; }
        await c.query('UPDATE lot_custody SET status = $1, closed_at = $2, close_op_id = $3 WHERE id = $4', [closeStatus(op.kind), op.date, opId, row.id]);
      }
      if (out && !kept) {
        await c.query(
          `INSERT INTO lot_custody (user_id, lot_id, holder, purpose, carats_out, pieces_out, date_out, due_date, memo_price_per_ct, currency, out_op_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'out')`,
          [o.user_id, id, lot.holder || op.holder || 'unknown', lot.location, lot.carats, lot.pieces, op.date, op.due_date || null,
            lot.location === 'memo' && op.memo_price_per_ct != null ? op.memo_price_per_ct : null,
            (u && (u.reporting_currency || u.default_currency)) || null, opId]
        );
      }
    }

    const fee = op.fee || null;
    const done = await c.query(
      `UPDATE lot_ops SET status = 'posted', posted_at = $1, error = NULL, before = $2, yield_pct = $3, fee_amount = $4, fee_basis = $5,
              holder = $6, note = $7 WHERE id = $8 AND status IN ('pending', 'partial') RETURNING id`,
      [t, JSON.stringify(before), op.yield_pct == null ? null : op.yield_pct, fee ? fee.capitalised : null, fee ? fee.basis || null : null,
        op.holder || null, op.note || null, opId]
    );
    if (!done.rows.length) throw LOST; // someone else finished it meanwhile: this transaction is rolled back
    return after();
  });
}

const sameValue = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));

/**
 * What putting an operation's lots back would throw away. Read it BEFORE reverseOp (the lots it
 * looks at are gone afterwards); reverseOp returns the same two lists.
 *  - certificates: lab reports added to a lot the operation created (the lot is deleted with them)
 *  - detailsChanged: codes of lots the operation re-used whose descriptive fields were edited after
 *    it (species, colour, treatment, …): they go back to what they were before the operation
 * @returns {Promise<{certificates: Array<{lot: string, lab: string, report_no: string|null}>, detailsChanged: string[]}>}
 *   both empty for an operation that never posted or is already undone
 */
async function reverseLosses(opId) {
  return lossesOf((sql, args) => db.query(sql, args), await getOpById(opId));
}

async function lossesOf(q, o) {
  const none = { certificates: [], detailsChanged: [] };
  if (!o || !o.before || !['posted', 'undoing', 'partial'].includes(o.status)) return none;
  const before = { lots: [], created: [], ...o.before };
  const certificates = [];
  for (const id of before.created) {
    const lot = (await q('SELECT code FROM lots WHERE id = $1', [id])).rows[0];
    if (!lot) continue;
    const { rows } = await q('SELECT lab, report_no FROM lot_certificates WHERE lot_id = $1 ORDER BY id', [id]);
    for (const r of rows) certificates.push({ lot: lot.code, lab: r.lab, report_no: r.report_no == null ? null : r.report_no });
  }
  const detailsChanged = [];
  const outputs = (o.plan && o.plan.op && o.plan.op.outputs) || [];
  for (const row of before.lots) {
    const now_ = (await q('SELECT * FROM lots WHERE id = $1', [row.id])).rows[0];
    if (!now_) continue;
    const out = outputs.find((x) => !x.new && x.lot_id === row.id);
    // What the operation itself left on the lot: the snapshot, with what its output line wrote over it.
    const changed = ATTRS.some((k) => !sameValue(out && out.attrs && out.attrs[k] !== undefined ? out.attrs[k] : row[k], now_[k]));
    if (changed && !detailsChanged.includes(now_.code)) detailsChanged.push(now_.code);
  }
  return { certificates, detailsChanged };
}

/** The list of lots handed back by reverseOp carries the two loss lists as properties that do not show up in a comparison or a JSON dump. */
function withLosses(list, losses) {
  Object.defineProperty(list, 'certificates', { value: losses.certificates, enumerable: false });
  Object.defineProperty(list, 'detailsChanged', { value: losses.detailsChanged, enumerable: false });
  return list;
}

/**
 * The operation's ERPNext documents are cancelled (or it never posted any): put the lots back.
 * One transaction. Lots the operation created are deleted (lot_ops.plan keeps what they were);
 * existing lots it re-used as outputs go back to their snapshot; lots it only took from get their
 * carats, pieces and cost back.
 * @returns {Promise<Array<{code, carats, pieces, cost, location, status}>>} the lots that are back; the
 *   array also has `.certificates` and `.detailsChanged` (see reverseLosses) for what this threw away
 * @throws when the operation is not being undone (markUndoing first), a document of it is not cancelled
 *   yet (markDocCancelled), or a later posted operation touches one of its output lots
 */
async function reverseOp(opId) {
  return serial(`op:${opId}`, async () => {
    try {
      return await reverseLocked(opId);
    } catch (err) {
      if (err !== LOST) throw err;
      return withLosses([], { certificates: [], detailsChanged: [] }); // the other caller undid it first
    }
  });
}

async function reverseLocked(opId) {
  return db.withTransaction(async (c) => {
    const o = opRow((await c.query('SELECT * FROM lot_ops WHERE id = $1 FOR UPDATE', [opId])).rows[0]);
    if (!o) throw notFound();
    if (o.status === 'undone') return withLosses([], { certificates: [], detailsChanged: [] });
    if (o.status === 'failed') throw new Error(`Stock operation ${o.reference} was never saved; there is nothing to undo.`);
    if (o.status !== 'undoing') throw new Error(`Stock operation ${o.reference} is ${said(o.status)}; it has to be marked as being undone, and its documents cancelled, before the stones are put back.`);
    const standing = o.erpnext_docs.filter((d) => !d.cancelled).map((d) => d.name);
    if (standing.length) throw new Error(`Stock operation ${o.reference} still has documents in the books (${standing.join(', ')}); they have to be cancelled before the stones are put back.`);
    const lines = (await c.query('SELECT * FROM lot_op_lines WHERE op_id = $1 ORDER BY id', [opId])).rows.map(lineRow);
    const t = now();
    const back = [];
    const losses = await lossesOf((sql, args) => c.query(sql, args), o);

    if (lines.length) {
      const before = { lots: [], created: [], custody: [], certificates: [], uncounted: [], ...(o.before || {}) };
      const later = await laterOpsWith((sql, args) => c.query(sql, args), o.user_id, lines.filter((l) => l.role === 'out').map((l) => l.lot_id), o.id);
      if (later.length) {
        throw new Error(`Lot ${later[0].lot_code} was used again after this (${kindWords(later[0].kind)} ${later[0].reference} on ${later[0].op_date}). Undo that first.`);
      }

      await c.query('DELETE FROM lot_custody WHERE out_op_id = $1', [opId]);
      await c.query("UPDATE lot_custody SET status = 'out', closed_at = NULL, close_op_id = NULL WHERE close_op_id = $1", [opId]);
      for (const d of before.custody) {
        await c.query('UPDATE lot_custody SET carats_returned = carats_returned - $1, carats_sold = carats_sold - $2, carats_out = carats_out + $3 WHERE id = $4',
          [d.returned || 0, d.sold || 0, d.lost || 0, d.id]);
        if (d.lostPieces) {
          const { rows } = await c.query('SELECT pieces_out FROM lot_custody WHERE id = $1', [d.id]);
          if (rows.length && rows[0].pieces_out != null) await c.query('UPDATE lot_custody SET pieces_out = $1 WHERE id = $2', [Number(rows[0].pieces_out) + d.lostPieces, d.id]);
        }
      }
      for (const id of before.certificates) await c.query('UPDATE lot_certificates SET outdated = FALSE WHERE id = $1', [id]);

      await c.query('DELETE FROM lot_op_lines WHERE op_id = $1', [opId]);
      for (const id of before.created) {
        for (const table of ['lot_op_lines', 'lot_custody', 'lot_certificates']) await c.query(`DELETE FROM ${table} WHERE lot_id = $1`, [id]);
        await c.query('DELETE FROM lots WHERE id = $1 AND user_id = $2', [id, o.user_id]);
      }
      for (const row of before.lots) {
        await c.query(`UPDATE lots SET ${RESTORED.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${RESTORED.length + 1} WHERE id = $${RESTORED.length + 2}`,
          [...RESTORED.map((k) => row[k]), t, row.id]);
        back.push(row.id);
      }
      const settled = new Set([...before.created, ...before.lots.map((l) => l.id)]);
      for (const l of lines.filter((x) => x.role === 'in' && !settled.has(x.lot_id))) {
        const lot = lotRow((await c.query('SELECT * FROM lots WHERE id = $1', [l.lot_id])).rows[0]);
        if (!lot) continue;
        const was = before.uncounted.find((x) => x.id === lot.id);
        const pieces = was && lot.pieces == null ? was.pieces
          : lot.pieces != null && l.pieces != null ? lot.pieces + l.pieces : lot.pieces;
        const last = await c.query(
          `SELECT MAX(o.op_date) AS d FROM lot_op_lines l JOIN lot_ops o ON o.id = l.op_id WHERE l.lot_id = $1 AND o.status = 'posted' AND o.id <> $2`,
          [lot.id, opId]
        );
        await c.query("UPDATE lots SET carats = $1, cost = $2, pieces = $3, status = 'active', last_op_date = $4, updated_at = $5 WHERE id = $6",
          [lots.round3(lot.carats + l.carats), round2(lot.cost + l.value), pieces, (last.rows[0] && last.rows[0].d) || null, t, lot.id]);
        if (!back.includes(lot.id)) back.push(lot.id);
      }
    }

    const done = await c.query("UPDATE lot_ops SET status = 'undone', undone_at = $1, error = NULL WHERE id = $2 AND status = 'undoing' RETURNING id", [t, opId]);
    if (!done.rows.length) throw LOST;
    const out = [];
    for (const id of back) {
      const l = lotRow((await c.query('SELECT * FROM lots WHERE id = $1', [id])).rows[0]);
      if (l) out.push(brief(l));
    }
    return withLosses(out, losses);
  });
}


module.exports = {
  ATTRS, DETAILS, UNFINISHED,
  getLot, getLots, listLots, lotTotals, nextCodes, setDetails,
  addCertificate, listCertificates,
  getOp, getOpById, unfinishedOps, allUnfinishedOps, listOps, countOps, opLines, laterOps, history, lineage,
  listCustody,
  beginOp, recordStep, markDocCancelled, failOp, markPartial, markUndoing, unmarkUndoing, noteError, postOp, reverseOp, reverseLosses,
};

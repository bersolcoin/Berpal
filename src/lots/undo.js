/**
 * Take a lot operation back: cancel its ERPNext documents newest first, then put the lot rows
 * back (store.reverseOp). Its own confirmation card; resumable.
 *
 * Allowed while no lot the operation touched has been used by a later operation, and for the
 * operation that is stuck half way (the way out when it cannot be finished). A purchase or a sale
 * of lots is a bill / an invoice, and those are never cancelled from here: the accountant cancels
 * them in the books. Once that is done, the undo of the purchase or sale only puts the lots back.
 *
 * Three rules keep the books and the lots together:
 *  - An operation that is only partly saved may have posted a document Berpal never recorded (a
 *    crash between ERPNext saying yes and the record). Before anything is cancelled, at card time
 *    and again at the start of the run, ERPNext is searched for the steps that are not recorded
 *    (the same remark search execute.run does), what is found is recorded and cancelled with the
 *    rest. If that search fails the undo stops: it never ends 'undone' without knowing.
 *  - Every money document (a fee bill, a fee entry) is checked up front for being cancellable (a
 *    bill with a payment against it is not); if one is not, the whole undo is refused before
 *    anything is cancelled, never stopped half way with the stones moved back and the bill standing.
 *  - A cancel whose outcome is unknown (a timeout, a 5xx) leaves the operation 'undoing': the
 *    document may be cancelled after all. Only a clear refusal of the first document sends it back
 *    (store.unmarkUndoing).
 *
 * Nothing here writes the lot tables itself (store.js does), and a refusal by ERPNext is a
 * result, never a throw: the operation then waits as 'undoing' and retry_stock_op continues it.
 */
const lots = require('./index');
const store = require('./store');
const lotErp = require('./erp');
const runner = require('./execute');
const erpnext = require('../erpnext');
const { round2, companyCurrency, ts } = require('../erp-sync/common');
const { fmt } = require('../tools/card');

const fail = (error) => ({ ok: false, error });
const isoToCard = (d) => (d ? String(d).slice(0, 10).replace(/-/g, '/') : '');

const JOB_WORDS = { cutting: 'cutting', sawing: 'sawing', heating: 'heating', preform: 'preforming', recut: 'recut', reweigh: 're-weigh' };
const MOVE_WORDS = { out_work: 'stones sent out for work', out_memo: 'stones sent out on memo', return: 'stones taken back in' };
const KIND_WORDS = { buy: 'purchase', sell: 'sale', split: 'split', merge: 'merge', transform: 'work on stones', move: 'move', write_off: 'write-off' };
/** The operation's documents in the trader's words. */
const DOC_WORDS = { 'Stock Entry': 'stock movement', 'Purchase Invoice': 'bill', 'Sales Invoice': 'invoice', 'Journal Entry': 'accounting entry', 'Payment Entry': 'payment' };
/** Documents that carry money: they are looked at before anything is cancelled. */
const MONEY_DOCTYPES = ['Purchase Invoice', 'Sales Invoice', 'Journal Entry', 'Payment Entry'];
const INVOICES = ['Purchase Invoice', 'Sales Invoice'];
const OPEN = ['pending', 'partial', 'undoing'];

/** What the trader would call the operation: "cutting", "split", "stones sent out on memo". */
function kindWords({ kind, job = null, direction = null }) {
  if (kind === 'transform' && JOB_WORDS[job]) return JOB_WORDS[job];
  if (kind === 'move' && MOVE_WORDS[direction]) return MOVE_WORDS[direction];
  return KIND_WORDS[kind] || String(kind);
}

/** ERPNext's own words, without the client's "[erpnext POST …]" prefix. */
const reason = (err) => String((err && err.message) || err).replace(/^\[erpnext[^\]]*\]\s*/, '').trim().slice(0, 400);
/** ERPNext answered and said no (4xx; a 408 says nothing either way). No answer, or a 5xx: unknown. */
const refused = (err) => Number(err && err.status) >= 400 && Number(err.status) < 500 && Number(err.status) !== 408;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One document as the trader reads it: "the bill from Somchai for 2,400 THB (ACC-PINV-1)". */
function docLabel(d, currency) {
  const what = DOC_WORDS[d.doctype] || d.doctype;
  const link = d.doctype === 'Sales Invoice' ? 'to' : d.doctype === 'Purchase Invoice' ? 'from' : 'with';
  const who = d.party ? ` ${link} ${d.party}` : '';
  const money = d.amount != null ? ` for ${fmt(d.amount)} ${d.currency || currency}` : '';
  return `the ${what}${who}${money} (${d.name})`;
}

/** What goes into the lists a result and a plan carry: no internals. */
const view = (d) => ({
  ...(d.step != null ? { step: d.step } : {}), doctype: d.doctype, name: d.name,
  ...(d.party ? { party: d.party } : {}), ...(d.amount != null ? { amount: d.amount } : {}),
  ...(d.amount != null && d.currency ? { currency: d.currency } : {}),
});
const bare = (d) => ({ step: d.step, doctype: d.doctype, name: d.name });

const codesOf = (o) => {
  const op = (o.plan && o.plan.op) || {};
  return [...(op.inputs || []), ...(op.outputs || [])].map((x) => x.code);
};

/** The operation an undo without a reference means. */
async function findTarget(user, want) {
  if (want.reference) {
    const o = await store.getOp(user.id, want.reference);
    return o ? { target: o } : fail(`There is no stock operation with the reference ${String(want.reference).trim()}.`);
  }
  const open = await store.unfinishedOps(user.id);
  if (want.lot) {
    const code = lots.normCode(want.lot);
    // The operation that is stuck comes first: nothing else may touch the lots until it is settled.
    const stuck = code && open.find((o) => codesOf(o).includes(code));
    if (stuck) return { target: stuck };
    const lot = code ? await store.getLot(user.id, code) : null;
    if (!lot) return fail(`There is no lot ${code || want.lot}.`);
    const [newest] = await store.history(user.id, code, { limit: 1 });
    if (!newest) return fail(`Nothing was done with lot ${code} that could be taken back.`);
    return { target: await store.getOp(user.id, newest.reference) };
  }
  if (open.length) return { target: open[0] };
  const [newest] = await store.listOps(user.id, { status: 'posted', limit: 1 });
  return newest ? { target: newest } : fail('There is no stock operation to take back.');
}

// ── what ERPNext holds ─────────────────────────────────────────────────

/** store.unmarkUndoing, whatever it answers: the status the operation is in now, or null when it stays 'undoing'. */
async function unmark(opId) {
  if (typeof store.unmarkUndoing !== 'function') return null;
  try {
    const back = await store.unmarkUndoing(opId);
    const status = typeof back === 'string' ? back : back && back.status;
    return status && status !== 'undoing' ? status : null;
  } catch {
    return null;
  }
}

/**
 * A step that was posted but never recorded (a crash or a timeout between ERPNext saying yes and
 * store.recordStep) is in ERPNext without being in Berpal's record. For an operation that never
 * finished posting, look for the steps that are not recorded, by the remark every document of the
 * operation carries (lotErp.findByReference, as execute.run does before it posts), and record what
 * is found. Never posts.
 * @returns {Promise<{op: object, orphans: Array<{step, doctype, name}>}>}  op: the row as it is now;
 *   orphans: found but impossible to record (the undo already cancelled a document, so the record
 *   is closed): they are cancelled all the same, without being recorded
 * @throws when ERPNext cannot be searched: the caller must stop, not carry on blind
 */
async function adopt(erp, o) {
  if (!OPEN.includes(o.status) || o.posted_at || !o.plan || !o.plan.op) return { op: o, orphans: [] };
  const plan = runner.steps(o.plan.op, o.plan.draft);
  const have = new Set((o.erpnext_docs || []).map((d) => d.step));
  let row = o;
  const orphans = [];
  for (const step of plan) {
    if (have.has(step.step)) continue;
    const doc = await lotErp.findByReference(erp, lots.remarkFor(o.reference, step.step, plan.length), { doctypes: [step.doctype] });
    if (!doc) continue;
    if (row.status === 'undoing') {
      // The record is closed to new documents while it is being undone: reopen it if nothing is cancelled yet.
      const back = await unmark(row.id);
      if (back) row = await store.getOpById(row.id);
    }
    if (OPEN.includes(row.status) && row.status !== 'undoing') {
      row = await store.recordStep(row.id, { step: step.step, doctype: doc.doctype, name: doc.name });
    } else {
      orphans.push({ step: step.step, doctype: doc.doctype, name: doc.name, unrecorded: true });
    }
    console.log(`• [lots] [${ts()}] undo ${o.reference}: found step ${step.step} in ERPNext that was never recorded (${doc.doctype} ${doc.name})`);
  }
  return { op: row, orphans };
}

/** Every document of the operation, recorded or found, oldest step first. */
const everyDoc = (o, orphans = []) => [...(o.erpnext_docs || []), ...orphans].sort((a, b) => a.step - b.step);
/** What is still posted, newest step first: the order they are cancelled in. */
const standingDocs = (o, orphans = []) => everyDoc(o, orphans).filter((d) => !d.cancelled).reverse();

/**
 * Read the money documents of the operation: who and how much (for the card and the result), and
 * whether each can be cancelled at all. A bill or an invoice with a payment (or a credit) settled
 * against it cannot: its outstanding amount is below its total.
 * @returns {Promise<{details: Map<string, object>, blocked: object[]}>}  blocked: the standing documents that cannot be cancelled
 * @throws when a money document that still stands cannot be read
 */
async function inspect(erp, user, docs) {
  const details = new Map();
  const blocked = [];
  const currency = companyCurrency(user);
  for (const d of docs.filter((x) => MONEY_DOCTYPES.includes(x.doctype))) {
    let doc;
    try {
      const r = await erp.getResource(d.doctype, d.name);
      doc = (r && r.data) || r;
    } catch (err) {
      if (err && err.status === 404) continue; // nothing there: nothing to cancel
      if (d.cancelled) continue; // already done; only the words are missing
      throw err;
    }
    if (!doc) continue;
    const one = {};
    if (d.doctype === 'Purchase Invoice') one.party = doc.supplier_name || doc.supplier;
    else if (d.doctype === 'Sales Invoice') one.party = doc.customer_name || doc.customer;
    else if (d.doctype === 'Payment Entry') one.party = doc.party_name || doc.party;
    else one.party = ((doc.accounts || []).find((a) => a.party) || {}).party;
    let amount;
    if (INVOICES.includes(d.doctype)) amount = Number(doc.rounded_total) || Number(doc.grand_total);
    else if (d.doctype === 'Payment Entry') amount = Number(doc.paid_amount);
    else amount = Number(doc.total_debit) || (doc.accounts || []).reduce((a, r) => a + (Number(r.debit_in_account_currency) || 0), 0);
    if (Number.isFinite(amount) && amount > 0) one.amount = round2(amount);
    one.currency = doc.currency || currency;
    if (!one.party) delete one.party;
    details.set(d.name, one);
    if (!d.cancelled && Number(doc.docstatus) !== 2 && INVOICES.includes(d.doctype)) {
      const total = Number(doc.rounded_total) || Number(doc.grand_total);
      const outstanding = Number(doc.outstanding_amount);
      if (Number.isFinite(total) && Number.isFinite(outstanding) && total > 0 && outstanding < total - 0.005) blocked.push({ ...d, ...one });
    }
  }
  return { details, blocked };
}

const withDetail = (list, details) => list.map((d) => ({ ...d, ...(details.get(d.name) || {}) }));

/** The whole undo refused before anything is cancelled, in the trader's words. */
function blockedWords(blocked, currency) {
  const what = blocked.map((d) => docLabel(d, currency)).join(' and ');
  const many = blocked.length > 1;
  return `${cap(what)} ${many ? 'have' : 'has'} a payment recorded against ${many ? 'them' : 'it'}, so this cannot be taken back while the payment stands. `
    + 'Nothing was changed. The payment has to be cancelled in the books first (the accountant can do it); then ask for the undo again.';
}

/** The search of ERPNext (or the look at its documents) failed: the undo does not go on blind. */
const notChecked = (ref, err) => `I could not check what the books hold for ${ref} just now (${reason(err)}), and I will not take it back without knowing. `
  + 'Nothing was changed. Try again in a moment.';

const isTrade = (o) => o.kind === 'buy' || o.kind === 'sell';

/**
 * Of these documents, the ones the books still hold in force. Cancelled there (docstatus 2) or
 * not there at all counts as gone.
 * @throws when a document cannot be read
 */
async function inForce(erp, docs) {
  const live = [];
  for (const d of docs) {
    try {
      const r = await erp.getResource(d.doctype, d.name);
      const doc = (r && r.data) || r;
      if (doc && Number(doc.docstatus) !== 2) live.push(d);
    } catch (err) {
      if (!(err && err.status === 404)) throw err;
    }
  }
  return live;
}

/** A purchase or a sale whose bill / invoice still stands: who cancels it, and what happens then. */
function tradeWords(ref, o, live) {
  const what = o.kind === 'buy' ? 'purchase' : 'sale';
  const paper = o.kind === 'buy' ? 'bill' : 'invoice';
  const named = live.length ? ` (${live.map((d) => d.name).join(', ')})` : '';
  return `${ref} is a ${what} of stones. A ${what} cannot be taken back from here: its ${paper}${named} has to be cancelled `
    + 'in the books first, by the accountant. Once that is done, ask for the undo again and the lots are put back. Nothing was changed.';
}

// ── the plan ───────────────────────────────────────────────────────────

/**
 * The lot rows as store.reverseOp will leave them. Mirrors its arithmetic; reads only.
 * @returns {Promise<{lots: object[], removed: string[]}>} removed = lots the operation made, which go
 */
async function lotsAfter(user, target, lines) {
  if (!lines.length) return { lots: [], removed: [] }; // never posted: the lot rows did not change
  const before = { lots: [], created: [], uncounted: [], ...(target.before || {}) };
  const created = new Set(before.created);
  const after = [];
  const lean = (l) => ({
    code: l.code, carats: lots.round3(Number(l.carats)), pieces: l.pieces == null ? null : Number(l.pieces),
    cost: round2(Number(l.cost)), location: l.location, holder: l.holder || null,
  });
  for (const row of before.lots) after.push(lean(row));

  const settled = new Set([...before.created, ...before.lots.map((l) => l.id)]);
  const taken = lines.filter((l) => l.role === 'in' && !settled.has(l.lot_id));
  const current = await store.getLots(user.id, taken.map((l) => l.lot_code));
  const byId = new Map();
  for (const l of taken) {
    const now = [...current.values()].find((x) => x.id === l.lot_id);
    if (!now) continue;
    if (!byId.has(now.id)) { byId.set(now.id, lean(now)); after.push(byId.get(now.id)); }
    const lot = byId.get(now.id);
    const was = before.uncounted.find((x) => x.id === now.id);
    lot.pieces = was && lot.pieces == null ? was.pieces
      : lot.pieces != null && l.pieces != null ? lot.pieces + l.pieces : lot.pieces;
    lot.carats = lots.round3(lot.carats + l.carats);
    lot.cost = round2(lot.cost + l.value);
  }
  const removed = [...new Set(lines.filter((l) => l.role === 'out' && created.has(l.lot_id)).map((l) => l.lot_code))];
  return { lots: after, removed };
}

/** What putting the lots back throws away (store.reverseLosses), or null when nothing. */
async function lossesOf(target) {
  if (typeof store.reverseLosses !== 'function') return null;
  try {
    const l = await store.reverseLosses(target.id);
    const certificates = (l && l.certificates) || [];
    const detailsChanged = (l && l.detailsChanged) || [];
    return certificates.length || detailsChanged.length ? { certificates, detailsChanged } : null;
  } catch (err) {
    console.error(`[lots] undo losses not read (${target.reference}):`, err.message);
    return null;
  }
}

/**
 * @param {object} user
 * @param {{kind: 'undo', reference?: string, lot?: string}} stockOp  the operation by reference, or
 *   the newest posted operation of that lot; neither: the operation that is stuck, else the newest
 * @param {{erp?: object}} [opts]  the user's ERPNext client (default: a new one for the user). It is
 *   asked for the documents of an operation that is not fully saved, and for its money documents
 * @returns {Promise<{ok: true, op: object}|{ok: false, error: string}>}
 *   op (JSON-safe; the gate signs it with lots.opSignature, so it must come out the same for the
 *   card and the save while nothing changed):
 *   { kind: 'undo', reference, target: { kind, job, direction, date, status },
 *     docs: [{ step, doctype, name, party?, amount?, currency? }] still to cancel, in cancel order
 *       (party, amount and currency for money documents; `unrecorded: true` on a document found in
 *       ERPNext that the record had missed and could not take back),
 *     lots: [{ code, carats, pieces, cost, location, holder }] as they will be afterwards,
 *     removed: [codes of lots the operation made, which will be gone],
 *     losses?: { certificates: [{ lot, lab, report_no }], detailsChanged: [codes] } what goes with them,
 *     warnings: [] }
 *   Targets in status posted | partial | pending | undoing are accepted. For one that is not fully
 *   saved, the steps ERPNext holds but the record lacks are recorded here (store.recordStep) and
 *   are part of `docs`. Refused (ok: false) when the books cannot be searched or read, when a
 *   money document cannot be cancelled (a bill with a payment against it), and for a purchase or a
 *   sale whose bill / invoice still stands in the books, each with the instruction. For a purchase
 *   or a sale `docs` lists what the accountant cancelled already: nothing is cancelled from here.
 */
async function resolve(user, stockOp, { erp = null } = {}) {
  const found = await findTarget(user, stockOp || {});
  if (!found.target) return found;
  let o = found.target;
  const ref = o.reference;
  if (o.status === 'undone') return fail(`${ref} was already taken back.`);
  if (o.status === 'failed') return fail(`${ref} was never saved, so there is nothing to take back.`);

  let client;
  let orphans = [];
  try {
    client = erp || erpnext.forUser(user);
    ({ op: o, orphans } = await adopt(client, o));
  } catch (err) {
    return fail(notChecked(ref, err));
  }

  const docs = standingDocs(o, orphans);
  // A purchase or a sale of lots is a bill / an invoice, and those are never cancelled from here.
  // Once the accountant has cancelled it in the books (or it never reached them), the undo only
  // puts the lots back.
  if (isTrade(o) && docs.length) {
    let live;
    try {
      live = await inForce(client, docs);
    } catch (err) {
      return fail(notChecked(ref, err));
    }
    if (live.length) return fail(tradeWords(ref, o, live));
  }

  const lines = await store.opLines(o.id);
  const later = await store.laterOps(user.id, lines.map((l) => l.lot_id), o.id);
  if (later.length) {
    const l = later[0];
    return fail(`Lot ${l.lot_code} was used again after this (${kindWords(l)} ${l.reference} on ${l.op_date}). Undo that first.`);
  }

  let seen;
  try {
    seen = await inspect(client, user, everyDoc(o, orphans));
  } catch (err) {
    return fail(notChecked(ref, err));
  }
  if (seen.blocked.length) return fail(blockedWords(seen.blocked, companyCurrency(user)));

  const after = await lotsAfter(user, o, lines);
  const losses = await lossesOf(o);
  return {
    ok: true,
    op: {
      kind: 'undo',
      reference: ref,
      target: { kind: o.kind, job: o.job || null, direction: o.direction || null, date: o.op_date, status: o.status },
      docs: withDetail(docs, seen.details).map((d) => ({ ...view(d), ...(d.unrecorded ? { unrecorded: true } : {}) })),
      lots: after.lots,
      removed: after.removed,
      ...(losses ? { losses } : {}),
      warnings: [],
    },
  };
}

// ── the card ───────────────────────────────────────────────────────────

const ct = (n) => Number(lots.round3(n)).toLocaleString('en-US', { maximumFractionDigits: 3 });

function placeWords(lot) {
  if (lot.location === 'work') return `out for work${lot.holder ? ` with ${lot.holder}` : ''}`;
  if (lot.location === 'memo') return `out on memo${lot.holder ? ` with ${lot.holder}` : ''}`;
  return 'in stock';
}

/** "L13: 120 ct, 42 pcs, cost 270,000 THB, in stock" */
function lotLine(lot, currency) {
  return `- ${lot.code}: ${ct(lot.carats)} ct${lot.pieces != null ? `, ${lot.pieces} pcs` : ''}, cost ${fmt(lot.cost)} ${currency}, ${placeWords(lot)}`;
}

/** What goes with the removed lots: lab reports on them, details the trader changed after the operation. */
function lossLines(losses) {
  const lines = [];
  if (losses && losses.certificates && losses.certificates.length) {
    const named = losses.certificates.map((c) => `${[c.lab, c.report_no].filter(Boolean).join(' ') || 'certificate'} (${c.lot})`);
    lines.push(`Certificates that go with the removed lots: ${named.join(', ')}`);
  }
  if (losses && losses.detailsChanged && losses.detailsChanged.length) {
    lines.push(`Details you changed on ${losses.detailsChanged.join(', ')} after this go back to what they were`);
  }
  return lines;
}

/** @returns {Promise<{lines: string[]}>} the undo card */
async function card(user, op) {
  const t = op.target || {};
  const currency = companyCurrency(user);
  const unfinished = t.status !== 'posted';
  const lines = [
    `Take back: ${kindWords(t)} of ${isoToCard(t.date)}${unfinished ? (t.status === 'undoing' ? ' (partly taken back already)' : ' (only partly saved)') : ''}`,
    `Ref: ${op.reference}`,
  ];
  if (op.docs && op.docs.length) {
    // The bill / invoice of a purchase or sale was cancelled by the accountant; nothing is cancelled from here.
    lines.push(isTrade(t) ? 'Already cancelled in the books:' : 'Cancelled in the books:', ...op.docs.map((d) => `- ${docLabel(d, currency)}`));
  } else {
    lines.push('Nothing in the books needs cancelling.');
  }
  if ((op.lots && op.lots.length) || (op.removed && op.removed.length)) {
    lines.push('Your lots afterwards:', ...(op.lots || []).map((l) => lotLine(l, currency)));
    if (op.removed && op.removed.length) lines.push(`- ${op.removed.join(', ')}: removed`);
  } else {
    lines.push('Your lots stay as they are now.');
  }
  lines.push(...lossLines(op.losses));
  return { lines };
}

// ── the run ────────────────────────────────────────────────────────────

/** Why a document could not be cancelled and what has to happen first, for the model to pass on. */
function refusal(doc, err, currency) {
  const why = reason(err);
  const label = cap(docLabel(doc, currency));
  const pay = /linked with submitted Payment Entry\s+([^\s.,;]+)/i.exec(why);
  if (pay) {
    return `${label} could not be cancelled because a payment (${pay[1]}) is recorded against it. `
      + 'That payment has to be cancelled in the books first (the accountant can do it); then retry.';
  }
  if (/used by a later transaction|later document|NegativeStock|negative stock/i.test(why)) {
    return `${label} could not be cancelled because the books hold a later entry that used these stones. `
      + `That later entry has to be cancelled first; then retry. (${why})`;
  }
  return `${label} could not be cancelled: ${why}`;
}

/** A document ERPNext already holds as cancelled counts as done (a retry, or the accountant did it). */
async function alreadyCancelled(erp, doc) {
  try {
    const r = await erp.getResource(doc.doctype, doc.name);
    const d = (r && r.data) || r;
    return !!d && Number(d.docstatus) === 2;
  } catch {
    return false;
  }
}

const result = (l) => ({ code: l.code, carats: l.carats, pieces: l.pieces, cost: l.cost, location: l.location });

/**
 * store.markUndoing, then each document that is not cancelled yet, newest step first: erp.cancelDoc
 * and store.markDocCancelled; then store.reverseOp. (A purchase or a sale: nothing is cancelled from
 * here; its documents must be cancelled in the books already, and are only marked.) Before any of it ERPNext is searched for steps
 * the record missed (they are cancelled too) and every money document is checked to be cancellable.
 *
 * @returns {Promise<object>} RunResult (src/lots/index.js) plus the two lists the gate words its answer from:
 *   cancelled: [{ step, doctype, name, party?, amount?, currency? }]  documents of the operation cancelled (now or earlier), newest step first
 *   standing:  [{ step, doctype, name, party?, amount?, currency? }]  documents of the operation still in force, newest step first
 *   ok: { ok: true, reference, docs (every document of the operation, all cancelled), saved: null,
 *     lots (the lot rows that are back), removed, cancelled, standing: [], lost?: { certificates, detailsChanged } }
 *   not ok: { ok: false, partial, reference, docs (still posted), error, cancelled, standing }
 *     - refused before anything was cancelled (a money document that cannot be cancelled, or the
 *       first document refused): the operation is where it was (store.unmarkUndoing): 'posted'
 *       gives partial: false; one that is not fully saved stays open and gives partial: true.
 *     - ERPNext cannot be searched or read, or a cancel whose outcome is unknown (timeout, 5xx), or
 *       a document refused after others were cancelled: the operation waits as 'undoing' with
 *       partial: true (retry_stock_op continues it). Never put back in the unknown case: the
 *       document may be cancelled after all. A 404 on cancel counts as done.
 */
async function run(user, erp, op) {
  const reference = op && op.reference;
  const target = reference ? await store.getOp(user.id, reference) : null;
  const currency = companyCurrency(user);
  const stop = (error, extra = {}) => ({ ok: false, partial: false, reference, docs: [], error, cancelled: [], standing: [], ...extra });
  if (!target) return stop(`There is no stock operation with the reference ${reference}.`);
  if (target.status === 'failed') return stop(`${reference} was never saved, so there is nothing to take back.`);
  if (target.status === 'undone') {
    const all = everyDoc(target);
    return { ok: true, reference, docs: all.map(bare), saved: null, lots: (op.lots || []).map(result), removed: op.removed || [], cancelled: [...all].reverse().map(view), standing: [] };
  }

  // What ERPNext holds, before anything is cancelled.
  let row = target;
  let orphans = [];
  let seen;
  try {
    ({ op: row, orphans } = await adopt(erp, target));
    seen = await inspect(erp, user, everyDoc(row, orphans));
  } catch (err) {
    console.error(`• [lots] [${ts()}] undo ${reference} stopped before cancelling anything: ${reason(err)}`);
    // The undo was asked for: a retry continues the undo, never the operation.
    let status = row.status;
    if (['pending', 'partial'].includes(status)) {
      try { await store.markUndoing(row.id); status = 'undoing'; } catch { /* stays as it is */ }
    }
    return stop(notChecked(reference, err), {
      partial: status !== 'posted', docs: standingDocs(row, orphans).map(bare), standing: withDetail(standingDocs(row, orphans), new Map()).map(view),
    });
  }
  // Both lists the result carries run newest step first: the order the documents are cancelled in.
  const list = (docs) => withDetail([...docs].sort((a, b) => b.step - a.step), seen.details).map(view);
  const anyCancelled = () => everyDoc(row, orphans).some((d) => d.cancelled);

  // Nothing has been touched yet: the whole undo can still be refused cleanly.
  const refuse = async (error) => {
    let status = row.status;
    if (status === 'undoing' && !anyCancelled()) status = (await unmark(row.id)) || status;
    return stop(error, {
      partial: status !== 'posted', docs: standingDocs(row, orphans).map(bare),
      cancelled: list(everyDoc(row, orphans).filter((d) => d.cancelled)), standing: list(standingDocs(row, orphans)),
    });
  };
  if (seen.blocked.length) return refuse(blockedWords(seen.blocked, currency));
  // The bill / invoice of a purchase or sale has to be cancelled in the books already (see resolve).
  const trade = isTrade(row);
  if (trade) {
    let live;
    try {
      live = await inForce(erp, standingDocs(row, orphans));
    } catch (err) {
      return refuse(notChecked(reference, err));
    }
    if (live.length) return refuse(tradeWords(reference, row, live));
  }

  try {
    await store.markUndoing(row.id);
  } catch (err) {
    return stop(err.message, { partial: row.status !== 'posted', docs: standingDocs(row, orphans).map(bare), standing: list(standingDocs(row, orphans)) });
  }

  const todo = standingDocs(row, orphans);
  const done = new Set(everyDoc(row, orphans).filter((d) => d.cancelled).map((d) => d.name));
  const progress = () => ({
    cancelled: list(everyDoc(row, orphans).filter((d) => done.has(d.name))),
    standing: list(everyDoc(row, orphans).filter((d) => !done.has(d.name))),
  });
  for (const [i, doc] of todo.entries()) {
    let went = false;
    try {
      if (!trade) await erp.cancelDoc(doc.doctype, doc.name);
      went = true;
    } catch (err) {
      // ERPNext has no such document: nothing to cancel. Or it holds it as cancelled already.
      if ((err && err.status === 404) || (await alreadyCancelled(erp, doc))) went = true;
      else if (!refused(err)) {
        // No clear answer: the document may be cancelled after all. It stays 'undoing'; a retry finds out.
        const d = view({ ...doc, ...(seen.details.get(doc.name) || {}) });
        const error = `I could not tell whether ${docLabel(d, currency)} was cancelled: the books did not answer properly (${reason(err)}). `
          + 'Nothing else was changed. Replying "retry" checks it and carries on.';
        console.error(`• [lots] [${ts()}] undo ${reference} unsure at ${doc.doctype} ${doc.name}: ${reason(err)}`);
        await store.noteError(row.id, error);
        return stop(error, { partial: true, docs: todo.slice(i).map(bare), ...progress() });
      } else {
        const error = refusal({ ...doc, ...(seen.details.get(doc.name) || {}) }, err, currency);
        console.error(`• [lots] [${ts()}] undo ${reference} stopped at ${doc.doctype} ${doc.name}: ${reason(err)}`);
        const left = todo.slice(i).map(bare);
        // Nothing was cancelled yet: the operation simply is where it was.
        if (!done.size) {
          const status = await unmark(row.id);
          return stop(error, { partial: status !== 'posted', docs: left, ...progress() });
        }
        await store.noteError(row.id, error);
        return stop(error, { partial: true, docs: left, ...progress() });
      }
    }
    if (went) {
      if (!doc.unrecorded) await store.markDocCancelled(row.id, doc.name);
      done.add(doc.name);
    }
  }

  let back;
  try {
    back = await store.reverseOp(row.id);
  } catch (err) {
    // Every document is cancelled but the lot rows could not go back: it stays 'undoing'.
    await store.noteError(row.id, err.message);
    return stop(err.message, { partial: true, ...progress() });
  }
  console.log(`• [lots] [${ts()}] undone user_id=${user.id} ref=${reference} docs=${todo.length}`);
  const lost = back && ((back.certificates && back.certificates.length) || (back.detailsChanged && back.detailsChanged.length))
    ? { certificates: back.certificates || [], detailsChanged: back.detailsChanged || [] } : null;
  return {
    ok: true, reference, docs: everyDoc(row, orphans).map(bare), saved: null, lots: back.map(result), removed: op.removed || [],
    cancelled: list(everyDoc(row, orphans)), standing: [], ...(lost ? { lost } : {}),
  };
}

module.exports = { resolve, card, run, kindWords };

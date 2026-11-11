/**
 * Run a confirmed lot operation against ERPNext, one document at a time, and then apply it to the
 * lot rows (store.postOp).
 *
 * The protocol (docs/parcel-lot-stock-design.md, "when a step fails"):
 *   1. store.beginOp      the operation is on record ('pending') before ERPNext hears of it
 *   2. each step in a fixed order: unless it is recorded already, look in ERPNext for a submitted
 *      document carrying this step's remark (erp.findByReference); post it only when there is
 *      none; store.recordStep
 *   3. after the last step: read back what ERPNext did (erp.voucherStock) and store.postOp with
 *      those actuals
 * A step that fails stops the run where it is. Nothing is reversed. Calling run again with the
 * reference resumes at the first step that is not recorded.
 *
 * What each kind posts:
 *   buy         Purchase Invoice, update_stock, one batch row per lot line
 *   sell        Sales Invoice, update_stock, one batch row per lot line, from where the lot is
 *   split, merge            one Repack
 *   transform   the fee (Journal Entry when paid now, Purchase Invoice when owed) into the holding
 *               account, then one Repack whose additional cost takes the same amount out of it
 *   move        whole lots: one Material Transfer; part of a lot: one Repack (a new lot there)
 *   write_off   one Material Issue
 * A lot paid for on the spot is still the bill / invoice here; the payment is logged against it
 * afterwards, like any other (save_transaction's chained payment).
 */
const lots = require('./index');
const store = require('./store');
const lotErp = require('./erp');
const entries = require('./stock-entry');
const { saveDraft } = require('../erp-sync');
const taxes = require('../erp-sync/taxes');
const items = require('../erp-sync/items');
const { ts, round2 } = require('../erp-sync/common');

const INVOICE_TYPE = { buy: 'bill_received', sell: 'invoice_issued' };
const ENTRY_TYPE = { repack: 'Repack', transfer: 'Material Transfer', issue: 'Material Issue' };

const hasFee = (op) => op.kind === 'transform' && !!op.fee && Number(op.fee.capitalised) > 0;

/** A move of whole lots only: every lot leaves one warehouse for another as it is. */
function wholeMove(op) {
  const inputs = op.inputs || [];
  const outputs = op.outputs || [];
  return outputs.length > 0 && outputs.length === inputs.length && outputs.every((out) => {
    const inp = inputs.find((i) => i.lot_id === out.lot_id);
    return !out.new && !!inp && !!inp.whole && lots.round3(inp.carats) === lots.round3(out.carats);
  });
}

/**
 * The documents an operation needs, in posting order (also what the card and the tests can show).
 * what: 'bill' | 'invoice' | 'fee' | 'repack' | 'transfer' | 'issue'.
 * @returns {Array<{step: number, doctype: string, what: string}>}
 */
function steps(op, draft) {
  const list = [];
  const add = (doctype, what) => list.push({ step: list.length + 1, doctype, what });
  switch (op && op.kind) {
    case 'buy': add('Purchase Invoice', 'bill'); break;
    case 'sell': add('Sales Invoice', 'invoice'); break;
    case 'split':
    case 'merge': add('Stock Entry', 'repack'); break;
    case 'transform':
      if (hasFee(op)) add(draft && draft.transaction_type === 'bill_received' ? 'Purchase Invoice' : 'Journal Entry', 'fee');
      add('Stock Entry', 'repack');
      break;
    case 'move': add('Stock Entry', wholeMove(op) ? 'transfer' : 'repack'); break;
    case 'write_off': add('Stock Entry', 'issue'); break;
    default: throw new Error(`Not a lot operation: ${op && op.kind}`);
  }
  return list;
}

/** Why this operation cannot be run at all (nothing is put on record), or null. */
function refuse(user, op, draft) {
  if (!op || !lots.OP_KINDS.includes(op.kind)) return 'There is no stock operation to save.';
  const money = !!draft && Number(draft.amount) > 0;
  if (INVOICE_TYPE[op.kind]) {
    if (!draft || draft.transaction_type !== INVOICE_TYPE[op.kind]) {
      return op.kind === 'buy'
        ? 'Lots are bought on a bill (transaction_type=bill_received). Paid on the spot: save the bill, then log the payment against it.'
        : 'Lots are sold on an invoice (transaction_type=invoice_issued). Paid on the spot: save the invoice, then log the payment against it.';
    }
    return null;
  }
  if (hasFee(op)) {
    if (!money || !['cash', 'bill_received'].includes(draft.transaction_type || 'cash')) {
      return 'The fee for the work has no payment or bill to post. Set the fee on the draft (cash or bill_received) and confirm again.';
    }
    // The Repack takes out of the holding account exactly what the fee document puts in.
    if (round2(lotErp.feeToStock(user, draft)) !== round2(op.fee.capitalised)) {
      return 'The fee on the draft is not the fee this operation was worked out with. Request the confirmation again.';
    }
    return null;
  }
  if (money) return 'This stock operation cannot carry a fee: only cutting, heating and other work on the stones can.';
  return null;
}

/** The operation's documents that stand (an undo may have cancelled some). */
const live = (row) => (row.erpnext_docs || []).filter((d) => !d.cancelled).map((d) => ({ step: d.step, doctype: d.doctype, name: d.name }));

/**
 * The ERPNext names of everything the operation touches. Reads only (Berpal's lot rows and the
 * company abbreviation); `make` marks the batches that may still have to be created.
 */
async function names(user, erp, op) {
  const abbr = await lotErp.abbr(erp);
  const warehouses = {};
  for (const place of Object.keys(lots.PLACES)) warehouses[place] = await lotErp.warehouse(erp, place);
  const targets = [];
  for (const out of op.outputs || []) {
    const item = lotErp.itemCode(out.item_kind, abbr);
    // An existing lot that keeps its revision keeps the batch it is in.
    const lot = out.new ? null : await store.getLot(user.id, out.code);
    const kept = !!lot && !!lot.erpnext_batch && lot.erpnext_item === item && Number(lot.revision) === Number(out.revision || 0);
    targets.push({
      code: out.code, item, batch: kept ? lot.erpnext_batch : lotErp.batchName(out.code, out.revision, abbr),
      warehouse: warehouses[out.to || 'stores'], make: !kept, revision: out.revision || 0,
      description: (out.attrs && out.attrs.description) || null,
    });
  }
  return { abbr, warehouses, targets };
}

/** Before the first document: the gem masters, the output batches and (for stock entries) the accounts. */
async function prepare(user, erp, op, plan) {
  await lotErp.ensureSetup(erp);
  const n = await names(user, erp, op);
  for (const t of n.targets.filter((x) => x.make)) {
    await lotErp.ensureBatch(erp, { code: t.code, revision: t.revision, item: t.item, description: t.description });
  }
  const accounts = plan.some((s) => s.doctype === 'Stock Entry') ? await lotErp.accounts(erp) : null;
  return { ...n, accounts };
}

/** saveDraft's `lots` option: which line of the bill / invoice is which batch, where, how many carats. */
function invoiceLots(op, draft, prep) {
  const lines = Array.isArray(draft.items) ? draft.items : [];
  const rows = [];
  if (op.kind === 'buy') {
    op.outputs.forEach((out, i) => {
      if (out.line == null || !lines[out.line] || !lines[out.line].lot) throw new Error(`Lot ${out.code} has no line on the bill`);
      const t = prep.targets[i];
      rows.push({ line: out.line, item: t.item, batch: t.batch, warehouse: t.warehouse, carats: lots.round3(out.carats) });
    });
  } else {
    const left = [...op.inputs];
    lines.forEach((it, i) => {
      if (!it || !it.lot) return;
      const code = lots.normCode(it.lot.code);
      const k = code ? left.findIndex((x) => x.code === code) : 0;
      const inp = k >= 0 ? left.splice(k, 1)[0] : null;
      if (!inp) throw new Error(`Line ${i + 1} sells lot ${code || '?'}, which this operation does not take from`);
      rows.push({ line: i, item: inp.item, batch: inp.batch, warehouse: prep.warehouses[inp.from], carats: lots.round3(inp.carats) });
    });
    if (left.length) throw new Error(`Lot ${left[0].code} has no line on the invoice`);
  }
  if (rows.length !== lots.lotLines(draft).length) throw new Error('The lot lines of the draft are not the lots of this operation');
  return rows;
}

/** The Stock Entry of a step, from the builders. */
function stockEntry(op, step, prep, remark) {
  const ctx = { company: prep.company, date: op.date, remark, accounts: prep.accounts };
  const sources = (op.inputs || []).map((i) => ({ item: i.item, batch: i.batch, warehouse: prep.warehouses[i.from], carats: i.carats }));
  if (step.what === 'issue') return entries.issue(ctx, { rows: sources });
  if (step.what === 'transfer') {
    return entries.transfer(ctx, {
      rows: op.inputs.map((inp, i) => ({ ...sources[i], to: prep.warehouses[op.outputs.find((o) => o.lot_id === inp.lot_id).to || 'stores'] })),
    });
  }
  const targets = op.outputs.map((out, i) => ({
    item: prep.targets[i].item, batch: prep.targets[i].batch, warehouse: prep.targets[i].warehouse, carats: out.carats, cost: out.cost,
  }));
  return entries.repack(ctx, { sources, targets, fee: hasFee(op) ? { amount: op.fee.capitalised } : null });
}

/** Post one step's document. @returns {Promise<{doctype: string, name: string}>} */
async function post(user, erp, { op, draft, step, remark, prep }) {
  if (step.what === 'bill' || step.what === 'invoice' || step.what === 'fee') {
    const opts = step.what === 'fee' ? { remark } : { remark, lots: invoiceLots(op, draft, prep) };
    const saved = await saveDraft(user, erp, draft, opts);
    return { doctype: saved.doctype, name: saved.erpnext_name };
  }
  const r = await erp.createResource('Stock Entry', stockEntry(op, step, { ...prep, company: erp.company }, remark));
  const name = r.data && r.data.name;
  if (!name) throw new Error('ERPNext did not name the stock entry it saved');
  console.log(`• [lots] [${ts()}] saved Stock Entry ${name} (${ENTRY_TYPE[step.what]}, ${remark})`);
  return { doctype: 'Stock Entry', name };
}

/**
 * What ERPNext really booked for each lot, from the stock ledger of the one document that moved
 * the stones: an input's cost is the value that left its batch, an output's the value that came
 * in. A lot the ledger does not show on its own keeps the planned figure.
 */
async function readActuals(erp, op, plan, docs, n) {
  const step = plan.find((s) => s.what !== 'fee');
  const doc = docs.find((d) => d.step === step.step);
  const rows = await lotErp.voucherStock(erp, doc.doctype, doc.name);
  const value = (batch, warehouse, sign) => {
    const hit = rows.filter((r) => r.batch === batch && r.warehouse === warehouse && Math.sign(r.qty) === sign);
    return hit.length ? round2(Math.abs(hit.reduce((s, r) => s + r.value, 0))) : null;
  };
  const once = (list, key) => (x) => list.filter((y) => key(y) === key(x)).length === 1;

  const inputs = {};
  const ins = (op.inputs || []).map((i) => ({ code: i.code, batch: i.batch, warehouse: n.warehouses[i.from] }));
  for (const i of ins.filter(once(ins, (x) => `${x.batch}|${x.warehouse}`))) {
    const cost = value(i.batch, i.warehouse, -1);
    if (cost != null) inputs[i.code] = { cost };
  }
  const outputs = {};
  const alone = once(n.targets, (x) => `${x.batch}|${x.warehouse}`);
  for (const t of n.targets) {
    const cost = alone(t) ? value(t.batch, t.warehouse, 1) : null;
    outputs[t.code] = { item: t.item, batch: t.batch, ...(cost != null ? { cost } : {}) };
  }
  return { inputs, outputs };
}

/**
 * Every document of the operation is recorded: read the actuals back and apply it to the lots.
 * Creates nothing in ERPNext (recover.js calls it too). @returns {Promise<object>} RunResult, ok
 */
async function complete(user, erp, row) {
  const { op, draft } = row.plan;
  const plan = steps(op, draft);
  const docs = live(row);
  // Applied already (a retry of a finished operation): the lots as they stand, nothing is read.
  const actuals = row.status === 'posted' ? {} : await readActuals(erp, op, plan, docs, await names(user, erp, op));
  const after = await store.postOp(row.id, { actuals });
  const shown = (what) => {
    const s = plan.find((x) => what.includes(x.what));
    const d = s && docs.find((x) => x.step === s.step);
    return d ? { doctype: d.doctype, erpnext_name: d.name } : null;
  };
  return {
    ok: true,
    reference: row.reference,
    docs,
    saved: shown(['bill', 'invoice', 'repack', 'transfer', 'issue']),
    money_doc: shown(['bill', 'invoice', 'fee']),
    lots: after.map((l) => ({ code: l.code, carats: l.carats, pieces: l.pieces, cost: l.cost, location: l.location })),
  };
}

/**
 * The client, telling `state` when one of the operation's own documents goes out: from then on a
 * failure that is not a clear refusal may have posted it.
 */
function watch(erp, state) {
  const watched = Object.create(erp);
  watched.createResource = (doctype, data) => {
    if (lotErp.REFERENCE_DOCTYPES.includes(doctype)) state.sent = true;
    return erp.createResource(doctype, data);
  };
  return watched;
}

/** ERPNext answered and said no (4xx; a 408 says nothing either way). No answer, or a 5xx: unknown. */
const refused = (err) => Number(err && err.status) >= 400 && Number(err.status) < 500 && Number(err.status) !== 408;
const stopped = (reference, error, extra = {}) => ({ ok: false, partial: false, reference, docs: [], error, ...extra });

/**
 * @param {object} user
 * @param {object} erp      the user's ErpNextClient
 * @param {{op?: object, draft?: object, reference?: string|null}} args
 *   reference given: resume that operation; its STORED plan (op + draft) is what runs, whatever is
 *   passed. No reference: a new operation from op + draft (the confirmed chat draft; its money
 *   part, when it has one, becomes the bill / invoice / fee payment).
 * @returns {Promise<object>} RunResult (src/lots/index.js). Never throws for an ERPNext refusal:
 *   { ok: false, partial, error }. partial is true as soon as one document is posted OR it is
 *   unknown whether one was (timeout, 5xx); false only when ERPNext clearly refused the first
 *   document, in which case the operation is marked failed and blocks nothing.
 */
async function run(user, erp, { op = null, draft = null, reference = null } = {}) {
  let row;
  if (reference) {
    row = await store.getOp(user.id, reference);
    if (!row) return stopped(reference, `Stock operation ${reference} was not found.`);
    if (!row.plan || !row.plan.op) return stopped(row.reference, `Stock operation ${row.reference} has no stored plan.`, { partial: store.UNFINISHED.includes(row.status), docs: live(row) });
    if (row.status === 'posted') return complete(user, erp, row);
    if (!['pending', 'partial'].includes(row.status)) {
      return stopped(row.reference, `Stock operation ${row.reference} is ${row.status}; it cannot be continued.`, { partial: row.status === 'undoing', docs: live(row) });
    }
  } else {
    const bad = refuse(user, op, draft);
    if (bad) return stopped(null, bad);
    try {
      row = await store.beginOp(user, { op, draft });
    } catch (err) {
      return stopped(null, err.message);
    }
  }
  // The stored plan runs, on the first attempt too: a retry then does exactly the same.
  ({ op, draft } = row.plan);

  const state = { sent: false, searched: !reference };
  const client = watch(erp, state);
  let docs = live(row);
  try {
    const plan = steps(op, draft);
    let prep = null;
    for (const step of plan) {
      if (docs.some((d) => d.step === step.step)) continue;
      state.sent = false;
      const remark = lots.remarkFor(row.reference, step.step, plan.length);
      // Posted before but never recorded (a crash or a timeout in between)? Then it is not posted again.
      let doc = await lotErp.findByReference(erp, remark, { doctypes: [step.doctype] });
      state.searched = true;
      if (!doc) {
        prep = prep || await prepare(user, erp, op, plan);
        doc = await post(user, client, { op, draft, step, remark, prep });
      }
      row = await store.recordStep(row.id, { step: step.step, doctype: doc.doctype, name: doc.name });
      docs = live(row);
    }
    return await complete(user, erp, row);
  } catch (err) {
    // A master may have been renamed or deleted in ERPNext since it was memoised.
    taxes.clearCaches(erp.company);
    items.clearCaches(erp.company);
    lotErp.clearCaches(erp.company);
    console.error(`[lots] operation ${row.reference} stopped:`, err.message);
    // Nothing posted, for certain: no document is recorded, and this attempt either never sent
    // one (after looking for an earlier one) or ERPNext clearly refused it.
    const nothing = !docs.length && (state.sent ? refused(err) : state.searched);
    if (nothing) {
      await store.failOp(row.id, err.message);
      return stopped(row.reference, err.message);
    }
    await store.markPartial(row.id, err.message).catch(() => store.noteError(row.id, err.message).catch(() => {}));
    return stopped(row.reference, err.message, { partial: true, docs });
  }
}

module.exports = { run, steps, complete };

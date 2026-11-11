/**
 * Put the record straight for operations that stopped half way (a crash, a timeout): find the
 * documents ERPNext has but Berpal did not record, and finish the bookkeeping when every document
 * is there. It never posts a new document: only the trader (retry) or an undo does that.
 *
 * An operation that is being undone is left to undo.run, and a young one may still be running.
 */
const lots = require('./index');
const store = require('./store');
const lotErp = require('./erp');
const execute = require('./execute');

const DEFAULT_OLDER_THAN_MINUTES = 10;

const standing = (row) => (row.erpnext_docs || []).filter((d) => !d.cancelled);

/** One unfinished operation. Reads ERPNext, writes only Berpal's own record of it. */
async function recoverOp(user, erp, listed) {
  let row = listed;
  const found = [];
  const say = (action, detail) => ({ reference: listed.reference, action, detail });
  try {
    row = await store.getOpById(listed.id);
    if (!row || !['pending', 'partial'].includes(row.status)) return say('waiting', `is ${row ? row.status : 'gone'} now`);
    if (!row.plan || !row.plan.op) return say('waiting', 'has no stored plan');
    const plan = execute.steps(row.plan.op, row.plan.draft);
    const missing = () => plan.filter((s) => !standing(row).some((d) => d.step === s.step));

    for (const step of missing()) {
      const remark = lots.remarkFor(row.reference, step.step, plan.length);
      const doc = await lotErp.findByReference(erp, remark, { doctypes: [step.doctype] });
      if (!doc) continue;
      row = await store.recordStep(row.id, { step: step.step, doctype: doc.doctype, name: doc.name });
      found.push(`${doc.doctype} ${doc.name}`);
    }

    const left = missing();
    if (!left.length) {
      await execute.complete(user, erp, row);
      return say('posted', found.length ? `found ${found.join(', ')}; the lots are updated` : 'every document was recorded; the lots are updated');
    }
    if (!standing(row).length && row.status === 'pending') {
      await store.failOp(row.id, 'Stopped before anything was posted to ERPNext');
      return say('failed', 'nothing was posted to ERPNext; closed');
    }
    const waits = `step ${left.map((s) => s.step).join(', ')} of ${plan.length} is not in ERPNext`;
    return found.length ? say('recorded', `found ${found.join(', ')}; ${waits}`) : say('waiting', waits);
  } catch (err) {
    // ERPNext could not be asked (or answered nonsense): what was found stays recorded, the rest waits.
    return say(found.length ? 'recorded' : 'waiting', `${found.length ? `found ${found.join(', ')}; ` : ''}${err.message}`);
  }
}

/**
 * @param {object} user  @param {object} erp
 * @param {{olderThanMinutes?: number, now?: Date}} [opts]  leave operations younger than this alone (they may be running)
 * @returns {Promise<Array<{reference: string, action: 'recorded'|'posted'|'failed'|'waiting', detail: string}>>}
 *   recorded: found documents and recorded them, still unfinished; posted: all documents were
 *   there, the lots are updated; failed: nothing was ever posted, the operation is closed;
 *   waiting: needs the trader (retry or undo)
 */
async function recoverUser(user, erp, { olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES, now = new Date() } = {}) {
  const before = new Date(now).getTime() - olderThanMinutes * 60000;
  const out = [];
  for (const o of await store.unfinishedOps(user.id)) {
    if (o.status === 'undoing') continue;
    // Also skipped when the start time cannot be read: better left alone than closed too early.
    if (!(Date.parse(o.created_at) <= before)) continue;
    out.push(await recoverOp(user, erp, o));
  }
  return out;
}

module.exports = { recoverUser };

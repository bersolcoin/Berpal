/**
 * The confirmation gate for lot drafts: what request_confirmation and save_transaction do when the
 * draft buys / sells lots (items[].lot) or carries a stock operation (draft.stock_op).
 *
 * The rule is the same as for money: nothing reaches ERPNext or the lot tables until the user has
 * seen a card and answered it on a LATER turn. What is signed is the draft plus the resolved
 * operation (lot codes, carats, costs, the state of the input lots), so a lot that changed between
 * the card and the save refuses the save.
 *
 *   draft ─ draft.prepare ─ money checks ─ resolve ─ ERPNext preflight ─ card ─ signature
 *   save  ─ the same again, signature compared ─ execute.run (step by step, resumable)
 *
 * One operation at a time per user: while one is only partly saved, nothing else may touch the
 * lots. The same draft confirmed again ("retry") resumes it; retry_stock_op resumes it when the
 * draft is gone; an undo of that very operation (its own card) is the way out when it cannot be
 * finished. Nothing is ever reversed automatically.
 */
const lots = require('./index');
const draftRules = require('./draft');
const resolver = require('./resolve');
const lotErp = require('./erp');
const lotCard = require('./card');
const runner = require('./execute');
const undo = require('./undo');
const store = require('./store');
const { validateDraft, readinessError, applyDefaults, stripProtected } = require('../tools/validate');
const { getErp } = require('../tools/context');
const { ts } = require('../erp-sync/common');
const review = require('../trust/review');
const { attachToDoc } = require('../media/attach');

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// The two gate tools require this module, so theirs are read at call time, not load time.
const signer = () => require('../tools/request-confirmation');
const saver = () => require('../tools/save-transaction');

const isUndo = (draft) => lots.hasStockOp(draft) && draft.stock_op.kind === 'undo';

function unfinishedMessage(op) {
  const docs = (op.erpnext_docs || []).filter((d) => !d.cancelled).map((d) => `${d.doctype} ${d.name}`).join(', ');
  if (op.status === 'undoing') {
    return `Stock operation ${op.reference} (${op.kind}, ${op.op_date}) is only partly undone${docs ? ` (still posted: ${docs})` : ''}. `
      + 'Nothing else can touch the lots until the undo is finished: call retry_stock_op.';
  }
  return `Stock operation ${op.reference} (${op.kind}, ${op.op_date}) is only partly saved${docs ? ` (posted so far: ${docs})` : ''}. `
    + `Nothing else can touch the lots until it is finished (call retry_stock_op) or taken back (an undo of ${op.reference}, which needs its own confirmation).`;
}

/** Codes the resolver assigned go back into the draft, so the card, the signature and the save agree. */
function writeCodes(draft, op) {
  for (const out of op.outputs || []) {
    if (out.line == null) continue;
    const target = lots.hasStockOp(draft)
      ? (draft.stock_op.outputs || [])[out.line]
      : ((draft.items || [])[out.line] || {}).lot;
    if (target && !target.code) target.code = out.code;
  }
}

/**
 * Everything up to (not including) the card: the draft is normalised, the money part validated
 * like any other draft, the operation resolved against the lot rows and checked against ERPNext.
 * @returns {Promise<{ok:false,error:string}|{ok:true, op:object, undoing:boolean, money:boolean, resume:object|null}>}
 */
async function plan(ctx) {
  const { user, draft } = ctx;
  if (!lots.isGems(user)) return fail('Lot tracking is not switched on for this account. Record this without lots.');
  if (lots.hasStockOp(draft) && lots.hasLotLines(draft)) {
    return fail('A stock operation and a purchase or sale of lots need separate confirmations. Finish one, then draft the other.');
  }
  const bad = await draftRules.prepare(user, draft);
  if (bad) return fail(bad);

  const undoing = isUndo(draft);
  const money = !undoing && lots.hasMoney(draft);
  if (money) {
    // A fee on a stock operation is an expense that goes into the stones, never to profit and loss.
    if (lots.hasStockOp(draft)) {
      draft.direction = 'expense';
      draft.category_code = lots.FEE_CATEGORY_CODE;
    }
    await applyDefaults(user, draft);
    const missing = validateDraft(draft);
    if (missing.length) return fail(`Required fields still missing: ${missing.join(', ')}. Ask the user for them before requesting confirmation.`);
    const problem = await readinessError(user, draft, () => getErp(ctx));
    if (problem) return fail(problem);
  }

  let op;
  if (undoing) {
    const r = await undo.resolve(user, draft.stock_op, { erp: getErp(ctx) });
    if (!r.ok) return fail(r.error);
    op = r.op;
  } else {
    const feeCapitalised = money && lots.hasStockOp(draft) ? lotErp.feeToStock(user, draft) : 0;
    const r = await resolver.resolveDraft(user, draft, { feeCapitalised });
    if (!r.ok) return fail(r.error);
    op = r.op;
    writeCodes(draft, op);
  }

  const open = await store.unfinishedOps(user.id);
  let resume = null;
  if (open.length) {
    const sig = lots.opSignature(op);
    // An undo may only target the unfinished operation itself; anything else must be that operation again.
    resume = undoing
      ? open.find((o) => o.reference === op.reference) || null
      : open.find((o) => o.status !== 'undoing' && o.plan && lots.opSignature(o.plan.op) === sig) || null;
    if (!resume) return fail(unfinishedMessage(open[0]));
  } else if (!undoing) {
    // Read-only: is every input still in ERPNext where Berpal thinks it is?
    const short = await lotErp.preflight(user, getErp(ctx), op);
    if (short) return fail(short);
  }
  return { ok: true, op, undoing, money, resume };
}

const signature = (draft, op) => `${signer().cardSignature(draft)}:${lots.opSignature(op)}`;

/** request_confirmation for a lot draft. */
async function requestConfirmation(ctx) {
  const p = await plan(ctx);
  if (!p.ok) return p;

  // Warnings go on the draft before the card and the signature (as for money drafts): they are
  // card lines, a changed set means a new card, and the review Comment repeats them.
  if (p.money) await signer().applyTrust(ctx);
  else {
    delete ctx.draft.trust_warnings;
    delete ctx.draft.receipt_hash;
  }
  const advisory = (p.op.warnings || []).filter(Boolean);
  if (advisory.length) ctx.draft.trust_warnings = [...(ctx.draft.trust_warnings || []), ...advisory];

  // The card first: if building it fails, nothing is armed.
  const card = p.undoing
    ? await undo.card(ctx.user, p.op)
    : await lotCard.build(ctx.user, ctx.draft, p.op, () => getErp(ctx));
  const sig = signature(ctx.draft, p.op);
  const duplicate = ctx.draft.confirmation_pending === sig;
  ctx.draft.confirmation_sig = sig;
  ctx.confirmationRequested = true;
  console.log(`• [lots] [${ts()}] tool=request_confirmation user_id=${ctx.user.id} kind=${p.undoing ? 'undo' : p.op.kind}${duplicate ? ' (duplicate card)' : ''}`);
  return {
    ok: true,
    card,
    draft: stripProtected(ctx.draft),
    note: duplicate
      ? 'This exact card was ALREADY sent to the user earlier. If their latest message is a confirmation (yes/ok/confirm/save/retry), call save_transaction NOW instead of re-sending it.'
      : 'Reply with card.lines VERBATIM, one per line, in this order, then a blank line and "Choose below or tell me what to fix." Nothing else. Then WAIT for the user — do not call save_transaction in this turn.',
  };
}

const plain = (s) => String(s || '').trim().replace(/[.\s]+$/, '');
const named = (list) => (list || []).map((d) => `${d.doctype} ${d.name}`).join(', ');

/** For the model, when a save or an undo stopped with something (possibly) in the books. */
function stoppedWords(result, undoing) {
  const why = `It stopped at: ${plain(result.error)}.`;
  if (undoing) {
    const done = named(result.cancelled);
    const left = named(result.standing);
    return `The undo of ${result.reference} is not finished${done ? ` (cancelled so far: ${done})` : ''}${left ? `; still in the books: ${left}` : ''}. ${why} `
      + 'Tell the user plainly what was taken back and what was not, and that replying "retry" finishes the undo (retry_stock_op).';
  }
  const posted = named(result.docs);
  if (!posted) {
    return `It is not known whether this reached the books: they did not answer properly. ${why} `
      + 'Tell the user plainly that it is NOT saved yet, and that replying "retry" checks the books and finishes it (retry_stock_op).';
  }
  return `Only part of this was saved (posted: ${posted}). ${why} `
    + 'Tell the user plainly what was saved and what was not, and that replying "retry" finishes it from where it stopped (retry_stock_op).';
}

/**
 * What an undo has cancelled so far, also when it stopped half way: a bill, an invoice or a fee
 * payment leaves the accountant's queue, a stock entry keeps its place there with a line saying so.
 */
async function markTakenBack(ctx, { result, op }) {
  const erp = getErp(ctx);
  for (const d of result.cancelled || []) {
    try {
      await review.markStockPosted(erp, { user: ctx.user, doc: { doctype: d.doctype, erpnext_name: d.name }, op, undoing: true, reference: result.reference });
    } catch (err) {
      console.error(`[lots] review mark failed (${d.doctype} ${d.name}):`, err.message);
    }
  }
}

/**
 * After execute.run / undo.run: on success the turn's bookkeeping (as save_transaction does it),
 * on a partial failure the draft and its card stay armed so the same confirmation finishes it.
 */
async function settle(ctx, { result, confirmed, op, undoing }) {
  const erp = getErp(ctx);
  const docs = result.docs || [];
  if (undoing) await markTakenBack(ctx, { result, op });
  if (!result.ok) {
    // An undo words its own refusal for the trader (what has to happen first).
    if (!result.partial) return fail(undoing ? result.error : `Save failed: ${result.error}`);
    if (confirmed && typeof confirmed.confirmation_pending === 'string') {
      ctx.draft.confirmation_sig = confirmed.confirmation_pending;
      ctx.confirmationRequested = true;
    }
    return fail(stoppedWords(result, undoing), { partial: true, reference: result.reference, documents: docs });
  }

  const mediaId = confirmed ? confirmed.receipt_media_id : null;
  ctx.saved = result.saved || { doctype: 'Lot Operation', erpnext_name: result.reference };
  ctx.savedIds = [...(ctx.savedIds || []), ...docs.map((d) => d.name)];
  ctx.draft = {};
  ctx.confirmationRequested = false;

  const money = result.money_doc || null;
  if (money && confirmed) {
    ctx.savedDocs = { ...(ctx.savedDocs || {}), [money.erpnext_name]: saver().savedDoc(money, confirmed) };
    await review.markPosted(erp, { user: ctx.user, saved: money, draft: confirmed, mediaId });
    if (mediaId) {
      try {
        await attachToDoc(erp, { userId: ctx.user.id, mediaId, doctype: money.doctype, docname: money.erpnext_name });
      } catch (err) {
        console.error(`[lots] receipt attach failed (media ${mediaId}, ${money.doctype} ${money.erpnext_name}):`, err.message);
      }
    }
  }
  // Stock entries go to the accountant's queue too (a sort by value re-prices stock).
  for (const d of undoing ? [] : docs.filter((x) => x.doctype === 'Stock Entry')) {
    try {
      await review.markStockPosted(erp, {
        user: ctx.user, doc: { doctype: d.doctype, erpnext_name: d.name }, op,
        reference: result.reference, warnings: (confirmed && confirmed.trust_warnings) || [],
      });
    } catch (err) {
      console.error(`[lots] review mark failed (${d.doctype} ${d.name}):`, err.message);
    }
  }
  console.log(`• [lots] [${ts()}] saved user_id=${ctx.user.id} kind=${undoing ? 'undo' : op.kind} ref=${result.reference} docs=${docs.length}`);
  // A lot with nothing left (sold out, sorted away, cut) is named, not listed at 0 ct.
  const all = result.lots || [];
  const usedUp = undoing ? [] : all.filter((l) => !(l.carats > 0)).map((l) => l.code);
  const out = { ok: true, ...ctx.saved, reference: result.reference, documents: docs, lots: all.filter((l) => !usedUp.includes(l.code)) };
  if (!undoing) {
    return {
      ...out,
      ...(usedUp.length ? { used_up: usedUp } : {}),
      note: 'Tell the user it is saved: the Ref, then one short line per lot in `lots` (code, carats, pieces if counted, cost)'
        + `${usedUp.length ? '; the lots in `used_up` have nothing left, say so in one line' : ''}.`,
    };
  }
  const removed = result.removed || [];
  return {
    ...out,
    undone: true,
    ...(removed.length ? { removed } : {}),
    ...(result.lost ? { lost: result.lost } : {}),
    note: `Tell the user ${result.reference} is taken back: one short line per lot in \`lots\` as it stands again (code, carats, pieces if counted, cost)`
      + `${removed.length ? '; the lots in `removed` no longer exist' : ''}`
      + `${result.lost ? '. Say also what went with it (`lost`): lab reports added to a removed lot (`certificates`), and lots whose details were edited since and are back as they were before (`detailsChanged`)' : ''}.`,
  };
}

/** save_transaction for a lot draft. */
async function saveTransaction(ctx) {
  if (typeof ctx.draft.confirmation_pending !== 'string') {
    return fail('No confirmation card has been sent for this draft. Call request_confirmation, send the summary, and wait for the user to confirm in their next message.');
  }
  const p = await plan(ctx);
  if (!p.ok) return fail(`Cannot save; ${p.error}`);
  if (ctx.draft.confirmation_pending !== signature(ctx.draft, p.op)) {
    return fail('The draft or the lots changed after the confirmation card was sent, so the user has not confirmed this version. Call request_confirmation again, send the updated summary, and wait for their reply.');
  }

  const confirmed = { ...ctx.draft };
  let result;
  try {
    result = p.undoing
      ? await undo.run(ctx.user, getErp(ctx), p.op)
      : await runner.run(ctx.user, getErp(ctx), { op: p.op, draft: confirmed, reference: p.resume ? p.resume.reference : null });
  } catch (err) {
    // run() reports failures in its result; a throw means it died somewhere unexpected. Whether
    // anything was posted is then read from the operations table, never assumed.
    console.error('[lots] run threw:', err.message);
    const open = await store.unfinishedOps(ctx.user.id).catch(() => []);
    result = { ok: false, partial: open.length > 0, reference: open[0] && open[0].reference, docs: (open[0] && open[0].erpnext_docs) || [], error: err.message };
  }
  return settle(ctx, { result, confirmed, op: p.op, undoing: p.undoing });
}

/**
 * retry_stock_op: finish the operation that is only partly saved, from its stored plan. The user
 * confirmed it once already; this posts the remaining steps of that same confirmation.
 */
async function retry(ctx) {
  if (!lots.isGems(ctx.user)) return fail('Lot tracking is not switched on for this account.');
  const open = await store.unfinishedOps(ctx.user.id);
  if (!open.length) return { ok: true, nothing_to_finish: true, note: 'No stock operation is waiting to be finished.' };
  const o = open[0];
  // An undo that stopped half way is finished as an undo: the user confirmed that already.
  const undoing = o.status === 'undoing';
  let result;
  let undoOp = null;
  try {
    if (undoing) {
      const r = await undo.resolve(ctx.user, { kind: 'undo', reference: o.reference }, { erp: getErp(ctx) });
      if (!r.ok) return fail(`Still not undone: ${r.error}`, { partial: true, reference: o.reference });
      undoOp = r.op;
      result = await undo.run(ctx.user, getErp(ctx), undoOp);
    } else {
      result = await runner.run(ctx.user, getErp(ctx), { reference: o.reference });
    }
  } catch (err) {
    console.error('[lots] retry threw:', err.message);
    result = { ok: false, partial: true, reference: o.reference, docs: o.erpnext_docs || [], error: err.message };
  }
  // The chat draft may be gone or be something else by now: leave it alone on failure, and only
  // clear it on success when it is this very operation.
  const stored = (o.plan && o.plan.draft) || null;
  const sameDraft = lots.applies(ctx.draft) && isUndo(ctx.draft) === undoing;
  if (!result.ok) {
    if (undoing) await markTakenBack(ctx, { result, op: undoOp });
    const words = result.partial ? stoppedWords({ ...result, reference: o.reference }, undoing) : `${plain(result.error)}.`;
    return fail(`Still not finished. ${words}`, { partial: !!result.partial, reference: o.reference, documents: result.docs || [] });
  }
  const keep = sameDraft ? null : { draft: ctx.draft, requested: ctx.confirmationRequested };
  const out = await settle(ctx, { result, confirmed: undoing ? null : stored, op: undoing ? undoOp : o.plan.op, undoing });
  if (keep) {
    ctx.draft = keep.draft;
    ctx.confirmationRequested = keep.requested;
  }
  return out;
}

module.exports = { requestConfirmation, saveTransaction, retry, plan };

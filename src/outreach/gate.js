/**
 * Server-side consent gate for anything that messages a third party.
 *
 * Contract with src/conversation.js:
 *   1. A preview call stores the exact plan on ctx.draft.outreach_preview (unarmed).
 *   2. conversation.js sets .armed = true when that turn ends — so the earliest a confirm can
 *      land is the user's NEXT message, never the same turn as the preview — and deletes it if
 *      the next turn ends with it still pending (one-turn window). The model can't forge it:
 *      outreach_preview is a protected draft key (stripped from update_draft, hidden from the prompt).
 *   3. A confirmed:true call recomputes the plan from live data and must hash to the same
 *      plan_hash (recipient + body + attachments + refs). Any drift — a payment landed, a phone
 *      changed, the date rolled into "overdue" — means the user approved something else, so we
 *      re-preview instead of sending.
 *   4. After sending, the preview is deleted so one yes can't be replayed.
 */
const crypto = require('crypto');

// A yes from yesterday isn't consent for today's send.
const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** view = { to: [], body: [], attachments: [[]], refs: [] } — the user-visible content. */
function planHash(view) {
  // view.payees (full PromptPay ids) is hashed but never shown: the preview only shows ••••1234,
  // and two ids sharing their last 4 digits must still count as a change.
  const material = JSON.stringify([view.to, view.body, view.attachments, view.refs, view.payees || null]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

function storePreview(ctx, tool, args, view) {
  if (!ctx.draft) ctx.draft = {};
  const { confirmed, ...rest } = args || {}; // eslint-disable-line no-unused-vars
  ctx.draft.outreach_preview = {
    // Identity of THIS preview: conversation.js expires an armed preview by id, and a re-preview
    // in the same millisecond must not be mistaken for the stale one (created_at can collide).
    preview_id: crypto.randomUUID(),
    tool,
    args: rest,
    plan_hash: planHash(view),
    to: view.to,
    body: view.body,
    attachments: view.attachments,
    refs: view.refs,
    created_at: new Date().toISOString(),
  };
}

/** null when confirmed:true may proceed; otherwise why not (for the model). */
function verify(ctx, tool, view, now = Date.now()) {
  const p = ctx.draft && ctx.draft.outreach_preview;
  if (!p || p.tool !== tool) return 'Nothing sent: there is no preview for this yet. Show the user this preview and ask for a yes.';
  if (p.armed !== true) {
    return "Nothing sent: confirmed:true needs the user's yes in a NEW message after they saw the preview. Show it and wait for their reply.";
  }
  if (now - Date.parse(p.created_at) > PREVIEW_TTL_MS) return 'Nothing sent: the preview expired. Show the user this fresh preview and ask again.';
  if (p.plan_hash !== planHash(view)) {
    return 'Nothing sent: something changed since the preview (a payment landed, the phone number or a date changed). Show the user this UPDATED preview and ask again.';
  }
  return null;
}

/** Drop the pending preview (after a send, or when it can no longer be sent). `tool` limits it to that tool's. */
function clearPreview(ctx, tool = null) {
  const p = ctx.draft && ctx.draft.outreach_preview;
  if (p && (!tool || p.tool === tool)) delete ctx.draft.outreach_preview;
}

module.exports = { planHash, storePreview, verify, clearPreview, PREVIEW_TTL_MS };

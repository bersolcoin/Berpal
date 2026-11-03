const { ts } = require('../erp-sync/common');
const { validateDraft, readinessError, applyDefaults, stripProtected } = require('./validate');
const { computeTotals, vatTreatment } = require('../erp-sync/taxes');
const { getErp } = require('./context');
const { buildCard } = require('./card');

const definition = {
  name: 'request_confirmation',
  description:
    'Indicates you have all required fields and your text reply contains a clean summary for the user to confirm. Use only when amount, currency, direction, and transaction_date are all set in the draft.',
  parameters: { type: 'object', properties: {} },
};

// Fields that change what the card says. Flags and bookkeeping keys are left out.
// receipt_media_id is deliberately IN the signature: swapping the receipt after the card must
// invalidate it (save_transaction compares). outreach_preview is a separate consent flow.
const IGNORED = new Set(['wallet_options', 'confirmation_pending', 'confirmation_sig', 'counterparty_contact_skipped',
  'wallet_skipped', 'wallet_skip_requested_by_model', 'exchange_rate_source', 'outreach_preview']);
/** What the user saw on the card, as a comparable string. save_transaction re-checks it. */
// Ids the model may pass as "9" or 9: the same wallet / contact / receipt either way.
const NUMERIC_IDS = new Set(['payment_account_id', 'transfer_destination_account_id', 'counterparty_id', 'receipt_media_id']);
// Flags where false is NOT the same as absent (false = not claimable / VAT on top), so they keep
// their false in the signature. Every other false is treated like an unset field.
const FALSE_MEANINGFUL = new Set(['vat_claimable', 'tax_inclusive']);

function cardSignature(draft) {
  const entries = Object.keys(draft)
    .filter((k) => !IGNORED.has(k))
    .map((k) => [k, NUMERIC_IDS.has(k) && draft[k] != null && draft[k] !== '' ? Number(draft[k]) : draft[k]])
    .filter(([k, v]) => v != null && v !== '' && !(v === false && !FALSE_MEANINGFUL.has(k)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

async function execute(args, ctx) {
  await applyDefaults(ctx.user, ctx.draft);
  const missing = validateDraft(ctx.draft);
  if (missing.length) {
    return {
      ok: false,
      error: `Required fields still missing: ${missing.join(', ')}. Ask the user for them before requesting confirmation.`,
    };
  }
  const problem = await readinessError(ctx.user, ctx.draft, () => getErp(ctx));
  if (problem) return { ok: false, error: problem };

  // Same card as the one the user saw on an earlier turn (confirmation_pending holds its
  // signature)? Then they have most likely just confirmed it: save rather than re-issue.
  // confirmation_sig is THIS turn's card; handle() promotes it to confirmation_pending only when
  // the turn ends, so re-signing here never authorises a save in the same turn.
  // The card first: if building it fails, nothing is armed (no signature, no button card).
  const card = await buildCard(ctx.user, ctx.draft, () => getErp(ctx));
  const sig = cardSignature(ctx.draft);
  const duplicate = ctx.draft.confirmation_pending === sig;
  ctx.draft.confirmation_sig = sig;
  ctx.confirmationRequested = true;
  console.log(`• [tools] [${ts()}] tool=request_confirmation user_id=${ctx.user.id}${duplicate ? ' (duplicate card)' : ''}`);

  // Return the draft: defaults (date, currency, category, FX rate) were filled in server-side
  // and the model must render the card from these values, not from memory.
  const rate = Number(ctx.draft.exchange_rate) || 1;
  // Net / VAT / gross / WHT computed here so the card never depends on the model's arithmetic.
  // base_amount is the gross (what the counterparty pays / is invoiced) in reporting currency.
  const t = computeTotals(ctx.draft);
  const taxed = t.vat > 0 || t.wht > 0;
  return {
    ok: true,
    card,
    draft: stripProtected(ctx.draft),
    base_amount: Math.round(t.gross * rate * 100) / 100,
    ...(taxed ? {
      totals: {
        currency: ctx.draft.currency, net: t.net, vat: t.vat, gross: t.gross,
        ...(t.vat ? { vat_rate: Number(ctx.draft.tax_rate), vat_claimable: vatTreatment(ctx.user, ctx.draft) !== 'non_claimable' } : {}),
        ...(t.wht ? { wht: t.wht, wht_rate: Number(ctx.draft.wht_rate), wht_form: ctx.draft.wht_form, payable_to_counterparty: t.due } : {}),
      },
    } : {}),
    note: duplicate
      ? 'This exact card was ALREADY sent to the user earlier. If their latest message is a confirmation (yes/ok/confirm/save), call save_transaction NOW instead of re-sending it.'
      : 'Reply with card.lines VERBATIM, one per line, in this order (you may append " (assumed)" to the Amount line if the user named no currency), then a blank line and "Choose below or tell me what to fix." Nothing else. Then WAIT for the user — do not call save_transaction in this turn.',
  };
}

module.exports = { definition, execute, cardSignature };

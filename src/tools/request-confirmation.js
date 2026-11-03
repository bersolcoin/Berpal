const { ts } = require('../erp-sync/common');
const { validateDraft, readinessError, applyDefaults } = require('./validate');
const { computeTotals, vatTreatment } = require('../erp-sync/taxes');
const { getErp } = require('./context');

const definition = {
  name: 'request_confirmation',
  description:
    'Indicates you have all required fields and your text reply contains a clean summary for the user to confirm. Use only when amount, currency, direction, and transaction_date are all set in the draft.',
  parameters: { type: 'object', properties: {} },
};

// Fields that change what the card says. Flags and bookkeeping keys are left out.
const IGNORED = new Set(['wallet_options', 'confirmation_pending', 'confirmation_sig', 'counterparty_contact_skipped',
  'wallet_skipped', 'wallet_skip_requested_by_model', 'exchange_rate_source']);
function cardSignature(draft) {
  return JSON.stringify(Object.keys(draft).filter((k) => !IGNORED.has(k)).sort().map((k) => [k, draft[k]]));
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

  // Same card as one already sent on an earlier turn? Then the user has most likely just
  // confirmed it, and the model should save rather than re-issue the card.
  const sig = cardSignature(ctx.draft);
  const duplicate = ctx.draft.confirmation_pending && ctx.draft.confirmation_sig === sig;
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
    draft: ctx.draft,
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
      : `Render the summary from \`draft\` exactly (use exchange_rate and base_amount as given${taxed ? '; Net/VAT/Gross/WHT lines from `totals`' : ''}). Then WAIT for the user — do not call save_transaction in this turn.`,
  };
}

module.exports = { definition, execute };

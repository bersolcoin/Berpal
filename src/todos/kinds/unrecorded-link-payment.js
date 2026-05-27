/**
 * Kind: unrecorded_link_payment
 *
 * Enqueued when the buyer accepts a linked invoice whose seller_paid_now
 * was true — meaning the seller said the bill was paid at the time of
 * sale, but the buyer's mirror Purchase Invoice was created without a
 * matching Payment Entry (we don't know which wallet they paid from).
 *
 * Without resolution, the buyer's AP shows an open payable to the
 * seller that doesn't match reality, and their cash balance is
 * inflated by the unrecorded outflow.
 *
 * payload shape:
 *   {
 *     link_id:                2,
 *     purchase_invoice_ref:   'ACC-PINV-2026-00003',
 *     seller_label:           'Test Trading',
 *     amount:                 2000,
 *     currency:               'USD',
 *   }
 *
 * Resolution (userInput shape):
 *   {
 *     payment_legs: [
 *       { payment_account_code: '1000', wallet_name: 'Cash USD', amount: 2000 },
 *       // or split:
 *       // { payment_account_code: '1000', wallet_name: 'Cash USD', amount: 1000 },
 *       // { payment_account_code: '1100', wallet_name: 'BBL Savings', amount: 1000 },
 *     ],
 *   }
 *
 * Posts one Payment Entry per leg, all referencing the same PI. ERPNext
 * tracks remaining outstanding naturally — partial payments leave AP
 * outstanding, full payments clear it.
 */

const { ts } = require('../../log');
const paymentEntry = require('../../erp-sync/payment-entry');

function buildPrompt(p = {}) {
  const who = p.seller_label || 'the seller';
  const money = p.amount != null && p.currency
    ? `${p.currency} ${Number(p.amount).toLocaleString('en-US')}`
    : 'this amount';
  const ref = p.purchase_invoice_ref ? ` (${p.purchase_invoice_ref})` : '';
  return `${who} was paid ${money} at the time of sale${ref} — which of your wallets did you pay from?`;
}

async function resolve(user, erp, payload, userInput) {
  const piRef = payload?.purchase_invoice_ref;
  if (!piRef) {
    return { ok: false, error: 'payload is missing purchase_invoice_ref.' };
  }

  if (userInput?.skip) {
    return { ok: true, action: 'skipped' };
  }

  const legs = Array.isArray(userInput?.payment_legs) ? userInput.payment_legs : [];
  if (legs.length === 0) {
    return { ok: false, error: 'add at least one payment leg, or skip to dismiss.' };
  }

  // Per-leg validation. The web form enforces these but defending here
  // since the API is callable from elsewhere too.
  let totalPaid = 0;
  for (const leg of legs) {
    if (!leg?.payment_account_code) {
      return { ok: false, error: 'each payment_leg needs payment_account_code (1000 / 1100 / 2100).' };
    }
    const amt = Number(leg.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return { ok: false, error: 'each payment_leg amount must be a positive number.' };
    }
    totalPaid += amt;
  }

  const totalCost = Number(payload?.amount) || 0;
  if (totalCost && totalPaid > totalCost + 0.001) {
    return { ok: false, error: `payments (${totalPaid}) exceed the bill total (${totalCost}).` };
  }

  // The PI already has the supplier on it — we just need the supplier
  // name for the PE counterparty_name. Pull it from the doc.
  let supplierName = payload?.seller_label;
  try {
    const piDoc = await erp.getResource('Purchase Invoice', piRef);
    if (piDoc?.data?.supplier) supplierName = piDoc.data.supplier;
  } catch (err) {
    // Non-fatal — payload's seller_label is a usable fallback. Log so
    // we can spot if the PI was deleted out from under us.
    console.warn(`• [todos] [${ts()}] could not refetch PI ${piRef}: ${err.message}`);
  }

  // Post one PE per leg, all allocating against the same PI. Stop on
  // first failure so partial-success doesn't silently leave a mess.
  const currency = payload?.currency || user.reporting_currency;
  const paymentNames = [];
  for (const leg of legs) {
    const peDraft = {
      transaction_type: 'payment',
      direction: 'expense',
      amount: Number(leg.amount),
      currency,
      counterparty_name: supplierName,
      payment_account_code: leg.payment_account_code,
      wallet_name: leg.wallet_name || null,
      parent_invoice_ref: piRef,
      transaction_date: leg.transaction_date || todayISO(),
    };
    const peResult = await paymentEntry.save(user, erp, peDraft);
    if (!peResult?.ok) {
      return {
        ok: false,
        error: `Payment Entry post failed: ${peResult?.error || 'unknown'}`,
        partial_payment_entry_names: paymentNames,
      };
    }
    paymentNames.push(peResult.erpnext_name);
    console.log(`• [todos] [${ts()}]   link-payment leg posted: ${peResult.erpnext_name} (${leg.amount} from ${leg.wallet_name})`);
  }

  return {
    ok: true,
    action: 'link_payment_recorded',
    purchase_invoice_ref: piRef,
    payment_entry_names: paymentNames,
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  kind: 'unrecorded_link_payment',
  bot_resolvable: true,
  web_resolvable: true,
  buildPrompt,
  resolve,
};

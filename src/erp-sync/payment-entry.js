/**
 * Handler for transaction_type='payment' — posts a Payment Entry to ERPNext
 * that settles (in full, partially, or with overpayment) one open invoice.
 *
 * Required draft fields:
 *   parent_invoice_ref      ERPNext name of the invoice being settled (e.g. ACC-SINV-2026-00001)
 *   direction               'income' = customer paid us (Sales Invoice settlement)
 *                           'expense' = we paid a supplier (Purchase Invoice settlement)
 *   amount                  amount actually paid, in `currency`
 *   currency                ISO code, MUST match the invoice's currency for v1
 *   payment_account_code    '1000' / '1100' / '2100' — the wallet money flowed in/out of
 *   exchange_rate           payment-day rate (currency → user.reporting_currency).
 *                           Required only if currency != user.reporting_currency.
 *
 * Allocation math:
 *   allocated  = min(amount, outstanding_amount on invoice)
 *   unallocated = max(0, amount - outstanding_amount)
 *
 * The three scenarios fall out naturally:
 *   amount == outstanding  →  fully settles, invoice goes to "Paid"
 *   amount  < outstanding  →  partial, invoice stays "Partly Paid", remainder open
 *   amount  > outstanding  →  pays in full + remainder becomes a customer advance
 *                             (ERPNext stores it as unallocated_amount on the entry,
 *                             which then sits as a positive on the customer ledger
 *                             and can be applied to future invoices)
 *
 * FX gain/loss: when `exchange_rate` on the payment differs from the invoice's
 * own `conversion_rate`, ERPNext computes the THB difference and posts it to
 * the Company's `exchange_gain_loss_account` automatically. We don't compute
 * the diff; we just pass `source_exchange_rate` and let ERPNext handle it.
 */

const { resolveErpAccount } = require('./account');
const { resolvePartyAccount } = require('./party-account');
const { ts } = require('../log');

async function save(user, erp, draft) {
  if (!draft.parent_invoice_ref) {
    return { ok: false, error: 'payment requires parent_invoice_ref (ERPNext invoice name)' };
  }
  if (!draft.direction || (draft.direction !== 'income' && draft.direction !== 'expense')) {
    return { ok: false, error: "payment requires direction='income' or 'expense'" };
  }
  if (!draft.amount || draft.amount <= 0) {
    return { ok: false, error: 'payment requires amount > 0' };
  }
  if (!draft.currency) {
    return { ok: false, error: 'payment requires currency' };
  }
  if (!draft.payment_account_code) {
    return { ok: false, error: "payment requires payment_account_code (wallet — '1000' for cash, '1100' for bank, etc.)" };
  }

  const isIncome = draft.direction === 'income';
  const refDoctype = isIncome ? 'Sales Invoice' : 'Purchase Invoice';
  const partyType = isIncome ? 'Customer' : 'Supplier';
  const partyField = isIncome ? 'customer' : 'supplier';

  // 1. Fetch the invoice to learn party, outstanding, and original conversion_rate.
  let inv;
  try {
    const r = await erp.getResource(refDoctype, draft.parent_invoice_ref);
    inv = r.data;
  } catch (err) {
    return { ok: false, error: `invoice ${draft.parent_invoice_ref} not found in ERPNext: ${err.message}` };
  }
  if (!inv) {
    return { ok: false, error: `invoice ${draft.parent_invoice_ref} not found in ERPNext` };
  }
  if (inv.currency !== draft.currency) {
    return {
      ok: false,
      error: `currency mismatch: payment is ${draft.currency} but invoice ${inv.name} is in ${inv.currency}. Re-do the payment in ${inv.currency} (or split into two flows).`,
    };
  }

  // 2. Resolve the user's wallet ERPNext account.
  //    Use draft.currency for the lookup so a USD-cash payment finds USD cash, not THB cash.
  const walletAccount = await resolveErpAccount(user, erp, draft.payment_account_code, draft.currency);
  if (!walletAccount) {
    return {
      ok: false,
      error: `could not resolve wallet for code=${draft.payment_account_code} currency=${draft.currency}. The account may not exist yet — add it in ERPNext or via create_user_account when that tool is wired.`,
    };
  }

  // 3. Resolve the party account (Debtors/Creditors in payment currency).
  //    For Receive: paid_from = Debtors <CCY> (where the receivable sits).
  //    For Pay:     paid_to   = Creditors <CCY> (where the payable sits).
  const partyAccount = await resolvePartyAccount(
    erp,
    isIncome ? 'Receivable' : 'Payable',
    draft.currency
  );

  // 4. Compute allocation.
  const outstanding = Number(inv.outstanding_amount) || 0;
  const paidAmount = Number(draft.amount);
  const allocated = Math.min(paidAmount, outstanding);
  const unallocated = Math.max(0, paidAmount - outstanding);

  // 5. Build the Payment Entry payload.
  //    ERPNext field model (for Receive):
  //      paid_from  = party's AR account (currency = invoice currency)
  //      paid_to    = our wallet (currency = wallet's own currency)
  //      paid_amount     = amount in paid_from currency
  //      received_amount = amount in paid_to currency
  //    For v1 we require wallet currency == payment currency, so paid == received.
  const payload = {
    payment_type: isIncome ? 'Receive' : 'Pay',
    posting_date: draft.transaction_date,
    party_type: partyType,
    party: inv[partyField],
    paid_amount: paidAmount,
    received_amount: paidAmount,
    paid_from: isIncome ? partyAccount : walletAccount,
    paid_to:   isIncome ? walletAccount : partyAccount,
    references: [
      {
        reference_doctype: refDoctype,
        reference_name: inv.name,
        total_amount: inv.grand_total,
        outstanding_amount: outstanding,
        allocated_amount: allocated,
      },
    ],
    docstatus: 1, // submit on create
  };

  // 6. FX. When the payment currency differs from company currency, ERPNext
  //    needs `source_exchange_rate` so it can compute base totals and compare
  //    against the invoice's own conversion_rate (the difference posts to
  //    Exchange Gain/Loss automatically).
  if (draft.currency !== user.reporting_currency) {
    if (!draft.exchange_rate) {
      return {
        ok: false,
        error: `payment in ${draft.currency} needs exchange_rate (rate to ${user.reporting_currency}) on the draft`,
      };
    }
    payload.source_exchange_rate = draft.exchange_rate;
    payload.target_exchange_rate = draft.exchange_rate;
  }

  // 7. Overpayment → leave as unallocated; ERPNext records it on the party account.
  if (unallocated > 0) {
    payload.unallocated_amount = unallocated;
  }

  // 8. POST.
  const result = await erp.createPaymentEntry(payload);
  const erpName = result.data?.name;

  const settlementSummary =
    unallocated > 0
      ? `${allocated} settled + ${unallocated} as advance`
      : allocated < outstanding
        ? `${allocated} of ${outstanding} (partial)`
        : `${allocated} (full)`;

  console.log(
    `• [conversation] [${ts()}] saved Payment Entry to ERPNext: ${erpName} ` +
      `(${draft.direction} ${paidAmount} ${draft.currency} against ${inv.name}; ${settlementSummary})`
  );

  return {
    ok: true,
    erpnext_name: erpName,
    doctype: 'Payment Entry',
    allocated,
    unallocated,
    invoice_outstanding_before: outstanding,
    invoice_ref: inv.name,
  };
}

module.exports = { save };

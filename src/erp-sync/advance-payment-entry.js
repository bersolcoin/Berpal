/**
 * Handler for transaction_type='advance_given' / 'advance_received'.
 *
 * An "advance" is money moved to/from a counterparty WITHOUT a matching
 * invoice — it sits as unallocated on the party ledger until a future
 * invoice/bill is created and matched against it.
 *
 *   advance_given:    we sent money out (refund a customer, prepay a supplier).
 *                     payment_type = 'Pay', cash leaves a wallet, party_account
 *                     accrues a debit balance (customer) or our payable shrinks
 *                     (supplier prepayment sits as unallocated payment).
 *
 *   advance_received: someone sent us money (customer prepay, supplier refund).
 *                     payment_type = 'Receive', cash lands in a wallet, party
 *                     account accrues a credit balance (customer advance) or
 *                     our receivable shrinks (supplier refund).
 *
 * Mechanically identical to payment-entry.js but with NO `references[]` —
 * the entire amount becomes unallocated. ERPNext stores that on the party
 * ledger; the next invoice for that party can be matched against it via
 * the standard Payment Reconciliation flow (web ERPNext UI today, our bot
 * later).
 *
 * party_type is required on the draft so we know which side to charge:
 *   - customer prepayment → party_type='Customer'
 *   - supplier prepayment → party_type='Supplier'
 *
 * Required draft fields:
 *   transaction_type        'advance_given' | 'advance_received'
 *   counterparty_name       resolved via resolveOrCreateCustomer/Supplier
 *   party_type              'Customer' | 'Supplier'
 *   amount, currency        as usual
 *   payment_account_code    wallet code ('1000' / '1100' / '2100')
 *   wallet_name             required for Bank/CC source/destination
 *   exchange_rate           required when currency != user.reporting_currency
 */

const { resolvePartyAccount } = require('./party-account');
const { resolveWalletAccount } = require('./wallet');
const { resolveOrCreateCustomer } = require('./customer');
const { resolveOrCreateSupplier } = require('./supplier');
const { ts } = require('../log');

async function save(user, erp, draft) {
  const tt = draft.transaction_type;
  if (tt !== 'advance_given' && tt !== 'advance_received') {
    return { ok: false, error: `advance-payment-entry got unexpected transaction_type=${tt}` };
  }
  if (!draft.counterparty_name) {
    return { ok: false, error: `${tt} requires counterparty_name` };
  }
  if (!draft.party_type || (draft.party_type !== 'Customer' && draft.party_type !== 'Supplier')) {
    return {
      ok: false,
      error: `${tt} requires party_type='Customer' or 'Supplier' (who's the other side?)`,
    };
  }
  if (!draft.amount || draft.amount <= 0) {
    return { ok: false, error: `${tt} requires amount > 0` };
  }
  if (!draft.currency) {
    return { ok: false, error: `${tt} requires currency` };
  }
  if (!draft.payment_account_code) {
    return { ok: false, error: `${tt} requires payment_account_code (wallet — '1000' cash / '1100' bank / '2100' credit card)` };
  }

  const isReceive = tt === 'advance_received';
  const partyType = draft.party_type;

  // Resolve party (Customer or Supplier). Eager dual-create ensures the
  // other side exists too — useful for refunds and the like.
  let partyName;
  try {
    if (partyType === 'Customer') {
      partyName = await resolveOrCreateCustomer(user, erp, draft.counterparty_name, {
        currency: draft.currency,
        phone: draft.counterparty_phone,
        email: draft.counterparty_email,
      });
    } else {
      partyName = await resolveOrCreateSupplier(user, erp, draft.counterparty_name, {
        currency: draft.currency,
        phone: draft.counterparty_phone,
        email: draft.counterparty_email,
      });
    }
  } catch (err) {
    return { ok: false, error: `counterparty resolution failed: ${err.message}` };
  }

  // Per-currency wallet (auto-creates leaf on first use).
  let walletAccount;
  try {
    walletAccount = await resolveWalletAccount(
      erp,
      draft.payment_account_code,
      draft.currency,
      draft.wallet_name || null
    );
  } catch (err) {
    return { ok: false, error: `wallet resolution failed: ${err.message}` };
  }

  // Per-currency Receivable/Payable account.
  const partyAccount = await resolvePartyAccount(
    erp,
    partyType === 'Customer' ? 'Receivable' : 'Payable',
    draft.currency
  );

  // Build the Payment Entry. NO references — full amount becomes unallocated.
  const payload = {
    payment_type: isReceive ? 'Receive' : 'Pay',
    posting_date: draft.transaction_date,
    party_type: partyType,
    party: partyName,
    paid_amount: draft.amount,
    received_amount: draft.amount,
    paid_from: isReceive ? partyAccount : walletAccount,
    paid_to:   isReceive ? walletAccount : partyAccount,
    unallocated_amount: draft.amount,
    docstatus: 1,
  };

  // FX: payment in non-base currency needs source/target exchange rate.
  if (draft.currency !== user.reporting_currency) {
    if (!draft.exchange_rate) {
      return {
        ok: false,
        error: `${tt} in ${draft.currency} needs exchange_rate (rate to ${user.reporting_currency}) on the draft`,
      };
    }
    payload.source_exchange_rate = draft.exchange_rate;
    payload.target_exchange_rate = draft.exchange_rate;
  }

  // Bank/Card wallets need a reference_no per ERPNext rules.
  if (draft.payment_account_code === '1100' || draft.payment_account_code === '2100') {
    payload.reference_no = draft.payment_reference || `${tt.replace('_', ' ')} ${draft.counterparty_name}`;
    payload.reference_date = draft.transaction_date;
  }

  const result = await erp.createPaymentEntry(payload);
  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved Advance Payment Entry to ERPNext: ${erpName} ` +
      `(${tt} ${draft.amount} ${draft.currency} ${isReceive ? 'from' : 'to'} ${partyName}, sits as unallocated)`
  );

  return {
    ok: true,
    erpnext_name: erpName,
    doctype: 'Payment Entry',
    unallocated: draft.amount,
    party: partyName,
  };
}

module.exports = { save };

/**
 * Draft checks shared by request_confirmation and save_transaction.
 *   validateDraft → list of missing fields (pure)
 *   readinessError → the first business-rule problem (may hit Postgres), or null
 */
const counterparties = require('../counterparties');
const wallets = require('../wallets');
const exchange = require('../exchange');
const { companyCurrency } = require('../erp-sync/common');

const REQUIRED_FIELDS = ['amount', 'currency', 'direction', 'transaction_date'];
const WALLET_TYPES = ['cash', 'payment', 'advance_given', 'advance_received'];
const PARTY_TYPES = ['invoice_issued', 'bill_received', 'payment', 'advance_given', 'advance_received'];

function validateDraft(draft) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (draft[field] == null || draft[field] === '') missing.push(field);
  }
  const tt = draft.transaction_type || 'cash';
  const isTransfer = draft.direction === 'transfer';

  // P&L category: required for cash income/expense and invoices/bills. Transfers, settlements
  // and advances only touch wallets + party accounts.
  const needsCategory = !isTransfer && ['cash', 'invoice_issued', 'bill_received'].includes(tt);
  if (needsCategory && (draft.category_code == null || draft.category_code === '')) {
    missing.push('category_code');
  }
  // Anything that creates or clears a party balance needs a Customer/Supplier in ERPNext.
  if (!isTransfer && PARTY_TYPES.includes(tt) && !draft.counterparty_name && !draft.counterparty_id
      && !draft.parent_invoice_name) {
    missing.push('counterparty_name');
  }
  if (isTransfer) {
    if (!draft.payment_account_id) missing.push('payment_account_id');
    if (!draft.transfer_destination_account_id) missing.push('transfer_destination_account_id');
  }
  if (draft.amount != null && !(Number(draft.amount) > 0)) missing.push('amount (must be positive)');
  return missing;
}

/**
 * Fill the fields the prompt tells the model to default silently (today's date, fallback
 * category, auto-fetched FX rate) so a terse model turn still produces a card instead of a
 * round trip. Never overrides a value the model set.
 */
async function applyDefaults(user, draft) {
  const tt = draft.transaction_type || 'cash';
  if (!draft.transaction_date && draft.amount != null) {
    draft.transaction_date = new Date().toISOString().slice(0, 10);
  }
  if (!draft.currency && draft.amount != null && user.default_currency) {
    draft.currency = user.default_currency;
  }
  const needsCategory = draft.direction !== 'transfer' && ['cash', 'invoice_issued', 'bill_received'].includes(tt);
  if (needsCategory && !draft.category_code && (draft.direction === 'income' || draft.direction === 'expense')) {
    draft.category_code = draft.direction === 'income' ? '4000' : '5900';
  }
  if (draft.currency && draft.currency !== companyCurrency(user) && !(Number(draft.exchange_rate) > 0)) {
    const r = await exchange.fetchRate(draft.currency, companyCurrency(user), draft.transaction_date);
    if (r.rate) {
      draft.exchange_rate = r.rate;
      draft.exchange_rate_source = r.source;
    }
  }
}

async function readinessError(user, draft) {
  const tt = draft.transaction_type || 'cash';
  const isTransfer = draft.direction === 'transfer';

  if (draft.currency && draft.currency !== companyCurrency(user) && !(Number(draft.exchange_rate) > 0)) {
    return `Transaction is in ${draft.currency} but reporting currency is ${companyCurrency(user)} and no exchange_rate is set. Call fetch_exchange_rate (or ask the user for a rate) first.`;
  }

  // New counterparty on an invoice/bill → ask for their phone first (or user skipped).
  if ((tt === 'invoice_issued' || tt === 'bill_received') && !draft.counterparty_phone
      && !draft.counterparty_contact_skipped) {
    const known = await counterparties.forDraft(user, draft);
    if (!known) {
      return `"${draft.counterparty_name}" is a new counterparty. Ask the user for their phone/nickname (or 'skip' → set counterparty_contact_skipped=true) before requesting confirmation.`;
    }
  }

  // Money moving in/out of a real pot must say which pot.
  if (!isTransfer && WALLET_TYPES.includes(tt) && !draft.payment_account_id && !draft.wallet_skipped) {
    return 'No wallet linked. Call list_user_accounts for this currency and set payment_account_id (or set wallet_skipped=true if the user said skip).';
  }
  // Only accept wallet ids that list_user_accounts / create_user_account offered for THIS draft.
  // The model otherwise reuses ids from earlier conversation history, which may point at the wrong wallet.
  const offered = Array.isArray(draft.wallet_options) ? draft.wallet_options.map(Number) : [];
  for (const field of ['payment_account_id', 'transfer_destination_account_id']) {
    if (!draft[field]) continue;
    if (!offered.includes(Number(draft[field]))) {
      return `${field}=${draft[field]} was not offered by list_user_accounts for this draft (ids from earlier conversations may be stale). Call list_user_accounts and pick an id from its result.`;
    }
    const w = await wallets.getById(user, draft[field]);
    if (!w || !w.is_active) {
      return `${field}=${draft[field]} is not an active wallet. Call list_user_accounts again and use a current id.`;
    }
  }
  return null;
}

module.exports = { validateDraft, readinessError, applyDefaults };

/**
 * Draft checks shared by request_confirmation and save_transaction.
 *   validateDraft → list of missing fields (pure)
 *   readinessError → the first business-rule problem (may hit Postgres / ERPNext), or null
 */
const counterparties = require('../counterparties');
const wallets = require('../wallets');
const exchange = require('../exchange');
const { companyCurrency, round2 } = require('../erp-sync/common');
const { computeTotals, amountFromPaidAfterWht, vatTreatment, WHT_RATES, WHT_FORMS } = require('../erp-sync/taxes');
const { splitLine } = require('../erp-sync/invoice-lines');
const { stockShortfall, itemCodeProblem } = require('../erp-sync/items');
const { whtOverpaymentError } = require('../erp-sync/payment-entry');

const REQUIRED_FIELDS = ['amount', 'currency', 'direction', 'transaction_date'];
const WALLET_TYPES = ['cash', 'payment', 'advance_given', 'advance_received'];
const PARTY_TYPES = ['invoice_issued', 'bill_received', 'payment', 'advance_given', 'advance_received'];

function validateDraft(draft) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (draft[field] != null && draft[field] !== '') continue;
    // amount is derived from items when they're valid; if it's still missing, say why.
    const itemsIssue = field === 'amount' && Array.isArray(draft.items) && draft.items.length && itemsProblem(draft.items);
    const paidIssue = field === 'amount' && Number(draft.paid_after_wht) > 0 && paidAfterWhtProblem(draft);
    missing.push(itemsIssue ? `amount (${itemsIssue})` : paidIssue ? `amount (${paidIssue})` : field);
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

/** Why paid_after_wht can't be grossed up, or null. */
function paidAfterWhtProblem(draft) {
  if (!(Number(draft.wht_rate) > 0)) return 'paid_after_wht needs wht_rate (and wht_form)';
  if (Array.isArray(draft.items) && draft.items.length) return 'paid_after_wht cannot be combined with items; set the item rates instead';
  const r = amountFromPaidAfterWht(draft, Number(draft.paid_after_wht));
  if (!r || r.exact) return null;
  return `no invoice amount leaves exactly ${draft.paid_after_wht} after ${draft.wht_rate}% WHT` +
    `${Number(draft.tax_rate) > 0 ? ` and ${draft.tax_rate}% VAT` : ''}; the nearest is ${r.nearest_paid} paid ` +
    `(difference ${r.difference}) for an amount of ${r.nearest_amount}. Ask the user which figure is right, or for the invoice amount itself`;
}

/**
 * Fill the fields the prompt tells the model to default silently (today's date, fallback
 * category, auto-fetched FX rate) so a terse model turn still produces a card instead of a
 * round trip. Never overrides a value the model set.
 */
async function applyDefaults(user, draft) {
  const tt = draft.transaction_type || 'cash';
  // Multi-item drafts: the model may omit amount and let us sum the lines (no model arithmetic).
  if (draft.amount == null && Array.isArray(draft.items) && draft.items.length && itemsProblem(draft.items) == null) {
    draft.amount = itemsSum(draft.items);
  }
  // "Transferred 9,700 after 3%": the user stated what was paid net of WHT; gross it up here.
  // Always re-derived (a later wht_rate / VAT change must recompute); no exact solution →
  // amount is cleared and validateDraft explains with the nearest reachable figure.
  if (Number(draft.paid_after_wht) > 0 && Number(draft.wht_rate) > 0 && !(Array.isArray(draft.items) && draft.items.length)) {
    const r = amountFromPaidAfterWht(draft, Number(draft.paid_after_wht));
    if (r && r.exact) draft.amount = r.amount;
    else delete draft.amount;
  }
  // tax_amount is informational; keep it in step with what will actually post.
  if (Number(draft.tax_rate) > 0 && draft.amount != null) {
    draft.tax_amount = computeTotals(draft).vat;
  }
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

/** Σ flt(qty × rate) — the same per-row rounding ERPNext applies. */
function itemsSum(items) {
  return round2(items.reduce((sum, it) => sum + round2((it.qty == null ? 1 : Number(it.qty)) * Number(it.rate)), 0));
}

function hasMoreThan2dp(n) {
  return Math.abs(Number(n) * 100 - Math.round(Number(n) * 100)) > 1e-6;
}

/** Shape problems with draft.items, or null. Pure. */
function itemsProblem(items) {
  if (!Array.isArray(items)) return 'items must be a list of { description, qty, rate, item_code? }';
  for (const [i, it] of items.entries()) {
    if (!it || !(Number(it.rate) > 0)) return `items[${i}] needs a positive rate`;
    // ERPNext rounds the rate to 2 dp before multiplying (3 × 33.333 posts 99.99), so a finer
    // rate would make the invoice disagree with the card.
    if (hasMoreThan2dp(it.rate)) return `items[${i}] rate ${it.rate} has more than 2 decimals; use the per-unit price in satang precision, or one line with qty 1 and the line total`;
    if (it.qty != null && !(Number(it.qty) > 0)) return `items[${i}] needs a positive qty`;
    // Every Item's UOM is Nos, which ERPNext marks must_be_whole_number.
    if (it.qty != null && !Number.isInteger(Number(it.qty))) {
      return `items[${i}] qty ${it.qty} must be a whole number (each stone/piece is 1 unit; put carat weight in the description, or use qty 1 with the line total as rate)`;
    }
    if (!it.description && !it.item_code) return `items[${i}] needs a description`;
    if (it.item_code) {
      const p = itemCodeProblem(it.item_code);
      if (p) return `items[${i}]: ${p}`;
    }
  }
  return null;
}

const ASK_VAT_REGISTERED = 'The user\'s VAT registration is unknown. Ask once: "Are you VAT-registered?" Then call set_tax_settings(vat_registered) and request_confirmation again.';

/** VAT / WHT / items rules. Pure apart from reading the user's tax settings. */
function taxAndItemsError(user, draft) {
  const tt = draft.transaction_type || 'cash';
  const hasItems = Array.isArray(draft.items) && draft.items.length > 0;
  if (hasMoreThan2dp(draft.amount || 0)) return `amount ${draft.amount} has more than 2 decimals.`;
  if (hasItems) {
    if (!['invoice_issued', 'bill_received', 'cash'].includes(tt) || draft.direction === 'transfer') {
      return `items only apply to invoice_issued, bill_received or a cash sale/expense, not ${tt}. Remove items.`;
    }
    const p = itemsProblem(draft.items);
    if (p) return p;
    const sum = itemsSum(draft.items);
    if (Math.abs(sum - Number(draft.amount)) > 0.005) {
      return `amount ${draft.amount} does not match the items (Σ qty×rate = ${sum}). Fix the item rates/qty with the user, or set amount=${sum} if the items are right.`;
    }
    // A cash JE has no item rows, so a stock line there would silently skip the inventory move.
    if (tt === 'cash' && draft.items.some((it) => it.item_code)) {
      return 'Stock items (item_code) move inventory only through an invoice/bill. Use transaction_type=invoice_issued (sale) or bill_received (purchase) with payment_terms=net_0, then log the payment.';
    }
  }

  const vat = Number(draft.tax_rate) || 0;
  if (Number(draft.tax_amount) > 0 && !(vat > 0)) {
    return 'tax_amount is set but tax_rate is not. Set tax_rate (Thai VAT is 7) and tax_inclusive; the VAT amount is computed for you.';
  }
  if (vat > 0) {
    if (vat >= 100) return `tax_rate ${vat} is not a percentage.`;
    if (draft.direction === 'transfer' || ['payment', 'advance_given', 'advance_received'].includes(tt)) {
      return `VAT is charged on the invoice/bill/sale itself, not on a ${tt}. Clear tax_rate.`;
    }
    if (draft.tax_inclusive == null) {
      return 'tax_rate is set but tax_inclusive is not. Does the stated amount include VAT? Infer it ("incl VAT"/receipt total → true, "+VAT"/"plus 7%" → false) or ask.';
    }
    if (user.vat_registered == null) return ASK_VAT_REGISTERED;
    // Only a VAT registrant may charge VAT / issue a tax invoice (Revenue Code s.86/13).
    const sales = tt === 'invoice_issued' || (tt === 'cash' && draft.direction === 'income');
    if (sales && Number(user.vat_registered) !== 1) {
      return 'The user is not VAT-registered, so they cannot charge VAT on a sale (Revenue Code s.86/13). Clear tax_rate; if they believe they are registered, call set_tax_settings(vat_registered=true) first.';
    }
  }

  // Every posted row needs a non-zero amount and unit rate: a tiny line can round to 0.00 once
  // VAT is backed out, and a zero-rate stock row is rejected by ERPNext (no valuation).
  if (['invoice_issued', 'bill_received'].includes(tt) && Number(draft.amount) > 0) {
    const t = computeTotals(draft);
    const gross = vatTreatment(user, draft) === 'non_claimable';
    for (const [i, l] of t.lines.entries()) {
      const amount = gross ? l.gross : l.net;
      const split = splitLine(amount, l.qty, !!l.item_code);
      if (!(amount > 0) || !(split.rate > 0)) {
        return `line ${i + 1} (${l.description || l.item_code}) is too small to post: after VAT it comes to ${amount} for ${l.qty} unit(s), which rounds to a zero rate. Merge it into another line or drop it.`;
      }
    }
  }

  const wht = Number(draft.wht_rate) || 0;
  if (wht) {
    if (!WHT_RATES.includes(wht)) return `wht_rate ${wht} is not a Thai WHT rate (${WHT_RATES.join(', ')}%); 0 clears it.`;
    const isExpense = tt === 'bill_received' || (tt === 'cash' && draft.direction === 'expense');
    if (!isExpense) return 'wht_rate only applies to a bill_received or cash expense the user pays a supplier. Set wht_rate=0.';
    if (!WHT_FORMS.includes(draft.wht_form)) {
      return 'wht_rate is set but wht_form is not: PND53 if the payee is a company/juristic person (Co., Ltd., บริษัท, หจก.), PND3 if an individual. Infer it from the name or ask.';
    }
  }
  return null;
}

// getErp: lazy () => ERPNext client, only built when a check needs ERPNext (stock on hand), so
// drafts without stock lines never require ERPNext credentials here.
async function readinessError(user, draft, getErp = null) {
  const tt = draft.transaction_type || 'cash';
  const isTransfer = draft.direction === 'transfer';

  const taxProblem = taxAndItemsError(user, draft);
  if (taxProblem) return taxProblem;

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
  // Selling a tracked stone that isn't on hand (as of the posting date) would fail at submit
  // (NegativeStockError); catch it before the card goes out.
  if (getErp && tt === 'invoice_issued' && Array.isArray(draft.items) && draft.items.some((it) => it.item_code)) {
    const short = await stockShortfall(user, getErp(), draft.items, draft.transaction_date);
    if (short) return short;
  }
  // Paying a WHT bill: the supplier is owed gross − WHT. Refuse the gross before the card goes out.
  if (getErp && tt === 'payment' && draft.parent_invoice_name) {
    const over = await whtOverpaymentError(getErp(), draft);
    if (over) return over;
  }
  return null;
}

module.exports = { validateDraft, readinessError, applyDefaults, itemsSum, taxAndItemsError };

/**
 * Handler for transaction_type='bill_received' — posts a Purchase Invoice to ERPNext.
 *
 * Mirror of sales-invoice.js for the AP side:
 *   Customer       → Supplier
 *   Receivable     → Payable        (Creditors per-currency)
 *   debit_to       → credit_to
 *   income_account → expense_account
 *
 * Multi-currency: same shape as sales — pass conversion_rate AND a per-currency
 * `credit_to` (a Creditors account in the bill's currency). Without it, ERPNext
 * rejects with "Party Account currency and document currency should be same".
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveOrCreateSupplier } = require('./supplier');
const { ensureGenericPurchaseItem } = require('./item');
const { resolveErpAccount } = require('./account');
const { resolvePartyAccount } = require('./party-account');
const { ts } = require('../log');

async function save(user, erp, draft) {
  if (!draft.counterparty_name) {
    return { ok: false, error: 'bill requires counterparty_name (supplier)' };
  }

  const supplierName = await resolveOrCreateSupplier(user, erp, draft.counterparty_name, {
    phone: draft.counterparty_phone,
    email: draft.counterparty_email,
  });

  const itemCode = await ensureGenericPurchaseItem(user, erp);

  // Resolve expense account from category_code (5900 → 5223 - Misc Expenses - TTC etc.)
  const expenseAccount = await resolveErpAccount(
    user, erp, draft.category_code, user.reporting_currency
  );

  const postingDate = draft.transaction_date;
  let dueDate = draft.due_date;
  if (!dueDate && typeof draft.payment_terms === 'string' && draft.payment_terms.startsWith('net_')) {
    const days = parseInt(draft.payment_terms.slice(4), 10);
    if (!isNaN(days)) {
      const d = new Date(postingDate);
      d.setDate(d.getDate() + days);
      dueDate = d.toISOString().slice(0, 10);
    }
  }
  if (!dueDate) dueDate = postingDate;

  const billPayload = {
    supplier: supplierName,
    posting_date: postingDate,
    due_date: dueDate,
    bill_no: draft.invoice_number || undefined,
    bill_date: draft.invoice_number ? postingDate : undefined,
    currency: draft.currency,
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: draft.amount,
        description: draft.description || `${supplierName} bill`,
        ...(expenseAccount ? { expense_account: expenseAccount } : {}),
      },
    ],
    docstatus: 1, // submit on create
  };

  // Multi-currency: needs conversion_rate AND a Payable account in the
  // bill's currency. The per-currency Creditors leaf is auto-created on
  // first use by resolvePartyAccount.
  if (draft.currency !== user.reporting_currency) {
    billPayload.conversion_rate = draft.exchange_rate || 1;
    billPayload.credit_to = await resolvePartyAccount(erp, 'Payable', draft.currency);
  }

  const result = await erp.createPurchaseInvoice(billPayload);
  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved Purchase Invoice to ERPNext: ${erpName} ` +
      `(${draft.amount} ${draft.currency} from ${supplierName}, due ${dueDate})`
  );

  return { ok: true, erpnext_name: erpName, doctype: 'Purchase Invoice' };
}

module.exports = { save };

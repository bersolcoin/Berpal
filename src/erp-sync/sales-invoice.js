/**
 * Handler for transaction_type='invoice_issued' — posts a Sales Invoice to ERPNext.
 *
 * Multi-currency: if the invoice currency differs from the user's reporting
 * currency, we set `conversion_rate` AND pass a per-currency `debit_to`
 * (a Debtors account in the invoice's currency). Without `debit_to`, ERPNext
 * rejects with "Party Account currency and document currency should be same".
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveOrCreateCustomer } = require('./customer');
const { ensureGenericSalesItem } = require('./item');
const { resolveErpAccount } = require('./account');
const { resolvePartyAccount } = require('./party-account');
const { ts } = require('../log');

async function save(user, erp, draft) {
  if (!draft.counterparty_name) {
    return { ok: false, error: 'invoice requires counterparty_name' };
  }

  const customerName = await resolveOrCreateCustomer(user, erp, draft.counterparty_name, {
    currency: draft.currency,
    phone: draft.counterparty_phone,
    email: draft.counterparty_email,
  });

  const itemCode = await ensureGenericSalesItem(erp);

  // Resolve income account from category_code (4000 → 4110 - Sales - TTC)
  const incomeAccount = await resolveErpAccount(
    user, erp, draft.category_code, user.reporting_currency
  );

  // Compute due_date from payment_terms if not set
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

  const invoicePayload = {
    customer: customerName,
    posting_date: postingDate,
    due_date: dueDate,
    currency: draft.currency,
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: draft.amount,
        description: draft.description || `${customerName} invoice`,
        ...(incomeAccount ? { income_account: incomeAccount } : {}),
      },
    ],
    docstatus: 1, // submit on create
  };

  // Multi-currency: needs conversion_rate AND a Receivable account in the
  // invoice's currency. The per-currency Debtors leaf is auto-created on
  // first use by resolvePartyAccount.
  if (draft.currency !== user.reporting_currency) {
    invoicePayload.conversion_rate = draft.exchange_rate || 1;
    invoicePayload.debit_to = await resolvePartyAccount(erp, 'Receivable', draft.currency);
  }

  const result = await erp.createSalesInvoice(invoicePayload);
  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved Sales Invoice to ERPNext: ${erpName} ` +
      `(${draft.amount} ${draft.currency} for ${customerName}, due ${dueDate})`
  );

  return { ok: true, erpnext_name: erpName, doctype: 'Sales Invoice' };
}

module.exports = { save };

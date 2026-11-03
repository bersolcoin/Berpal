/** WRITE side — bill_received → ERPNext Purchase Invoice (you owe). */
const counterparties = require('../counterparties');
const {
  ts, companyCurrency, txRate, resolveErpAccount, resolvePartyAccount, ensureGenericItem, computeDueDate,
} = require('./common');

async function savePurchaseInvoice(user, erp, draft) {
  const supplier = await counterparties.resolveParty(user, erp, draft, 'Supplier');
  const itemCode = await ensureGenericItem(erp, 'purchase');

  // Expense side from category_code (5000 COGS for inventory, 5xxx for operating bills)
  const expenseAccount = await resolveErpAccount(user, erp, draft.category_code, companyCurrency(user));
  const dueDate = computeDueDate(draft);

  const payload = {
    supplier,
    posting_date: draft.transaction_date,
    set_posting_time: 1,
    bill_date: draft.transaction_date,
    due_date: dueDate,
    currency: draft.currency,
    update_stock: 0,
    ...(draft.invoice_number ? { bill_no: draft.invoice_number } : {}),
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: draft.amount,
        description: draft.description || `${supplier} bill`,
        ...(expenseAccount ? { expense_account: expenseAccount } : {}),
      },
    ],
    docstatus: 1,
  };

  // Mirror of the Sales Invoice rule: a foreign-currency bill needs a Payable account
  // in that currency (credit_to) plus the conversion rate.
  if (draft.currency !== companyCurrency(user)) {
    payload.conversion_rate = txRate(user, draft);
    payload.credit_to = await resolvePartyAccount(erp, 'Payable', draft.currency);
  }

  const result = await erp.createPurchaseInvoice(payload);
  const name = result.data?.name;
  console.log(
    `• [erp-sync] [${ts()}] saved Purchase Invoice ${name} (${draft.amount} ${draft.currency} from ${supplier}, due ${dueDate})`
  );
  return { erpnext_name: name, doctype: 'Purchase Invoice' };
}

module.exports = { savePurchaseInvoice };

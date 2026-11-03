/** WRITE side — invoice_issued → ERPNext Sales Invoice (you are owed). */
const counterparties = require('../counterparties');
const {
  ts, companyCurrency, txRate, resolveErpAccount, resolvePartyAccount, ensureGenericItem, computeDueDate,
} = require('./common');

async function saveSalesInvoice(user, erp, draft) {
  const customer = await counterparties.resolveParty(user, erp, draft, 'Customer');
  const itemCode = await ensureGenericItem(erp, 'sale');

  // Resolve income account from category_code (4000 → 4110 - Sales - TTC)
  const incomeAccount = await resolveErpAccount(user, erp, draft.category_code, companyCurrency(user));
  const dueDate = computeDueDate(draft);

  const payload = {
    customer,
    posting_date: draft.transaction_date,
    set_posting_time: 1,
    due_date: dueDate,
    currency: draft.currency,
    ...(draft.invoice_number ? { po_no: draft.invoice_number } : {}),
    ...(draft.delivery_date ? { remarks: `Delivery: ${draft.delivery_date}` } : {}),
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: draft.amount,
        description: draft.description || `${customer} invoice`,
        ...(incomeAccount ? { income_account: incomeAccount } : {}),
      },
    ],
    docstatus: 1, // submit on create
  };

  // Multi-currency: if invoice currency != company currency, ERPNext needs
  //   (a) conversion_rate so it can compute base totals, AND
  //   (b) a Receivable account in the invoice's currency (debit_to).
  //       Without (b), ERPNext rejects with "Party Account currency and
  //       document currency should be same".
  if (draft.currency !== companyCurrency(user)) {
    payload.conversion_rate = txRate(user, draft);
    payload.debit_to = await resolvePartyAccount(erp, 'Receivable', draft.currency);
  }

  const result = await erp.createSalesInvoice(payload);
  const name = result.data?.name;
  console.log(
    `• [erp-sync] [${ts()}] saved Sales Invoice ${name} (${draft.amount} ${draft.currency} for ${customer}, due ${dueDate})`
  );
  return { erpnext_name: name, doctype: 'Sales Invoice' };
}

module.exports = { saveSalesInvoice };

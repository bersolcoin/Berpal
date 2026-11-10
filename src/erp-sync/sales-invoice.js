/** WRITE side — invoice_issued → ERPNext Sales Invoice (you are owed). */
const counterparties = require('../counterparties');
const {
  ts, companyCurrency, txRate, resolveErpAccount, resolvePartyAccount, computeDueDate,
} = require('./common');
const { buildTaxRows, computeTotals } = require('./taxes');
const { buildInvoiceLines } = require('./invoice-lines');

async function saveSalesInvoice(user, erp, draft) {
  const customer = await counterparties.resolveParty(user, erp, draft, 'Customer');

  // Resolve income account from category_code (4000 → 4110 - Sales - TTC)
  const incomeAccount = await resolveErpAccount(user, erp, draft.category_code, companyCurrency(user));
  const dueDate = computeDueDate(draft);
  const totals = computeTotals(draft, `${customer} invoice`);
  const lines = await buildInvoiceLines(user, erp, draft, 'sales', { lineAccount: incomeAccount, totals });
  const taxes = await buildTaxRows(user, erp, draft, 'sales', totals);

  const payload = {
    customer,
    posting_date: draft.transaction_date,
    set_posting_time: 1,
    due_date: dueDate,
    currency: draft.currency,
    ...(draft.invoice_number ? { po_no: draft.invoice_number } : {}),
    ...(draft.delivery_date ? { remarks: `Delivery: ${draft.delivery_date}` } : {}),
    items: lines.rows,
    // Stock lines deliver from the warehouse on submit (no separate Delivery Note) so the Bin
    // and COGS move with the invoice.
    ...(lines.updateStock ? { update_stock: 1, set_warehouse: lines.warehouse } : {}),
    ...(taxes.length ? { taxes } : {}),
    // Always: VAT/WHT produce satang amounts, and ERPNext's default rounded total would round the
    // outstanding to whole baht (diff to Round Off) so it no longer matches the card.
    disable_rounded_total: 1,
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
  const t = totals;
  console.log(
    `• [erp-sync] [${ts()}] saved Sales Invoice ${name} (${t.gross} ${draft.currency} for ${customer}` +
      `${t.vat ? `, VAT ${t.vat}` : ''}${lines.updateStock ? ', stock out' : ''}, due ${dueDate})`
  );
  return { erpnext_name: name, doctype: 'Sales Invoice' };
}

module.exports = { saveSalesInvoice };

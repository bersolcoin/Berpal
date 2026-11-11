/** WRITE side — bill_received → ERPNext Purchase Invoice (you owe). */
const counterparties = require('../counterparties');
const {
  ts, companyCurrency, txRate, resolveErpAccount, resolvePartyAccount, computeDueDate,
} = require('./common');
const { buildTaxRows, computeTotals } = require('./taxes');
const { buildInvoiceLines } = require('./invoice-lines');

async function savePurchaseInvoice(user, erp, draft, opts = {}) {
  const supplier = await counterparties.resolveParty(user, erp, draft, 'Supplier');

  // Expense side from category_code (5000 COGS for inventory, 5xxx for operating bills).
  // Stock lines ignore it: ERPNext debits the warehouse's stock account instead.
  const expenseAccount = await resolveErpAccount(user, erp, draft.category_code, companyCurrency(user));
  const dueDate = computeDueDate(draft);
  const totals = computeTotals(draft, `${supplier} bill`);
  const lines = await buildInvoiceLines(user, erp, draft, 'purchase', { lineAccount: expenseAccount, totals, lots: opts.lots });
  // VAT (Input VAT) and WHT (deducted to WHT Payable). The WHT row lowers grand_total, so the
  // bill's outstanding — what the supplier is actually paid — is gross − WHT.
  const taxes = await buildTaxRows(user, erp, draft, 'purchase', totals);

  const payload = {
    supplier,
    posting_date: draft.transaction_date,
    set_posting_time: 1,
    bill_date: draft.transaction_date,
    due_date: dueDate,
    currency: draft.currency,
    // Stock lines receive into the warehouse on submit (no separate Purchase Receipt).
    update_stock: lines.updateStock,
    ...(lines.warehouse ? { set_warehouse: lines.warehouse } : {}),
    ...(draft.invoice_number ? { bill_no: draft.invoice_number } : {}),
    ...(opts.remark ? { remarks: opts.remark } : {}),
    items: lines.rows,
    ...(taxes.length ? { taxes } : {}),
    // Always: VAT/WHT produce satang amounts, and ERPNext's default rounded total would round the
    // outstanding to whole baht (diff to Round Off) so it no longer matches the card.
    disable_rounded_total: 1,
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
  const t = totals;
  console.log(
    `• [erp-sync] [${ts()}] saved Purchase Invoice ${name} (${t.gross} ${draft.currency} from ${supplier}` +
      `${t.vat ? `, VAT ${t.vat}` : ''}${t.wht ? `, WHT ${t.wht}` : ''}${lines.updateStock ? ', stock in' : ''}, due ${dueDate})`
  );
  return { erpnext_name: name, doctype: 'Purchase Invoice' };
}

module.exports = { savePurchaseInvoice };

/**
 * WRITE side entry point: route a confirmed draft to the right ERPNext doctype handler.
 * Returns { erpnext_name, doctype }.
 */
const { saveSalesInvoice } = require('./sales-invoice');
const { savePurchaseInvoice } = require('./purchase-invoice');
const { savePayment } = require('./payment-entry');
const { saveCash, saveTransfer, saveAdvance } = require('./journal-entry');

async function saveDraft(user, erp, draft) {
  const tt = draft.transaction_type || 'cash';
  if (draft.direction === 'transfer') return saveTransfer(user, erp, draft);
  switch (tt) {
    case 'invoice_issued':
      return saveSalesInvoice(user, erp, draft);
    case 'bill_received':
      return savePurchaseInvoice(user, erp, draft);
    case 'payment':
      return savePayment(user, erp, draft);
    case 'advance_given':
    case 'advance_received':
      return saveAdvance(user, erp, draft);
    case 'cash':
      return saveCash(user, erp, draft);
    default:
      throw new Error(`unsupported transaction_type ${tt}`);
  }
}

module.exports = { saveDraft };

/**
 * WRITE side entry point: route a confirmed draft to the right ERPNext doctype handler.
 * Returns { erpnext_name, doctype }.
 *
 * `opts` is for the gem lot runner (src/lots/execute.js) only; without it nothing changes:
 *   remark   put on the document so an interrupted lot operation can find it again
 *            (invoices and payments: `remarks`; journal entries: `user_remark`)
 *   lots     [{ line, item, batch, warehouse, carats }]: draft.items[line] is a lot. Its invoice
 *            row moves `carats` of that batch in that warehouse instead of a generic qty 1.
 *            Only a bill_received / invoice_issued draft may carry them.
 */
const { saveSalesInvoice } = require('./sales-invoice');
const { savePurchaseInvoice } = require('./purchase-invoice');
const { savePayment } = require('./payment-entry');
const { saveCash, saveTransfer, saveAdvance } = require('./journal-entry');
const taxes = require('./taxes');
const items = require('./items');

async function saveDraft(user, erp, draft, opts = {}) {
  try {
    return await route(user, erp, draft, opts);
  } catch (err) {
    // A memoised tax account / warehouse may have been renamed or deleted in ERPNext since we
    // cached it; drop the memos so the retry resolves them afresh.
    taxes.clearCaches(erp.company);
    items.clearCaches(erp.company);
    throw err;
  }
}

async function route(user, erp, draft, opts) {
  if (opts.lots && opts.lots.length && !['invoice_issued', 'bill_received'].includes(draft.transaction_type)) {
    throw new Error('lot lines post as a Purchase Invoice or a Sales Invoice only');
  }
  const tt = draft.transaction_type || 'cash';
  if (draft.direction === 'transfer') return saveTransfer(user, erp, draft, opts);
  switch (tt) {
    case 'invoice_issued':
      return saveSalesInvoice(user, erp, draft, opts);
    case 'bill_received':
      return savePurchaseInvoice(user, erp, draft, opts);
    case 'payment':
      return savePayment(user, erp, draft, opts);
    case 'advance_given':
    case 'advance_received':
      return saveAdvance(user, erp, draft, opts);
    case 'cash':
      return saveCash(user, erp, draft, opts);
    default:
      throw new Error(`unsupported transaction_type ${tt}`);
  }
}

module.exports = { saveDraft };

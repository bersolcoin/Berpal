/**
 * Dispatcher: route a confirmed draft to the right ERPNext doctype handler.
 *
 * Each handler in this directory exports an async `save(user, erp, draft)`
 * returning either:
 *   { ok: true, erpnext_name, doctype }     — success, doc posted in ERPNext
 *   { ok: false, error }                    — validation or upstream failure
 *
 * The dispatcher constructs the per-user ERPNext client and picks the
 * handler based on draft.transaction_type. Adding a new doctype is a
 * three-line change: import + add a case below.
 */

const erpnext = require('../erpnext');
const salesInvoice = require('./sales-invoice');
const journalEntry = require('./journal-entry');
const paymentEntry = require('./payment-entry');

async function save(user, draft) {
  const erp = erpnext.forUser(user);
  const tt = draft.transaction_type || 'cash';

  switch (tt) {
    case 'invoice_issued':
      return salesInvoice.save(user, erp, draft);

    case 'payment':
      return paymentEntry.save(user, erp, draft);

    case 'cash':
    default:
      // Cash income/expense → Journal Entry. Default fallback so unknown
      // transaction_types don't silently break — they hit the JE path,
      // which has its own validation (will return ok:false if missing fields).
      return journalEntry.save(user, erp, draft);
  }
}

module.exports = { save };

/**
 * Read-side facade: queries that read from ERPNext.
 * Each query module here is a small, focused unit that the bot can call
 * to answer a specific question. As more queries get wired, add them to
 * this index so callers have one entry point.
 */

const openInvoices = require('./open-invoices');

module.exports = {
  listOpenInvoices: openInvoices.listOpenInvoices,
};

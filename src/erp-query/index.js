/**
 * Read-side facade: queries that read from ERPNext.
 * Each query module here is a small, focused unit that the bot can call
 * to answer a specific question. As more queries get wired, add them to
 * this index so callers have one entry point.
 */

const openInvoices = require('./open-invoices');
const balanceWithCounterparty = require('./balance-with-counterparty');
const cashBankBalance = require('./cash-bank-balance');
const counterpartyDetails = require('./counterparty-details');
const recentTransactions = require('./recent-transactions');
const accountLedger = require('./account-ledger');
const { resolveAccountParam } = accountLedger;
const customerList = require('./customer-list');
const supplierList = require('./supplier-list');
const accountsList = require('./accounts-list');
const expenseSummary = require('./expense-summary');
const itemsList = require('./items-list');
const itemDetail = require('./item-detail');
const pendingLinks = require('./pending-links');
const contactsList = require('./contacts-list');

module.exports = {
  listOpenInvoices: openInvoices.listOpenInvoices,
  getBalanceWithCounterparty: balanceWithCounterparty.getBalanceWithCounterparty,
  getCashBankBalance: cashBankBalance.getCashBankBalance,
  getCounterpartyDetails: counterpartyDetails.getCounterpartyDetails,
  listRecentTransactions: recentTransactions.listRecentTransactions,
  countRecentTransactions: recentTransactions.countRecentTransactions,
  getAccountLedger: accountLedger.getAccountLedger,
  resolveAccountParam,
  listCustomersWithAR: customerList.listCustomersWithAR,
  listSuppliersWithAP: supplierList.listSuppliersWithAP,
  listAccounts: accountsList.listAccounts,
  getExpenseSummary: expenseSummary.getExpenseSummary,
  listItems: itemsList.listItems,
  countItems: itemsList.countItems,
  getItemDetail: itemDetail.getItemDetail,
  listPendingLinks: pendingLinks.listPendingLinks,
  countPendingLinks: pendingLinks.countPendingLinks,
  listContacts: contactsList.listContacts,
};

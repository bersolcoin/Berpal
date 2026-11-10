/** READ side — current balance of every wallet, live from ERPNext. */
const wallets = require('../wallets');
const { round2 } = require('../erp-sync/common');

async function getCashBankBalance(user, erp, { currency = null, wallet_id = null } = {}) {
  let list = await wallets.list(user, erp, { currency });
  if (wallet_id) list = list.filter((w) => w.id === wallet_id);
  if (list.length === 0) return { ok: true, message: 'no_accounts', accounts: [] };

  const accounts = [];
  const totals = {};
  for (const w of list) {
    const r = await erp.getAccountBalance(w.erpnext_account);
    // get_balance_on returns Dr − Cr in the account's own currency. For a credit card
    // (liability) a negative balance means money owed on the card.
    const balance = round2(Number(r.message) || 0);
    accounts.push({ id: w.id, name: w.name, type: w.type, currency: w.currency, balance });
    totals[w.currency] = round2((totals[w.currency] || 0) + balance);
  }
  return { ok: true, accounts, totals_by_currency: totals };
}

module.exports = { getCashBankBalance };

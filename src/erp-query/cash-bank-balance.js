/**
 * Current cash + bank + credit-card position across all of the user's wallets.
 * Per-account balance pulled from ERPNext via erpnext.accounts.utils.get_balance_on
 * (the same call ERPNext's own dashboards use).
 *
 * Returns:
 *   {
 *     wallets: [
 *       { erpnext_name, account_name, account_type, currency, balance }, ...
 *     ],
 *     totals_by_currency: { USD: 53000, THB: 124500 },
 *     as_of: 'YYYY-MM-DD'
 *   }
 *
 * "Wallet" here means any account with account_type IN ('Cash', 'Bank', 'Credit Card').
 * Credit card balances come back as negative (a liability — you owe) which the
 * LLM can render appropriately.
 */

async function getCashBankBalance(user, erp, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);

  // List wallet leaves
  const wallets = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', 'in', ['Cash', 'Bank', 'Credit Card']],
      ['is_group', '=', 0],
    ],
    fields: ['name', 'account_name', 'account_number', 'account_type', 'account_currency'],
    limit: 100,
  });

  const rows = [];
  const totalsByCurrency = {};

  for (const w of wallets.data || []) {
    // Get balance on this account as of `date`. ERPNext returns the balance
    // in the account's currency by default.
    let balance = 0;
    try {
      const r = await erp.callMethod('erpnext.accounts.utils.get_balance_on', {
        account: w.name,
        date,
        company: erp.company,
      });
      balance = Number(r.message) || 0;
    } catch (err) {
      // If a single account fails, log and continue rather than aborting the whole query.
      console.warn(`[cash-bank-balance] get_balance_on failed for ${w.name}: ${err.message}`);
    }

    // For Credit Card (liability), ERPNext stores the credit as positive on
    // the liability side. We invert sign so positive=you have it,
    // negative=you owe it across the board.
    const signed = w.account_type === 'Credit Card' ? -balance : balance;

    rows.push({
      erpnext_name: w.name,
      account_name: w.account_name,
      account_number: w.account_number,
      account_type: w.account_type,
      currency: w.account_currency,
      balance: signed,
    });

    const ccy = w.account_currency || 'UNKNOWN';
    totalsByCurrency[ccy] = (totalsByCurrency[ccy] || 0) + signed;
  }

  return {
    wallets: rows,
    totals_by_currency: totalsByCurrency,
    as_of: date,
  };
}

module.exports = { getCashBankBalance };

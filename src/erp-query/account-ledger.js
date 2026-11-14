/**
 * General Ledger entries for a specific Account, newest first, with running
 * balance from the present-day end (since we sorted desc, the running balance
 * is computed forward from the oldest row in the slice).
 *
 *   {
 *     account:        ERPNext account name
 *     account_name:   friendly label
 *     account_type:   'Cash' | 'Bank' | 'Receivable' | 'Payable' | ...
 *     currency:       account currency
 *     opening_balance: balance BEFORE the first row in `entries`
 *     closing_balance: balance as of today (or the most recent row)
 *     entries: [
 *       {
 *         erpnext_name, posting_date, against,
 *         voucher_type, voucher_no, debit, credit,
 *         remarks, balance
 *       }, ...
 *     ]
 *   }
 *
 * Uses ERPNext's GL Entry doctype directly. Cancelled entries (is_cancelled=1)
 * are skipped — they appear in the raw GL but not in user-visible reports.
 */

/**
 * Resolve a URL param (either a numeric account_number or a full ERPNext
 * Account name) back to the canonical ERPNext name. Returns null if no
 * account matches in this company.
 */
async function resolveAccountParam(erp, param) {
  if (!param) return null;
  // Numeric → look up by account_number within the user's Company.
  if (/^\d+$/.test(param)) {
    const r = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_number', '=', param],
      ],
      fields: ['name'],
      limit: 1,
    });
    return r.data?.[0]?.name || null;
  }
  // Otherwise treat as the literal ERPNext name (URL-decoded by the router).
  return param;
}

async function getAccountLedger(user, erp, { accountName, limit = 100 } = {}) {
  if (!accountName) throw new Error('accountName is required');

  const acct = await erp.getResource('Account', accountName);
  const account = acct.data;

  // Pull the latest N entries first (newest first), then re-sort ascending
  // for the running-balance walk. We also fetch the balance as-of NOW so we
  // can derive opening from closing - sum(deltas).
  const r = await erp.listResource('GL Entry', {
    filters: [
      ['company', '=', erp.company],
      ['account', '=', accountName],
      ['is_cancelled', '=', 0],
    ],
    fields: [
      'name', 'posting_date', 'against', 'voucher_type', 'voucher_no',
      'debit', 'credit', 'remarks',
    ],
    limit,
    orderBy: 'posting_date desc, creation desc',
  });

  const raw = r.data || [];

  let closing = 0;
  try {
    closing = await erp.getAccountBalance(accountName);
  } catch (err) {
    console.warn(`[account-ledger] balance lookup failed: ${err.message}`);
  }

  // Walk from newest → oldest, subtracting net (debit - credit) at each step
  // to derive the balance as it stood AFTER each entry posted. Asset/Expense
  // accounts are debit-positive; Liability/Equity/Income are credit-positive.
  // The sign convention here matches ERPNext's general ledger view (debits
  // increase, credits decrease, regardless of natural side — we annotate the
  // type so the UI can color-code.)
  let runningBalance = closing;
  const withBalance = raw.map((e) => {
    const debit = Number(e.debit) || 0;
    const credit = Number(e.credit) || 0;
    const balanceAfterThisEntry = runningBalance;
    runningBalance = runningBalance - (debit - credit);
    return {
      erpnext_name: e.name,
      posting_date: e.posting_date,
      against: e.against,
      voucher_type: e.voucher_type,
      voucher_no: e.voucher_no,
      debit,
      credit,
      remarks: e.remarks,
      balance: balanceAfterThisEntry,
    };
  });

  return {
    account: account.name,
    account_name: account.account_name,
    account_type: account.account_type || account.root_type,
    root_type: account.root_type,
    currency: account.account_currency,
    is_group: !!account.is_group,
    parent_account: account.parent_account,
    opening_balance: runningBalance,
    closing_balance: closing,
    entries: withBalance,
  };
}

module.exports = { getAccountLedger, resolveAccountParam };

/**
 * Pure display/formatting helpers for ERPNext account names and Journal Entry titles.
 * No external dependencies — safe to use anywhere.
 */

/**
 * Strip the "<code> - " prefix and " - <abbr>" suffix from an ERPNext account
 * name, leaving just the human-readable middle.
 *   "1000 - Cash - TTC"                      → "Cash"
 *   "5223 - Miscellaneous Expenses - TTC"    → "Miscellaneous Expenses"
 *   "BBL Savings - TTC"                      → "BBL Savings"      (no code prefix)
 *   "Cash"                                   → "Cash"             (already friendly)
 */
function friendlyAccountName(erpAccountName) {
  if (!erpAccountName) return '';
  return String(erpAccountName)
    .replace(/^\d+\s*-\s*/, '')             // drop leading "1000 - "
    .replace(/\s*-\s*[A-Z]{2,8}$/, '')      // drop trailing " - TTC"
    .trim();
}

/**
 * Build the `title` field for an ERPNext Journal Entry (or any from→to ledger move).
 * Without this, ERPNext defaults the title to the first account name
 * (e.g. "5223 - Miscellaneous Expenses - TTC") — unhelpful in list views.
 *
 * Format: "<From>(<CUR>) to <To>(<CUR>)" — money flows source → destination.
 * Per-side currency is shown so multi-currency moves are unambiguous, e.g.
 * "Jameel Crest Gems(USD) to Cash(THB)" when a USD invoice is settled in THB cash.
 *
 *   Expense:   from = cash/bank/card wallet, to = expense category
 *   Income:    from = revenue category,      to = cash/bank/card wallet
 *   Transfer:  from = source wallet,         to = destination wallet
 *   Payment:   from = AR/AP party,           to = cash/bank/card wallet (or reverse)
 *
 * `currency` is the convenience arg when both sides match. Pass `fromCurrency`
 * and/or `toCurrency` to override per side.
 */
function buildJournalTitle({ currency, fromCurrency, toCurrency, fromAccount, toAccount }) {
  const from = friendlyAccountName(fromAccount) || 'Unknown';
  const to = friendlyAccountName(toAccount) || 'Unknown';
  const fc = fromCurrency || currency;
  const tc = toCurrency || currency;
  const fcTag = fc ? `(${fc})` : '';
  const tcTag = tc ? `(${tc})` : '';
  return `${from}${fcTag} to ${to}${tcTag}`.slice(0, 140);
}

module.exports = { friendlyAccountName, buildJournalTitle };

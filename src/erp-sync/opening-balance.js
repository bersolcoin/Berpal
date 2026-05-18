/**
 * Record an opening balance for a wallet via a JE in ERPNext.
 *
 *   DR wallet            (asset increase)
 *   CR Opening Balance Equity   (existing capital captured)
 *
 * The "Opening Balance Equity" account is part of ERPNext's standard chart
 * (auto-created during Company setup, usually account_type='Equity', named
 * like "Opening Balance Equity"). We look it up dynamically — name and
 * exact prefix can vary by template.
 *
 * For wallets in a non-company currency (e.g. USD bank when base is THB),
 * the equity leg is credited in the company currency, so we also fetch an
 * FX rate to compute the equivalent. exchangeRate can be passed in
 * explicitly or omitted — when omitted and currencies differ, the caller
 * must have fetched the rate already and passed it.
 */

const { ts } = require('../log');

async function findOpeningBalanceEquity(erp) {
  // Try a few patterns: exact name → contains "Opening Balance" → any Equity leaf.
  const tries = [
    [['account_name', '=', 'Opening Balance Equity']],
    [['account_name', 'like', '%Opening Balance%']],
    [['account_type', '=', 'Equity']],
  ];
  for (const extra of tries) {
    const r = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['is_group', '=', 0],
        ...extra,
      ],
      fields: ['name'],
      limit: 1,
    });
    if (r.data && r.data.length > 0) return r.data[0].name;
  }
  return null;
}

async function recordOpeningBalance(
  user,
  erp,
  { walletErpName, walletCurrency, amount, asOfDate = null, exchangeRate = null }
) {
  if (!walletErpName) throw new Error('walletErpName required');
  if (!walletCurrency) throw new Error('walletCurrency required');
  if (!amount || amount <= 0) throw new Error('opening balance amount must be > 0');

  const equityAccount = await findOpeningBalanceEquity(erp);
  if (!equityAccount) {
    throw new Error(
      `could not locate an Opening Balance Equity account in ${erp.company}. Add one to the chart under Equity (or rename an existing one).`
    );
  }

  const postingDate = asOfDate || new Date().toISOString().slice(0, 10);
  const baseCurrency = user.reporting_currency || 'THB';
  const isMultiCurrency = walletCurrency !== baseCurrency;

  if (isMultiCurrency && !exchangeRate) {
    throw new Error(
      `opening balance in ${walletCurrency} needs an exchange rate to ${baseCurrency}. Caller must fetch it via fetch_exchange_rate and pass it as exchangeRate.`
    );
  }
  const rate = isMultiCurrency ? Number(exchangeRate) : 1;
  const equityCredit = amount * rate;

  const accounts = [
    {
      account: walletErpName,
      debit_in_account_currency: amount,
      ...(isMultiCurrency ? { exchange_rate: rate } : {}),
    },
    {
      account: equityAccount,
      credit_in_account_currency: equityCredit,
      ...(isMultiCurrency ? { exchange_rate: 1 } : {}),
    },
  ];

  const payload = {
    voucher_type: 'Opening Entry',
    posting_date: postingDate,
    title: `Opening Balance — ${walletErpName}`,
    user_remark: `Opening balance ${amount} ${walletCurrency}`,
    accounts,
    docstatus: 1,
    ...(isMultiCurrency ? { multi_currency: 1 } : {}),
  };

  const result = await erp.createJournalEntry(payload);
  const jeName = result.data?.name;
  console.log(
    `• [conversation] [${ts()}] posted Opening Balance JE: ${jeName} for ${walletErpName} ` +
      `(${amount} ${walletCurrency}${isMultiCurrency ? ` @ ${rate} → ${equityCredit} ${baseCurrency}` : ''})`
  );
  return jeName;
}

module.exports = { recordOpeningBalance, findOpeningBalanceEquity };

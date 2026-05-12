/**
 * Handler for transaction_type='cash' (income/expense) — posts a Journal Entry to ERPNext.
 *
 * Expense: DR category, CR wallet  (money leaves wallet, expense recorded)
 * Income:  DR wallet,   CR category  (money lands in wallet, revenue recognized)
 *
 * The JE `title` is built via `buildJournalTitle` for readable list-view labels.
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveErpAccount } = require('./account');
const { buildJournalTitle } = require('./naming');
const { ts } = require('../log');

async function save(user, erp, draft) {
  // Resolve cash-side account (defaults to '1000' Cash)
  const cashCode = draft.payment_account_code || '1000';
  const cashAccount = await resolveErpAccount(user, erp, cashCode, draft.currency);

  const categoryAccount = await resolveErpAccount(
    user, erp, draft.category_code, draft.currency
  );

  if (!cashAccount || !categoryAccount) {
    return {
      ok: false,
      error: `Could not find ERPNext accounts (cash=${cashCode}→${cashAccount}, category=${draft.category_code}→${categoryAccount})`,
    };
  }

  const entries =
    draft.direction === 'expense'
      ? [
          { account: categoryAccount, debit_in_account_currency: draft.amount },
          { account: cashAccount, credit_in_account_currency: draft.amount },
        ]
      : [
          { account: cashAccount, debit_in_account_currency: draft.amount },
          { account: categoryAccount, credit_in_account_currency: draft.amount },
        ];

  // For the title, follow the money: expense flows cash→category;
  // income flows category→cash. (Transfers, when wired, pass source→dest directly.)
  const fromAccount = draft.direction === 'expense' ? cashAccount : categoryAccount;
  const toAccount   = draft.direction === 'expense' ? categoryAccount : cashAccount;

  const result = await erp.createJournalEntry({
    voucher_type: 'Journal Entry',
    posting_date: draft.transaction_date,
    title: buildJournalTitle({
      currency: draft.currency,
      fromAccount,
      toAccount,
    }),
    user_remark: draft.description || 'Bot entry',
    accounts: entries,
    docstatus: 1,
  });

  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved JE to ERPNext: ${erpName} ` +
      `(${draft.direction} ${draft.amount} ${draft.currency})`
  );

  return { ok: true, erpnext_name: erpName, doctype: 'Journal Entry' };
}

module.exports = { save };

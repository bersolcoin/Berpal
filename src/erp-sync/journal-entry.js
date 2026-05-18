/**
 * Handler for transaction_type='cash' — posts a Journal Entry to ERPNext.
 *
 * Three sub-shapes by direction:
 *   expense:  DR category,  CR wallet     (money leaves wallet, expense booked)
 *   income:   DR wallet,    CR category   (money lands, revenue recognized)
 *   transfer: DR dst wallet, CR src wallet (own-money move between wallets)
 *
 * Transfers stay in the same currency for v1; cross-currency wallet swaps
 * are a separate "FX trade" concept and don't fit cleanly under a single
 * conversion rate.
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveErpAccount } = require('./account');
const { resolveWalletAccount } = require('./wallet');
const { buildJournalTitle } = require('./naming');
const { ts } = require('../log');

async function save(user, erp, draft) {
  if (draft.direction === 'transfer') {
    return saveTransfer(user, erp, draft);
  }

  // ── Income / expense path ────────────────────────────────────────
  // Cash side uses resolveWalletAccount — the canonical multi-currency-
  // aware wallet lookup that creates a per-currency leaf on demand.
  // (account.js previously handled this but its fuzzy match could
  // return e.g. the THB Cash account for a USD txn, which corrupts
  // the JE.)
  const cashCode = draft.payment_account_code || '1000';
  let cashAccount;
  try {
    cashAccount = await resolveWalletAccount(
      erp, cashCode, draft.currency, draft.wallet_name || null, user
    );
  } catch (err) {
    return { ok: false, error: `Wallet lookup failed: ${err.message}` };
  }

  // Category side is a non-wallet chart account — use the category resolver.
  const categoryAccount = await resolveErpAccount(
    user, erp, draft.category_code, draft.currency
  );

  if (!cashAccount || !categoryAccount) {
    return {
      ok: false,
      error: `Could not find ERPNext accounts (cash=${cashCode}→${cashAccount}, category=${draft.category_code}→${categoryAccount})`,
    };
  }

  // Multi-currency JE: if txn currency differs from the company's
  // reporting currency, the wallet leg is in txn currency and the
  // category leg is in company currency. ERPNext requires:
  //   - multi_currency = 1 on the doc
  //   - per-row exchange_rate (rate from row's account currency → company)
  //   - amounts stated in each row's own account currency
  const companyCcy = user.reporting_currency || 'THB';
  const isMulti = draft.currency !== companyCcy;
  const rate = isMulti ? (draft.exchange_rate || 1) : 1;
  const amtTxn = Number(draft.amount);
  const amtCompany = isMulti ? amtTxn * rate : amtTxn;

  const cashRow = (debitOrCredit) => ({
    account: cashAccount,
    exchange_rate: rate,
    [debitOrCredit + '_in_account_currency']: amtTxn,
  });
  const categoryRow = (debitOrCredit) => ({
    account: categoryAccount,
    exchange_rate: 1,
    [debitOrCredit + '_in_account_currency']: amtCompany,
  });

  const entries =
    draft.direction === 'expense'
      ? [categoryRow('debit'), cashRow('credit')]
      : [cashRow('debit'), categoryRow('credit')];

  // For the title, follow the money: expense flows cash→category;
  // income flows category→cash.
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
    ...(isMulti ? { multi_currency: 1 } : {}),
    docstatus: 1,
  });

  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved JE to ERPNext: ${erpName} ` +
      `(${draft.direction} ${draft.amount} ${draft.currency})`
  );

  return { ok: true, erpnext_name: erpName, doctype: 'Journal Entry' };
}

/**
 * Wallet-to-wallet transfer (single user's own books).
 * Source: payment_account_code + wallet_name
 * Destination: transfer_destination_account_code + transfer_destination_wallet_name
 *
 * Both must be in the same currency. Cross-currency transfers are an FX
 * trade (different conceptual model) and out of scope here.
 */
async function saveTransfer(user, erp, draft) {
  if (!draft.amount || draft.amount <= 0) {
    return { ok: false, error: 'transfer requires amount > 0' };
  }
  if (!draft.currency) {
    return { ok: false, error: 'transfer requires currency' };
  }

  const srcCode = draft.payment_account_code || '1000';
  const dstCode = draft.transfer_destination_account_code;
  if (!dstCode) {
    return {
      ok: false,
      error: "transfer requires transfer_destination_account_code (the destination wallet type — '1000' cash / '1100' bank / '2100' credit card)",
    };
  }

  // Bank + Card destinations need a name to disambiguate (which bank?).
  if ((dstCode === '1100' || dstCode === '2100') && !draft.transfer_destination_wallet_name) {
    return {
      ok: false,
      error: `transfer to ${dstCode === '1100' ? 'bank' : 'credit card'} needs transfer_destination_wallet_name (e.g. "BBL Savings")`,
    };
  }
  if ((srcCode === '1100' || srcCode === '2100') && !draft.wallet_name) {
    return {
      ok: false,
      error: `transfer FROM ${srcCode === '1100' ? 'bank' : 'credit card'} needs wallet_name (the source wallet, e.g. "BBL Savings")`,
    };
  }

  let srcAccount, dstAccount;
  try {
    srcAccount = await resolveWalletAccount(erp, srcCode, draft.currency, draft.wallet_name || null, user);
    dstAccount = await resolveWalletAccount(erp, dstCode, draft.currency, draft.transfer_destination_wallet_name || null, user);
  } catch (err) {
    return { ok: false, error: `wallet resolution failed: ${err.message}` };
  }

  if (srcAccount === dstAccount) {
    return { ok: false, error: 'source and destination are the same wallet — nothing to transfer' };
  }

  // DR destination (money lands here), CR source (money leaves here).
  const entries = [
    { account: dstAccount, debit_in_account_currency: draft.amount },
    { account: srcAccount, credit_in_account_currency: draft.amount },
  ];

  const result = await erp.createJournalEntry({
    voucher_type: 'Bank Entry',     // ERPNext-standard voucher_type for wallet moves
    posting_date: draft.transaction_date,
    title: buildJournalTitle({
      currency: draft.currency,
      fromAccount: srcAccount,
      toAccount: dstAccount,
    }),
    user_remark: draft.description || `Transfer ${draft.amount} ${draft.currency}`,
    accounts: entries,
    docstatus: 1,
  });

  const erpName = result.data?.name;
  console.log(
    `• [conversation] [${ts()}] saved Transfer JE to ERPNext: ${erpName} ` +
      `(${draft.amount} ${draft.currency} ${srcAccount} → ${dstAccount})`
  );

  return { ok: true, erpnext_name: erpName, doctype: 'Journal Entry' };
}

module.exports = { save };

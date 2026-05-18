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
    srcAccount = await resolveWalletAccount(erp, srcCode, draft.currency, draft.wallet_name || null);
    dstAccount = await resolveWalletAccount(erp, dstCode, draft.currency, draft.transfer_destination_wallet_name || null);
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

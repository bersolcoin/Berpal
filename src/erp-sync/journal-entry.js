/**
 * WRITE side — ERPNext Journal Entry for everything that isn't an invoice/bill/settlement:
 *   cash income / expense (incl. opening balances + reconciliation adjustments, category 3200)
 *   wallet-to-wallet transfers
 *   advances given / received (open party balance, no goods exchanged)
 */
const wallets = require('../wallets');
const counterparties = require('../counterparties');
const {
  ts, round2, companyCurrency, txRate, resolveErpAccount, resolvePartyAccount,
  getAccountCurrency, buildJournalTitle,
} = require('./common');

/**
 * Turn [{ account, debit|credit (in tx currency), party_type?, party? }] into ERPNext JE rows.
 *
 * Each account is posted in its own currency: accounts held in the tx currency get the
 * tx amount at the tx rate; accounts held in the company currency get the converted amount
 * at rate 1. The company-currency debit/credit is computed once per line so the entry
 * always balances. Any third currency is rejected rather than guessed.
 */
async function buildRows(erp, lines, { currency, rate, baseCurrency }) {
  let multiCurrency = false;
  const rows = [];
  for (const line of lines) {
    const isDebit = line.debit != null;
    const amount = isDebit ? line.debit : line.credit;
    const base = round2(amount * rate);
    const accCur = (await getAccountCurrency(erp, line.account)) || baseCurrency;

    let inAccount, exchangeRate;
    if (accCur === currency) {
      inAccount = round2(amount);
      exchangeRate = rate;
    } else if (accCur === baseCurrency) {
      inAccount = base;
      exchangeRate = 1;
    } else {
      throw new Error(`account "${line.account}" is held in ${accCur}; can't post a ${currency} amount to it`);
    }
    if (accCur !== baseCurrency) multiCurrency = true;

    rows.push({
      account: line.account,
      account_currency: accCur,
      exchange_rate: exchangeRate,
      ...(isDebit
        ? { debit_in_account_currency: inAccount, debit: base }
        : { credit_in_account_currency: inAccount, credit: base }),
      ...(line.party ? { party_type: line.party_type, party: line.party } : {}),
    });
  }
  return { rows, multiCurrency };
}

async function postJournal(user, erp, draft, { lines, fromAccount, toAccount, remark }) {
  const baseCurrency = companyCurrency(user);
  const { rows, multiCurrency } = await buildRows(erp, lines, {
    currency: draft.currency,
    rate: txRate(user, draft),
    baseCurrency,
  });
  const result = await erp.createJournalEntry({
    voucher_type: 'Journal Entry',
    posting_date: draft.transaction_date,
    title: buildJournalTitle({ currency: draft.currency, fromAccount, toAccount }),
    user_remark: draft.description || remark,
    ...(draft.invoice_number ? { cheque_no: draft.invoice_number, cheque_date: draft.transaction_date } : {}),
    multi_currency: multiCurrency ? 1 : 0,
    accounts: rows,
    docstatus: 1,
  });
  return result.data?.name;
}

/** Cash income / expense against a P&L (or equity, for opening balances) category. */
async function saveCash(user, erp, draft) {
  const walletAccount = await wallets.accountForDraft(user, erp, draft);
  const categoryAccount = await resolveErpAccount(user, erp, draft.category_code, companyCurrency(user));
  if (!categoryAccount) {
    throw new Error(`no ERPNext account mapped for category ${draft.category_code}`);
  }

  const expense = draft.direction === 'expense';
  const lines = expense
    ? [{ account: categoryAccount, debit: draft.amount }, { account: walletAccount, credit: draft.amount }]
    : [{ account: walletAccount, debit: draft.amount }, { account: categoryAccount, credit: draft.amount }];

  const name = await postJournal(user, erp, draft, {
    lines,
    fromAccount: expense ? walletAccount : categoryAccount,
    toAccount: expense ? categoryAccount : walletAccount,
    remark: 'Bot entry',
  });
  console.log(`• [erp-sync] [${ts()}] saved JE ${name} (${draft.direction} ${draft.amount} ${draft.currency})`);
  return { erpnext_name: name, doctype: 'Journal Entry' };
}

/** Wallet → wallet. Not a P&L event. */
async function saveTransfer(user, erp, draft) {
  if (!draft.payment_account_id || !draft.transfer_destination_account_id) {
    throw new Error('transfer needs both payment_account_id (source) and transfer_destination_account_id');
  }
  if (draft.payment_account_id === draft.transfer_destination_account_id) {
    throw new Error('transfer source and destination are the same wallet');
  }
  const source = await wallets.accountForDraft(user, erp, draft);
  const dest = await wallets.accountForDraft(user, erp, draft, { field: 'transfer_destination_account_id' });

  const name = await postJournal(user, erp, draft, {
    lines: [{ account: dest, debit: draft.amount }, { account: source, credit: draft.amount }],
    fromAccount: source,
    toAccount: dest,
    remark: 'Transfer',
  });
  console.log(`• [erp-sync] [${ts()}] saved transfer JE ${name} (${draft.amount} ${draft.currency})`);
  return { erpnext_name: name, doctype: 'Journal Entry' };
}

/**
 * advance_given:    Dr Receivable (party = Customer)  / Cr wallet   — they now owe you
 * advance_received: Dr wallet / Cr Payable (party = Supplier)       — you now owe them
 * Settled later with a Payment Entry against the same party (see payment-entry.js).
 */
async function saveAdvance(user, erp, draft) {
  const given = draft.transaction_type === 'advance_given';
  const role = given ? 'Customer' : 'Supplier';
  const party = await counterparties.resolveParty(user, erp, draft, role);
  const partyAccount = await resolvePartyAccount(erp, given ? 'Receivable' : 'Payable', draft.currency);
  const walletAccount = await wallets.accountForDraft(user, erp, draft);

  const partyLine = { account: partyAccount, party_type: role, party };
  const lines = given
    ? [{ ...partyLine, debit: draft.amount }, { account: walletAccount, credit: draft.amount }]
    : [{ account: walletAccount, debit: draft.amount }, { ...partyLine, credit: draft.amount }];

  const name = await postJournal(user, erp, draft, {
    lines,
    fromAccount: given ? walletAccount : party,
    toAccount: given ? party : walletAccount,
    remark: given ? `Advance to ${party}` : `Advance from ${party}`,
  });
  console.log(`• [erp-sync] [${ts()}] saved advance JE ${name} (${draft.transaction_type} ${draft.amount} ${draft.currency} ${party})`);
  return { erpnext_name: name, doctype: 'Journal Entry' };
}

module.exports = { saveCash, saveTransfer, saveAdvance, buildRows };

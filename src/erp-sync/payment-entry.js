/**
 * WRITE side — transaction_type=payment → ERPNext Payment Entry.
 *
 *   direction=income  → payment_type 'Receive' (customer pays you; clears a Sales Invoice or advance_given)
 *   direction=expense → payment_type 'Pay'     (you pay a supplier; clears a Purchase Invoice or advance_received)
 *
 * With parent_invoice_name pointing at a Sales/Purchase Invoice, the payment is allocated
 * against it. Pointing at a Journal Entry (an advance) or with no parent, it posts unallocated
 * against the party, which still nets the party balance to zero.
 */
const wallets = require('../wallets');
const counterparties = require('../counterparties');
const { ts, round2, companyCurrency, txRate, resolvePartyAccount, getAccountCurrency } = require('./common');
const { whtOnInvoice } = require('./taxes');

const INVOICE_FIELDS = {
  'Sales Invoice': { party: 'customer', account: 'debit_to', partyType: 'Customer' },
  'Purchase Invoice': { party: 'supplier', account: 'credit_to', partyType: 'Supplier' },
};

function guessDoctype(name) {
  if (/SINV/i.test(name)) return 'Sales Invoice';
  if (/PINV/i.test(name)) return 'Purchase Invoice';
  if (/JV/i.test(name)) return 'Journal Entry';
  return null;
}

async function loadParent(erp, name, doctype) {
  const candidates = doctype ? [doctype] : [guessDoctype(name), 'Sales Invoice', 'Purchase Invoice', 'Journal Entry'];
  for (const dt of [...new Set(candidates.filter(Boolean))]) {
    try {
      const r = await erp.getResource(dt, name);
      return { doctype: dt, doc: r.data };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  throw new Error(`could not find ${name} in ERPNext`);
}

async function savePayment(user, erp, draft, opts = {}) {
  const receiving = draft.direction === 'income';
  const baseCurrency = companyCurrency(user);

  // ── Party side: from the parent invoice when there is one ──────────
  let partyType = receiving ? 'Customer' : 'Supplier';
  let party, partyAccount, partyCurrency;
  let reference = null;

  if (draft.parent_invoice_name) {
    const { doctype, doc } = await loadParent(erp, draft.parent_invoice_name, draft.parent_invoice_doctype);
    if (doc.docstatus !== 1) throw new Error(`${doctype} ${doc.name} is not submitted`);
    const f = INVOICE_FIELDS[doctype];
    if (f) {
      if (f.partyType !== partyType) {
        throw new Error(`${doc.name} is a ${doctype}; a ${receiving ? 'received' : 'outgoing'} payment can't settle it`);
      }
      if (!(doc.outstanding_amount > 0)) throw new Error(`${doc.name} is already fully paid`);
      party = doc[f.party];
      partyAccount = doc[f.account];
      partyCurrency = doc.party_account_currency || doc.currency;
      reference = {
        reference_doctype: doctype,
        reference_name: doc.name,
        allocated_amount: round2(Math.min(draft.amount, doc.outstanding_amount)),
      };
    } else {
      // Journal Entry (advance): take the party off its receivable/payable line.
      const line = (doc.accounts || []).find((a) => a.party_type === partyType && a.party);
      if (!line) throw new Error(`${doc.name} has no ${partyType} line to settle`);
      party = line.party;
      partyAccount = line.account;
      partyCurrency = line.account_currency || (await getAccountCurrency(erp, line.account));
    }
  } else {
    party = await counterparties.resolveParty(user, erp, draft, partyType);
    partyAccount = await resolvePartyAccount(erp, receiving ? 'Receivable' : 'Payable', draft.currency);
    partyCurrency = draft.currency;
  }

  if (partyCurrency !== draft.currency) {
    throw new Error(`payment is in ${draft.currency} but ${party}'s balance is in ${partyCurrency}; confirm the currency with the user`);
  }

  // ── Wallet side ────────────────────────────────────────────────────
  const walletAccount = await wallets.accountForDraft(user, erp, draft);
  const walletCurrency = (await getAccountCurrency(erp, walletAccount)) || baseCurrency;
  const partyRate = txRate(user, draft);
  let walletAmount, walletRate;
  if (walletCurrency === draft.currency) {
    walletAmount = round2(draft.amount);
    walletRate = partyRate;
  } else if (walletCurrency === baseCurrency) {
    walletAmount = round2(draft.amount * partyRate);
    walletRate = 1;
  } else {
    throw new Error(`wallet is in ${walletCurrency}; can't settle a ${draft.currency} balance from it`);
  }

  const partySide = { account: partyAccount, currency: partyCurrency, amount: round2(draft.amount), rate: partyRate };
  const walletSide = { account: walletAccount, currency: walletCurrency, amount: walletAmount, rate: walletRate };
  const [from, to] = receiving ? [partySide, walletSide] : [walletSide, partySide];

  const payload = {
    payment_type: receiving ? 'Receive' : 'Pay',
    posting_date: draft.transaction_date,
    party_type: partyType,
    party,
    paid_from: from.account,
    paid_from_account_currency: from.currency,
    paid_amount: from.amount,
    source_exchange_rate: from.rate,
    paid_to: to.account,
    paid_to_account_currency: to.currency,
    received_amount: to.amount,
    target_exchange_rate: to.rate,
    // ERPNext requires a reference no/date whenever a Bank account is on either side.
    reference_no: draft.invoice_number || `WA-${draft.transaction_date}`,
    reference_date: draft.transaction_date,
    remarks: draft.description || `${receiving ? 'Received from' : 'Paid to'} ${party}`,
    // A gem lot operation's step marker has to survive: without custom_remarks ERPNext writes
    // its own text over `remarks` on a Payment Entry.
    ...(opts.remark ? { remarks: `${opts.remark} | ${draft.description || (receiving ? 'Received from' : 'Paid to') + ' ' + party}`, custom_remarks: 1 } : {}),
    references: reference ? [reference] : [],
    docstatus: 1,
  };

  const result = await erp.createPaymentEntry(payload);
  const name = result.data?.name;
  console.log(
    `• [erp-sync] [${ts()}] saved Payment Entry ${name} (${payload.payment_type} ${draft.amount} ${draft.currency} ${party}` +
      `${reference ? ` → ${reference.reference_name}` : ''})`
  );
  return { erpnext_name: name, doctype: 'Payment Entry', settles: reference?.reference_name || null };
}

/**
 * A bill with withholding tax is owed gross − WHT; the WHT goes to the Revenue Department, not the
 * supplier. Paying the gross would leave the WHT as an unallocated advance to the supplier.
 * Called from validate.readinessError (so the card is refused before the user confirms).
 * Returns an error string or null.
 */
async function whtOverpaymentError(erp, draft) {
  if (!draft.parent_invoice_name || draft.direction !== 'expense') return null;
  let parent;
  try {
    parent = await loadParent(erp, draft.parent_invoice_name, draft.parent_invoice_doctype);
  } catch {
    return null; // missing parent is reported by savePayment with its own message
  }
  if (parent.doctype !== 'Purchase Invoice') return null;
  const wht = whtOnInvoice(parent.doc);
  const owed = parent.doc.outstanding_amount;
  if (wht > 0 && Number(draft.amount) > owed + 0.005) {
    return `${parent.doc.name} had ${wht} ${parent.doc.currency} withholding tax deducted; ${parent.doc.supplier} is owed ` +
      `${owed} ${parent.doc.currency}, not ${draft.amount}. Set amount=${owed} and re-issue the card (WHT is paid to the Revenue Department separately).`;
  }
  return null;
}

module.exports = { savePayment, whtOverpaymentError };

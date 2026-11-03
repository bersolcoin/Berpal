/**
 * READ side — net position with one counterparty, from the party ledger (GL Entry).
 * Using the ledger rather than summing invoices means advances and unallocated
 * payments are counted too.
 */
const counterparties = require('../counterparties');
const { round2 } = require('../erp-sync/common');
const { getOpenInvoices } = require('./open-invoices');

async function partyBalances(erp, partyType, party) {
  const r = await erp.listResource('GL Entry', {
    filters: [
      ['company', '=', erp.company],
      ['party_type', '=', partyType],
      ['party', '=', party],
      ['is_cancelled', '=', 0],
    ],
    fields: ['account_currency', 'debit_in_account_currency', 'credit_in_account_currency'],
    limit: 10000,
  });
  const byCurrency = {};
  for (const g of r.data || []) {
    const net = (g.debit_in_account_currency || 0) - (g.credit_in_account_currency || 0);
    byCurrency[g.account_currency] = round2((byCurrency[g.account_currency] || 0) + net);
  }
  return byCurrency;
}

function addInto(target, cur, amount) {
  if (Math.abs(amount) < 0.005) return;
  target[cur] = round2((target[cur] || 0) + amount);
}

async function getBalanceWithCounterparty(user, erp, { counterparty_id = null, counterparty_search = null } = {}) {
  let contact;
  if (counterparty_id) {
    contact = await counterparties.getById(user, counterparty_id);
    if (!contact) return { ok: false, error: `counterparty_id ${counterparty_id} not found` };
  } else if (counterparty_search) {
    const matches = await counterparties.search(user, erp, counterparty_search);
    if (matches.length === 0) return { ok: true, found: false };
    const exact = matches.filter((m) => m.exact);
    if (matches.length > 1 && exact.length !== 1) {
      return { ok: true, ambiguous: true, matches };
    }
    contact = await counterparties.getById(user, (exact[0] || matches[0]).id);
  } else {
    return { ok: false, error: 'counterparty_id or counterparty_search required' };
  }

  // Customer ledger: debit balance = they owe you. Supplier ledger: credit balance = you owe them.
  // A negative balance on either flips sides (e.g. customer overpaid → you owe them).
  const owesYou = {};
  const youOwe = {};
  if (contact.erpnext_customer) {
    for (const [cur, net] of Object.entries(await partyBalances(erp, 'Customer', contact.erpnext_customer))) {
      net >= 0 ? addInto(owesYou, cur, net) : addInto(youOwe, cur, -net);
    }
  }
  if (contact.erpnext_supplier) {
    for (const [cur, net] of Object.entries(await partyBalances(erp, 'Supplier', contact.erpnext_supplier))) {
      net <= 0 ? addInto(youOwe, cur, -net) : addInto(owesYou, cur, net);
    }
  }

  const open = await getOpenInvoices(user, erp, { counterparty_id: contact.id, limit: 50 });
  return {
    ok: true,
    found: true,
    counterparty: { id: contact.id, name: contact.name, nickname: contact.nickname || null },
    owes_you: owesYou,
    you_owe: youOwe,
    open_invoices: open.rows.filter((r) => r.kind === 'receivable').length,
    open_bills: open.rows.filter((r) => r.kind === 'payable').length,
  };
}

module.exports = { getBalanceWithCounterparty };

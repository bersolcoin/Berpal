/**
 * Kind: unknown_item_purchase
 *
 * Triggered after a Sales Invoice saves and one of its line items has no
 * prior purchase history (no Purchase Invoice or Stock Entry has ever
 * referenced it in this tenant's Company). Accounting-wise that means
 * we're showing revenue against an item we have no cost basis for —
 * the user needs to fill in who supplied it and at what cost.
 *
 * payload shape (set by sales-invoice.js when the todo is enqueued):
 *   {
 *     item_code:     'GEN-SALE-TTC',
 *     item_name:     'Paraiba 5ct',
 *     qty_sold:      1,
 *     amount_sold:   2000,
 *     currency:      'USD',
 *     invoice_ref:   'ACC-SINV-2026-00001',
 *     customer_name: 'Acme Trading',
 *   }
 *
 * Resolution (userInput.branch + branch-specific fields):
 *
 *   branch = 'open_stock'
 *     User had this item on hand BEFORE adopting Berpal. We book a
 *     Journal Entry: DR Cost of Goods Sold, CR Opening Balance Equity.
 *     No phantom AP, no negative wallet — just acknowledges the
 *     pre-existing cost basis so the sale's gross profit is correct.
 *     Required: { unit_cost }
 *     Optional: { qty (default payload.qty_sold), opening_date (default
 *                 the sale's posting_date) }
 *
 *   branch = 'purchased'
 *     Bought AFTER adopting Berpal. Books a Purchase Invoice + one
 *     Payment Entry per leg of `payment_legs` (each leg = wallet +
 *     amount). Empty array → fully on credit. Sum(legs) < total →
 *     partial (invoice keeps outstanding). Sum(legs) = total → fully
 *     paid. Sum(legs) > total → reject.
 *     Required: { supplier_name, unit_cost, purchase_date,
 *                 payment_legs: [{ payment_account_code, wallet_name,
 *                                  amount }] }
 *     Optional: { due_date (only when payment_legs is empty) }
 *
 *   branch = 'skip'
 *     User can't / won't fill it in. Delete the todo, no doc written.
 */

const { resolveOrCreateSupplier } = require('../../erp-sync/supplier');
const { resolveErpAccount } = require('../../erp-sync/account');
const { ts } = require('../../log');
const purchaseInvoice = require('../../erp-sync/purchase-invoice');
const paymentEntry = require('../../erp-sync/payment-entry');

function buildPrompt(p = {}) {
  const item = p.item_name || p.item_code || 'this item';
  const sold = p.amount_sold != null && p.currency
    ? ` (sold for ${p.amount_sold} ${p.currency}${p.customer_name ? ' to ' + p.customer_name : ''})`
    : '';
  return `You sold ${item}${sold} but I don't have a purchase record for it — who did you buy it from, and for how much?`;
}

async function resolve(user, erp, payload, userInput) {
  const branch = userInput?.branch;

  if (branch === 'skip' || userInput?.skip) {
    return { ok: true, action: 'skipped' };
  }

  if (!branch) {
    return { ok: false, error: 'branch is required (open_stock | purchased_paid | purchased_credit | skip)' };
  }

  const unitCost = Number(userInput?.unit_cost);
  if (!Number.isFinite(unitCost) || unitCost <= 0) {
    return { ok: false, error: 'unit_cost must be a positive number.' };
  }
  const qty = Number(userInput?.qty || payload?.qty_sold || 1) || 1;
  const totalCost = unitCost * qty;
  const currency = userInput?.currency || payload?.currency || user.reporting_currency;

  if (branch === 'open_stock') {
    return await bookOpeningStock(user, erp, {
      payload,
      unitCost,
      qty,
      totalCost,
      currency,
      openingDate: userInput?.opening_date || todayISO(),
    });
  }

  if (branch === 'purchased') {
    if (!userInput?.supplier_name) {
      return { ok: false, error: 'supplier_name is required for the purchased branch.' };
    }
    if (!userInput?.purchase_date) {
      return { ok: false, error: 'purchase_date is required for the purchased branch.' };
    }
    const paymentLegs = Array.isArray(userInput.payment_legs) ? userInput.payment_legs : [];
    // Per-leg validation. UI already enforces these but defending here
    // since the API is callable from anywhere (incl. eventually the bot).
    for (const leg of paymentLegs) {
      if (!leg?.payment_account_code) {
        return { ok: false, error: 'each payment_leg needs payment_account_code (1000 / 1100 / 2100).' };
      }
      const amt = Number(leg.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return { ok: false, error: 'each payment_leg amount must be a positive number.' };
      }
    }
    const totalCost = unitCost * qty;
    const totalPaid = paymentLegs.reduce((s, l) => s + Number(l.amount), 0);
    if (totalPaid > totalCost + 0.001) {
      return { ok: false, error: `payments (${totalPaid}) exceed total cost (${totalCost}).` };
    }

    return await bookPurchase(user, erp, {
      payload,
      supplierName: userInput.supplier_name,
      supplierPhone: userInput.supplier_phone || null,
      unitCost,
      qty,
      currency,
      purchaseDate: userInput.purchase_date,
      dueDate: userInput.due_date || null,
      paymentLegs,
    });
  }

  return { ok: false, error: `unknown branch "${branch}".` };
}

/**
 * Journal Entry: DR COGS, CR Opening Balance Equity. The opening cost
 * basis appears as an expense dated alongside (or before) the sale,
 * so the sale's gross profit reflects reality without inventing a
 * supplier or touching any wallet.
 */
async function bookOpeningStock(user, erp, { payload, totalCost, currency, openingDate }) {
  const cogsAccount = await resolveErpAccount(user, erp, '5000', user.reporting_currency);
  if (!cogsAccount) return { ok: false, error: 'Could not resolve a Cost of Goods Sold account on this Company.' };
  const equityAccount = await resolveErpAccount(user, erp, '3200', user.reporting_currency);
  if (!equityAccount) return { ok: false, error: 'Could not resolve an Opening Balance Equity account on this Company.' };

  const isMultiCurrency = currency && currency !== user.reporting_currency;
  const accounts = [
    { account: cogsAccount, debit_in_account_currency: totalCost, credit_in_account_currency: 0 },
    { account: equityAccount, debit_in_account_currency: 0, credit_in_account_currency: totalCost },
  ];

  const payload2 = {
    voucher_type: 'Journal Entry',
    posting_date: openingDate,
    company: erp.company,
    multi_currency: isMultiCurrency ? 1 : 0,
    user_remark: `Opening stock — ${payload?.item_name || payload?.item_code || 'item'} (sale ${payload?.invoice_ref || ''})`,
    accounts,
    docstatus: 1,
  };
  const result = await erp.createResource('Journal Entry', payload2);
  const erpName = result.data?.name;
  console.log(`• [todos] [${ts()}] open-stock JE posted: ${erpName} (${totalCost} ${user.reporting_currency})`);
  return {
    ok: true,
    action: 'open_stock_booked',
    journal_entry_name: erpName,
    journal_entry_doctype: 'Journal Entry',
  };
}

/**
 * Book the purchase. Always creates a Purchase Invoice via the shared
 * handler (no paid_now — we manage payments below). Then for each leg
 * we post an individual Payment Entry against the same invoice via
 * paymentEntry.save. This naturally produces:
 *   0 legs            → invoice + AP outstanding (on credit)
 *   sum < total       → partial settlement (invoice keeps outstanding)
 *   sum = total       → fully paid
 *   mixed wallets     → one PE per wallet, all referencing the invoice
 */
async function bookPurchase(user, erp, {
  payload,
  supplierName, supplierPhone,
  unitCost, qty, currency,
  purchaseDate, dueDate,
  paymentLegs,
}) {
  // Ensure the supplier exists / cache is current.
  await resolveOrCreateSupplier(user, erp, supplierName, { currency, phone: supplierPhone });

  const totalCost = unitCost * qty;

  // Step 1 — Purchase Invoice (no paid_now flag; payments handled below).
  const billDraft = {
    transaction_type: 'bill_received',
    direction: 'expense',
    transaction_date: purchaseDate,
    amount: totalCost,
    currency,
    counterparty_name: supplierName,
    counterparty_phone: supplierPhone,
    description: payload?.item_name || payload?.item_code || 'item',
    category_code: '5000', // COGS bucket
    paid_now: false,
    due_date: dueDate || purchaseDate,
  };
  const billResult = await purchaseInvoice.save(user, erp, billDraft);
  if (!billResult?.ok) {
    return { ok: false, error: billResult?.error || 'Purchase Invoice post failed.' };
  }
  const billName = billResult.erpnext_name;
  console.log(`• [todos] [${ts()}] purchase bill posted: ${billName} (legs=${paymentLegs.length})`);

  // Step 2 — one Payment Entry per leg. If any leg fails AFTER the
  // invoice was created, we surface a partial-success result so the
  // user can see what landed and retry the rest manually if needed.
  const paymentNames = [];
  const paymentErrors = [];
  for (const leg of paymentLegs) {
    try {
      const peDraft = {
        transaction_type: 'payment',
        direction: 'expense',
        amount: Number(leg.amount),
        currency,
        counterparty_name: supplierName,
        payment_account_code: leg.payment_account_code,
        wallet_name: leg.wallet_name || null,
        parent_invoice_ref: billName,
        transaction_date: purchaseDate,
      };
      const peResult = await paymentEntry.save(user, erp, peDraft);
      if (peResult?.ok) {
        paymentNames.push(peResult.erpnext_name);
        console.log(`• [todos] [${ts()}]   leg paid: ${peResult.erpnext_name} (${leg.amount} from ${leg.wallet_name})`);
      } else {
        paymentErrors.push(peResult?.error || 'unknown PE error');
      }
    } catch (err) {
      paymentErrors.push(err.message);
    }
  }

  return {
    ok: true,
    action: 'purchased',
    purchase_invoice_name: billName,
    purchase_invoice_doctype: 'Purchase Invoice',
    payment_entry_names: paymentNames,
    ...(paymentErrors.length > 0 ? { payment_errors: paymentErrors } : {}),
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  kind: 'unknown_item_purchase',
  bot_resolvable: true,
  web_resolvable: true,
  buildPrompt,
  resolve,
};

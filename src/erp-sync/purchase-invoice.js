/**
 * Handler for transaction_type='bill_received' — posts a Purchase Invoice to ERPNext.
 *
 * Mirror of sales-invoice.js for the AP side:
 *   Customer       → Supplier
 *   Receivable     → Payable        (Creditors per-currency)
 *   debit_to       → credit_to
 *   income_account → expense_account
 *
 * Multi-currency: same shape as sales — pass conversion_rate AND a per-currency
 * `credit_to` (a Creditors account in the bill's currency). Without it, ERPNext
 * rejects with "Party Account currency and document currency should be same".
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveOrCreateSupplier } = require('./supplier');
const { ensureGenericPurchaseItem, resolveItem } = require('./item');
const { resolveErpAccount } = require('./account');
const { resolvePartyAccount } = require('./party-account');
const { ts } = require('../log');
const { query } = require('../db');
const { proposeLink } = require('../links/linked-transactions');
const paymentEntry = require('./payment-entry');
const { getDefaultWarehouseForUser } = require('./stock');

async function save(user, erp, draft) {
  if (!draft.counterparty_name) {
    return { ok: false, error: 'bill requires counterparty_name (supplier)' };
  }

  const supplierName = await resolveOrCreateSupplier(user, erp, draft.counterparty_name, {
    phone: draft.counterparty_phone,
    email: draft.counterparty_email,
  });

  // Build PI line items — same pattern as sales-invoice.js. For
  // product/both: resolve real per-SKU Items (NEW_ITEM/AMBIGUOUS_ITEM
  // bubble up). Service or legacy single-line: GEN-PURCHASE fallback.
  const bt = user.business_type;
  const requireRealItems = bt === 'product' || bt === 'both';
  let piLineItems;
  if (Array.isArray(draft.items) && draft.items.length > 0) {
    piLineItems = [];
    for (const line of draft.items) {
      if (!line?.item_code) {
        return { ok: false, error: 'item line missing item_code' };
      }
      const hit = await resolveItem(user, erp, {
        code: line.item_code,
        description: line.description || null,
      });
      piLineItems.push({
        resolved_item: hit.erpnext_name,
        qty: Number(line.qty) || 1,
        rate: Number(line.rate) || 0,
        description: line.description || hit.item_name || line.item_code,
      });
    }
  } else if (requireRealItems) {
    return { ok: false, error: 'product/both business_type requires draft.items[]' };
  } else {
    const genericCode = await ensureGenericPurchaseItem(user, erp);
    piLineItems = [{
      resolved_item: genericCode,
      qty: 1,
      rate: Number(draft.amount) || 0,
      description: draft.description || `${supplierName} bill`,
    }];
  }

  // Resolve expense account from category_code (5900 → 5223 - Misc Expenses - TTC etc.)
  const expenseAccount = await resolveErpAccount(
    user, erp, draft.category_code, user.reporting_currency
  );

  const postingDate = draft.transaction_date;
  let dueDate = draft.due_date;
  if (!dueDate && typeof draft.payment_terms === 'string' && draft.payment_terms.startsWith('net_')) {
    const days = parseInt(draft.payment_terms.slice(4), 10);
    if (!isNaN(days)) {
      const d = new Date(postingDate);
      d.setDate(d.getDate() + days);
      dueDate = d.toISOString().slice(0, 10);
    }
  }
  if (!dueDate) dueDate = postingDate;

  // Product/both tenants buy stock Items: receive them into the tenant's
  // Stores warehouse on the same document (update_stock), so /inventory
  // reflects the purchase. Stock lines then post to the warehouse's stock
  // account via perpetual inventory — no expense_account on those lines.
  const warehouse = requireRealItems ? getDefaultWarehouseForUser(user) : null;
  const updateStock = !!(warehouse && Array.isArray(draft.items) && draft.items.length > 0);

  const billPayload = {
    supplier: supplierName,
    posting_date: postingDate,
    due_date: dueDate,
    bill_no: draft.invoice_number || undefined,
    bill_date: draft.invoice_number ? postingDate : undefined,
    currency: draft.currency,
    items: piLineItems.map((l) => ({
      item_code: l.resolved_item,
      qty: l.qty,
      rate: l.rate,
      description: l.description,
      // delivered_by_supplier=0 sidesteps an unguarded getattr in
      // erpnext.controllers.accounts_controller.is_drop_ship which trips
      // on some ERPNext versions. Safe to send.
      delivered_by_supplier: 0,
      ...(updateStock
        ? { warehouse }
        : expenseAccount ? { expense_account: expenseAccount } : {}),
    })),
    ...(updateStock ? { update_stock: 1, set_warehouse: warehouse } : {}),
    ...(draft.description ? { remarks: draft.description } : {}),
    docstatus: 1, // submit on create
  };

  // Multi-currency: needs conversion_rate AND a Payable account in the
  // bill's currency. The per-currency Creditors leaf is auto-created on
  // first use by resolvePartyAccount.
  if (draft.currency !== user.reporting_currency) {
    billPayload.conversion_rate = draft.exchange_rate || 1;
    billPayload.credit_to = await resolvePartyAccount(erp, 'Payable', draft.currency, user);
  }

  const result = await erp.createPurchaseInvoice(billPayload);
  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved Purchase Invoice to ERPNext: ${erpName} ` +
      `(${draft.amount} ${draft.currency} from ${supplierName}, due ${dueDate})`
  );

  // Buyer-initiated B2B link: if the supplier's contact phone matches
  // another Berpal user, park a linked_transactions row + send them a
  // proposal so they get a mirror Sales Invoice on Accept. Fire-and-forget.
  try {
    const linkRow = await query(
      `SELECT linked_user_id, phone FROM counterparty_cache
         WHERE owner_user_id = $1 AND erpnext_name = $2 AND erpnext_doctype = 'Supplier'
         LIMIT 1`,
      [user.id, supplierName]
    );
    const responderUserId = linkRow.rows[0]?.linked_user_id;
    const responderPhone = linkRow.rows[0]?.phone || draft.counterparty_phone || null;
    if (responderUserId || responderPhone) {
      let walletType = null;
      let walletLabel = null;
      if (draft.paid_now && draft.payment_account_code) {
        walletType =
          draft.payment_account_code === '1000' ? 'cash' :
          draft.payment_account_code === '1100' ? 'bank' :
          draft.payment_account_code === '2100' ? 'card' :
          null;
        walletLabel = draft.wallet_name
          ? draft.wallet_name
          : (walletType === 'cash' ? `Cash ${draft.currency}` : null);
      }
      await proposeLink({
        initiatorUser: user,
        initiatorRole: 'buyer',
        initiatorDoctype: 'Purchase Invoice',
        initiatorDocName: erpName,
        responderUserId,
        responderPhone,
        currency: draft.currency,
        totalAmount: Number(draft.amount) || 0,
        items: [
          {
            description: draft.description || `${supplierName} bill`,
            qty: 1,
            rate: Number(draft.amount) || 0,
            amount: Number(draft.amount) || 0,
          },
        ],
        paidNow: !!draft.paid_now,
        paymentAccountCode: draft.paid_now ? draft.payment_account_code : null,
        walletLabel,
        walletType,
      });
    }
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] linked-txn (buyer-init) propose skipped: ${err.message}`);
  }

  // paid_now: post the matching outbound Payment Entry against this
  // bill in the same save. See sales-invoice.js for the mirror flow.
  if (draft.paid_now) {
    try {
      const peResult = await paymentEntry.save(user, erp, {
        transaction_type: 'payment',
        direction: 'expense',
        amount: draft.amount,
        currency: draft.currency,
        exchange_rate: draft.exchange_rate,
        counterparty_name: draft.counterparty_name,
        payment_account_code: draft.payment_account_code,
        wallet_name: draft.wallet_name || null,
        wallet_account: draft.wallet_account || null,
        parent_invoice_ref: erpName,
        transaction_date: draft.transaction_date,
        payment_reference: draft.payment_reference || null,
      });
      if (peResult?.ok) {
        console.log(
          `• [conversation] [${ts()}] saved paid-now PE to ERPNext: ${peResult.erpnext_name} (settles ${erpName})`
        );
        return {
          ok: true,
          erpnext_name: erpName,
          doctype: 'Purchase Invoice',
          payment_entry_name: peResult.erpnext_name,
          payment_entry_doctype: 'Payment Entry',
        };
      }
      return {
        ok: true,
        erpnext_name: erpName,
        doctype: 'Purchase Invoice',
        payment_entry_error: peResult?.error || 'unknown payment-entry failure',
      };
    } catch (err) {
      console.warn(`• [conversation] [${ts()}] paid-now PE post failed for ${erpName}: ${err.message}`);
      return {
        ok: true,
        erpnext_name: erpName,
        doctype: 'Purchase Invoice',
        payment_entry_error: err.message,
      };
    }
  }

  return { ok: true, erpnext_name: erpName, doctype: 'Purchase Invoice' };
}

module.exports = { save };

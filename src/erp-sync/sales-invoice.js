/**
 * Handler for transaction_type='invoice_issued' — posts a Sales Invoice to ERPNext.
 *
 * Multi-currency: if the invoice currency differs from the user's reporting
 * currency, we set `conversion_rate` AND pass a per-currency `debit_to`
 * (a Debtors account in the invoice's currency). Without `debit_to`, ERPNext
 * rejects with "Party Account currency and document currency should be same".
 *
 * Return shape: { ok: true, erpnext_name, doctype } on success;
 *               { ok: false, error } on validation/upstream failure.
 */

const { resolveOrCreateCustomer } = require('./customer');
const { ensureGenericSalesItem, resolveItem } = require('./item');
const { resolveErpAccount } = require('./account');
const { resolvePartyAccount } = require('./party-account');
const { ts } = require('../log');
const { query } = require('../db');
const { proposeLink } = require('../links/linked-transactions');
const { createTodo } = require('../todos');
const paymentEntry = require('./payment-entry');

async function save(user, erp, draft) {
  if (!draft.counterparty_name) {
    return { ok: false, error: 'invoice requires counterparty_name' };
  }

  const customerName = await resolveOrCreateCustomer(user, erp, draft.counterparty_name, {
    currency: draft.currency,
    phone: draft.counterparty_phone,
    email: draft.counterparty_email,
  });

  // Build the SI line items. For product/both: every line is a real
  // resolved Item (resolveItem throws NEW_ITEM/AMBIGUOUS_ITEM, which
  // bubbles to the LLM with structured info). For service or legacy
  // single-line drafts (no items[]): fall back to the per-tenant
  // GEN-SALE placeholder so the flow doesn't break.
  const bt = user.business_type;
  const requireRealItems = bt === 'product' || bt === 'both';
  let siLineItems;
  if (Array.isArray(draft.items) && draft.items.length > 0) {
    siLineItems = [];
    for (const line of draft.items) {
      if (!line?.item_code) {
        return { ok: false, error: 'item line missing item_code' };
      }
      const hit = await resolveItem(user, erp, {
        code: line.item_code,
        description: line.description || null,
      });
      siLineItems.push({
        resolved_item: hit.erpnext_name,
        qty: Number(line.qty) || 1,
        rate: Number(line.rate) || 0,
        description: line.description || hit.item_name || line.item_code,
        weight_ct: typeof line.weight_ct === 'number' ? line.weight_ct : null,
      });
    }
  } else if (requireRealItems) {
    return { ok: false, error: 'product/both business_type requires draft.items[]' };
  } else {
    // Service or legacy fallback.
    const genericCode = await ensureGenericSalesItem(user, erp);
    siLineItems = [{
      resolved_item: genericCode,
      qty: 1,
      rate: Number(draft.amount) || 0,
      description: draft.description || `${customerName} invoice`,
      weight_ct: null,
    }];
  }

  // Resolve income account from category_code (4000 → 4110 - Sales - TTC)
  const incomeAccount = await resolveErpAccount(
    user, erp, draft.category_code, user.reporting_currency
  );

  // Compute due_date from payment_terms if not set
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

  const invoicePayload = {
    customer: customerName,
    posting_date: postingDate,
    due_date: dueDate,
    currency: draft.currency,
    items: siLineItems.map((l) => ({
      item_code: l.resolved_item,
      qty: l.qty,
      rate: l.rate,
      description: l.description,
      ...(incomeAccount ? { income_account: incomeAccount } : {}),
      // weight_ct is a Custom Field on Item — propagating it onto the SI
      // line as well requires a separate Sales Invoice Item Custom Field;
      // out of scope here. The Item itself carries it for reports.
    })),
    docstatus: 1, // submit on create
  };

  // Multi-currency: needs conversion_rate AND a Receivable account in the
  // invoice's currency. The per-currency Debtors leaf is auto-created on
  // first use by resolvePartyAccount.
  if (draft.currency !== user.reporting_currency) {
    invoicePayload.conversion_rate = draft.exchange_rate || 1;
    invoicePayload.debit_to = await resolvePartyAccount(erp, 'Receivable', draft.currency, user);
  }

  const result = await erp.createSalesInvoice(invoicePayload);
  const erpName = result.data?.name;

  console.log(
    `• [conversation] [${ts()}] saved Sales Invoice to ERPNext: ${erpName} ` +
      `(${draft.amount} ${draft.currency} for ${customerName}, due ${dueDate})`
  );

  // B2B link: if we have a phone for this customer, park a linked_transactions
  // row. If their phone matches a Berpal user, status='pending_buyer_confirmation'
  // and we WhatsApp them now. If not, status='pending_buyer_signup' and the
  // row claims itself when (if) they later sign up. Fire-and-forget.
  try {
    const linkRow = await query(
      `SELECT linked_user_id, phone FROM counterparty_cache
         WHERE owner_user_id = $1 AND erpnext_name = $2 AND erpnext_doctype = 'Customer'
         LIMIT 1`,
      [user.id, customerName]
    );
    const buyerUserId = linkRow.rows[0]?.linked_user_id;
    const buyerPhone = linkRow.rows[0]?.phone || draft.counterparty_phone || null;
    if (buyerUserId || buyerPhone) {
      // Derive seller-side payment context. The buyer-side template uses
      // it to (a) show "received in cash" / "received to bank" in the
      // proposal body, and (b) narrow the buyer's wallet-pick step to
      // accounts of the same type.
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
        initiatorRole: 'seller',
        initiatorDoctype: 'Sales Invoice',
        initiatorDocName: erpName,
        responderUserId: buyerUserId,
        responderPhone: buyerPhone,
        currency: draft.currency,
        totalAmount: Number(draft.amount) || 0,
        items: [
          {
            description: draft.description || `${customerName} invoice`,
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
    console.warn(`• [conversation] [${ts()}] linked-txn propose skipped: ${err.message}`);
  }

  // Pending-TODO trigger: every line item we sold without a prior
  // purchase record becomes a follow-up so the user fills in supplier +
  // cost basis later. One todo per line per SI. Idempotent via
  // (user_id, kind, related_name) — except related_name is the SI doc
  // name, so for multi-line we need to disambiguate by item_code in
  // the payload (the existing index dedups per-SI; we deliberately
  // accept one todo per SI for V1 — the resolver handles all lines).
  try {
    const bizType = user.business_type;
    const isServiceRevenue = draft.category_code === '4100';
    if (!isServiceRevenue && (bizType === 'product' || bizType === 'both')) {
      for (const line of siLineItems) {
        // Skip the generic placeholder fallback — that's not a real SKU.
        if (line.resolved_item.startsWith('GEN-SALE')) continue;
        // Check for prior Purchase Invoice lines on this item. If any
        // exist, cost basis is established; no todo needed.
        let hasPriorPurchase = false;
        try {
          const r = await erp.listResource('Purchase Invoice Item', {
            filters: [['item_code', '=', line.resolved_item], ['docstatus', '=', 1]],
            fields: ['name'],
            limit: 1,
          });
          hasPriorPurchase = (r.data || []).length > 0;
        } catch (probeErr) {
          // Non-fatal — assume no prior, enqueue the todo to be safe.
          console.warn(`• [conversation] [${ts()}]   purchase-history probe failed for ${line.resolved_item}: ${probeErr.message}`);
        }
        if (hasPriorPurchase) continue;

        // The todos table has UNIQUE(user_id, kind, related_name) — one
        // todo per SI not per-line. For multi-line, we attach the first
        // line missing history; users with multi-line bills can re-enqueue
        // via re-saves if needed. (V1 simplification.)
        await createTodo({
          userId: user.id,
          kind: 'unknown_item_purchase',
          payload: {
            item_code: line.resolved_item,
            item_name: line.description || '(item)',
            qty_sold: line.qty,
            weight_ct: line.weight_ct || null,
            amount_sold: Number(line.qty) * Number(line.rate) || 0,
            currency: draft.currency,
            invoice_ref: erpName,
            customer_name: customerName,
          },
          relatedDoctype: 'Sales Invoice',
          relatedName: erpName,
        });
        break; // first line with no prior history → todo enqueued, stop
      }
    }
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] todo enqueue skipped: ${err.message}`);
  }

  // paid_now flow: the SAME message described the invoice AND its
  // immediate payment (e.g. "sold X to Acme for 2000 USD, paid cash").
  // Post the matching Payment Entry now so AR is created AND cleared
  // in one user action. If the PE post fails, the SI stays — operator
  // (or user via "X paid me Y") can settle it later. Surface a clear
  // partial-success in the return so the caller can render both refs.
  if (draft.paid_now) {
    try {
      const peResult = await paymentEntry.save(user, erp, {
        transaction_type: 'payment',
        direction: 'income',
        amount: draft.amount,
        currency: draft.currency,
        exchange_rate: draft.exchange_rate,
        counterparty_name: draft.counterparty_name,
        payment_account_code: draft.payment_account_code,
        wallet_name: draft.wallet_name || null,
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
          doctype: 'Sales Invoice',
          payment_entry_name: peResult.erpnext_name,
          payment_entry_doctype: 'Payment Entry',
        };
      }
      // PE failed AFTER SI succeeded — return a partial-success shape so
      // the caller can tell the user "invoice saved, payment didn't post".
      return {
        ok: true,
        erpnext_name: erpName,
        doctype: 'Sales Invoice',
        payment_entry_error: peResult?.error || 'unknown payment-entry failure',
      };
    } catch (err) {
      console.warn(`• [conversation] [${ts()}] paid-now PE post failed for ${erpName}: ${err.message}`);
      return {
        ok: true,
        erpnext_name: erpName,
        doctype: 'Sales Invoice',
        payment_entry_error: err.message,
      };
    }
  }

  return { ok: true, erpnext_name: erpName, doctype: 'Sales Invoice' };
}

module.exports = { save };

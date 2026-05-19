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
const { ensureGenericSalesItem } = require('./item');
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

  const itemCode = await ensureGenericSalesItem(user, erp);

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
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: draft.amount,
        description: draft.description || `${customerName} invoice`,
        ...(incomeAccount ? { income_account: incomeAccount } : {}),
      },
    ],
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
      await proposeLink({
        sellerUser: user,
        sellerDoctype: 'Sales Invoice',
        sellerDocName: erpName,
        buyerUserId,
        buyerPhone,
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
      });
    }
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] linked-txn propose skipped: ${err.message}`);
  }

  // Pending-TODO trigger: every product sale where we don't have a
  // purchase record for the goods becomes a follow-up (the user fills
  // in supplier + cost later via /todos or by asking the bot).
  // Two filters:
  //   - business_type: services-only tenants don't sell goods at all
  //   - category_code: 4100 (Service/Consulting/Fees) means this
  //     specific invoice is for labor, not goods — nothing was "bought"
  //     to fulfill it, so no purchase-record question to ask.
  // Idempotent via the (user_id, kind, related_name) unique index, so
  // re-saves of the same invoice never produce duplicates.
  try {
    const bizType = user.business_type;
    const isServiceRevenue = draft.category_code === '4100';
    if (!isServiceRevenue && (bizType === 'product' || bizType === 'both')) {
      await createTodo({
        userId: user.id,
        kind: 'unknown_item_purchase',
        payload: {
          item_name: draft.description || '(item)',
          qty_sold: 1,
          amount_sold: Number(draft.amount) || 0,
          currency: draft.currency,
          invoice_ref: erpName,
          customer_name: customerName,
        },
        relatedDoctype: 'Sales Invoice',
        relatedName: erpName,
      });
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

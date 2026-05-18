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

  return { ok: true, erpnext_name: erpName, doctype: 'Sales Invoice' };
}

module.exports = { save };

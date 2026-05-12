const { withTransaction, query } = require('./db');
const counterparties = require('./counterparties');
const accounts = require('./accounts');

/**
 * Verify a payment_account_id is owned by the user, currently active, and matches the tx currency.
 * Returns the row if valid; throws if not — preventing transactions from linking to stale/deleted/cross-user accounts.
 */
async function validateUserAccount(userId, accountId, currency, label) {
  const r = await query(
    `SELECT id, name, currency, is_active FROM chart_of_accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId]
  );
  if (r.rowCount === 0) throw new Error(`${label} account ${accountId} not found or not owned by user`);
  const row = r.rows[0];
  if (!row.is_active) throw new Error(`${label} account ${accountId} (${row.name}) is inactive — pick another`);
  if (currency && row.currency && row.currency !== currency) {
    throw new Error(`${label} account ${accountId} (${row.name}) is ${row.currency}, not ${currency}`);
  }
  return row;
}

function computeDueDate(transactionDate, paymentTerms) {
  if (!paymentTerms || !paymentTerms.startsWith('net_')) return null;
  const days = parseInt(paymentTerms.slice(4), 10);
  if (Number.isNaN(days)) return null;
  const d = new Date(transactionDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function save({ user, draft, conversationId }) {
  const now = new Date().toISOString();

  let counterpartyId = draft.counterparty_id || null;
  if (!counterpartyId && (draft.counterparty_name || draft.counterparty_phone || draft.counterparty_nickname)) {
    counterpartyId = await counterparties.findOrCreate(user.id, {
      name: draft.counterparty_name,
      nickname: draft.counterparty_nickname,
      phone: draft.counterparty_phone,
    });
  }

  const transactionType = draft.transaction_type || 'cash';
  const userSide = draft.direction === 'income' ? 'credit' : 'debit';

  const currency = draft.currency || user.default_currency || 'THB';
  const baseCurrency = user.reporting_currency || currency;
  const sameCurrency = currency === baseCurrency;

  // Invoices/bills/advances enter the system as unpaid; cash/payment/transfer have no payment_status
  const paymentStatus =
    ['invoice_issued', 'bill_received', 'advance_given', 'advance_received'].includes(transactionType)
      ? 'unpaid'
      : null;

  const dueDate = draft.due_date || computeDueDate(draft.transaction_date, draft.payment_terms);

  // Resolve payment_account_id: prefer what the LLM set; otherwise auto-link if exactly 1
  // user account matches the (parent_code, currency) combo. If 0 or 2+ matches, leave null.
  let paymentAccountId = draft.payment_account_id || null;
  if (!paymentAccountId && draft.payment_account_code) {
    const match = await accounts.resolveSingleMatch(user.id, draft.payment_account_code, currency);
    if (match) paymentAccountId = match.id;
  }
  if (paymentAccountId) await validateUserAccount(user.id, paymentAccountId, currency, 'payment');

  // Same validation for transfer destination
  const transferDestId = draft.transfer_destination_account_id || null;
  if (transferDestId) await validateUserAccount(user.id, transferDestId, currency, 'transfer destination');

  return withTransaction(async (client) => {
    const txResult = await client.query(
      `INSERT INTO transactions (
        created_by_user_id, source, source_conversation_id,
        transaction_type, transaction_date, direction,
        description, category_code, counterparty_id,
        amount, currency,
        tax_amount, tax_rate, tax_inclusive, tax_code,
        payment_method, payment_account_code, payment_account_id, payment_reference,
        invoice_number, receipt_number, external_reference,
        payment_terms, due_date, payment_status, paid_amount, parent_transaction_id, delivery_date,
        transfer_destination_account_id,
        confirmation_status, confirmed_at, last_edited_by_user_id,
        created_at, updated_at
      ) VALUES (
        $1, 'whatsapp_chat', $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21,
        $22, $23, $24, $25, $26, $27,
        $28,
        'confirmed', $29, $1,
        $29, $29
      )
      RETURNING id`,
      [
        user.id,
        conversationId || null,
        transactionType,
        draft.transaction_date,
        draft.direction,
        draft.description || null,
        draft.category_code || null,
        counterpartyId,
        draft.amount,
        currency,
        draft.tax_amount ?? null,
        draft.tax_rate ?? null,
        draft.tax_inclusive == null ? null : draft.tax_inclusive ? 1 : 0,
        draft.tax_code || null,
        draft.payment_method || null,
        draft.payment_account_code || null,
        paymentAccountId,
        draft.payment_reference || null,
        draft.invoice_number || null,
        draft.receipt_number || null,
        draft.external_reference || null,
        draft.payment_terms || null,
        dueDate,
        paymentStatus,
        null,
        draft.parent_transaction_id || null,
        draft.delivery_date || null,
        draft.transfer_destination_account_id || null,
        now,
      ]
    );

    const transactionId = txResult.rows[0].id;

    // If this payment settles a prior invoice/bill, update the parent's payment_status + paid_amount
    if (transactionType === 'payment' && draft.parent_transaction_id) {
      const parentResult = await client.query(
        'SELECT amount, paid_amount FROM transactions WHERE id = $1 AND created_by_user_id = $2',
        [draft.parent_transaction_id, user.id]
      );
      const parent = parentResult.rows[0];
      if (parent) {
        const newPaidAmount = (parent.paid_amount || 0) + (draft.amount || 0);
        const newStatus = newPaidAmount >= parent.amount ? 'paid' : 'partial';
        await client.query(
          `UPDATE transactions
           SET payment_status = $1, paid_amount = $2, updated_at = $3
           WHERE id = $4`,
          [newStatus, newPaidAmount, now, draft.parent_transaction_id]
        );
        console.log(
          `[transactions] payment id=${transactionId} settled parent id=${draft.parent_transaction_id} → status=${newStatus} paid_amount=${newPaidAmount}`
        );
      }
    }

    let baseAmount;
    let exchangeRate;
    let rateSource;
    if (sameCurrency) {
      baseAmount = draft.amount;
      exchangeRate = 1.0;
      rateSource = 'same_currency';
    } else if (typeof draft.exchange_rate === 'number' && draft.exchange_rate > 0) {
      baseAmount = draft.amount * draft.exchange_rate;
      exchangeRate = draft.exchange_rate;
      rateSource = draft.exchange_rate_source || 'manual';
    } else {
      baseAmount = null;
      exchangeRate = null;
      rateSource = 'pending';
    }

    await client.query(
      `INSERT INTO transaction_postings (
        transaction_id, party_user_id, side, status,
        base_amount, base_currency, exchange_rate, exchange_rate_source,
        created_at, updated_at
      ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)`,
      [
        transactionId,
        user.id,
        userSide,
        baseAmount,
        baseCurrency,
        exchangeRate,
        rateSource,
        now,
        now,
      ]
    );

    return { id: transactionId };
  });
}

module.exports = { save, computeDueDate };

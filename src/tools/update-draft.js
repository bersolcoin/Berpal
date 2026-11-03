const { ts } = require('../erp-sync/common');

const definition = {
  name: 'update_draft',
  description:
    'Update fields on the in-progress transaction draft. Call this whenever you extract any information from the user, even partial. Only include fields you actually inferred from the conversation.',
  parameters: {
    type: 'object',
    properties: {
      transaction_date: {
        type: 'string',
        description:
          'ISO date YYYY-MM-DD. Resolve relative phrases ("yesterday", "last Tuesday") to absolute dates using today as reference.',
      },
      direction: { type: 'string', enum: ['expense', 'income', 'transfer'] },
      amount: {
        type: 'number',
        description: 'The transaction amount in transaction currency. Positive number.',
      },
      currency: { type: 'string', description: 'ISO 4217 currency code, e.g. THB, USD, EUR.' },
      counterparty_name: {
        type: 'string',
        description: 'The other party (vendor name, customer name, person name).',
      },
      counterparty_phone: {
        type: 'string',
        description: 'Phone number of the counterparty if shared. For invoice_issued/bill_received with a NEW counterparty, ask for this.',
      },
      counterparty_email: { type: 'string', description: 'Email of the counterparty if shared (e.g. from a vCard).' },
      counterparty_nickname: {
        type: 'string',
        description: 'Casual identifier the user uses for this counterparty (e.g., "tall mike", "the regular customer", "Big J"). Capture when the user uses one. Used for fuzzy lookup later.',
      },
      counterparty_contact_skipped: {
        type: 'boolean',
        description: 'Set true when the user says "skip"/"no"/"later" in response to the new-counterparty contact ask. Lets request_confirmation proceed without a phone for invoice/bill flows.',
      },
      counterparty_id: {
        type: 'number',
        description: 'Existing counterparty id from lookup_counterparty / create_contact. When set, the save uses that exact contact instead of matching by name — preventing duplicate records.',
      },
      payment_account_id: {
        type: 'number',
        description: 'Wallet id (from list_user_accounts / create_user_account) the cash/bank movement hits. For direction=transfer, this is the SOURCE wallet (where money leaves).',
      },
      transfer_destination_account_id: {
        type: 'number',
        description: 'For direction=transfer ONLY: the DESTINATION wallet id (where the money lands). Both this and payment_account_id must be set for transfers.',
      },
      wallet_skipped: {
        type: 'boolean',
        description: "Set true only when the user explicitly said 'skip' to the wallet picker. The entry then posts to the generic Cash account.",
      },
      category_code: {
        type: 'string',
        description:
          'Code from the chart of accounts (e.g. "5100"). YOU pick this based on context — never ask the user. If nothing reasonably fits, default to "5900" (Other Expenses) silently.',
      },
      payment_method: {
        type: 'string',
        enum: ['cash', 'bank_transfer', 'credit_card', 'debit_card', 'wallet', 'cheque', 'other'],
      },
      payment_account_code: {
        type: 'string',
        description:
          'Code from the chart of accounts for the asset/liability account hit. YOU pick: default to "1000" (Cash) for small expenses unless user mentions card/bank. "bank"/"transfer" → "1100", "credit card"/"visa"/"mastercard" → "2100".',
      },
      description: {
        type: 'string',
        description: 'Free-text memo describing what the transaction was for.',
      },
      tax_amount: { type: 'number' },
      tax_rate: { type: 'number', description: 'Tax rate as a percentage, e.g. 7 for 7%.' },
      tax_inclusive: {
        type: 'boolean',
        description: 'True if amount already includes tax; false if tax is on top.',
      },
      transaction_type: {
        type: 'string',
        enum: ['cash', 'invoice_issued', 'bill_received', 'payment', 'advance_given', 'advance_received'],
        description: 'Default cash. invoice_issued = you sent an invoice (you are owed). bill_received = you got a bill (you owe). payment = settles a prior invoice/bill/advance. advance_given = simple journal entry: you gave money to a counterparty for any non-trade reason (prepay, advance, friendly cash, refund) — cash leaves your wallet, an open balance is recorded against them. advance_received = mirror: someone gave you money for any non-trade reason — cash arrives, an open balance recorded.',
      },
      payment_terms: {
        type: 'string',
        enum: ['net_0', 'net_7', 'net_15', 'net_30', 'net_60', 'custom'],
        description: 'For invoices/bills only. "due immediately"/"on receipt" = net_0; "net 30"/"due in 30 days" = net_30, etc.',
      },
      due_date: {
        type: 'string',
        description: 'For invoices/bills: ISO date YYYY-MM-DD when payment is due. Compute from payment_terms + transaction_date if not explicitly stated.',
      },
      delivery_date: {
        type: 'string',
        description: 'When goods/services were/will be delivered (often ≠ transaction_date for invoices). ISO date YYYY-MM-DD.',
      },
      parent_invoice_name: {
        type: 'string',
        description: 'For payment transactions only: the ref of the invoice/bill/advance being settled, exactly as returned by query_open_invoices or save_transaction (e.g. "ACC-SINV-2026-00004").',
      },
      parent_invoice_doctype: {
        type: 'string',
        enum: ['Sales Invoice', 'Purchase Invoice', 'Journal Entry'],
        description: 'The doctype of parent_invoice_name, as returned alongside the ref.',
      },
      invoice_number: {
        type: 'string',
        description: "External invoice/bill reference number (the supplier's number for bill_received, your own number for invoice_issued).",
      },
      exchange_rate: {
        type: 'number',
        description: 'Exchange rate from transaction currency to user reporting currency (1 unit of currency = N units of reporting_currency). Set after calling fetch_exchange_rate, or when user explicitly states a rate ("use rate 36.5").',
      },
      exchange_rate_source: {
        type: 'string',
        description: 'Where the rate came from: "frankfurter" (auto-fetched), "manual" (user override), or "same_currency".',
      },
    },
  },
};

async function execute(args, ctx) {
  ctx.draft = { ...ctx.draft, ...args };
  console.log(`• [tools] [${ts()}] tool=update_draft draft=${JSON.stringify(ctx.draft)}`);
  return { ok: true, current_draft: ctx.draft };
}

module.exports = { definition, execute };

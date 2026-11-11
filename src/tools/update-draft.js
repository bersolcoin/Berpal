const { ts } = require('../erp-sync/common');
const { stripProtected } = require('./validate');
const lots = require('../lots');

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
        description: 'The transaction amount in transaction currency, exactly as the user stated it (with VAT: gross if tax_inclusive, net otherwise). Positive number. With items it must equal Σ qty×rate — you may omit it.',
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
        description: "Set automatically when the user replies 'skip' to the wallet picker. Never set this yourself — ask the user instead.",
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
      tax_amount: {
        type: 'number',
        description: 'Informational only — request_confirmation recomputes VAT from tax_rate/tax_inclusive and overwrites this.',
      },
      tax_rate: {
        type: 'number',
        description: 'VAT rate as a percentage (Thailand: 7). Set ONLY when the user mentions VAT/tax/a tax invoice; otherwise leave unset (no VAT).',
      },
      tax_inclusive: {
        type: 'boolean',
        description: 'With tax_rate: true if the stated amount/rates already include VAT ("incl VAT", "รวม VAT", a receipt total); false if VAT is added on top ("+VAT", "plus 7%", "ex VAT").',
      },
      wht_rate: {
        type: 'number',
        enum: [0, 1, 2, 3, 5],
        description: 'Thai withholding tax % the USER deducts when paying a supplier (bill_received or cash expense only): 3 services/professional fees/contractors, 1 transport, 5 rent, 2 advertising. 0 removes it. Set only when the user withholds (they are a company/juristic person paying ≥1,000 THB) or says so ("withheld 3%", "หัก ณ ที่จ่าย"). Never on goods or sales.',
      },
      wht_form: {
        type: 'string',
        enum: ['PND3', 'PND53'],
        description: 'Required with wht_rate: PND53 if the payee is a company/juristic person (Co., Ltd., บริษัท, หจก.), PND3 if an individual.',
      },
      paid_after_wht: {
        type: 'number',
        description: 'When the user states what they actually transferred AFTER withholding ("sent 9,700 after 3%"): that figure. Leave amount unset — the gross is computed. 0 clears it (setting amount also clears it).',
      },
      receipt_media_id: {
        type: 'number',
        description: 'media_id from the latest "[receipt scanned] {…}" line. Set it whenever the draft comes from a scan so the image is attached to the saved ERPNext document. Never invent one.',
      },
      vat_claimable: {
        type: 'boolean',
        description: 'false when the purchase VAT cannot be claimed (abbreviated tax invoice ใบกำกับภาษีอย่างย่อ, plain receipt). Leave unset otherwise.',
      },
      items: {
        type: 'array',
        description: 'Line items for invoice_issued / bill_received. Use when the user lists several things, or names a SKU/stone id (then one row with item_code). Rates are on the same VAT basis as the amount. amount must equal Σ qty×rate — omit amount and it is computed. Replaces the whole list on every call.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What the line is, e.g. "ruby 7.68ct" or "cutting service".' },
            qty: { type: 'number', description: 'Quantity (default 1).' },
            rate: { type: 'number', description: 'Price per unit in transaction currency.' },
            item_code: {
              type: 'string',
              description: 'Stock id ONLY when the user names one ("pa2293", "lot R-17", "SKU 4471") — makes it a tracked stock item. Never invent one; leave unset for services and untracked goods.',
            },
            force_item_code: {
              type: 'boolean',
              description: 'true only when the user explicitly said a code WITHOUT digits is their stock code (request_confirmation otherwise treats it as a description).',
            },
          },
          required: ['rate'],
        },
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
      settles_advance: {
        type: 'boolean',
        description: 'For a payment with NO parent_invoice_name: true only when the user says it settles an advance (money given/received earlier as an advance, not an invoice).',
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

/**
 * The same tool as a gem trader's model should see it: a line may carry a `lot` block (a lot
 * bought or sold by the carat; lots/draft.js turns its price into the line total, so `rate` is
 * not required). Everyone else gets `definition` untouched.
 */
const lotLine = {
  type: 'object',
  description: 'Gem lot bought (bill_received) or sold (invoice_issued) on this line. Price as said in price + pricing_basis; leave rate out. Never invent a code, weight or price.',
  properties: {
    code: { type: 'string', description: 'Selling: the lot sold. Buying: only when the trader names one.' },
    carats: { type: 'number', description: 'Weight in carats (1 gram = 5 carats). Selling: leave out for the whole lot.' },
    pieces: { type: 'number', description: 'Only when counted.' },
    weight_estimated: { type: 'boolean', description: 'true when the weight is a guess.' },
    price: { type: 'number', description: 'As said: per carat, gram, kilo, piece or the whole sum (see pricing_basis).' },
    pricing_basis: { type: 'string', enum: lots.PRICING_BASES },
    form: { type: 'string', enum: lots.FORMS, description: 'Buying: required.' },
    species: { type: 'string', description: 'e.g. corundum.' },
    variety: { type: 'string', description: 'e.g. sapphire, ruby.' },
    shape: { type: 'string' },
    size: { type: 'string' },
    colour: { type: 'string' },
    clarity: { type: 'string' },
    origin: { type: 'string' },
    grade: { type: 'string', description: 'The trader\'s own grade.' },
    description: { type: 'string' },
    treatment: { type: 'string', enum: lots.TREATMENTS },
    treatment_source: { type: 'string', description: 'Who says so: seller, lab or own.' },
    supplier_doc: { type: 'boolean', description: 'Buying: the supplier gave a document.' },
    vat_exempt: { type: 'boolean', description: 'Buying: under the VAT exemption for uncut stones.' },
  },
  required: ['carats', 'price', 'pricing_basis'],
};
const gemsItems = {
  ...definition.parameters.properties.items,
  description: `${definition.parameters.properties.items.description} A gem lot (parcel) bought or sold by weight goes in a line's lot block instead of item_code.`,
  items: {
    ...definition.parameters.properties.items.items,
    properties: {
      ...definition.parameters.properties.items.items.properties,
      // A lot code ("L12") is not a stock id: the general examples would compete with it.
      item_code: { type: 'string', description: 'Stock id ONLY for a single stone kept by the piece under its own id the user names ("pa2293", "SKU 4471"). Never a lot code (those go in the lot block). Never invent one.' },
      lot: lotLine,
    },
    required: [],
  },
};
const nicheDefinitions = {
  [lots.NICHE]: { ...definition, parameters: { ...definition.parameters, properties: { ...definition.parameters.properties, items: gemsItems } } },
};

async function execute(args, ctx) {
  // Server-only keys never come from the model, even if it copies them from a tool result.
  // wallet_skipped is only ever set from the user's own 'skip' reply (conversation.js).
  const { wallet_skipped, ...accepted } = stripProtected(args);
  // A stock operation is set through update_stock_op only, and the fee category of a transform by
  // the lot gate only: here both are dropped, like the protected keys.
  const refused = [];
  if ('stock_op' in accepted) {
    delete accepted.stock_op;
    refused.push('stock_op is set with update_stock_op, not update_draft');
  }
  if (String(accepted.category_code) === lots.FEE_CATEGORY_CODE) {
    delete accepted.category_code;
    refused.push(`category_code ${lots.FEE_CATEGORY_CODE} is set by the system for the fee of a cutting / heating operation`);
  }
  // The user picked a wallet by number this turn (conversation.js resolved it): that pick stands.
  if (ctx.pickedWallet && accepted.payment_account_id !== undefined && Number(accepted.payment_account_id) !== Number(ctx.pickedWallet)) {
    console.log(`• [tools] [${ts()}] update_draft: kept the user's wallet pick ${ctx.pickedWallet} over payment_account_id=${accepted.payment_account_id}`);
    delete accepted.payment_account_id;
  }
  if (wallet_skipped) accepted.wallet_skip_requested_by_model = true;
  const amountBefore = ctx.draft.amount;
  ctx.draft = { ...ctx.draft, ...accepted };
  // A newly stated amount supersedes an earlier "paid N after WHT" — otherwise applyDefaults
  // would keep re-deriving the old figure over what the user just said.
  if (args.amount != null && args.paid_after_wht === undefined) delete ctx.draft.paid_after_wht;
  // ...and a different one is the trader's figure now, no longer one the server worked out from fee_rate.
  if (args.amount != null && Number(args.amount) !== Number(amountBefore) && lots.hasStockOp(ctx.draft) && ctx.draft.stock_op.fee_derived) {
    const { fee_derived, ...stated } = ctx.draft.stock_op;
    ctx.draft.stock_op = stated;
  }
  console.log(`• [tools] [${ts()}] tool=update_draft draft=${JSON.stringify(ctx.draft)}`);
  return {
    ok: true,
    current_draft: stripProtected(ctx.draft),
    ...(refused.length ? { note: `Not applied: ${refused.join('; ')}.` } : {}),
  };
}

module.exports = { definition, execute, nicheDefinitions };

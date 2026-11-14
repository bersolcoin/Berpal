const OpenAI = require('openai');
const { query } = require('./db');
const { ts } = require('./log');
const exchange = require('./exchange');
const erpnext = require('./erpnext');
const erpSync = require('./erp-sync');
const erpQuery = require('./erp-query');
const todos = require('./todos');
const { validateDraft: validateDraftServer } = require('./erp-sync/validate');
const { resolveOrCreateCustomer } = require('./erp-sync/customer');
const { resolveOrCreateSupplier } = require('./erp-sync/supplier');
const { resolveWalletAccount } = require('./erp-sync/wallet');
const { resolveItem, createItem, lookupItemByAttributes } = require('./erp-sync/item');
const { resolveErpAccount } = require('./erp-sync/account');
const { recordOpeningBalance } = require('./erp-sync/opening-balance');
const { linkCounterparty } = require('./links/counterparty-match');
const { filterByNameMatch, normalizeNameForMatch } = require('./links/name-match');

// Inlined twin of app/(app)/_components/format.js#friendlyAccountName.
// Kept duplicate (rather than require'd) because the app/ file is JSX/ESM
// and not consumable from CommonJS src/. Keep both versions in sync.
const ACCOUNT_ABBR_RE = /^[A-Z0-9]{2,10}$/;
/**
 * Server-built reply for a successful save. Used as a short-circuit
 * so the user sees a fixed-format confirmation every time, instead of
 * the LLM rephrasing it (and occasionally drifting / claiming success
 * on a failed payment leg). Mirrors the templates that were previously
 * in the LLM prompt — change here, NOT in the prompt.
 */
function formatSaveSuccessReply(result, draft) {
  const inv = result.erpnext_name;
  const pay = result.payment_entry_name;
  const payErr = result.payment_entry_error;
  const tt = draft?.transaction_type;

  if (tt === 'invoice_issued' || tt === 'bill_received') {
    if (payErr) {
      return (
        `Invoice saved ✓ ${inv}\n` +
        `Payment didn't post: ${payErr}\n` +
        `Tell me when you settle it and I'll book the payment.`
      );
    }
    if (pay) {
      return `Saved ✓\nInvoice: ${inv}\nPayment: ${pay}`;
    }
    return `Saved ✓\nRef: ${inv}`;
  }
  // payment / cash JE / transfer / opening / etc. all share the simple form.
  return `Saved ✓\nRef: ${inv}`;
}

function friendlyAccountName(erpName) {
  if (!erpName) return '';
  const parts = String(erpName).split(' - ');
  if (parts.length < 2) return erpName;
  if (ACCOUNT_ABBR_RE.test(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && /^\d+$/.test(parts[0])) parts.shift();
  return parts.join(' - ') || erpName;
}

// Account resolvers, customer/item resolvers, naming helpers, and ERP_CODE_MAP
// all live in src/erp-sync/ — see imports at the top of this file.

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const RECENT_MESSAGES_LIMIT = 20;
const MAX_TOOL_LOOP_ITERATIONS = 12;
const REQUIRED_FIELDS = ['amount', 'currency', 'direction', 'transaction_date'];

const TOOLS = [
  {
    type: 'function',
    function: {
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
            description: 'Existing counterparty record id, set after lookup_counterparty resolved which existing record the user meant. When set, transactions.save uses it directly instead of name-based find-or-create — preventing duplicate counterparty records.',
          },
          payment_account_id: {
            type: 'number',
            description: 'Specific user account instance id (from list_user_accounts) the cash/bank movement hits. Set after picker resolves which account. If user has only one matching account for the type+currency, transactions.save will auto-link — but setting it explicitly is preferred for clarity. For direction=transfer, this is the SOURCE wallet (where money leaves).',
          },
          transfer_destination_account_id: {
            type: 'number',
            description: 'For direction=transfer ONLY: the DESTINATION wallet id (where the money lands). Combined with payment_account_id (source), records the move in one transaction row. Both must be set for transfers.',
          },
          transfer_destination_account_code: {
            type: 'string',
            description: 'For direction=transfer ONLY: chart-of-accounts code of the DESTINATION wallet type ("1000" cash, "1100" bank, "2100" credit card). Parallel to payment_account_code which is the SOURCE side.',
          },
          transfer_destination_wallet_name: {
            type: 'string',
            description: 'For direction=transfer ONLY: short name of the SPECIFIC destination wallet (e.g. "BBL Savings"). REQUIRED when transfer_destination_account_code is 1100 or 2100.',
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
          wallet_name: {
            type: 'string',
            description: 'Short name of the SPECIFIC wallet involved — e.g. "BBL Savings", "SCB", "KBank", "AmEx Platinum". REQUIRED whenever payment_account_code is 1100 (bank) or 2100 (credit card). OPTIONAL for 1000 (cash). Used when the bot needs to create the wallet account in ERPNext on first use (becomes the leaf account name, e.g. "BBL Savings USD - TTC").',
          },
          payment_reference: {
            type: 'string',
            description: 'External reference for bank/card payments — wire confirmation code, deposit slip number, SWIFT/MT103 ref, card auth code, etc. Extract from phrases like "wired via SWIFT 12345", "ref 88-7766", "auth code XYZ". OPTIONAL — defaults to "Settles <invoice>" if not provided. Used as Reference No on ERPNext Payment Entry (required by ERPNext for any Bank-type payment).',
          },
          description: {
            type: 'string',
            description: 'Free-text memo describing what the transaction was for. For cash transactions and single-line invoices without per-item detail. For multi-line invoices use items[] instead.',
          },
          items: {
            type: 'array',
            description: 'PRODUCT/STOCK transactions (invoice_issued / bill_received for product/both business_type) — one entry per line. Single-item sales should also use this array (length=1). For each item supply item_code (user\'s SKU, verbatim), qty (count or weight depending on the item\'s unit_type — server reconciles), rate (price per unit), and weight_ct when the user mentions weight on a per-piece sale (e.g. "1.05ct paraiba pa2293 to Mike for 1000$" → items=[{item_code:"pa2293", qty:1, rate:1000, weight_ct:1.05}]). Multi-line example: "sold 1.05ct paraiba pa2293 and 0.8ct ruby rb007 to Mike total 1500$" → items=[{item_code:"pa2293", qty:1, rate:1000, weight_ct:1.05},{item_code:"rb007", qty:1, rate:500, weight_ct:0.8}]. When user gives only a single total without per-line rates, distribute reasonably or ask. amount (top-level) should equal sum(qty*rate); the server validates.',
            items: {
              type: 'object',
              properties: {
                item_code: { type: 'string', description: 'User\'s SKU verbatim (e.g. "pa2293"). REQUIRED for product/both business_type sales.' },
                qty: { type: 'number', description: 'For piece-type items: count of stones (usually 1 per line). For weight-type items: total carats. Default 1 if user said "a stone" / didn\'t mention qty.' },
                rate: { type: 'number', description: 'Price per qty unit. For a "sold pa2293 for $1000" with qty=1 → rate=1000.' },
                weight_ct: { type: 'number', description: 'Carat weight of the stone on this line. Capture when the user mentions it ("1.05ct"); written to the SI line for receipts/reports.' },
                description: { type: 'string', description: 'Optional line memo.' },
              },
              required: ['item_code'],
            },
          },
          tax_amount: { type: 'number' },
          tax_rate: { type: 'number', description: 'Tax rate as a percentage, e.g. 7 for 7%.' },
          tax_inclusive: {
            type: 'boolean',
            description: 'True if amount already includes tax; false if tax is on top.',
          },
          party_type: {
            type: 'string',
            enum: ['Customer', 'Supplier'],
            description: 'Required for transaction_type=advance_given / advance_received. Tells the server which side of the books to charge. Customer = the other party is a buyer-from-you (advances they paid, refunds you gave them). Supplier = the other party is a seller-to-you (prepayments you made, refunds they gave you).',
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
          parent_invoice_ref: {
            type: 'string',
            description: 'For transaction_type=payment ONLY: the ERPNext name of the invoice/bill being settled (e.g. "ACC-SINV-2026-00001" for AR, "ACC-PINV-2026-00001" for AP). Get this from query_open_invoices.invoices[N].erpnext_name. Required for payment transactions.',
          },
          paid_now: {
            type: 'boolean',
            description: 'For transaction_type=invoice_issued / bill_received ONLY. Set TRUE when the same message says the invoice/bill was paid at the time it was raised (e.g. "sold X to Acme for 2000 USD, got paid cash"; "received a bill from Acme for 500 USD, paid via BBL"). On save, the server posts BOTH the Invoice/Bill AND a matching Payment Entry that settles it in one shot, so AR/AP is created and immediately cleared. Requires payment_account_code (and wallet_name if bank/card). When FALSE/omitted, only the Invoice/Bill is posted and AR/AP stays open until a later "X paid me Y" / "I paid X Y" message.',
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_confirmation',
      description:
        'Indicates you have all required fields and your text reply contains a clean summary for the user to confirm. Use only when amount, currency, direction, and transaction_date are all set in the draft.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_transaction',
      description:
        'Save the draft as a confirmed transaction. ONLY call after the user has explicitly confirmed (yes/save/ok in response to your confirmation summary). Never auto-save.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_transaction',
      description:
        'Discard the current draft and reset. Call if user says cancel, forget it, never mind, etc.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ─── ERPNext-pivot temporary slim-down ────────────────────────────
  // The following tools were removed and will be re-added as ERPNext-backed
  // equivalents during incremental rebuild:
  //   query_open_invoices, query_balance_with_counterparty, query_upcoming,
  //   query_transaction_summary, lookup_counterparty, create_contact,
  //   list_user_accounts, create_user_account, query_cash_bank_balance.
  // fetch_exchange_rate is kept (pure HTTP, no DB).
  // ──────────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fetch_exchange_rate',
      description:
        'Fetch the exchange rate from one currency to another for a given date (ECB reference rates via frankfurter.app). Call this when the transaction currency differs from the user\'s reporting currency, BEFORE request_confirmation. After getting the rate, call update_draft with exchange_rate + exchange_rate_source so the saved transaction stores the conversion.',
      parameters: {
        type: 'object',
        required: ['from_currency', 'to_currency'],
        properties: {
          from_currency: { type: 'string', description: 'ISO 4217 code, e.g. "USD".' },
          to_currency: { type: 'string', description: 'ISO 4217 code, e.g. "THB".' },
          date: {
            type: 'string',
            description: 'ISO YYYY-MM-DD; the transaction_date works best. Defaults to today if omitted. Frankfurter may return the previous business day for weekends.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_balance_with_counterparty',
      description:
        'Compute a counterparty\'s net balance in ERPNext: outstanding open invoices MINUS advances on file. Returns per-currency net (positive = they owe us / we owe them; negative = advance sitting on their account in our favor / our favor for supplier). Use when the user asks "what does X owe me", "X\'s balance", "do I owe X anything", "balance with X". Resolves the natural-language counterparty name to its ERPNext record via the local counterparty_cache.',
      parameters: {
        type: 'object',
        required: ['counterparty_name', 'party_type'],
        properties: {
          counterparty_name: {
            type: 'string',
            description: 'Natural-language counterparty name as the user said it (e.g. "Acme Trading"). The bot resolves this to the ERPNext party name internally.',
          },
          party_type: {
            type: 'string',
            enum: ['Customer', 'Supplier', 'Both'],
            description: 'DEFAULT: "Both". Use "Both" for nearly every balance question — it shows AR and AP sides together (the empty side is auto-hidden in the answer) and gives the user the full relationship picture. Only pass "Customer" or "Supplier" when the user explicitly drilled down to one direction (e.g. "show me ONLY what\'s outstanding from X", "list bills from X only"). Even questions phrased as "what does X owe me" or "what do I owe X" should use "Both" — the user wants their position with X, not a half-view.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_open_invoices',
      description:
        'List unpaid invoices (Sales Invoice for AR / Purchase Invoice for AP) from ERPNext. Call BEFORE setting transaction_type=payment, so you can pick the right invoice to settle. Returns each invoice\'s ERPNext name (e.g. ACC-SINV-2026-00001), counterparty, currency, grand_total, and outstanding_amount. Use the ERPNext name as parent_invoice_ref on the payment draft.',
      parameters: {
        type: 'object',
        required: ['direction'],
        properties: {
          direction: {
            type: 'string',
            enum: ['receivable', 'payable'],
            description: '"receivable" = invoices we issued (customer owes us). "payable" = bills from suppliers (we owe).',
          },
          counterparty_search: {
            type: 'string',
            description: 'Optional. Filter to invoices for this customer/supplier (exact match by ERPNext name). Omit to list all open invoices.',
          },
          limit: {
            type: 'number',
            description: 'Optional. Max rows to return; default 20.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_counterparty_details',
      description:
        'Look up metadata about a customer / supplier — default currency, phone, email, group, etc. Use when the user asks identity or contact questions like "what currency is X", "what\'s X\'s phone", "details of X", "is Acme a customer or supplier".',
      parameters: {
        type: 'object',
        required: ['counterparty_name'],
        properties: {
          counterparty_name: {
            type: 'string',
            description: 'Natural-language counterparty name as the user said it.',
          },
          party_type: {
            type: 'string',
            enum: ['Customer', 'Supplier', 'Both'],
            description: 'Default "Both" — returns whichever sides exist in ERPNext (some counterparties are only a Customer, only a Supplier, or both).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_pending_todos',
      description:
        'List the user\'s pending TODOs (deferred follow-up questions about past transactions, e.g. "you sold X but I don\'t know who you bought it from"). Use ONLY when the user explicitly asks ("any todos?", "anything pending?", "what should I do?", "any follow-ups?"). NEVER proactively. Returns id, kind, and the question the user needs to answer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_todo',
      description:
        'Resolve a pending TODO with the user\'s answer. Call after the user has answered the question from query_pending_todos. Pass the todo `id` and an `input` object whose shape depends on the TODO kind — for unknown_item_purchase the fields are { supplier_name, unit_cost, purchase_date?, skip? }. Use skip:true if the user says "skip it" / "I don\'t remember" — that just deletes the TODO without creating any document.',
      parameters: {
        type: 'object',
        required: ['id', 'input'],
        properties: {
          id: { type: 'integer', description: 'The TODO id from query_pending_todos.' },
          input: {
            type: 'object',
            description: 'Kind-specific answer payload. See tool description.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_cash_bank_balance',
      description:
        'List the user\'s current cash, bank, and credit-card balances per wallet, with totals per currency. Use when the user asks "how much money do I have", "what\'s my bank balance", "current cash position", "what\'s in my wallets". Credit-card balances come back negative (you owe).',
      parameters: {
        type: 'object',
        properties: {
          as_of: {
            type: 'string',
            description: 'Optional ISO YYYY-MM-DD. Default: today.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_counterparty',
      description:
        'STANDALONE: create a new contact (Customer, Supplier, or Both) in ERPNext WITHOUT logging a transaction. Use when the user explicitly asks to add a contact ("add contact for X", "save Acme as a new customer", "new supplier"), or when a vCard share has no transaction context. For transaction flows (sales, bills, payments) do NOT call this — the counterparty is auto-created at save time. Returns the ERPNext party name(s) created.',
      parameters: {
        type: 'object',
        required: ['name', 'party_type'],
        properties: {
          name: { type: 'string', description: 'Full name of the contact.' },
          party_type: {
            type: 'string',
            enum: ['Customer', 'Supplier', 'Both'],
            description: '"Customer" if they buy from us; "Supplier" if we buy from them; "Both" if both (common for gem cutters / wholesalers). If unclear from context, ASK the user before calling.',
          },
          phone: {
            type: 'string',
            description: 'E.164 phone (e.g. "+12345550111"). If user gave a bare number, apply country-code inference first.',
          },
          email: { type: 'string', description: 'Optional.' },
          nickname: { type: 'string', description: 'Optional fuzzy alias like "tall mike".' },
          default_currency: { type: 'string', description: 'Optional ISO code; set if you know they trade in non-base currency.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_wallet',
      description:
        'STANDALONE: create a new cash/bank/credit-card wallet in ERPNext WITHOUT logging a transaction. Use when the user explicitly asks ("add bank account BBL Savings USD", "create new card AmEx", "set up cash drawer Bangkok THB"). For payment flows do NOT call this — the wallet is auto-created at save time when first used. Returns the ERPNext account name. If opening_balance is provided AND > 0, the bot ALSO posts an Opening Balance JE (DR wallet, CR Opening Balance Equity).',
      parameters: {
        type: 'object',
        properties: {
          wallet_name: {
            type: 'string',
            description: 'Specific name — e.g. "BBL Savings", "HSBC HK", "AmEx Platinum", "Cash Bangkok".',
          },
          parent_code: {
            type: 'string',
            enum: ['1000', '1100', '2100'],
            description: '"1000" for Cash, "1100" for Bank, "2100" for Credit Card.',
          },
          currency: { type: 'string', description: 'ISO code (e.g. "USD", "THB").' },
          opening_balance: {
            type: 'number',
            description: 'Current balance on the wallet right now, in the wallet\'s currency. Pass 0 (or omit) if the user said "skip"/"later"/"0"/"none". When > 0, the bot books an Opening Balance JE (DR wallet, CR Opening Balance Equity).',
          },
          opening_balance_skipped: {
            type: 'boolean',
            description: 'Set true when user explicitly says skip/no/later/none in response to the opening-balance ask. Lets the server proceed without booking a JE.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_item',
      description:
        'STANDALONE: create a new Item (product/service) in ERPNext WITHOUT logging a transaction. Use when (a) the user explicitly asks ("add item pa2293", "create new product Sapphire 1ct"), OR (b) the user has provided enough detail to bring a previously-unknown item into existence so the next save_transaction can reference it (e.g. after a save_transaction returned new_item error). is_stock_item and stock_uom are decided server-side from business_type and unit_type — do NOT pass uom unless override is intentional. Returns the created item_code. Industry-specific attributes (gem_type, weight_ct, color, origin, etc.) go in the `attributes` object — the server tells you which are required for this user\'s industry.',
      parameters: {
        type: 'object',
        required: ['item_code'],
        properties: {
          item_code: {
            type: 'string',
            description: 'User\'s reference code/SKU — typed verbatim ("pa2293", "rb-007"). The server suffixes per tenant.',
          },
          item_name: {
            type: 'string',
            description: 'Optional friendly name. Defaults to item_code if not provided.',
          },
          description: {
            type: 'string',
            description: 'Optional longer description. Default: item_name.',
          },
          unit_type: {
            type: 'string',
            enum: ['piece', 'weight'],
            description: 'How this item is sold/inventoried. "piece" = one stock unit per physical thing (stock_uom=Nos; each gem-stone or each garment). "weight" = sold by weight (stock_uom=Ct for gems, Kg for spices, etc.); qty on a sale line equals total weight sold. Default is "piece" for single-item cases; ASK when ambiguous (parcels, bulk).',
          },
          uom: {
            type: 'string',
            description: 'Optional override of the unit-of-measure. Server picks "Nos" for unit_type=piece, "Ct" for unit_type=weight (gemstone industry). Only set if user explicitly says something else ("Kg", "Lt", "Hour").',
          },
          attributes: {
            type: 'object',
            description: 'Industry-specific fields. For gemstones: gem_type ("Sapphire"|"Ruby"|"Emerald"|"Diamond"|"Paraiba"|"Spinel"|"Tourmaline"|"Tanzanite"|"Aquamarine"|"Other"), weight_ct (number — required for piece-type), color (string), origin (string), shape ("Round"|"Oval"|"Cushion"|"Pear"|"Princess"|"Emerald Cut"|"Heart"|"Marquise"|"Rough"|"Other"), treatment ("Heated"|"Unheated"|"Oiled"|"Diffused"|"None"|"Unknown"). The server tells you exactly which are required when it returns needs_user_input.',
            properties: {
              gem_type: { type: 'string' },
              weight_ct: { type: 'number' },
              color: { type: 'string' },
              origin: { type: 'string' },
              shape: { type: 'string' },
              treatment: { type: 'string' },
            },
          },
          opening_qty: {
            type: 'number',
            description: 'For stock items only: how many of this item the user has on hand RIGHT NOW. For unit_type=piece, this is a count. For unit_type=weight, this is total weight on hand. Pass 0 (or omit + opening_qty_skipped=true) if user says "none"/"skip"/"later". When > 0 and the item is stock-tracked, the server posts a Stock Reconciliation.',
          },
          opening_qty_skipped: {
            type: 'boolean',
            description: 'Set true when user explicitly says skip/none/later for the opening-qty ask.',
          },
          unit_cost_basis: {
            type: 'number',
            description: 'Optional. When opening_qty > 0, the valuation rate (cost per unit) for the Stock Reconciliation. Skip if user doesn\'t know — server defaults to 0 and the unknown_item_purchase todo handles cost later.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_item',
      description:
        'STANDALONE: search the user\'s Item catalog. Use when (a) the user asks about an item ("do I have any pa2293?", "what items do I sell?"), or (b) before a save_transaction when you\'re unsure if a referenced SKU exists. Returns 0 / 1 / many matches; on many, ASK the user which one before proceeding.',
      parameters: {
        type: 'object',
        required: ['search_term'],
        properties: {
          search_term: {
            type: 'string',
            description: 'What to search for — item code or name fragment. Free-form ("pa2293", "sapphire", "ruby 1ct").',
          },
        },
      },
    },
  },
];

// Static categorization hint — replaces the old query against the dropped chart_of_accounts table.
// Now used by the LLM to extract a category_code that the push worker maps to ERPNext accounts.
function getCategorizationHint() {
  return `  4000 - Sales Revenue   — selling products: "sold", "sale of <item>", "invoiced for <product>"
  4100 - Service Revenue — selling services: "consulting", "service fee", "labor"
  5000 - Cost of Goods Sold — buying things to resell or hold as inventory: "purchase", "purchased", "bought stones/gems/parcel/stock", "inventory", "got a parcel", "supplier bill for product/goods"
  5100 - Meals & Entertainment — "lunch", "dinner", "coffee", "drinks", "client meal", "restaurant"
  5200 - Travel — "flight", "hotel", "taxi", "uber", "train"
  5210 - Vehicle Expenses — "gas", "fuel", "petrol", "car repair", "parking"
  5300 - Office Supplies — "stationery", "printer", "pens", "paper"
  5400 - Rent — "rent", "lease"
  5500 - Utilities — "electricity", "water", "internet", "phone bill"
  5600 - Software & Subscriptions — "SaaS", "monthly subscription", "Notion", "Slack"
  5700 - Professional Services — "lawyer", "accountant", "consultant fee"
  5800 - Marketing & Advertising — "ads", "campaign", "marketing"
  5900 - Other Expenses — fallback ONLY when nothing else fits; never use this if "purchase"/"goods"/"inventory"/"stock" is in the message
  1000 - Cash (asset, wallet)
  1100 - Bank — Primary (asset, wallet)
  1200 - Accounts Receivable (asset)
  2000 - Accounts Payable (liability)
  2100 - Credit Card (liability, wallet)
  3200 - Opening Balance Equity`;
}

async function buildSystemPrompt({ user, draft, today }) {
  const coaListing = getCategorizationHint();
  const draftJson = JSON.stringify(draft || {}, null, 2);
  return `You are a bookkeeping assistant on WhatsApp. You help the user log transactions and answer questions about their books.

═══════════════════════════════════════════════════════════════════
YOUR JOB EVERY TURN
═══════════════════════════════════════════════════════════════════

1. Read the user's message.
2. Match it to the ONE function below that best fits.
3. Extract relevant data from the message into that function's parameters.
4. Call the function.

If the message is chitchat / off-topic / unclear, reply briefly without calling a function.

If the function returns ok:false with needs_user_input.ask_user — send that text VERBATIM to the user (light conversational wrap OK). The server tells you what to ask; you don't invent your own questions.

If the function returns ok:true — relay the success in a short line (see Success replies below).

═══════════════════════════════════════════════════════════════════
TWO HARD RULES
═══════════════════════════════════════════════════════════════════

RULE 1 — Never ask the user a clarifying question BEFORE calling a function. If you need info to complete an action, call the function with whatever you have; the server will tell you what's missing. The only time you reply without calling a function is for chitchat / off-topic / total ambiguity.

RULE 2 — Never claim success ("Added", "Saved", "Done", "Created", "Posted", "Booked") unless a function returned ok:true in THIS turn. No tool call = no success.

═══════════════════════════════════════════════════════════════════
AVAILABLE FUNCTIONS — match user intent to one of these
═══════════════════════════════════════════════════════════════════

WRITES (state-changing):

• create_wallet — user wants to ADD a wallet/bank/card outside any transaction.
  Triggers: "add bank account", "new wallet", "create card", "set up cash drawer", "add my BBL", "new credit card".
  Extract: wallet_name (the thing right after add/new), parent_code ("1000" cash | "1100" bank | "2100" card), currency, opening_balance.

• create_counterparty — user wants to ADD a contact outside any transaction.
  Triggers: "add contact", "new customer", "new supplier", "save buyer", "add vendor", "I want to add my client".
  Extract: name, party_type ("Customer" | "Supplier" | "Both"), phone (E.164), email, default_currency.
  vCard arrives standalone → still use this function.

• create_item — user wants to ADD a product/item to their catalog. Use this when:
  (a) user explicitly asks ("add item pa2293", "create new product Sapphire 1ct", "register new SKU"), OR
  (b) a prior save_transaction returned new_item error (item didn't exist) — gather the missing details from the user, then call this, then re-try save_transaction.
  Extract: item_code (SKU verbatim), item_name, description, uom (default "Nos"; use "Ct" for carats), opening_qty (how many on hand RIGHT NOW), unit_cost_basis (optional). is_stock_item is decided server-side — never pass it.
  Service-business users get a record-keeping item; product/both users get stock-tracked.

• lookup_item — search the user's item catalog. Use when:
  (a) user asks about items ("do I have pa2293?", "what items do I sell?", "search 'sapphire'"), OR
  (b) before save_transaction when you're unsure if a referenced SKU exists.
  Returns count + matches. On 0 → call create_item (after asking the user for details). On many → list candidates and ask the user which one.

• update_draft — user is DESCRIBING a transaction. Stages fields onto a draft. Cover:

  KEY DECISION — named counterparty changes the type:
    Any sale or purchase mentioning a SPECIFIC counterparty name ("Acme", "BBL", a person's name, a company) creates AR or AP that needs to be tracked per-party. Pick invoice_issued / bill_received — NOT cash — even if the same message says "paid cash". The paid_now flag (below) handles the immediate-payment case. Generic cash income/expense WITHOUT a named counterparty (walk-in sale, lunch, parking, coffee, "got 50 cash from the till") is the only case that uses transaction_type='cash'.

  - Sale to named customer, paid SAME message: "sold X to Acme for 2000 USD got paid cash", "invoiced Acme 500 paid via BBL" → transaction_type='invoice_issued', direction='income', paid_now=true, payment_account_code (+ wallet_name if bank/card). Server posts BOTH a Sales Invoice and a Payment Entry settling it.
  - Sale to named customer on terms: "sold X to Acme for 2000 USD net 30", "invoiced Acme" → transaction_type='invoice_issued', direction='income', paid_now=false (or omit). AR stays open.
  - Bill from named supplier, paid SAME message: "bought X from Acme for 500 USD paid cash" → transaction_type='bill_received', direction='expense', paid_now=true, payment_account_code.
  - Bill from named supplier on terms: "got a bill from Acme for 500 USD net 30" → transaction_type='bill_received', direction='expense', paid_now=false.
  - Cash income/expense (NO named counterparty): "spent 250 on lunch", "paid 50 for parking", "got 100 cash sale" → transaction_type='cash', direction='expense'/'income'.
  - Payment received (settling a PRIOR invoice): "Acme paid me 500", "received 500 from Acme for the invoice" → transaction_type='payment', direction='income'. Use query_open_invoices first to find which SI to settle.
  - Payment made (settling a PRIOR bill): "I paid Acme 500", "sent Acme the 500 for the bill" → transaction_type='payment', direction='expense'. query_open_invoices first.
  - Rate override / corrections: any time the user adjusts a field on the current draft.

  MULTI-ITEM SALES & PURCHASES (product/both business_type only):
    For invoice_issued / bill_received transactions involving real SKUs, populate the items[] array — one entry per stone/lot/line. Single-line sales also use items[] (length=1). Examples:
    - "sold 1.05ct paraiba pa2293 to Mike for 1000$" → items=[{item_code:"pa2293", qty:1, rate:1000, weight_ct:1.05}], amount=1000.
    - "sold 1.05ct paraiba pa2293 AND 0.8ct ruby rb007 to Mike for 1500$ net 30" → items=[{item_code:"pa2293", qty:1, rate:?, weight_ct:1.05},{item_code:"rb007", qty:1, rate:?, weight_ct:0.8}], amount=1500. Per-line rates may be unknown; set them when the user gives them per-line, otherwise leave qty=1 and let the user's total drive amount.
    - "bought parcel pa-rough100 50ct for 8000$ from Acme paid cash" → items=[{item_code:"pa-rough100", qty:50, rate:160}], amount=8000.
    - "sold pa2293 to Mike for 1000$" (no weight in message) → items=[{item_code:"pa2293", qty:1, rate:1000}]. Don't invent a weight_ct — the Item carries it.
    SKU extraction rules: a lowercase/alphanumeric short token next to a count or weight is usually the SKU ("pa2293", "rb007", "pa-rough100"). DO NOT invent SKUs.

    NO-SKU CASE — disambiguate before update_draft: if the user describes an item by attributes only ("sold 1.05ct paraiba to Mike", "sold a 0.8ct ruby"), DO NOT pass that description as an item_code. Instead:
      1. Call lookup_item({ search_term: "<the attribute description verbatim>" }) FIRST. The server parses weight + gem_type and searches by Item Custom Fields, returning candidates.
      2. If count=1: use that item_code in items[] and proceed.
      3. If count>1: list the matches to the user ("Is this pa2293 or pa2294?") and wait for their pick before update_draft.
      4. If count=0: ask the user for the SKU. If they say "new" / "add it" / "create one", trigger create_item with the parsed attributes pre-populated.
  Extract whatever fields are in the message; the server's validation result tells you what's still needed.

• request_confirmation — call ONLY when an update_draft response shows ready_to_confirm=true. The server gates this; don't decide on your own.

• save_transaction — call when the user replies confirm/yes/ok/Confirm/save to a confirmation card.

• cancel_transaction — call when the user replies no/cancel/abort/discard to a confirmation card.

• fetch_exchange_rate — call ONLY when an update_draft response's needs list says exchange_rate is needed. The server tells you when.

READS (no state change):

• query_open_invoices — "what's outstanding", "show unpaid", "list bills", "any open invoices from X". direction='receivable' for invoices we issued, 'payable' for bills we received.

• query_balance_with_counterparty — questions about ONE party. "What does X owe me?", "Do I owe X?", "Where do I stand with X?", "X's balance". DEFAULT party_type='Both' for most balance questions — that shows AR and AP sides together and lets the user see the full picture. Only use 'Customer' or 'Supplier' if user explicitly drills down ("ONLY what X owes me", "list bills from X only").

• query_cash_bank_balance — "how much money do I have", "what's my bank balance", "current cash position", "what's in my wallets".

• query_pending_todos — ONLY when user explicitly asks for pending things: "any todos?", "anything pending?", "what should I do?", "any follow-ups?", "what have I missed?". NEVER volunteer this. NEVER tack it onto a save confirmation. If count=0, reply "Nothing pending." If count>0, list the questions one per line numbered, then stop — let the user pick which to answer.

• resolve_todo — only after a query_pending_todos has been shown and the user supplies an answer to one of the questions. Pass id + input. For unknown_item_purchase the input is { supplier_name, unit_cost, purchase_date?, skip? }. Use skip:true if the user says "skip", "I don't remember", "drop it" — that just deletes the TODO without writing anything.

• get_counterparty_details — identity/contact lookup for ONE party. "What currency is X", "X's phone", "what's Acme's email", "is X a customer or supplier", "details of X". Returns name, default_currency, phone, email, group per side. Don't use for balance — use query_balance_with_counterparty for that.

═══════════════════════════════════════════════════════════════════
EXTRACTION HINTS
═══════════════════════════════════════════════════════════════════

CHART OF ACCOUNTS — pick a category_code for cash/invoice/bill drafts (NOT for payments or transfers):

${coaListing}

  Decision order — pick the FIRST match in this list:
    1. If message contains "purchase", "purchased", "bought ... stones/gems/parcel/stock/inventory", or it's clearly a supplier bill for goods → 5000 (COGS).
    2. If message clearly matches a specific category by its keywords above → that category.
    3. Income: SERVICE-shaped (intangible work: consulting, repair, design, fees, labor, advice, retainer, polishing, cutting, appraisal, brokerage) → 4100. PRODUCT-shaped (a physical item / SKU was handed over: gemstone, parcel, jewellery, goods, merchandise) → 4000. If ambiguous and the user's business_type is 'service' → prefer 4100; if 'product' → prefer 4000; if 'both' or unset → ask one short clarifying question ("was this for goods or for a service?") before picking. The downstream TODO system uses 4100 to skip "where did you buy it?" questions, so getting this right matters.
    4. Expense fallback → 5900 (Other Expenses) — ONLY when nothing above fits and the word "purchase"/"goods"/"stock" is NOT present.

ENTITY PARSING:
• Counterparty: word right after "to" / "from" (single name or multi-word like "Acme Trading"). NEVER ask "who?" when "to <name>" is in the message.
• Wallet identifier: "BBL", "SCB", "HSBC", "KBank" → wallet_name, payment_account_code='1100' (bank). "AmEx", "Visa", "Mastercard" → wallet_name, payment_account_code='2100' (card). Bare "cash" → payment_account_code='1000' (no wallet_name needed).
• Amount: number + currency. If user wrote "5000 us$" or "5000 USD", currency="USD", amount=5000. If currency missing, default to ${user.default_currency} and the server will mark "(assumed)".
• Date: "today"="${today}", "yesterday"=date-1, "last X"=relative. Default transaction_date=today.
• Terms: "net 30"→"net_30", "in 7 days"→"net_7", "cash now"→no terms (leave blank).
• Settlement: "X paid me Y" / "I paid X Y" → transaction_type='payment', direction follows. Use query_open_invoices first to find which invoice to settle. Set parent_invoice_ref=<erpnext_name from the result>.

PHONE COUNTRY CODE INFERENCE:
If user types a phone WITHOUT "+", infer from user.country (${user.country}). Common: TH→+66, IN→+91, US→+1, GB→+44, SG→+65, MY→+60, ID→+62, AE→+971, HK→+852, AU→+61. Strip leading 0 of the local part when prepending. Briefly confirm: "Got it — +66 83 888 3866?".

═══════════════════════════════════════════════════════════════════
RESPONSE RENDERING
═══════════════════════════════════════════════════════════════════

CONFIRMATION CARD — when you call request_confirmation and it returns ok:true, send the user the canonical card text below. Plain newlines, no markdown, no asterisks, no trailing spaces:

Date: YYYY/MM/DD
Amount: <pick ONE form>
   Form A (transaction currency == ${user.reporting_currency}):   Amount: X,XXX ${user.reporting_currency}
   Form B (foreign currency):                                    Amount: X,XXX ${user.reporting_currency} (Y,YYY <foreign_ccy> @ R.RR)
Type: <Sale | Purchase | Expense | Income | Invoice Sent | Bill Received | Payment | Transfer>
   Use "Sale"     when transaction_type='invoice_issued' AND paid_now=true.
   Use "Purchase" when transaction_type='bill_received'  AND paid_now=true.
   Use "Invoice Sent"     for invoice_issued without paid_now.
   Use "Bill Received"    for bill_received without paid_now.
Account: <source_name> → <destination_name>     (one-arrow form; see paid_now below for two-line form)
Counterparty: <name>            (omit entirely if no counterparty)
Due: YYYY/MM/DD (Net N)         (only for Invoice Sent or Bill Received WITHOUT paid_now)
{settles_preview.rendered}      (only for Payment, when present — drop the rendered string in VERBATIM, including its own line break)
Note: <description>             (omit if no description)

Choose below or tell me what to fix.

ACCOUNT ARROW (convention: "<credit side> → <debit side>"):
- Cash income (no counterparty):  Sales Revenue → <wallet_name>
- Cash expense (no counterparty): <wallet_name> → <expense_category>
- Invoice Sent:                   Sales Revenue → Receivable from <counterparty_name>
- Bill Received:                  <expense_category> → Payable to <counterparty_name>
- Payment received:               Receivable from <counterparty_name> → <wallet_name>
- Payment made:                   <wallet_name> → Payable to <counterparty_name>

PAID-NOW (paid_now=true on invoice_issued or bill_received) — TWO ENTRIES, render both on their own lines so the user sees the full dual-post:
- Sale (paid):     Entry 1: Sales Revenue → Receivable from <counterparty_name>
                   Entry 2: Receivable from <counterparty_name> → <wallet_name>
- Purchase (paid): Entry 1: <expense_category> → Payable to <counterparty_name>
                   Entry 2: Payable to <counterparty_name> → <wallet_name>
Skip the Due line in paid_now cases (it's paid).

IMPORTANT: when request_confirmation returns resolved_accounts (with wallet_display / category_display), use THOSE strings VERBATIM as <wallet_name> and <expense_category> in the Account: line. They are the real ERPNext leaf names the save will use (e.g. "cash (HKD)", "Miscellaneous Expenses") — showing generic words like "Cash" hides which currency leaf will be touched.

QUERY ANSWERS — short, scannable, currency-grouped:

(query_balance_with_counterparty with party_type='Both' — render only sides that have data)

Both sides:
"With Acme Trading:
• Acme owes you: 12,000 USD (1 invoice)
• You owe Acme: 3,000 USD (1 bill)
• Net: 9,000 USD in your favor"

Only AR:
"With Acme Trading:
• Acme owes you: 45,000 USD (1 invoice)"

Only AP:
"With Acme Gems:
• You owe Acme: 5,000 USD (1 bill)"

Advance only (no invoices):
"Acme has 5,000 USD on advance with you — no open invoices."

Empty:
"Nothing outstanding with Acme."

(query_cash_bank_balance)
"Cash position:
• Cash (THB) — 12,000 THB
• BBL Savings Bank (THB) — 200,000 THB
• HSBC HK Bank (USD) — 8,000 USD
Totals: 212,000 THB + 8,000 USD"

(query_open_invoices)
"You have 2 unpaid receivables:
• ACC-SINV-2026-00001 to Acme Trading — 45,000 USD (1,444,500 THB @ 32.10), due 2026/06/11
• ACC-SINV-2026-00003 to Vicky FEI — 50,000 USD (1,620,750 THB @ 32.415), due 2026/08/10"

Show overdue with "(OVERDUE by N days)" tag. Empty results: state plainly.

AMBIGUOUS RESPONSES — when a function returns ambiguous_wallet or ambiguous_counterparty, list candidates one per line, no numbers, no "reply with a number". User can reply with any natural form (name, "the HK one", "first", "1") — you map their reply back to a candidate, then call the function again with the full name.

"I have multiple HSBC USD accounts — which one?
• HSBC Hong Kong Bank (USD)
• HSBC Singapore Bank (USD)"

SUCCESS REPLIES — ONLY after a function returned ok:true:
• Sale/bill saved (no payment):    "Saved ✓\\nRef: <erpnext_name>"
• Sale/bill saved (paid_now ok):   "Saved ✓\\nInvoice: <erpnext_name>\\nPayment: <payment_entry_name>"
• Sale/bill saved (paid_now FAIL): "Invoice saved ✓ <erpnext_name>\\nPayment didn't post: <payment_entry_error>\\nTell me when you settle it (e.g. \\"<counterparty> paid me <amount> <ccy>\\") and I'll book the payment."
• Payment saved (standalone):      "Saved ✓\\nRef: <erpnext_name>"
• Cash JE saved:                   "Saved ✓\\nRef: <erpnext_name>"
• Wallet created:                  "Added <wallet_name> <currency> <type> ✓" (+ "(opening balance N CCY)" if a JE was booked)
• Counterparty created:            "Added <name> as a <currency> <party_type> ✓ (<phone if any>)"
• Item created:                    "Added <item_code> ✓" (+ "(opening qty N <uom>)" if a Stock Reconciliation was booked)

CHITCHAT (no function called):
• Greeting → "Hey! I help log transactions and answer questions about your books. What would you like to do?"
• Thanks → "Anytime."
• Help → "I can log transactions ('sold X to Y for Z net 30', 'paid 250 for lunch'), and answer questions ('what's outstanding?', 'how much does X owe me?', 'what's in my wallets?'). Try one."
• Off-topic → "I can only help with bookkeeping. Want to log something or check your books?"
• Unclear → "Could you tell me what you'd like to do?"

═══════════════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════════════

Today: ${today}
User reporting currency: ${user.reporting_currency}
User default currency: ${user.default_currency}
User country: ${user.country}
${businessTypeContext(user)}
CURRENT DRAFT (in progress, may be empty):
${draftJson}`;
}

/**
 * Per-business-type guidance for the LLM. Shaped as a context block, not
 * a hard rule, so the model can override on clearly-mixed phrasing
 * ("Acme paid for consulting hours" from a product user is still a service
 * line — don't force item_code).
 */
function businessTypeContext(user) {
  const t = user.business_type || null;
  if (t === 'service') {
    return `Business type: SERVICE (no physical inventory).
  - Sales/purchases describe deliverables, not stocked goods.
  - When recording a transaction, EXPECT: description + amount + counterparty.
  - DON'T ask for item codes, SKUs, or quantities unless the user
    volunteers them — that pattern doesn't apply here.

`;
  }
  if (t === 'product') {
    return `Business type: PRODUCT (physical inventory).
  - Sales/purchases move stocked items.
  - When recording a sale: EXPECT item code + qty + rate (or unit price).
  - When the user says "sold pa2293 for 1400 usd", treat pa2293 as the
    item code (or description if no separate code exists) and qty=1.
  - When the user says "sold 5 pa2293 at 280", qty=5, rate=280.

`;
  }
  if (t === 'both') {
    return `Business type: BOTH (services + physical inventory).
  - Infer per transaction from the user's wording.
  - "sold 5 of pa2293" → product line (item + qty + rate).
  - "consulting fee for X" → service line (description + amount, no item code).

`;
  }
  return '';
}

async function loadConversation(userId) {
  let result = await query('SELECT * FROM conversations WHERE user_id = $1', [userId]);
  if (result.rowCount === 0) {
    const now = new Date().toISOString();
    await query(
      `INSERT INTO conversations (user_id, state, draft_transaction, recent_messages, last_message_at, created_at, updated_at)
       VALUES ($1, 'idle', NULL, '[]', NULL, $2, $3)`,
      [userId, now, now]
    );
    result = await query('SELECT * FROM conversations WHERE user_id = $1', [userId]);
  }
  return result.rows[0];
}

async function saveConversationState(userId, { draft, recentMessages, state, pendingTool }) {
  const now = new Date().toISOString();
  await query(
    `UPDATE conversations
     SET draft_transaction = $1, recent_messages = $2, state = $3, pending_tool_args = $4, last_message_at = $5, updated_at = $6
     WHERE user_id = $7`,
    [
      draft ? JSON.stringify(draft) : null,
      JSON.stringify(recentMessages || []),
      state || 'idle',
      pendingTool ? JSON.stringify(pendingTool) : null,
      now,
      now,
      userId,
    ]
  );
}

async function resetConversation(userId) {
  await saveConversationState(userId, { draft: null, recentMessages: [], state: 'idle', pendingTool: null });
}

function validateDraft(draft) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (draft[field] == null || draft[field] === '') missing.push(field);
  }
  const tt = draft.transaction_type;
  const dir = draft.direction;

  // category_code requirement: cash income/expense need it for the
  // chart-of-accounts side. Transfers + advances + payments + invoices
  // settle to specific accounts already (wallets / party AR/AP).
  const NO_CATEGORY = new Set(['payment', 'advance_given', 'advance_received']);
  const isTransfer = dir === 'transfer';
  if (!isTransfer && !NO_CATEGORY.has(tt) && (draft.category_code == null || draft.category_code === '')) {
    missing.push('category_code');
  }

  // counterparty_name: required for anything that names a party.
  if ((tt === 'invoice_issued' || tt === 'bill_received' ||
       tt === 'advance_given' || tt === 'advance_received') && !draft.counterparty_name) {
    missing.push('counterparty_name');
  }

  // party_type: required for advance flows so the server knows which side
  // of the books to charge.
  if ((tt === 'advance_given' || tt === 'advance_received') && !draft.party_type) {
    missing.push('party_type');
  }

  return missing;
}

// Tools whose partial args are persisted across turns. The `identifier` field
// is what uniquely names the thing being created — same identifier across
// calls = continuation of the same flow (merge args). Different identifier =
// user moved on to a different thing (drop pending, start fresh).
// Add a new entry here when you want a future standalone tool to get the
// same robustness — no other code changes needed.
const STANDALONE_TOOLS_WITH_PENDING = {
  create_wallet: { identifier: 'wallet_name' },
  create_counterparty: { identifier: 'name' },
  create_item: { identifier: 'item_code' },
};

/**
 * Resolve the wallet + category leaves a save_transaction WOULD touch,
 * without creating anything. Used by request_confirmation so the card
 * shows the real leaf names ("cash (HKD)" / "Miscellaneous Expenses")
 * instead of generic words ("Cash" / "Other Expenses") that hide the
 * currency picked.
 *
 * Returns null on payment / transfer / invoice / bill drafts — those
 * shapes don't use the same code path and the LLM template already
 * handles their counterparty rendering. Returns null on lookup errors
 * too (best-effort — never block confirmation).
 */
async function dryResolveAccounts(ctx) {
  const draft = ctx.draft || {};
  if (draft.direction === 'transfer') return null;
  if (!draft.currency) return null;

  // We dry-resolve for two shapes:
  //   1. transaction_type='cash'  → wallet + category
  //   2. invoice/bill + paid_now  → wallet + category (the PE leg's wallet
  //      is the same as the user-typed payment_account_code)
  const isCash = draft.transaction_type === 'cash';
  const isPaidNowInvoice =
    (draft.transaction_type === 'invoice_issued' || draft.transaction_type === 'bill_received') &&
    draft.paid_now;
  if (!isCash && !isPaidNowInvoice) return null;
  if (!draft.payment_account_code || !draft.category_code) return null;

  try {
    const erp = erpnext.forUser(ctx.user);
    const [walletName, categoryName] = await Promise.all([
      resolveWalletAccount(
        erp,
        draft.payment_account_code,
        draft.currency,
        draft.wallet_name || null,
        ctx.user,
        { dryRun: true }
      ),
      resolveErpAccount(ctx.user, erp, draft.category_code, draft.currency, { dryRun: true }),
    ]);
    return {
      wallet_display: walletName ? friendlyAccountName(walletName) : null,
      category_display: categoryName ? friendlyAccountName(categoryName) : null,
    };
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] dryResolveAccounts: ${err.message}`);
    return null;
  }
}

async function executeTool(toolName, args, ctx) {
  const pendingConfig = STANDALONE_TOOLS_WITH_PENDING[toolName];

  // Pending-args merge — only when the user is continuing the SAME flow.
  if (pendingConfig && ctx.pendingTool?.name === toolName && ctx.pendingTool.args) {
    const idField = pendingConfig.identifier;
    const newId = args[idField];
    const oldId = ctx.pendingTool.args[idField];
    if (!newId || newId === oldId) {
      // Same flow → merge. New args override pending.
      const merged = { ...ctx.pendingTool.args, ...args };
      console.log(
        `• [conversation] [${ts()}] merged pending args for ${toolName} (same ${idField}): ${JSON.stringify(merged)}`
      );
      args = merged;
    } else {
      // Different identifier → user is creating a different thing. Drop the
      // orphaned pending and start fresh with just the new args.
      console.log(
        `• [conversation] [${ts()}] pending ${toolName} cleared — ${idField} changed from "${oldId}" to "${newId}"`
      );
      ctx.pendingTool = null;
    }
  }

  // Run the tool. Returns inside the switch propagate through this wrapper.
  const result = await _runTool(toolName, args, ctx);

  // Post-process pending state based on result.
  if (pendingConfig) {
    if (result?.ok === true) {
      ctx.pendingTool = null;
    } else if (result?.needs_user_input) {
      ctx.pendingTool = { name: toolName, args };
    }
  } else if (toolName === 'cancel_transaction' || toolName === 'save_transaction') {
    // User changed intent / completed a transaction — drop any orphaned pending.
    ctx.pendingTool = null;
  }

  return result;
}

async function _runTool(toolName, args, ctx) {
  switch (toolName) {
    case 'update_draft': {
      const prevCurrency = ctx.draft.currency;
      ctx.draft = { ...ctx.draft, ...args };

      // If the LLM swapped currencies mid-draft, any previously fetched
      // exchange_rate is now stale and would mis-convert at save time.
      // Drop it so the auto-fetch below (or the LLM's explicit
      // fetch_exchange_rate fallback) refreshes it.
      if (args && args.currency && args.currency !== prevCurrency) {
        delete ctx.draft.exchange_rate;
        delete ctx.draft.exchange_rate_source;
      }

      // Counterparty short-form resolution + existence check.
      //
      // Hybrid lookup: PG cache first (fast path), ERPNext fallback on miss.
      // The cache is fast but not authoritative — a customer may exist in
      // ERPNext from a previous flow without ever being cached for this
      // owner. ERPNext is the source of truth, so on a cache miss we
      // round-trip once and pre-warm the cache so subsequent calls stay
      // local. Sets _counterparty_known so the validator only asks for a
      // phone when the counterparty is genuinely new.
      if (args && Object.prototype.hasOwnProperty.call(args, 'counterparty_name') && args.counterparty_name) {
        const wantedDoctype =
          ctx.draft.transaction_type === 'bill_received' ? 'Supplier' : 'Customer';

        // Fetch all cache rows for this owner+doctype and filter JS-side
        // using normalized matching ("SS & co" ~ "ss and co"). SQL LIKE
        // misses these variants without REPLACE acrobatics; cache sizes
        // per tenant are small so JS-side filtering is fine.
        const cacheAll = await query(
          `SELECT name, erpnext_name FROM counterparty_cache
           WHERE owner_user_id = $1 AND erpnext_doctype = $2
           ORDER BY id DESC`,
          [ctx.user.id, wantedDoctype]
        );
        const cacheMatches = filterByNameMatch(cacheAll.rows, args.counterparty_name, 'name');

        if (cacheMatches.length === 1) {
          if (cacheMatches[0].name !== args.counterparty_name) {
            ctx.draft.counterparty_name = cacheMatches[0].name;
            console.log(`• [conversation] [${ts()}] counterparty resolved "${args.counterparty_name}" → "${cacheMatches[0].name}" (1 cache match)`);
          }
          ctx.draft._counterparty_known = true;
        } else if (cacheMatches.length > 1) {
          const candidates = cacheMatches.map((r) => r.name);
          console.log(`• [conversation] [${ts()}] counterparty ambiguous (cache) "${args.counterparty_name}" → ${candidates.join(', ')}`);
          return {
            ok: false,
            error: `Multiple ${wantedDoctype.toLowerCase()}s match "${args.counterparty_name}". Ask the user which one and call update_draft again with the full name.`,
            candidates,
          };
        } else {
          // Cache miss — ask ERPNext directly. Pre-warms the cache (incl.
          // mobile_no + linkCounterparty) so the downstream save path
          // and B2B link detection both work without re-asking the user.
          ctx.draft._counterparty_known = false;
          try {
            const erp = erpnext.forUser(ctx.user);
            const isCustomer = wantedDoctype === 'Customer';
            const nameField = isCustomer ? 'customer_name' : 'supplier_name';
            const live = await erp.listResource(wantedDoctype, {
              filters: [[nameField, 'like', `%${args.counterparty_name}%`]],
              fields: ['name', nameField, 'mobile_no', 'email_id'],
              limit: 5,
            });
            let rows = live.data || [];

            // & ↔ and fallback: the raw input may not LIKE-match because
            // ERPNext stores the swapped form (e.g. input "SS & co", stored
            // "SS and co"). Try the swap once before giving up.
            if (rows.length === 0) {
              const swapped = /[&]/.test(args.counterparty_name)
                ? args.counterparty_name.replace(/\s*&\s*/g, ' and ')
                : / and /i.test(args.counterparty_name)
                  ? args.counterparty_name.replace(/\s+and\s+/gi, ' & ')
                  : null;
              if (swapped && swapped !== args.counterparty_name) {
                const live2 = await erp.listResource(wantedDoctype, {
                  filters: [[nameField, 'like', `%${swapped}%`]],
                  fields: ['name', nameField, 'mobile_no', 'email_id'],
                  limit: 5,
                });
                rows = live2.data || [];
                if (rows.length > 0) {
                  console.log(`• [conversation] [${ts()}] ERPNext fuzzy hit via & ↔ and swap: "${args.counterparty_name}" → "${swapped}"`);
                }
              }
            }

            if (rows.length === 1) {
              const row = rows[0];
              const canonical = row[nameField] || row.name;
              const now = new Date().toISOString();
              await query(
                `INSERT INTO counterparty_cache
                   (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
                 ON CONFLICT (owner_user_id, erpnext_doctype, name) DO UPDATE SET
                   erpnext_name = EXCLUDED.erpnext_name,
                   phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
                   email = COALESCE(counterparty_cache.email, EXCLUDED.email),
                   updated_at = EXCLUDED.updated_at`,
                [ctx.user.id, canonical, row.mobile_no || null, row.email_id || null, wantedDoctype, row.name, now]
              );
              if (row.mobile_no) {
                try {
                  const linked = await linkCounterparty({
                    ownerUserId: ctx.user.id,
                    counterpartyName: canonical,
                    phone: row.mobile_no,
                  });
                  if (linked) {
                    console.log(`• [conversation] [${ts()}] erpnext-fuzzy linked "${canonical}" → user_id=${linked}`);
                  }
                } catch (err) {
                  console.warn(`• [conversation] [${ts()}] erpnext-fuzzy link skipped: ${err.message}`);
                }
              }
              if (canonical !== args.counterparty_name) {
                ctx.draft.counterparty_name = canonical;
                console.log(`• [conversation] [${ts()}] counterparty resolved "${args.counterparty_name}" → "${canonical}" (1 ERPNext match)`);
              } else {
                console.log(`• [conversation] [${ts()}] counterparty confirmed via ERPNext: "${canonical}"`);
              }
              ctx.draft._counterparty_known = true;
            } else if (rows.length > 1) {
              const candidates = rows.map((r) => r[nameField] || r.name);
              console.log(`• [conversation] [${ts()}] counterparty ambiguous (ERPNext) "${args.counterparty_name}" → ${candidates.join(', ')}`);
              return {
                ok: false,
                error: `Multiple ${wantedDoctype.toLowerCase()}s match "${args.counterparty_name}" in ERPNext. Ask the user which one and call update_draft again with the full name.`,
                candidates,
              };
            }
          } catch (err) {
            console.warn(`• [conversation] [${ts()}] ERPNext fuzzy lookup failed for "${args.counterparty_name}": ${err.message}`);
          }
        }
      }

      // For payments: pre-compute the Settles line server-side so the LLM
      // doesn't have to remember the invoice's outstanding amount across
      // turns. Hands back a verbatim string ready to drop into the card.
      let settles_preview = null;
      if (
        ctx.draft.transaction_type === 'payment' &&
        ctx.draft.parent_invoice_ref &&
        ctx.draft.amount &&
        ctx.draft.currency
      ) {
        try {
          const erp = erpnext.forUser(ctx.user);
          const refDoctype = ctx.draft.direction === 'expense' ? 'Purchase Invoice' : 'Sales Invoice';
          const invR = await erp.getResource(refDoctype, ctx.draft.parent_invoice_ref);
          const inv = invR.data;
          if (inv) {
            const outstanding = Number(inv.outstanding_amount) || 0;
            const pay = Number(ctx.draft.amount);
            const allocated = Math.min(pay, outstanding);
            const unallocated = Math.max(0, pay - outstanding);
            const remaining = Math.max(0, outstanding - pay);
            const ccy = inv.currency;
            const fmt = (n) => Number(n).toLocaleString('en-US');
            // Two-line, scannable. Line 1 always identifies the invoice;
            // line 2 communicates the consequence in the invoice's own
            // currency (NOT the payment's converted base currency).
            let rendered;
            let status;
            if (pay >= outstanding && unallocated === 0) {
              status = 'full';
              rendered = `Settles: ${inv.name}\nFully Paid`;
            } else if (pay < outstanding) {
              status = 'partial';
              rendered = `Settles: ${inv.name}\nOutstanding: ${fmt(remaining)} ${ccy}`;
            } else {
              status = 'overpayment';
              rendered = `Settles: ${inv.name}\nFully Paid + ${fmt(unallocated)} ${ccy} advance`;
            }
            settles_preview = {
              invoice: inv.name,
              invoice_currency: ccy,
              outstanding_before: outstanding,
              payment_amount: pay,
              allocated,
              unallocated,
              remaining_after: remaining,
              status,
              rendered,
            };
          }
        } catch (err) {
          console.warn(`[conversation] settles_preview lookup failed: ${err.message}`);
        }
      }

      // Server-side auto-defaults — collapse trivial round-trips that
      // the LLM would otherwise spend an iteration on. Each guard is
      // intentionally narrow so we never override what the LLM (or
      // user) explicitly chose.
      //
      // (1) Cash expense/income with no wallet code → bare cash (1000).
      //     Skipped for transfer (needs explicit source), payment
      //     (often bank/card — let LLM pick), and invoice/bill (no wallet).
      if (
        ctx.draft.transaction_type === 'cash' &&
        (ctx.draft.direction === 'expense' || ctx.draft.direction === 'income') &&
        !ctx.draft.payment_account_code
      ) {
        ctx.draft.payment_account_code = '1000';
        console.log(`• [conversation] [${ts()}] auto-default payment_account_code=1000 (cash ${ctx.draft.direction})`);
      }

      // (2) Cross-currency draft missing exchange_rate → fetch and inject.
      //     If the fetch fails (network, bad pair, etc) we just skip
      //     and the validator surfaces needs=[exchange_rate] so the LLM
      //     falls back to its explicit fetch_exchange_rate tool.
      const baseCcy = ctx.user.reporting_currency || ctx.user.default_currency || 'THB';
      if (
        ctx.draft.currency &&
        ctx.draft.currency !== baseCcy &&
        !ctx.draft.exchange_rate
      ) {
        try {
          const fx = await exchange.fetchRate(
            ctx.draft.currency,
            baseCcy,
            ctx.draft.transaction_date || null
          );
          if (fx && fx.rate) {
            ctx.draft.exchange_rate = fx.rate;
            ctx.draft.exchange_rate_source = fx.source;
            console.log(`• [conversation] [${ts()}] auto-fetched FX ${ctx.draft.currency}->${baseCcy} = ${fx.rate} (${fx.source})`);
          }
        } catch (err) {
          console.warn(`• [conversation] [${ts()}] auto-fetch FX failed: ${err.message}`);
        }
      }

      // Run the central validator. The LLM uses `needs` to drive its next
      // action — ask the user if needs_user_input items exist, otherwise
      // auto-fix (e.g. fetch_exchange_rate) or proceed to request_confirmation.
      const validation = validateDraftServer(ctx.draft, ctx.user);
      console.log(
        `• [conversation] [${ts()}] tool=update_draft draft=${JSON.stringify(ctx.draft)} ` +
          `needs=${validation.needs.length}${validation.next_user_question ? ` next_ask="${validation.next_user_question.ask_user}"` : ''}` +
          `${settles_preview ? ` settles=${settles_preview.status}` : ''}`
      );
      return {
        ok: true,
        current_draft: ctx.draft,
        ready_to_confirm: validation.ready_to_confirm,
        needs: validation.needs,
        next_user_question: validation.next_user_question,
        settles_preview,
      };
    }

    case 'request_confirmation': {
      // Single source of truth: the validator. If anything is still needed,
      // reject and hand back the structured needs[] — the LLM will either ask
      // the user (needs_user_input items) or auto-fix (e.g. fetch_exchange_rate).
      const validation = validateDraftServer(ctx.draft, ctx.user);
      if (!validation.ready_to_confirm) {
        return {
          ok: false,
          error: 'Cannot confirm yet — draft is missing required pieces.',
          needs: validation.needs,
          next_user_question: validation.next_user_question,
        };
      }
      ctx.confirmationRequested = true;
      console.log(`• [conversation] [${ts()}] tool=request_confirmation user_id=${ctx.user.id}`);

      // Dry-resolve the accounts that save_transaction WOULD use, so the
      // LLM can put the real leaf names on the confirmation card instead
      // of generic words like "Cash". For brand-new wallets, we return
      // what the leaf WOULD be named (no actual create).
      const resolved = await dryResolveAccounts(ctx);
      return { ok: true, ...(resolved ? { resolved_accounts: resolved } : {}) };
    }

    case 'save_transaction': {
      const validation = validateDraftServer(ctx.draft, ctx.user);
      if (!validation.ready_to_save) {
        return {
          ok: false,
          error: 'Cannot save yet — draft is missing required pieces.',
          needs: validation.needs,
          next_user_question: validation.next_user_question,
        };
      }
      // Snapshot the draft BEFORE save (save clears it) so the canned
      // success reply can describe what was saved.
      const draftSnapshot = { ...ctx.draft };
      try {
        const result = await erpSync.save(ctx.user, ctx.draft);
        if (result.ok) {
          ctx.saved = { erpnext_name: result.erpnext_name };
          ctx.savedIds = [...(ctx.savedIds || []), result.erpnext_name];
          ctx.draft = {};
          ctx.confirmationRequested = false;
          // Server-built reply — bypasses the next LLM iteration so the
          // user sees a fixed-format confirmation every time (no LLM
          // creative re-phrasing, no "BLUFF DETECTED" false positives).
          result._saved_reply = formatSaveSuccessReply(result, draftSnapshot);
        } else {
          // Handler returned ok=false without throwing (most validation
          // failures take this path). Log the full reason so we can debug
          // without needing the LLM to parrot it back.
          console.error(
            `× [conversation] [${ts()}] save returned ok=false user_id=${ctx.user.id} ` +
              `tx_type=${ctx.draft?.transaction_type || 'cash'} reason=${result.error}`
          );
        }
        return result;
      } catch (err) {
        console.error(`× [conversation] [${ts()}] save threw user_id=${ctx.user.id} tx_type=${ctx.draft?.transaction_type || 'cash'}:`);
        console.error(err);
        if (err.response) console.error('  err.response:', JSON.stringify(err.response).slice(0, 800));
        // Surface ambiguity errors with structured candidates so the LLM can
        // present a natural-language picker (not just a stringy error).
        if (err.code === 'AMBIGUOUS_WALLET') {
          return {
            ok: false,
            error: err.message,
            ambiguous_wallet: {
              search_term: ctx.draft.wallet_name || '',
              candidates: err.candidates.map((c) => c.account_name),
            },
          };
        }
        if (err.code === 'AMBIGUOUS_COUNTERPARTY') {
          return {
            ok: false,
            error: err.message,
            ambiguous_counterparty: {
              search_term: ctx.draft.counterparty_name || '',
              candidates: err.candidates.map((c) => c.name),
            },
          };
        }
        if (err.code === 'AMBIGUOUS_ITEM') {
          return {
            ok: false,
            error: err.message,
            ambiguous_item: {
              candidates: err.candidates,
            },
          };
        }
        if (err.code === 'NEW_ITEM') {
          // The user referenced an item that doesn't exist yet. Ask the LLM
          // to call create_item with the user-supplied code/description
          // plus any details still needed for the industry.
          return {
            ok: false,
            error: err.message,
            new_item: {
              suggested_code: err.suggested_code,
              suggested_description: err.suggested_description,
            },
            instruction:
              'The item does not exist yet. Ask the user for the missing details (gem type, weight, etc.), then call create_item with item_code + attributes, then re-attempt save_transaction.',
          };
        }
        return { ok: false, error: `Save failed: ${err.message}` };
      }
    }

    case 'cancel_transaction':
      ctx.cancelled = true;
      console.log(`• [conversation] [${ts()}] tool=cancel_transaction user_id=${ctx.user.id}`);
      return { ok: true };

    case 'fetch_exchange_rate': {
      const result = await exchange.fetchRate(args?.from_currency, args?.to_currency, args?.date);
      console.log(`• [conversation] [${ts()}] tool=fetch_exchange_rate ${args?.from_currency}->${args?.to_currency} date=${args?.date || 'today'} rate=${result.rate ?? 'err'} source=${result.source || 'n/a'}`);
      return result;
    }

    case 'query_open_invoices': {
      try {
        // Resolve user-facing short name (e.g. "Acme") to the ERPNext party
        // name (e.g. "Acme Trading") via counterparty_cache, so the
        // ERPNext filter is an EXACT match against the right record.
        let counterpartyErpName = null;
        if (args?.counterparty_search) {
          const wantedDoctype = args.direction === 'payable' ? 'Supplier' : 'Customer';
          const r = await query(
            `SELECT erpnext_name FROM counterparty_cache
             WHERE owner_user_id = $1
               AND erpnext_doctype = $2
               AND LOWER(name) LIKE LOWER($3)
             ORDER BY id DESC
             LIMIT 1`,
            [ctx.user.id, wantedDoctype, `%${args.counterparty_search}%`]
          );
          counterpartyErpName = r.rows[0]?.erpnext_name || null;
        }
        const erp = erpnext.forUser(ctx.user);
        const rows = await erpQuery.listOpenInvoices(ctx.user, erp, {
          direction: args?.direction,
          counterpartyName: counterpartyErpName,
          limit: args?.limit || 20,
        });
        console.log(`• [conversation] [${ts()}] tool=query_open_invoices direction=${args?.direction} counterparty=${args?.counterparty_search || '*'}${counterpartyErpName ? ` (resolved → ${counterpartyErpName})` : ''} found=${rows.length}`);
        return { ok: true, invoices: rows };
      } catch (err) {
        console.error('[conversation] query_open_invoices error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'query_balance_with_counterparty': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const search = args?.counterparty_name || '';
        const wantedDoctypes = args?.party_type === 'Both' ? ['Customer', 'Supplier'] : [args?.party_type];

        async function resolveErpName(doctype) {
          const cached = await query(
            `SELECT erpnext_name FROM counterparty_cache
             WHERE owner_user_id = $1 AND erpnext_doctype = $2
               AND LOWER(name) LIKE LOWER($3)
             ORDER BY id DESC
             LIMIT 1`,
            [ctx.user.id, doctype, `%${search}%`]
          );
          return cached.rows[0]?.erpnext_name || null;
        }

        const sides = {};
        for (const doctype of wantedDoctypes) {
          const erpName = await resolveErpName(doctype);
          if (!erpName) {
            sides[doctype.toLowerCase()] = null;
            continue;
          }
          sides[doctype.toLowerCase()] = await erpQuery.getBalanceWithCounterparty(ctx.user, erp, {
            partyType: doctype,
            partyName: erpName,
          });
        }

        // For single-direction queries: return the existing flat shape (backwards-compatible)
        if (args?.party_type !== 'Both') {
          const side = sides.customer || sides.supplier;
          if (!side) {
            return {
              ok: false,
              error: `Counterparty "${search}" not in counterparty_cache as a ${args?.party_type}. They may not exist in ERPNext yet — try creating an invoice/bill first, or check the spelling.`,
            };
          }
          console.log(`• [conversation] [${ts()}] tool=query_balance_with_counterparty ${args?.party_type}=${side.partyName} net=${JSON.stringify(side.netByCurrency)}`);
          return { ok: true, ...side };
        }

        // Both: combine sides. Convention used everywhere in the bot:
        //   positive net = party owes us (asset side wins)
        //   negative net = we owe party (liability side wins)
        // Combined = customer_net (they owe us) − supplier_net (we owe them).
        if (!sides.customer && !sides.supplier) {
          return {
            ok: false,
            error: `Counterparty "${search}" not found in counterparty_cache as Customer or Supplier. They may not exist in ERPNext yet, or the name doesn't match — check the spelling.`,
          };
        }
        const customerNet = sides.customer?.netByCurrency || {};
        const supplierNet = sides.supplier?.netByCurrency || {};
        const allCcy = new Set([...Object.keys(customerNet), ...Object.keys(supplierNet)]);
        const combinedNet = {};
        for (const ccy of allCcy) {
          const net = (customerNet[ccy] || 0) - (supplierNet[ccy] || 0);
          combinedNet[ccy] = Math.abs(net) > 0.005 ? net : 0;
        }
        const partyName = sides.customer?.partyName || sides.supplier?.partyName || search;
        console.log(`• [conversation] [${ts()}] tool=query_balance_with_counterparty Both=${partyName} combined=${JSON.stringify(combinedNet)}`);
        return {
          ok: true,
          party_type: 'Both',
          partyName,
          customer_side: sides.customer,
          supplier_side: sides.supplier,
          combined: { netByCurrency: combinedNet },
        };
      } catch (err) {
        console.error('[conversation] query_balance_with_counterparty error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'get_counterparty_details': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const search = args?.counterparty_name || '';
        const partyType = args?.party_type || 'Both';
        const wantedDoctypes = partyType === 'Both' ? ['Customer', 'Supplier'] : [partyType];

        // Resolve short name → full ERPNext name via cache for each side.
        async function resolveErpName(doctype) {
          const r = await query(
            `SELECT erpnext_name FROM counterparty_cache
             WHERE owner_user_id = $1 AND erpnext_doctype = $2
               AND LOWER(name) LIKE LOWER($3)
             ORDER BY id DESC LIMIT 1`,
            [ctx.user.id, doctype, `%${search}%`]
          );
          return r.rows[0]?.erpnext_name || null;
        }

        const sides = {};
        for (const dt of wantedDoctypes) {
          const erpName = await resolveErpName(dt);
          if (!erpName) {
            sides[dt.toLowerCase()] = null;
            continue;
          }
          const fetched = await erpQuery.getCounterpartyDetails(ctx.user, erp, {
            partyName: erpName,
            partyType: dt,
          });
          sides[dt.toLowerCase()] = fetched[dt.toLowerCase()];
        }

        if (!sides.customer && !sides.supplier) {
          return {
            ok: false,
            error: `Counterparty "${search}" not in counterparty_cache. They may not exist in ERPNext yet — try logging a transaction with them first.`,
          };
        }

        console.log(`• [conversation] [${ts()}] tool=get_counterparty_details search="${search}" found=${[sides.customer?'C':null,sides.supplier?'S':null].filter(Boolean).join('+') || 'none'}`);
        return { ok: true, ...sides };
      } catch (err) {
        console.error('[conversation] get_counterparty_details error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'query_pending_todos': {
      try {
        const rows = await todos.listTodos(ctx.user.id, { botOnly: true });
        console.log(`• [conversation] [${ts()}] tool=query_pending_todos count=${rows.length}`);
        return {
          ok: true,
          count: rows.length,
          todos: rows.map((t) => ({
            id: t.id,
            kind: t.kind,
            question: t.bot_prompt,
            related: t.related_name || null,
          })),
        };
      } catch (err) {
        console.error('[conversation] query_pending_todos error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'resolve_todo': {
      try {
        const id = parseInt(args?.id, 10);
        if (!id) return { ok: false, error: 'resolve_todo requires numeric id (from query_pending_todos)' };
        const erp = erpnext.forUser(ctx.user);
        const result = await todos.resolveTodo({
          user: ctx.user,
          erp,
          todoId: id,
          userInput: args?.input || {},
        });
        console.log(`• [conversation] [${ts()}] tool=resolve_todo id=${id} ok=${!!result?.ok}`);
        return result;
      } catch (err) {
        console.error('[conversation] resolve_todo error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'query_cash_bank_balance': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const balance = await erpQuery.getCashBankBalance(ctx.user, erp, {
          asOf: args?.as_of || null,
        });
        console.log(`• [conversation] [${ts()}] tool=query_cash_bank_balance wallets=${balance.wallets.length} totals=${JSON.stringify(balance.totals_by_currency)}`);
        return { ok: true, ...balance };
      } catch (err) {
        console.error('[conversation] query_cash_bank_balance error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'create_counterparty': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const name = args?.name;
        const partyType = args?.party_type;
        const currency = args?.default_currency;

        // Collect ALL missing fields and ask in one batched question so the
        // user isn't drip-fed prompts one at a time. Server still validates
        // each so the LLM can't sneak past with a partial payload.
        const missing = [];
        if (!name) {
          missing.push({
            field: 'name',
            short: "their name",
            full: "What's their name?",
          });
        }
        if (!partyType) {
          missing.push({
            field: 'party_type',
            short: 'whether they\'re a customer, supplier, or both',
            full: `Is ${name || 'this contact'} a customer (buys from you), a supplier (you buy from them), or both?`,
          });
        }
        if (!currency) {
          missing.push({
            field: 'default_currency',
            short: 'what currency you usually trade with them in',
            full: `What currency do you usually trade with ${name || 'them'} in?`,
            examples: 'e.g. USD, THB, EUR',
          });
        }
        if (missing.length > 0) {
          // Build one batched ask_user — joined naturally. Single-field
          // missing reads as a normal question; multi-field reads as one
          // compound sentence.
          let batched;
          if (missing.length === 1) {
            batched = missing[0].full;
          } else {
            // "I need a couple of things: <short A>, and <short B>."
            const last = missing[missing.length - 1].short;
            const head = missing.slice(0, -1).map((m) => m.short).join(', ');
            batched = `Sure — I just need ${head} and ${last}.`;
          }
          return {
            ok: false,
            error: `create_counterparty needs: ${missing.map((m) => m.field).join(', ')}`,
            needs_user_input: {
              missing_fields: missing.map((m) => m.field),
              ask_user: batched,
            },
          };
        }

        // Block exact-name duplicates. The bot's resolve flow for sales/
        // purchases silently reuses existing contacts (correct UX during a
        // transaction), but explicit create_counterparty is meant to add a
        // NEW contact. If the name already exists, the user almost
        // certainly means a different person — surface so they can disambiguate.
        const dup = await query(
          `SELECT name, erpnext_doctype FROM counterparty_cache
             WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2)
             LIMIT 1`,
          [ctx.user.id, name]
        );
        if (dup.rowCount > 0) {
          return {
            ok: false,
            error: `A contact named "${dup.rows[0].name}" already exists.`,
            needs_user_input: {
              missing_fields: ['name'],
              ask_user: `There's already a contact called "${dup.rows[0].name}" on file. If this is a different person, please use a more specific name (e.g. "${name} Trading" or "${name} (HK)"). If it's the same person, no need to add them — they're already in your contacts.`,
            },
          };
        }

        // Phone-uniqueness guard. Phone is the load-bearing identifier
        // for B2B linking; two contacts with the same phone would create
        // routing ambiguity. Block before creation.
        if (args?.phone) {
          const { assertPhoneUnused } = require('./erp-sync/contact-guard');
          const phoneCheck = await assertPhoneUnused(ctx.user.id, name, args.phone);
          if (!phoneCheck.ok) {
            const other = phoneCheck.conflictsWith;
            return {
              ok: false,
              error: `Phone ${args.phone} is already used by contact "${other.name}".`,
              needs_user_input: {
                missing_fields: ['phone'],
                ask_user: `That phone number is already on file under "${other.name}". A phone can only belong to one contact in your books. Double-check the number, or use the existing contact if it's the same person.`,
              },
            };
          }
        }

        const created = {};
        if (partyType === 'Customer' || partyType === 'Both') {
          created.customer = await resolveOrCreateCustomer(ctx.user, erp, name, {
            currency,
            phone: args?.phone || null,
            email: args?.email || null,
          });
        }
        if (partyType === 'Supplier' || partyType === 'Both') {
          created.supplier = await resolveOrCreateSupplier(ctx.user, erp, name, {
            currency,
            phone: args?.phone || null,
            email: args?.email || null,
          });
        }
        console.log(`• [conversation] [${ts()}] tool=create_counterparty name="${name}" type=${partyType} currency=${currency} created=${JSON.stringify(created)}`);
        return { ok: true, name, party_type: partyType, default_currency: currency, created };
      } catch (err) {
        console.error('[conversation] create_counterparty error:', err.message);
        if (err.code === 'AMBIGUOUS_COUNTERPARTY') {
          return {
            ok: false,
            error: err.message,
            ambiguous_counterparty: {
              search_term: args?.name || '',
              candidates: err.candidates.map((c) => c.name),
            },
          };
        }
        return { ok: false, error: err.message };
      }
    }

    case 'create_wallet': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const walletName = args?.wallet_name;
        const parentCode = args?.parent_code ? String(args.parent_code) : null;
        const currency = args?.currency;
        const openingBalance = typeof args?.opening_balance === 'number' ? args.opening_balance : null;
        const openingSkipped = args?.opening_balance_skipped === true;

        // Batch missing — same UX pattern as create_counterparty. Ask for
        // everything needed in one compound question rather than drip.
        const missing = [];
        if (!walletName) {
          missing.push({
            field: 'wallet_name',
            short: 'the name (e.g. BBL Savings, HSBC HK, AmEx Platinum)',
            full: 'What\'s the name of the wallet?',
          });
        }
        if (!parentCode) {
          missing.push({
            field: 'parent_code',
            short: 'whether it\'s cash, bank, or credit card',
            full: `Is ${walletName || 'this wallet'} a cash, bank, or credit-card account?`,
          });
        }
        if (!currency) {
          missing.push({
            field: 'currency',
            short: 'the currency',
            full: `What currency is ${walletName || 'it'} in?`,
            examples: 'e.g. USD, THB, EUR',
          });
        }
        if (openingBalance === null && !openingSkipped) {
          missing.push({
            field: 'opening_balance',
            short: 'the current balance on the wallet (or "skip" / "0" if you\'ll add later)',
            full: `What's the current balance on ${walletName || 'this wallet'}? Reply 0 or "skip" if you'll set it later.`,
          });
        }
        if (missing.length > 0) {
          let batched;
          if (missing.length === 1) {
            batched = missing[0].full;
          } else {
            const last = missing[missing.length - 1].short;
            const head = missing.slice(0, -1).map((m) => m.short).join(', ');
            batched = `Sure — I just need ${head} and ${last}.`;
          }
          return {
            ok: false,
            error: `create_wallet needs: ${missing.map((m) => m.field).join(', ')}`,
            needs_user_input: {
              missing_fields: missing.map((m) => m.field),
              ask_user: batched,
            },
          };
        }

        // Create / find the wallet itself.
        const erpName = await resolveWalletAccount(erp, parentCode, currency, walletName, ctx.user);
        console.log(`• [conversation] [${ts()}] tool=create_wallet name="${walletName}" code=${parentCode} currency=${currency} → ${erpName}`);

        // Opening balance: book a JE if the user gave one > 0.
        let openingJe = null;
        if (openingBalance && openingBalance > 0) {
          let rate = null;
          if (currency !== (ctx.user.reporting_currency || 'THB')) {
            const fx = await exchange.fetchRate(currency, ctx.user.reporting_currency || 'THB', null);
            if (!fx || !fx.rate) {
              return {
                ok: false,
                error: `created wallet ${erpName} but couldn't fetch FX rate to book opening balance — try again or set opening balance later.`,
              };
            }
            rate = fx.rate;
          }
          openingJe = await recordOpeningBalance(ctx.user, erp, {
            walletErpName: erpName,
            walletCurrency: currency,
            amount: openingBalance,
            exchangeRate: rate,
          });
        }

        return {
          ok: true,
          wallet_name: walletName,
          erpnext_account_name: erpName,
          opening_balance: openingBalance || 0,
          opening_balance_je: openingJe,
        };
      } catch (err) {
        console.error('[conversation] create_wallet error:', err.message);
        if (err.code === 'AMBIGUOUS_WALLET') {
          return {
            ok: false,
            error: err.message,
            ambiguous_wallet: {
              search_term: args?.wallet_name || '',
              candidates: err.candidates.map((c) => c.account_name),
            },
          };
        }
        return { ok: false, error: err.message };
      }
    }

    case 'lookup_item': {
      const term = args?.search_term;
      if (!term) return { ok: false, error: 'lookup_item needs search_term' };
      try {
        const erp = erpnext.forUser(ctx.user);

        // First pass: attribute-aware search (parses weight + gem_type
        // out of the term and queries by Item Custom Fields). Catches the
        // "1.05ct paraiba" case where there's no SKU but the user has
        // stated identifying attributes.
        const attrHit = await lookupItemByAttributes(ctx.user, erp, term);
        if (attrHit.count > 0) {
          console.log(`• [conversation] [${ts()}] tool=lookup_item term="${term}" parsed=${JSON.stringify(attrHit.parsed)} → ${attrHit.count} attr match(es)`);
          if (attrHit.count === 1) {
            return { ok: true, found: true, count: 1, item: attrHit.candidates[0], parsed: attrHit.parsed };
          }
          return { ok: true, found: true, count: attrHit.count, candidates: attrHit.candidates, parsed: attrHit.parsed };
        }

        // Fallback: exact / code+name fuzzy (resolveItem).
        const hit = await resolveItem(ctx.user, erp, { code: term, description: term });
        console.log(`• [conversation] [${ts()}] tool=lookup_item term="${term}" → ${hit.erpnext_name} (code/name match)`);
        return { ok: true, found: true, count: 1, item: hit };
      } catch (err) {
        if (err.code === 'AMBIGUOUS_ITEM') {
          console.log(`• [conversation] [${ts()}] tool=lookup_item term="${term}" → ${err.candidates.length} matches`);
          return {
            ok: true,
            found: true,
            count: err.candidates.length,
            candidates: err.candidates,
          };
        }
        if (err.code === 'NEW_ITEM') {
          console.log(`• [conversation] [${ts()}] tool=lookup_item term="${term}" → no match`);
          return { ok: true, found: false, count: 0 };
        }
        console.error('[conversation] lookup_item error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    case 'create_item': {
      try {
        const erp = erpnext.forUser(ctx.user);
        const code = args?.item_code ? String(args.item_code).trim() : null;
        const itemName = args?.item_name ? String(args.item_name).trim() : null;
        const description = args?.description ? String(args.description).trim() : null;
        const unitTypeRaw = args?.unit_type ? String(args.unit_type).trim().toLowerCase() : null;
        const attributes = (args?.attributes && typeof args.attributes === 'object') ? args.attributes : {};
        const openingQty =
          typeof args?.opening_qty === 'number' ? args.opening_qty : null;
        const openingSkipped = args?.opening_qty_skipped === true;
        const unitCostBasis =
          typeof args?.unit_cost_basis === 'number' ? args.unit_cost_basis : null;

        // is_stock_item from business_type (server-decides; not user-controllable).
        // product / both → stock-tracked; service → record-keeping only.
        const bt = ctx.user.business_type;
        const isStockItem = bt === 'product' || bt === 'both';

        // Load industry attribute schema (gemstones, …). Empty for users
        // without a configured industry — they get the legacy minimal path.
        const { loadIndustrySchema } = require('./erp-sync/item-custom-fields');
        const industry = ctx.user.industry || null;
        const schema = industry ? await loadIndustrySchema(industry) : [];

        // Unit-type → stock_uom. piece = Nos. weight = Ct for gems (and
        // any industry whose "weight" semantic is carats; we'll add a
        // per-industry default UoM later when needed). Explicit args.uom
        // overrides if provided.
        let unitType = unitTypeRaw;
        const uom =
          (args?.uom && String(args.uom).trim()) ||
          (unitType === 'weight' && industry === 'gemstones' ? 'Ct' : 'Nos');

        // Batch missing — code, unit_type (when ambiguous), industry-required
        // attributes, opening_qty.
        const missing = [];
        if (!code) {
          missing.push({
            field: 'item_code',
            short: 'the SKU/code',
            full: 'What\'s the code for this item? (e.g. "pa2293")',
          });
        }
        // unit_type prompt: only when the industry has weight-vs-piece
        // semantics (gemstones for now). Default to 'piece' if the user
        // already told us a weight_ct AND opening_qty<=1 — that pattern
        // signals "one stone with this weight" not "a parcel".
        if (!unitType && isStockItem && industry === 'gemstones') {
          const hasWeight = typeof attributes.weight_ct === 'number' && attributes.weight_ct > 0;
          if (hasWeight && (openingQty === null || openingQty <= 1)) {
            unitType = 'piece';
          } else {
            missing.push({
              field: 'unit_type',
              short: 'whether it\'s a single stone or a parcel sold by weight',
              full: `Is ${code || 'this item'} a single stone (sold per piece) or a parcel sold by weight? Reply "piece" or "weight".`,
            });
          }
        }
        // Industry-required attributes. weight_ct is only required for
        // piece-type — for weight-type the line qty IS the weight, no
        // separate attr needed.
        for (const def of schema) {
          if (!def.required) continue;
          if (def.field_key === 'weight_ct' && unitType === 'weight') continue;
          const v = attributes[def.field_key];
          const isMissing =
            v === undefined || v === null || v === '' ||
            (def.field_type === 'float' && (typeof v !== 'number' || Number.isNaN(v)));
          if (!isMissing) continue;
          let askFull;
          if (def.field_type === 'select' && Array.isArray(def.options)) {
            askFull = `What's the ${def.field_label.toLowerCase()} for ${code || 'this item'}? (e.g. ${def.options.slice(0, 4).join(', ')})`;
          } else if (def.field_type === 'float') {
            askFull = `What's the ${def.field_label.toLowerCase()} for ${code || 'this item'}?`;
          } else {
            askFull = `What's the ${def.field_label.toLowerCase()} for ${code || 'this item'}?`;
          }
          missing.push({
            field: def.field_key,
            short: def.field_label.toLowerCase(),
            full: askFull,
          });
        }
        // opening_qty — for piece-type single stones we can default to 1;
        // for weight-type and ambiguous cases, ask.
        if (isStockItem && openingQty === null && !openingSkipped) {
          if (unitType === 'piece' && typeof attributes.weight_ct === 'number') {
            // Single stone implied — default opening to 1, no ask.
          } else {
            missing.push({
              field: 'opening_qty',
              short: 'how much you have on hand now (or "skip" / "0" if none yet)',
              full: `How ${unitType === 'weight' ? 'many carats' : 'many'} of ${code || 'this item'} do you have on hand right now? Reply 0 or "skip" if none yet.`,
            });
          }
        }
        if (missing.length > 0) {
          let batched;
          if (missing.length === 1) {
            batched = missing[0].full;
          } else {
            const last = missing[missing.length - 1].short;
            const head = missing.slice(0, -1).map((m) => m.short).join(', ');
            batched = `Sure — I just need ${head} and ${last}.`;
          }
          return {
            ok: false,
            error: `create_item needs: ${missing.map((m) => m.field).join(', ')}`,
            needs_user_input: {
              missing_fields: missing.map((m) => m.field),
              ask_user: batched,
            },
          };
        }

        // Default opening_qty for piece-type single stones.
        const finalOpeningQty =
          openingQty !== null ? openingQty :
          (unitType === 'piece' && typeof attributes.weight_ct === 'number') ? 1 :
          null;

        const created = await createItem(ctx.user, erp, {
          code,
          name: itemName,
          description,
          uom,
          isStockItem,
          attributes,
        });
        console.log(`• [conversation] [${ts()}] tool=create_item code="${code}" unit_type=${unitType || 'n/a'} stock=${isStockItem ? 1 : 0} uom=${uom} opening_qty=${finalOpeningQty ?? 'skip'} → ${created.erpnext_name}`);

        // Opening stock reconciliation — post the starting on-hand qty
        // + valuation rate. Non-fatal if it fails: the Item already
        // exists and the user can backfill via the unknown_item_purchase
        // todo (whose open_stock branch also posts an SR).
        let openingStockEntry = null;
        if (isStockItem && finalOpeningQty && finalOpeningQty > 0) {
          try {
            const { postOpeningStockReconciliation } = require('./erp-sync/stock');
            openingStockEntry = await postOpeningStockReconciliation(ctx.user, erp, {
              itemCode: created.item_code,
              qty: finalOpeningQty,
              valuationRate: unitCostBasis || 0,
            });
          } catch (srErr) {
            console.warn(`• [item] [${ts()}]   opening SR failed for ${created.item_code}: ${srErr.message}`);
          }
        }

        return {
          ok: true,
          erpnext_name: created.erpnext_name,
          item_code: created.item_code,
          is_stock_item: isStockItem,
          unit_type: unitType || null,
          uom,
          opening_qty: finalOpeningQty || 0,
          opening_stock_entry: openingStockEntry,
          attributes: attributes,
        };
      } catch (err) {
        console.error('[conversation] create_item error:', err.message);
        return { ok: false, error: err.message };
      }
    }

    default:
      return { ok: false, error: `Unknown tool: ${toolName}` };
  }
}

async function handle(user, userMessage) {
  if (!openai) {
    return "Sorry, the bookkeeping AI isn't available right now. Please try again later.";
  }

  const conv = await loadConversation(user.id);
  const draft = conv.draft_transaction ? JSON.parse(conv.draft_transaction) : {};
  const history = JSON.parse(conv.recent_messages || '[]');
  const pendingTool = conv.pending_tool_args ? JSON.parse(conv.pending_tool_args) : null;
  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = await buildSystemPrompt({ user, draft, today });
  const llmMessages = [
    { role: 'system', content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const ctx = {
    user,
    draft: { ...draft },
    conversationId: conv.id,
    saved: null,
    cancelled: false,
    confirmationRequested: false,
    // In-flight args for standalone tools (create_wallet, create_counterparty)
    // that have been started but are waiting on more info. Merged into the
    // next matching tool call by executeTool — same robustness pattern as
    // draft persistence for transactions.
    pendingTool: pendingTool || null,
    // Track which tools succeeded during this turn — used by the bluff
    // detector below to catch LLM "Added/Saved" responses that weren't
    // backed by an actual tool call.
    toolsSucceeded: new Set(),
  };

  // Intent forcing: regex-detect intents that map cleanly to a single tool
  // so we can force tool_choice on the LLM's first iteration. Bypasses model
  // judgment for the brittle cases — the LLM has to call the tool, extracts
  // whatever it can, server drives the rest via needs_user_input.
  const lc = userMessage.toLowerCase().trim();
  const isCreateWalletIntent =
    /\b(add|create|new|set\s*up)\b/.test(lc) &&
    /\b(wallet|bank\s*account|bank|cash\s*drawer|card|credit\s*card)\b/.test(lc) &&
    !/\b(receive|payment|transfer|paid|spent|got|sold|invoice|bill)\b/.test(lc);
  const isCreateCounterpartyIntent =
    /\b(add|create|new|save)\b/.test(lc) &&
    /\b(contact|customer|supplier|buyer|vendor|client)\b/.test(lc) &&
    !/\b(invoice|bill|payment|sale|sold|bought)\b/.test(lc);
  const isCreateItemIntent =
    /\b(add|create|new|register)\b/.test(lc) &&
    /\b(item|product|sku|stone|gem|stock\s*item)\b/.test(lc) &&
    !/\b(sold|bought|paid|invoice|bill|sale)\b/.test(lc);
  // Confirm/cancel replies while a confirmation card is on screen — the LLM
  // has been re-calling request_confirmation instead of save_transaction
  // here, so force the right tool.
  const inConfirmingState = conv.state === 'confirming';
  const isConfirmReply =
    inConfirmingState &&
    /^(confirm|yes|ok|okay|sure|save|approve|go|do it|yep|yeah|👍|✅)\b[\s.!]*$/i.test(lc);
  const isCancelReply =
    inConfirmingState &&
    /^(no|cancel|abort|discard|reject|nope|nvm|nevermind|stop|don'?t|❌)\b[\s.!]*$/i.test(lc);

  let finalText = null;

  try {
    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      // On the very first iteration ONLY, if we detected a clear intent,
      // force the LLM to call the matching tool. Subsequent iterations are
      // 'auto' so the LLM can chain (e.g. fetch_exchange_rate after save).
      let toolChoice = 'auto';
      if (i === 0) {
        if (isConfirmReply) {
          toolChoice = { type: 'function', function: { name: 'save_transaction' } };
        } else if (isCancelReply) {
          toolChoice = { type: 'function', function: { name: 'cancel_transaction' } };
        } else if (isCreateWalletIntent) {
          toolChoice = { type: 'function', function: { name: 'create_wallet' } };
        } else if (isCreateCounterpartyIntent) {
          toolChoice = { type: 'function', function: { name: 'create_counterparty' } };
        } else if (isCreateItemIntent) {
          toolChoice = { type: 'function', function: { name: 'create_item' } };
        }
      }

      const iterStart = Date.now();
      const response = await openai.chat.completions.create({
        // Model is configurable via OPENAI_MODEL env var. Default is gpt-4o
        // (more reliable tool-call following than gpt-4o-mini for this
        // multi-rule prompt). Override to 'gpt-4o-mini' for cheaper dev work.
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: llmMessages,
        tools: TOOLS,
        tool_choice: toolChoice,
        temperature: 0.2,
        max_tokens: 600,
      });
      const iterMs = Date.now() - iterStart;

      // Visibility into OpenAI prompt-cache hit rate + latency per iteration.
      const usage = response.usage;
      if (usage) {
        const cached = usage.prompt_tokens_details?.cached_tokens || 0;
        const total = usage.prompt_tokens || 0;
        const pct = total > 0 ? Math.round((cached / total) * 100) : 0;
        console.log(`• [conversation] [${ts()}] llm iter=${i} ${iterMs}ms prompt_tokens=${total} cached=${cached} (${pct}%) completion=${usage.completion_tokens}`);
      } else {
        console.log(`• [conversation] [${ts()}] llm iter=${i} ${iterMs}ms`);
      }

      const choice = response.choices[0];
      const msg = choice.message;
      llmMessages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let args;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await executeTool(tc.function.name, args, ctx);
          if (result && result.ok === true) {
            ctx.toolsSucceeded.add(tc.function.name);
          }
          llmMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });

          // Server-driven short-circuit: when a tool returns a fully-formed
          // user-facing question (needs_user_input.ask_user OR a draft
          // validation's next_user_question), send that text DIRECTLY to the
          // user with no further LLM rewriting. Eliminates a class of bugs
          // where the LLM rewords the question and drifts.
          const directAsk =
            result?.needs_user_input?.ask_user ||
            result?.next_user_question?.ask_user ||
            null;
          if (directAsk) {
            ctx._directAsk = directAsk;
          }
          // Same idea, but for save-success — the backend builds a fixed
          // reply ("Saved ✓\nInvoice: …\nPayment: …") and we send it
          // directly. Side benefits: deterministic copy, immune to BLUFF
          // false-positives, one fewer LLM round.
          if (result?._saved_reply) {
            ctx._savedReply = result._saved_reply;
          }
        }
        // If any tool surfaced a direct user question OR a canned save
        // reply, short-circuit: send that text without burning another
        // LLM round to rephrase it.
        if (ctx._savedReply) {
          finalText = ctx._savedReply;
          console.log(`• [conversation] [${ts()}] saved-reply short-circuit: "${ctx._savedReply.replace(/\n/g, ' / ').slice(0, 100)}"`);
          break;
        }
        if (ctx._directAsk) {
          finalText = ctx._directAsk;
          console.log(`• [conversation] [${ts()}] direct-ask short-circuit: "${ctx._directAsk.slice(0, 100)}"`);
          break;
        }
        continue;
      }

      finalText = (msg.content || '').trim();
      break;
    }
  } catch (err) {
    console.error('[conversation] OpenAI error:', err.message);
    return "Sorry, I'm having trouble right now. Please try again in a moment.";
  }

  if (!finalText) finalText = 'Got it. Anything else?';

  // BLUFF SCRUBBER — last-line defense against the LLM claiming success
  // without an actual tool call. If the reply uses success language but no
  // corresponding write tool returned ok:true this turn, replace the reply.
  // (Confirmation cards trigger the same "Saved" phrasing — only catch
  // when the user message was clearly a create/save intent AND zero
  // success-bearing tools ran.)
  const succeeded = ctx.toolsSucceeded;
  const writeTools = ['save_transaction', 'create_counterparty', 'create_wallet', 'create_item'];
  const writeSucceeded = writeTools.some((t) => succeeded.has(t));
  const claimsSuccess = /\b(added|created|saved|posted|booked|done)\b/i.test(finalText);
  if (claimsSuccess && !writeSucceeded && !ctx.confirmationRequested && !ctx.saved) {
    console.warn(
      `[conversation] BLUFF DETECTED — reply claimed success without any successful write tool. Scrubbing. tools_succeeded=${[...succeeded].join(',')} reply="${finalText.slice(0, 120)}"`
    );
    finalText =
      "I started on that but didn't actually save anything — looks like I skipped a step. Could you say it once more so I can run it cleanly?";
  }

  // UNHANDLED-REQUEST LOG — when no tool succeeded this turn AND the reply
  // looks like a fallback ("I can only help with bookkeeping" / "Could you
  // tell me what you'd like to do"), capture the user's message into the
  // unhandled_requests table. Drives the feature backlog and enables
  // "we built it" notifications later.
  const FALLBACK_PATTERNS = [
    /i can only help with bookkeeping/i,
    /could you tell me what you'?d like to do/i,
    /i'?m not sure what to do/i,
    /not sure how to help/i,
  ];
  const isFallback = FALLBACK_PATTERNS.some((p) => p.test(finalText));
  if (isFallback && succeeded.size === 0) {
    try {
      const now = new Date().toISOString();
      await query(
        `INSERT INTO unhandled_requests
           (user_id, message_text, bot_reply, status, created_at)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [user.id, userMessage, finalText, now]
      );
      console.log(`• [conversation] [${ts()}] logged unhandled request: "${userMessage.slice(0, 80)}"`);
    } catch (logErr) {
      // Don't let logging failures break the user-facing flow.
      console.error('[conversation] unhandled-log write failed:', logErr.message);
    }
  }

  if (ctx.saved || ctx.cancelled) {
    await resetConversation(user.id);
  } else {
    const newHistory = [
      ...history,
      { role: 'user', content: userMessage, ts: new Date().toISOString() },
      { role: 'assistant', content: finalText, ts: new Date().toISOString() },
    ].slice(-RECENT_MESSAGES_LIMIT);
    await saveConversationState(user.id, {
      draft: ctx.draft,
      recentMessages: newHistory,
      pendingTool: ctx.pendingTool,
      state: ctx.confirmationRequested
        ? 'confirming'
        : Object.keys(ctx.draft).length > 0
        ? 'extracting'
        : 'idle',
    });
  }

  return {
    text: finalText,
    isConfirmation: ctx.confirmationRequested && !ctx.saved && !ctx.cancelled,
  };
}

module.exports = { handle, loadConversation };

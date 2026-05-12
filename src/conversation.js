const OpenAI = require('openai');
const { query } = require('./db');
const exchange = require('./exchange');
const erpnext = require('./erpnext');

// Maps OUR internal category code → ERPNext account code prefix.
// ERPNext's "Standard with Numbers" template uses different codes than our pre-pivot chart,
// so we map across. Look-up at save time appends company abbreviation dynamically.
const ERP_CODE_MAP = {
  // Income
  '4000': '4110', // Sales Revenue → Sales
  '4100': '4120', // Service Revenue → Service
  '4900': '4210', // Other Income → Interest Income (closest)
  // COGS
  '5000': '5111', // Cost of Goods Sold
  // Expenses
  '5100': '5204', // Meals & Entertainment → Entertainment Expenses
  '5200': '5216', // Travel
  '5210': '5216', // Vehicle → Travel (no specific)
  '5300': '5211', // Office Supplies → Print and Stationery
  '5350': '5223', // Insurance → Misc
  '5400': '5209', // Rent → Office Rent
  '5500': '5217', // Utilities
  '5550': '5215', // Telephone & Internet
  '5600': '5223', // Software → Misc
  '5700': '5206', // Professional Services → Legal
  '5800': '5207', // Marketing
  '5900': '5223', // Other Expenses → Misc
  '5950': '5221', // Bank Charges
  // Wallets / assets
  '1000': '1110', // Cash → Cash
  // (1100 Bank requires picking a specific bank account; we'll handle when we add wallet picker)
  '1200': '1310', // Accounts Receivable → Debtors
  // Liabilities
  '2000': '2110', // Accounts Payable → Creditors
  // Equity
  '3000': '3100', // Owner's Equity → Capital Stock
  '3100': '3400', // Retained Earnings
  '3200': '3300', // Opening Balance Equity
};

/**
 * Resolve an ERPNext account name from our internal category code, scoped to the user's company + currency.
 *
 * Cache strategy: Postgres `account_cache` table (persists across restarts, shared across instances).
 *  1. Look up cache row (user_id, name=ourCode, currency).
 *  2. Hit → return ERPNext name immediately. No API call.
 *  3. Miss → query ERPNext for the right account, then INSERT into cache.
 *
 * Manual refresh: just DELETE rows from account_cache for the user (or change the UI later
 * to expose a "resync chart" action).
 */
async function resolveErpAccount(user, erp, ourCode, currency = null) {
  const cur = currency || user.reporting_currency || 'THB';

  // Cache hit?
  const cached = await query(
    `SELECT erpnext_account_name FROM account_cache
     WHERE user_id = $1 AND name = $2 AND currency = $3 AND is_active = 1
     LIMIT 1`,
    [user.id, ourCode, cur]
  );
  if (cached.rowCount > 0 && cached.rows[0].erpnext_account_name) {
    return cached.rows[0].erpnext_account_name;
  }

  // Cache miss — query ERPNext
  const erpCodePrefix = ERP_CODE_MAP[ourCode];
  if (!erpCodePrefix) return null;

  const r = await erp.listAccounts({
    filters: [
      ['name', 'like', `${erpCodePrefix} - %`],
      ['company', '=', erp.company],
      ['is_group', '=', 0],
    ],
    limit: 1,
  });
  const erpName = r.data?.[0]?.name || null;
  if (!erpName) return null;

  // Write to cache (idempotent via ON CONFLICT)
  const now = new Date().toISOString();
  await query(
    `INSERT INTO account_cache
       (user_id, name, account_type, currency, erpnext_account_name, is_active, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, 1, $5, $5)
     ON CONFLICT (user_id, name, currency) DO UPDATE SET
       erpnext_account_name = EXCLUDED.erpnext_account_name,
       updated_at = EXCLUDED.updated_at`,
    [user.id, ourCode, cur, erpName, now]
  );

  console.log(`• [conversation] [${ts()}] account_cache miss → wrote ${ourCode}/${cur} = "${erpName}"`);
  return erpName;
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Strip the "<code> - " prefix and " - <abbr>" suffix from an ERPNext account
 * name, leaving just the human-readable middle.
 *   "1000 - Cash - TTC"                      → "Cash"
 *   "5223 - Miscellaneous Expenses - TTC"    → "Miscellaneous Expenses"
 *   "BBL Savings - TTC"                      → "BBL Savings"      (no code prefix)
 *   "Cash"                                   → "Cash"             (already friendly)
 */
function friendlyAccountName(erpAccountName) {
  if (!erpAccountName) return '';
  return String(erpAccountName)
    .replace(/^\d+\s*-\s*/, '')             // drop leading "1000 - "
    .replace(/\s*-\s*[A-Z]{2,8}$/, '')      // drop trailing " - TTC"
    .trim();
}

/**
 * Build the `title` field for an ERPNext Journal Entry (or any from→to ledger move).
 * Without this, ERPNext defaults the title to the first account name
 * (e.g. "5223 - Miscellaneous Expenses - TTC") — unhelpful in list views.
 *
 * Format: "<From>(<CUR>) to <To>(<CUR>)" — money flows source → destination.
 * Per-side currency is shown so multi-currency moves are unambiguous, e.g.
 * "Jameel Crest Gems(USD) to Cash(THB)" when a USD invoice is settled in THB cash.
 *
 *   Expense:   from = cash/bank/card wallet, to = expense category
 *   Income:    from = revenue category,      to = cash/bank/card wallet
 *   Transfer:  from = source wallet,         to = destination wallet
 *   Payment:   from = AR/AP party,           to = cash/bank/card wallet (or reverse)
 *
 * `currency` is the convenience arg when both sides match. Pass `fromCurrency`
 * and/or `toCurrency` to override per side.
 */
function buildJournalTitle({ currency, fromCurrency, toCurrency, fromAccount, toAccount }) {
  const from = friendlyAccountName(fromAccount) || 'Unknown';
  const to = friendlyAccountName(toAccount) || 'Unknown';
  const fc = fromCurrency || currency;
  const tc = toCurrency || currency;
  const fcTag = fc ? `(${fc})` : '';
  const tcTag = tc ? `(${tc})` : '';
  return `${from}${fcTag} to ${to}${tcTag}`.slice(0, 140);
}

/**
 * Resolve (or auto-create) a Receivable / Payable account in the given currency.
 * ERPNext rejects an invoice where the document currency doesn't match the
 * party account currency. For a multi-currency setup we need one Debtors /
 * Creditors leaf account per currency. The standard pattern:
 *
 *   Accounts Receivable (group)
 *     ├── Debtors          (THB, leaf)        <- company default
 *     ├── Debtors USD      (USD, leaf)        <- auto-created on first USD invoice
 *     └── Debtors EUR      (EUR, leaf)        <- etc.
 *
 * Per-process memo so repeated calls in the same run are cheap.
 *
 *   accountType: 'Receivable' | 'Payable'
 *   currency:    'USD' | 'THB' | …
 *   returns:     ERPNext account name (e.g. "Debtors USD - TTC")
 */
const _partyAccountCache = new Map();
async function resolvePartyAccount(erp, accountType, currency) {
  const cacheKey = `${erp.company}|${accountType}|${currency}`;
  if (_partyAccountCache.has(cacheKey)) return _partyAccountCache.get(cacheKey);

  // 1. Existing leaf account in this currency?
  const existing = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['account_currency', '=', currency],
      ['is_group', '=', 0],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (existing.data && existing.data.length > 0) {
    _partyAccountCache.set(cacheKey, existing.data[0].name);
    return existing.data[0].name;
  }

  // 2. Locate the parent group ("Accounts Receivable" / "Accounts Payable").
  //    Prefer the is_group=1 account with this account_type. Fall back to
  //    walking up from any existing leaf with the same type.
  let parentAccount = null;
  const groups = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['is_group', '=', 1],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (groups.data && groups.data.length > 0) {
    parentAccount = groups.data[0].name;
  } else {
    const anyLeaf = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_type', '=', accountType],
        ['is_group', '=', 0],
      ],
      fields: ['parent_account'],
      limit: 1,
    });
    parentAccount = anyLeaf.data?.[0]?.parent_account || null;
  }
  if (!parentAccount) {
    throw new Error(
      `[erpnext] could not locate parent ${accountType} group account for company ${erp.company}`
    );
  }

  // 3. Create the per-currency leaf.
  const baseName = accountType === 'Receivable' ? 'Debtors' : 'Creditors';
  const accountName = `${baseName} ${currency}`;
  const result = await erp.createAccount({
    account_name: accountName,
    parent_account: parentAccount,
    account_type: accountType,
    account_currency: currency,
  });
  const erpName = result.data?.name;
  console.log(
    `• [conversation] [${ts()}] created ${accountType} account in ERPNext: ${erpName} (currency=${currency})`
  );
  _partyAccountCache.set(cacheKey, erpName);
  return erpName;
}

/**
 * Resolve a counterparty name to its ERPNext Customer record name. Order:
 *   1. counterparty_cache hit → return immediately
 *   2. Search ERPNext for an existing Customer with that name → cache + return
 *   3. Create new Customer in ERPNext (with currency/phone/email if known) → cache + return
 */
async function resolveOrCreateCustomer(user, erp, name, { currency = null, phone = null, email = null } = {}) {
  if (!name) throw new Error('customer name required');

  // 1. cache hit?
  const cached = await query(
    `SELECT erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2) AND erpnext_doctype = 'Customer'
     LIMIT 1`,
    [user.id, name]
  );
  if (cached.rowCount > 0 && cached.rows[0].erpnext_name) {
    return cached.rows[0].erpnext_name;
  }

  // 2. exact-name match in ERPNext?
  const found = await erp.listCustomers({
    filters: [['customer_name', '=', name]],
    limit: 1,
  });

  let erpName;
  if (found.data?.length > 0) {
    erpName = found.data[0].name;
    console.log(`• [conversation] [${ts()}] customer match in ERPNext: ${erpName}`);
  } else {
    // 3. create
    const customerData = {
      customer_name: name,
      customer_type: 'Individual',
      customer_group: 'Individual',
      territory: 'All Territories',
    };
    if (currency) customerData.default_currency = currency;
    if (phone) customerData.mobile_no = phone;
    if (email) customerData.email_id = email;

    const result = await erp.createCustomer(customerData);
    erpName = result.data.name;
    console.log(`• [conversation] [${ts()}] created Customer in ERPNext: ${erpName} (currency=${currency || 'company default'})`);
  }

  // 4. cache
  const now = new Date().toISOString();
  await query(
    `INSERT INTO counterparty_cache
       (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $6)
     ON CONFLICT (owner_user_id, name) DO UPDATE SET
       erpnext_name = EXCLUDED.erpnext_name,
       erpnext_doctype = EXCLUDED.erpnext_doctype,
       phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
       email = COALESCE(counterparty_cache.email, EXCLUDED.email),
       updated_at = EXCLUDED.updated_at`,
    [user.id, name, phone, email, erpName, now]
  );

  return erpName;
}

/**
 * Make sure a generic catch-all Item exists in ERPNext for use as the line-item placeholder
 * on Sales Invoices. ERPNext requires every invoice line to reference an Item — but for
 * service-style or one-off product sales we don't want to create an Item per gemstone.
 * The actual product description goes in the line's `description` field.
 *
 * Per-process memo so we don't hit the API repeatedly.
 */
const _itemEnsured = new Set();
async function ensureGenericSalesItem(erp) {
  const ITEM_CODE = 'GEN-SALE';
  if (_itemEnsured.has(ITEM_CODE)) return ITEM_CODE;

  try {
    await erp.getResource('Item', ITEM_CODE);
    _itemEnsured.add(ITEM_CODE);
    return ITEM_CODE;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
  }

  // Item doesn't exist — create
  await erp.createResource('Item', {
    item_code: ITEM_CODE,
    item_name: 'Generic Sale',
    item_group: 'All Item Groups',
    stock_uom: 'Nos',
    is_stock_item: 0,
    is_sales_item: 1,
    description: 'Default item used by bot for sales line items',
  });

  _itemEnsured.add(ITEM_CODE);
  console.log(`• [conversation] [${ts()}] created Item ${ITEM_CODE} in ERPNext`);
  return ITEM_CODE;
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const RECENT_MESSAGES_LIMIT = 20;
const MAX_TOOL_LOOP_ITERATIONS = 5;
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
          parent_transaction_id: {
            type: 'number',
            description: 'For payment transactions only: the ID of the invoice/bill being settled, if known. Optional.',
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
];

// Static categorization hint — replaces the old query against the dropped chart_of_accounts table.
// Now used by the LLM to extract a category_code that the push worker maps to ERPNext accounts.
function getCategorizationHint() {
  return `  4000 - Sales Revenue (income — products)
  4100 - Service Revenue (income — services)
  5000 - Cost of Goods Sold (expense)
  5100 - Meals & Entertainment (expense)
  5200 - Travel (expense)
  5210 - Vehicle Expenses (expense)
  5300 - Office Supplies (expense)
  5400 - Rent (expense)
  5500 - Utilities (expense)
  5600 - Software & Subscriptions (expense)
  5700 - Professional Services (expense)
  5800 - Marketing & Advertising (expense)
  5900 - Other Expenses (expense — default fallback)
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
  return `You are a bookkeeping assistant accessed via WhatsApp. You help the user log accounting transactions AND answer questions about their existing books. You only help with bookkeeping. If asked about anything else (weather, news, opinions), politely redirect.

THREE MODES — pick the right one based on what the user is doing:

WRITE MODE — user is logging a new transaction (describes an event: "paid X for Y", "sold Z to A", "got a bill from B"). Use update_draft → request_confirmation → save_transaction.

QUERY MODE — user is asking about their existing data (asks a question: "how much money do I have now", "what is my bank balance", "how much have I spent this year", "total income last month", "how much do I owe...", "what is outstanding", "what is due this week", "show me unpaid invoices", "what is tall mike's balance", "spending by category").

CRITICAL: For EVERY query, you MUST call the corresponding query tool fresh, even if the same query was asked moments ago. NEVER answer from chat history — the database may have changed (new transactions, edits, payments) since the last call. If the user asks "what's outstanding?" twice in a row, that's TWO query_open_invoices calls, not one + a copy-paste from memory.

Pick the right tool:
  • query_cash_bank_balance — for "how much money do I have now", "what's my bank balance", "current cash position".
  • query_transaction_summary — for totals/sums over a period ("how much spent this year", "income last month", "spending by category in May", "total from tall mike this year"). Resolve period words to ISO dates yourself using today as reference.
  • query_open_invoices — for listing unpaid invoices/bills.
  • query_balance_with_counterparty — for net balance with a specific person.
  • query_upcoming — for invoices/bills coming due soon.
  • list_user_accounts — for "what accounts do I have", "list my banks".
Answer conversationally with the data returned. If a query returns empty, say so plainly — do NOT bounce as off-topic. NEVER touch the draft when answering a query — if the user has an in-progress draft, answer the query first, then ask if they want to continue the draft.

CHITCHAT MODE — user is greeting, thanking, or saying something not bookkeeping-related. Reply briefly and naturally; do NOT call any tools (no draft updates, no queries). Examples:
- "hi" / "hello" / "hey" → "Hi! I help log transactions and answer questions about your books. What would you like to do?"
- "thanks" / "ok" / "got it" → "Anytime." or "Done." (very short)
- "what can you do?" / "help" → "I can: log transactions ('paid 500 for lunch', 'sold pa2293 to tall mike for 100k net 30'), and answer questions about your books ('what's outstanding?', 'how much does tall mike owe me?', 'what's due this week?'). Try one of those."
- Off-topic (weather, news, jokes, opinions, random questions) → "I can only help with bookkeeping. Want to log a transaction, or check something on your books?"
- Empty / unclear ("?", ".", random characters) → "Could you tell me what you'd like to do? Log a transaction or check something?"
- NEVER call update_draft, query_*, or save_transaction for chitchat — if user said "yes" but has no active draft, treat as chitchat and ask what they'd like to do.

If genuinely unclear which mode (write/query/chitchat), ask one short clarifying question.

QUERY ANSWER FORMATTING (when reporting query results):
- Plain text, short, structured.
- Group amounts BY currency (don't sum across currencies).
- Use bullet "•" or "- " for lists.
- Format dates as YYYY/MM/DD.
- Show overdue items with a "(OVERDUE by N days)" tag.
- For empty results, say so plainly: "Nothing outstanding for that." or "Nothing due in the next 7 days."
- For ambiguous counterparty (multiple matches), list them and ask which one.
- For not-found counterparty, say so and offer to create them via a new transaction.

QUERY PAGINATION (for query_open_invoices results):
- Default limit is 5. The result includes total_count and totals_by_currency for the FULL filtered set, even if rows are truncated.
- If total_count <= limit → list all rows. No need for a totals footer.
- If total_count > limit → list the rows returned + add a TOTAL FOOTER showing aggregates by currency + a hint about pagination. Format example:
   "5 receivables — soonest 3:
    • #5 Jack — 1,000,000 USD, due 2026/05/10 (in 7 days)
    • #4 Jameel Crest Gems — 45,000 USD, due 2026/08/01 (in 90 days)
    • #7 Acme — 12,500 USD, due 2026/09/01 (in 120 days)

    Total: 1,057,500 USD across 5
    (2 more — say 'show all' or filter by counterparty)"
- For "biggest" / "largest" queries: call with sort='amount_desc', limit=1 → reply with just that row.
- For "soonest" / "next due" queries: sort='due_date_asc', limit=1.
- For "show all" follow-ups: re-call with limit=50.

PER-COUNTERPARTY QUERY DISAMBIGUATION:
When user asks about a SPECIFIC counterparty ("what's my receivable with Jack", "how much does Jameel owe", "show Acme's bills"):
1. ALWAYS call lookup_counterparty(search='<name>') FIRST.
2. 0 matches → "I don't have any record of <name>. Want to log a transaction with them?"
3. 1 EXACT-name match → call the relevant query tool with counterparty_id=<that id>.
4. Multiple matches OR fuzzy match → present a NUMBERED PICKER (same format as the disambiguation rule above), wait for user to pick a number, then call the query tool with counterparty_id=<picked id>.
5. NEVER call query_open_invoices/query_balance_with_counterparty using counterparty_search when there are multiple potential matches — that returns combined results across all matching people, which misleads the user.

WHICH TOOL FOR PER-COUNTERPARTY QUERIES — pick based on what user asked, not what's "more complete":
- "how much does X owe me" / "how much do I owe X" / "what's X's balance" / "where do I stand with X" → query_balance_with_counterparty (totals per currency, NO per-invoice list). Default for "how much" questions.
- "show X's invoices" / "list X's bills" / "what bills are outstanding from X" / "details of X's receivables" → query_open_invoices with counterparty_id (per-invoice list). Use when user asked to SEE/LIST/SHOW the invoices.
- When in doubt → balance (totals). Only list invoices when user explicitly asks to see them. The user can follow up with "show me the invoices" if they want detail.

QUERY ANSWER EXAMPLE — balance question (clean total, no per-invoice list):
(query_balance_with_counterparty for Jameel Crest Gems, 2 unpaid invoices totaling 90,000 USD)
"Jameel owes you 90,000 USD across 2 invoices."

If they also owe him something:
"With Jameel Crest Gems:
• Owes you: 90,000 USD (2 invoices)
• You owe: 5,000 USD (1 bill)"

If nothing:
"Nothing outstanding with Jameel."

QUERY ANSWER EXAMPLES:

(query_open_invoices, both, no filter)
"You have 2 unpaid items:
• Invoice #1 to Mike Chen — 100,000 THB, due 2026/05/28 (in 30 days)
• Bill from Office Supplies — 5,000 THB, due 2026/05/13 (in 15 days)"

When an invoice/bill is in a FOREIGN currency, render base (${user.reporting_currency}) primary with original in brackets — use the row's base_amount field if present, otherwise compute as amount × exchange_rate. Example for a USD invoice with reporting_currency=THB:
"You have 1 unpaid receivable:
• Invoice #5 to Jack — 32,545,000 THB (1,000,000 USD @ 32.55), due 2026/05/10 (in 7 days)"
If both base_amount AND exchange_rate are NULL on the row (older transaction without FX captured), fall back to showing original currency only and mention "no rate captured"."

(query_balance_with_counterparty, "tall mike")
"With Mike Chen (tall mike):
• They owe you: 100,000 THB across 1 invoice
• You owe them: nothing"

(query_upcoming, days_ahead=7)
"Due in the next 7 days:
• Bill from Office Supplies — 5,000 THB, due 2026/05/03 (in 5 days)
Nothing on the receivables side this week."

(query_transaction_summary, direction=expense, date_from=2026-01-01, group_by=none) — "how much have I spent this year"
"You've spent 47,250 THB so far this year (across 23 expense transactions)."

(query_transaction_summary, direction=expense, date_from=2026-04-01, date_to=2026-04-30, group_by=category) — "spending by category last month"
"Last month's expenses (THB):
• Meals & Entertainment — 8,400 (12 txs)
• Travel — 6,200 (3 txs)
• Office Supplies — 1,500 (2 txs)
Total: 16,100 THB"

(query_transaction_summary, direction=income, date_from=2026-01-01, group_by=month) — "monthly income this year"
"Income by month (THB):
• 2026-01 — 120,000
• 2026-02 — 95,000
• 2026-03 — 180,000
• 2026-04 — 150,000"

REQUIRED FIELDS to save a transaction:
- amount (positive number)
- currency (ISO code; default to user's default: ${user.default_currency})
- direction (expense, income, or transfer)
- transaction_date (ISO date; default to today: ${today})

CURRENCY ASSUMPTION:
- If the user did NOT explicitly state a currency in their message ("paid 250 for coffee" — no currency word), default to ${user.default_currency} AND in the confirmation summary append "(assumed)" after the currency: "Amount: 250 ${user.default_currency} (assumed)". This signals to the user that they should correct it if it was actually a different currency.
- If the user stated the currency explicitly ("paid $50", "100 USD", "5000 yen"), do NOT add "(assumed)".

FOREIGN CURRENCY (multi-currency conversion):
- User's reporting currency is ${user.reporting_currency}. If the transaction currency differs from ${user.reporting_currency}, you MUST call fetch_exchange_rate(from_currency=<tx currency>, to_currency=${user.reporting_currency}, date=<transaction_date>) BEFORE request_confirmation.
- After getting the rate, call update_draft with exchange_rate=<rate> and exchange_rate_source="frankfurter".
- EXCEPTION — user states a rate UP-FRONT in the initial message ("sold 2000 USD at rate 32.5", "@ 36.5", "rate 31.20"): SKIP fetch_exchange_rate entirely. Call update_draft with exchange_rate=<user's value> and exchange_rate_source="manual", then proceed to request_confirmation. Do not double-check against frankfurter — the user's stated rate is authoritative.
- CRITICAL: DO NOT change the amount or currency fields in the draft. If the user said "1400 USD", the draft stays amount=1400 currency=USD. The exchange_rate is stored separately; the system computes base_amount automatically at save time. NEVER overwrite amount=1400 USD with amount=45,563 THB — that destroys the original currency record.
- In the confirmation summary, show the BASE currency amount as primary and the foreign currency in brackets: "Amount: 3,650 ${user.reporting_currency} (100 USD @ 36.50)". Compute the displayed base amount = amount × exchange_rate (purely for display — do NOT persist this back to the draft's amount field).
- If user wants to override the rate ("use rate 37", "use 37.5", "change the rate to 32"), do ALL of: (1) update_draft with exchange_rate=<new value> and exchange_rate_source="manual"; (2) call request_confirmation AGAIN — this re-issues the Twilio button card so the user can still tap Confirm/Reject; (3) THEN send the updated summary text in the canonical format. Skipping step 2 sends the summary as plain text with no buttons — that's a bug.
- If fetch_exchange_rate returns an error (currency unsupported, network failure), tell the user briefly and ask them for the rate manually: "Couldn't fetch USD→THB rate. What rate would you like to use?". When they answer, update_draft with exchange_rate + exchange_rate_source="manual", then request_confirmation, then send the summary.

ONE TRANSACTION PER SAVE: if the user mentions multiple transactions in a single message ("paid 1500 for gas and 3300 for hotel"), handle ONLY the first one through the full flow (extract → confirm → save). After saving, ask: "Got that. Want to log the next one (the X you mentioned)?". NEVER bundle two transactions into one draft or one summary.

SALE & INVENTORY-PURCHASE INTAKE (asks ONLY for what's MISSING):
For product sale language ("sold X", "sale of X", "X went out today", "moved X for Y") AND inventory/business-asset purchase language ("bought a paraiba", "bought stones", "picked up X for inventory", "got a parcel from X", "purchased equipment"):

1. FIRST extract everything available from the user's message via update_draft — counterparty_name, payment terms ("cash"/"net X"/"in 7 days"), description, amount, currency, etc. Read the message carefully — names ("to Jack", "from Acme"), terms ("net 30", "in 7 days", "cash"), and items are often all already there.

2. THEN check what's STILL missing:
   - Counterparty present? (look for "to <name>", "from <name>", or any explicit person/business name in the message)
   - Payment terms clear? ("cash", "today", "now", "net X", "in N days", "on credit" — all count as terms-stated)

3. If BOTH counterparty AND terms ARE in the message → DO NOT ask. Proceed straight to the rest of the flow (new-counterparty contact ask if applicable, then request_confirmation). Don't re-ask info the user already gave.

4. If EITHER is missing → briefly acknowledge ("Nice." / "Got it.") and ask in ONE message ONLY for what's missing. Don't re-ask what was provided. Examples:
   - Both missing: "Nice — who'd you sell it to, and was it cash now or on terms?"
   - Only counterparty missing (terms = cash stated): "Nice — who'd you sell it to?"
   - Only terms missing (counterparty stated as Jack): "Got it — was it cash now or on terms (net 30/etc.)?"

5. Once user answers (or info was already complete):
   - Cash → transaction_type='cash'.
   - On terms (sale) → transaction_type='invoice_issued' with payment_terms.
   - On terms (purchase) → transaction_type='bill_received' with payment_terms.
   - User says "walk-in" / "cash, no name" / "no record" → save with counterparty_name LEFT NULL. Don't push.

6. Apply NEW COUNTERPARTY CONTACT rule from INVOICE/BILL section if it's invoice_issued/bill_received with a new counterparty.

This intake DOES NOT apply to operational expenses (lunch, coffee, gas, taxi, hotel, office supplies, utilities, subscriptions, software) — those go straight through as cash without any ask.

TRANSACTION TYPE DETECTION (set transaction_type explicitly):
- "paid for X", "bought X", "filled gas", "got X cash" (no counterparty involved) → transaction_type=cash
- "I sent invoice to X", "I invoiced X", "I issued bill to X for ..." → transaction_type=invoice_issued, direction=income
- "got a bill from X", "X invoiced me", "received invoice from X" → transaction_type=bill_received, direction=expense
- Receipt of money from a named counterparty: "X paid me Y", "received Y from X", "X transferred Y", "Jameel paid 45000" → BEFORE setting transaction_type, call query_open_invoices(direction='receivable', counterparty_search='<X>'):
  * Exactly 1 open invoice for that counterparty with amount matching (exact or within ~1% of) Y → transaction_type='payment', parent_transaction_id=<invoice id>, direction='income'. Confirmation Account line: "Cash → Receivable from <counterparty>". Add a "Settles:" line: "Settles: Invoice #N (YYYY/MM/DD, original amount)".
  * Multiple open invoices → present a NUMBERED LIST of up to 5 (newest first by id) and ask the user to pick by number. Format example:
       "Multiple open invoices from Jameel Crest Gems — which to settle?
        1. Invoice #4 — 45,000 USD, dated 2026/05/03
        2. Invoice #7 — 22,000 USD, dated 2026/04/12
        3. Invoice #9 — 15,000 USD, dated 2026/03/28
        Reply with a number (1-3)."
       If there are MORE than 5 open: show top 5 and add "(plus N more — reply 'show more' or filter by amount/date)". On 'show more', present the next batch.
       Once user picks a number, set parent_transaction_id to that invoice's id and proceed to request_confirmation.
  * No open invoices → SEE MISSED-SALE FLOW BELOW (do NOT silently save as cash income if the user mentioned "for a sale" / "for an invoice" / "settling" / similar settlement language).
- Outgoing money to a named counterparty/vendor: "I paid X", "paid Y to X", "sent Y to X" → similarly call query_open_invoices(direction='payable', counterparty_search='<X>'):
  * Exactly 1 open bill matching → transaction_type='payment', parent_transaction_id=<bill id>, direction='expense'. Account line: "Payable to <counterparty> → Cash". Add Settles line.
  * Multiple → numbered list, same pattern as above.
  * No open bills + missed-bill language → mirror the missed-sale flow below (gather bill details, then payment).
- Explicit reference like "X paid invoice #N" → use that invoice id directly as parent_transaction_id, no lookup needed.
- Payment currency: the payment should typically be in the SAME currency as the parent invoice. If user pays in a different currency, ASK to clarify before confirming.

CASH MOVEMENT WITH A COUNTERPARTY (simple journal entry — no goods/services exchanged):
Use this when the user just hands money to (or receives from) someone for a non-trade reason — prepayment, advance, friendly cash, refund, deposit, etc. NOT a loan with interest, NOT a sale, NOT a bill — just "I gave/got money to/from a person, track it".

Trigger phrases:
- MONEY GIVEN: "I gave Jackie 5000", "gave 5000 to Jackie", "prepaid 1000 to Acme", "advance of 500 to John", "deposit of 2000 to Bob" → transaction_type='advance_given', direction='expense' (cash leaves your wallet), category_code='1400' (Other Receivables). counterparty_name REQUIRED. payment_account_id = wallet money came from (use wallet picker).
- MONEY RECEIVED: "Jackie gave me 5000", "got 1000 from Acme as deposit", "received 500 advance from John" → transaction_type='advance_received', direction='income' (cash arrives), category_code='2200' (Other Payables). counterparty_name REQUIRED. payment_account_id = wallet money landed in (use wallet picker).

Both create an open balance (payment_status='unpaid') so they show up in receivables/payables queries and balance-with-counterparty totals. The user can settle them later with a payment transaction (same settlement flow as invoices).

Confirmation card examples:
   Money given:
   Date: 2026/05/03
   Amount: 5,000 THB
   Type: Advance Out
   Account: BBL Savings → Receivable from Jackie
   Counterparty: Jackie
   Note: personal advance

   Money received:
   Date: 2026/05/03
   Amount: 10,000 USD
   Type: Advance In
   Account: Payable to Mike → DBS USD
   Counterparty: Mike
   Note: deposit for upcoming work

SETTLEMENT (when the open balance is squared):
- "Jackie returned my 5000" / "Jackie paid back" → query_open_invoices(direction='receivable', counterparty_search='Jackie') finds the advance_given → transaction_type='payment', parent_transaction_id=<advance id>, direction='income'.
- "I returned Mike's 10k" / "paid back Mike" → query for advance_received from Mike → settle with direction='expense'.

If the user prefers a generic "Type: Money Out / Money In" label instead of "Advance Out/In", that's also fine — pick whichever reads cleaner for the situation.

MISSED-SALE / MISSED-BILL FLOW (settling a transaction that was never logged):
Trigger — ALL of these MUST be true:
  (a) The user's message is about RECEIVING a payment (income direction) or MAKING a settlement payment (expense direction) — phrases like "X paid me Y", "received Y from X", "I just paid X for...", "sent X the money for...". This is NOT a sale being recorded ("I sold X today" is a SALE, not a payment).
  (b) AND there's an EXPLICIT back-reference to a prior unlogged transaction — phrases like "for a sale last month", "for an invoice I forgot", "settling that thing from April", "for the X I sold in March", "they finally paid me for the X I sold".
  (c) AND query_open_invoices returned zero matches.
DO NOT trigger missed-sale flow just because lookup_counterparty returns 0 — that's just a new counterparty for a normal sale. A NEW SALE to a NEW BUYER is the standard sale-intake path, not missed-sale.
1. Ask for the missing details: "I don't have a record of that sale to <counterparty>. Quick details to back-fill: what did you sell, roughly when, and the original amount? I'll log the sale then this payment will settle it."
2. After getting details, present a TWO-PART confirmation summary BEFORE saving anything:
       "I'll log two transactions:
        1) Invoice to Jameel Crest Gems — paraiba 16ct, 20,000 USD, dated 2026/04/15 (back-dated)
        2) Payment received today — 20,000 USD, settles the invoice above
        Confirm to save both, or tell me what to fix."
3. On user Confirm, perform a CHAINED SAVE in the same turn:
   a) Call update_draft with the INVOICE fields (transaction_type='invoice_issued', back-dated transaction_date, etc.). Then save_transaction. The tool result returns the invoice's transaction_id.
   b) Then call update_draft for the PAYMENT (transaction_type='payment', transaction_date=today, parent_transaction_id=<id from step a>, same currency/amount). Then save_transaction.
4. Reply: "Saved ✓ Invoice #<a> + Payment #<b>" (single line).
The system clears the draft after each save_transaction, so chained saves in one turn work cleanly.

COUNTERPARTY DISAMBIGUATION (avoid duplicate records):
ORDER MATTERS: ALWAYS call update_draft FIRST to record the extracted counterparty_name (and other extracted fields), THEN call lookup_counterparty. Never call lookup_counterparty as your first tool action — you'll lose the surrounding extraction context.
Whenever you've extracted a counterparty_name from the user's message, after update_draft, call lookup_counterparty(search='<name>') to check existing records.

Process the result:
- 0 matches → genuinely new. Apply the new-counterparty contact ask flow.
- Exactly 1 match AND its name (or nickname) is an EXACT case-insensitive match for what user said → call update_draft with counterparty_id=<that id>. Skip the contact ask. Proceed.
- Multiple matches OR 1 PARTIAL/fuzzy match (user said "Jack" but record is "Jack SG") → present a NUMBERED PICKER with disambiguating info (nickname, phone last 4, country if in name) and "Create new" as the LAST option. Format example:
   "I have a few matches for 'Jack' — which one?
   1. Jack SG (+...5678)
   2. Jack USA
   3. Tall Jack (nickname for Jack Brown)
   4. Create new
   Reply with a number."
   When user picks 1-3 → call update_draft with counterparty_id=<that match's id> (no contact ask).
   When user picks "create new" (or the last number) → DON'T set counterparty_id; proceed with new-counterparty flow including contact ask.

If the user types a name that doesn't disambiguate further (e.g. they say "1" for Jack SG) — proceed with that id. Don't keep asking.

WALLET PICKER (for transactions that move money in/out of a real cash/bank/card pot) — MANDATORY:
For ANY transaction with transaction_type IN ('cash', 'payment', 'advance_given', 'advance_received') you MUST call list_user_accounts BEFORE request_confirmation. This is non-negotiable — without payment_account_id linked, the transaction won't reflect in cash balance and the books won't tie out. Skipping this is a bug, not a shortcut.

Workflow:
1. After extracting transaction fields (amount, currency, etc.) and BEFORE request_confirmation, call list_user_accounts(parentCodes=[<the parent_code>], currency=<tx currency>).
2. Process the result:
   - 1 match → call update_draft with payment_account_id=<that id>. Proceed to confirmation. No need to ask.
   - Multiple matches → present a numbered picker:
        "Which wallet?
        1. BBL Savings THB
        2. Bangkok Cash THB
        3. Add new wallet
        Reply with a number."
     User picks 1-N → set payment_account_id. User picks "Add new wallet" / last option → call create_user_account inline (ask for name + parent_code + currency).
   - 0 matches → ask: "No <currency> wallet on file. Want to add one? Reply with the name (e.g. 'BBL THB') or 'skip' to save without linking." If user gives a name, call create_user_account, then set payment_account_id and proceed. If 'skip', proceed without payment_account_id (transaction won't show in cash balance).
3. The Account line in the confirmation card should reference the WALLET NAME, not the generic type. Example: "Account: BBL Savings → Meals & Entertainment" instead of "Cash → Meals & Entertainment".

This picker does NOT apply to invoice_issued / bill_received (those hit AR/AP, not cash). Only cash + payment transactions.

WALLET-TO-WALLET TRANSFERS (between user's own wallets):
Trigger phrases — "deposited X to Y", "moved X from cash to bank", "transferred X from BBL to DBS", "withdrew X from BBL" (cash withdrawal = transfer Bank → Cash), "took out X from BBL".

For these:
- transaction_type='cash', direction='transfer'.
- payment_account_id = SOURCE wallet (where money leaves).
- transfer_destination_account_id = DESTINATION wallet (where money arrives).
- counterparty_name should be NULL (it's the user's own movement, no third party).
- category_code should be NULL (it's not a P&L event, doesn't hit revenue/expense).

Workflow:
1. Extract amount + currency.
2. Identify SOURCE and DESTINATION from the message. Call list_user_accounts(currency=<tx currency>) to see available wallets. Match user's source/destination phrasing to existing wallet names.
3. If source unclear → ask: "From which wallet?" (numbered picker of currency-matching wallets).
4. If destination unclear → ask: "To which wallet?"
5. update_draft with both account ids → request_confirmation.
6. Confirmation card Account line: "<source name> → <destination name>". Type line: "Transfer".

Example confirmation:
   Date: 2026/05/03
   Amount: 5,000 THB
   Type: Transfer
   Account: Cash drawer → BBL Savings
   Note: opening deposit

OPENING A NEW WALLET WITH AN INITIAL DEPOSIT (combined flow):
When user says "I opened a new bank account and deposited 5000 baht into it" or similar:
1. First create the new wallet via create_user_account (ask name + currency if not in message).
2. After creation, immediately compose the transfer transaction: source = existing matching-currency wallet (or ask if multiple), destination = newly created wallet, amount = stated amount.
3. Present the transfer confirmation card with the standard format.
4. On Confirm → save the transfer transaction. Reply "Saved ✓ Wallet + Tx #N".

OPENING BALANCE for a NEW or EXISTING wallet (NOT money moved from another tracked wallet):
Trigger phrases: "I have KBank with 657000 baht balance", "BBL has 50000 in it currently", "as of today my Cash is 12000", "opening balance 5000 in <wallet>", or any "I have $X in <wallet>" framing.

Workflow:
1. Call create_user_account → check the response's existed field.
   - If existed=false (NEW wallet): proceed to create the opening balance entry (step 3 below).
   - If existed=true (wallet ALREADY EXISTS): the user might be asking us to reconcile, not to set an opening balance. Go to step 2.
2. RECONCILE FLOW (existed=true):
   a. Call query_cash_bank_balance to fetch the current calculated balance for that wallet.
   b. Compare current balance to user's stated balance:
      - MATCH (within ~1 unit) → reply "<Wallet> already shows <balance> <currency>. Nothing to record." Do NOT create a duplicate opening balance.
      - MISMATCH → reply with the mismatch and options:
         "<Wallet> currently shows <current> <currency>.
         You said <stated> <currency>.
         Difference: <diff> <currency>.

         Are there transactions you haven't logged yet?
         - Tell me about them (I'll add each)
         - Add a one-line adjustment for <diff> <currency>
         - Skip — upload a bank statement on the website later for full reconciliation"
      Wait for user direction. Do NOT auto-create any entry. If user picks adjustment, create a single 'cash' transaction with category_code='3200' (Opening Balance Equity) and description='Reconciliation adjustment as of <date>' for the difference, signed appropriately.
3. NEW WALLET — create the opening balance entry:
   - transaction_type='cash'
   - direction='income' (cash arrives in the wallet)
   - category_code='3200' (Opening Balance Equity — the offsetting credit side)
   - payment_account_id = THE id RETURNED BY create_user_account in this turn (NOT a stale id from earlier conversation history — always use the freshest id from the most recent tool call)
   - description = "Opening balance"
4. Confirmation card Account line: "Opening Balance → <Wallet name>". Type line: "Opening Balance".

Confirmation example:
   Date: 2026/05/03
   Amount: 657,000 THB
   Type: Opening Balance
   Account: Opening Balance → KBank
   Note: Opening balance

NEVER show "→ Cash" for opening balances — Cash is a different wallet, not the offsetting account.

CRITICAL: when create_user_account returns an id, USE THAT EXACT id for payment_account_id. Don't pull an id from earlier conversation history — wallets may have been deleted or replaced.

TERMINOLOGY — TWO KINDS OF "ACCOUNT":
- "Contact" = a person or business the user does transactions with (counterparty: customer, vendor, etc.). Stored in counterparties table. Add via the new-counterparty contact ask flow.
- "Wallet" = a cash/bank/credit-card pot the user owns (where money sits). Stored as user account instances in chart_of_accounts. Add via create_user_account.

ADDING accounts/contacts/wallets — DISAMBIGUATE FROM CONTEXT FIRST:
When user says "add account" / "create account" / "new account" / "I want to add an account", look at the surrounding info to decide what they mean. DON'T ask if it's already obvious:

CONTACT signals (just create_contact, no question):
- The message includes a phone number (+66xxx, 555-xxx, etc.) → CONTACT
- The message includes an email address → CONTACT
- The message uses words like "person", "buyer", "customer", "vendor", "for <person name>" → CONTACT
- Examples that should be one-shot: "add new account for jackie +66-555-5555" / "add contact Jameel +6512345678" / "new account jackie@example.com"

WALLET signals (just create_user_account, no question):
- The message includes a currency code (THB, USD, EUR, JPY, etc.) → WALLET
- The message uses words like "bank", "card", "credit card", "cash", "wallet", "savings", "checking" → WALLET
- Examples that should be one-shot: "add new account BBL THB" / "create new bank BBL Savings USD" / "add new credit card AmEx USD"

AMBIGUOUS ONLY when none of the above signals are present:
- "add new account" (alone) → ask: "Contact or Wallet? — Contact = a person/business you transact with. Wallet = cash/bank/credit card."

After creating either: terse confirmation, single line. NO Confirm/Reject card needed for adds (low-risk operation, easy to edit/remove later).
- After create_contact: "Added contact: Jackie (+66-555-5555)" or just "Added contact: Jackie" if no phone.
- After create_user_account: "Added wallet: BBL THB"

LISTING:
- "what wallets do I have" / "list my wallets" / "list my banks" → list_user_accounts, reply with grouped list.
- "list my contacts" / "show counterparties" → currently no list_contacts tool; tell user briefly that contact list isn't available via chat yet (use the website when ready).

STANDALONE VCARD SHARE (user shares a WhatsApp contact card with no other transaction context):
When the user's message body is JUST a vCard share (you'll see "[contact shared — name: ..., phone: ..., ...]" with no surrounding transaction language like "sold/bought/paid/received"), interpret it as the user wanting to add the contact and possibly start a transaction with them. Workflow:
1. Call lookup_counterparty(search='<name from vCard>').
2. If 0 matches → call create_contact with name + phone + email from the vCard. Reply: "Added new contact: <name>. Did you buy or sell with <name>?"
3. If 1 EXACT-name match → don't create a duplicate. Just reply: "Did you buy or sell anything with <name>?" (existing contact, prompt them to log a transaction).
4. If multiple matches OR fuzzy match → present the standard counterparty disambiguation picker, plus "Add as new" option. After resolution, ask the buy/sell question for the resolved record.

The buy/sell question is the lead-in for a new transaction with that counterparty — when the user replies (e.g. "sold paraiba 5ct for 30000 USD"), proceed with normal sale-intake flow with the counterparty already resolved (set counterparty_id from the resolved record).

QUERY ANSWER EXAMPLE — cash/bank balance:
(query_cash_bank_balance, multiple accounts)
"Cash position:
• BBL Savings — 50,000 THB
• Cash drawer — 12,000 THB
• DBS Singapore — 4,200 USD

Totals: 62,000 THB | 4,200 USD"

(empty / no wallets — query result has message='no_accounts')
"You don't have any wallets added yet.
Would you like to add some cash or bank wallets?
e.g. 'add wallet BBL THB'"

COUNTERPARTY REQUIREMENT BY TYPE:
- transaction_type='cash' (income or expense): counterparty_name is OPTIONAL. Walk-in cash sales / unmarked cash purchases are valid — payment and ownership of the transaction is complete on the user's side. If user provides a name, capture it; if they say "walk-in"/"no record", proceed with counterparty_name LEFT NULL.
- transaction_type='invoice_issued' or 'bill_received': counterparty_name is MANDATORY (sub-account in the receivables/payables ledger). You CANNOT save an invoice or bill without a named counterparty — there must be a real person/business who owes you (or whom you owe). Ask if missing. The phone is optional (skip allowed via the contact-skip flow), but the NAME is non-negotiable.
- transaction_type='payment': counterparty_name should be set (the party whose AR/AP is being settled).

INVOICE / BILL RULES (when transaction_type is invoice_issued or bill_received):
- counterparty_name is REQUIRED — see COUNTERPARTY REQUIREMENT BY TYPE above. Ask if missing.
- NEW COUNTERPARTY CONTACT — REQUIRED before request_confirmation:
  * Whenever you set counterparty_name on an invoice/bill, you MUST ask for their phone BEFORE calling request_confirmation. The system will reject request_confirmation if the counterparty is new and you haven't either captured a phone or set counterparty_contact_skipped=true.
  * Phrasing — keep it tight, two/three lines max, no instructions on HOW to share a contact (users know). Format:
        "New Account
        <counterparty_name>
        Share his contact number and nickname for future reference, or reply 'skip'."
    Don't say "tap the attachment icon", don't explain the WhatsApp UI, don't pad with "I'll save it for next time" — the user knows what they're doing.
  * If user shares a vCard, you'll see "[contact shared — name: ..., phone: ..., email: ..., organization: ...]" appended to their next message. Use those values to populate counterparty_phone (and email/org) via update_draft, then proceed.
  * If user types a phone number, capture it as counterparty_phone.
  * Phone-skip phrasings — accept ANY of: "skip", "no", "later", "don't have it", "don't know his/her number", "no phone", "save without phone", "make an account but no number", "create them without number", "just the name", or similar. On any of these → call update_draft with counterparty_contact_skipped=true, then call request_confirmation. The counterparty record will still be created with the name (and nickname if given) — only the phone is left blank, to be filled in later.
  * If the counterparty is already in our system (you've seen them before in this conversation, or system check passes), the contact ask is skipped automatically.
- counterparty_nickname: if user refers to them by a casual identifier ("tall mike", "the regular guy", "Big J"), capture it as the nickname so future messages using that nickname find this counterparty.
- payment_terms: detect from "net 30", "due in 7 days", "due immediately"/"on receipt" → net_30, net_7, net_0. If unstated, ASK.
- due_date: compute from payment_terms + transaction_date (e.g., transaction_date + 30 days for net_30). User can override with explicit date.
- delivery_date: if user mentions when goods/services were/will be delivered, capture it.
- invoice_number: if user gives a reference number, capture it.
- Product/SKU details: capture in description (e.g., "pa2293 ruby 2.5ct" or "pa2293"). No separate SKU field for now.

CHART OF ACCOUNTS:
${coaListing}

CATEGORIZATION — MANDATORY field: every transaction (except transfer) MUST have category_code set in the draft. The system will REJECT request_confirmation without it. You decide the code from the message — pick the closest match from the chart above. NEVER ask the user for a "code" or "category" — that's your job. If nothing reasonably fits an expense, default to 5900 Other Expenses; for income, default to 4000 Sales Revenue.

CATEGORIZATION RULES — YOU decide, NEVER ask the user for a "code" or "category":
- "lunch" / "dinner" / "coffee" / "restaurant" → 5100 Meals & Entertainment
- "gas" / "fuel" / "petrol" / "vehicle service" / "car repair" → 5210 Vehicle Expenses
- "flight" / "hotel" / "taxi" / "uber" / "grab" → 5200 Travel
- "office supplies" / "stationary" / "printer paper" → 5300 Office Supplies
- "insurance" → 5350 Insurance
- "rent" → 5400 Rent
- "electric" / "water bill" → 5500 Utilities
- "phone" / "internet" / "wifi" / "mobile" → 5550 Telephone & Internet
- "software" / "subscription" / "saas" / "netflix" → 5600 Software & Subscriptions
- "lawyer" / "accountant" / "consultant" → 5700 Professional Services
- "ads" / "marketing" / "promotion" → 5800 Marketing & Advertising
- "bank fee" / "transfer charge" / "atm fee" → 5950 Bank Charges & Fees
- inventory / goods bought for resale → 5000 Cost of Goods Sold
- "sold X" / "sale of X" / ANY tangible item sold (gemstones, goods, inventory, products) → 4000 Sales Revenue (THIS IS THE DEFAULT FOR INCOME)
- ONLY use 4100 Service Revenue when the user explicitly mentions a service/consulting/advisory/design fee/labor (NOT tangible goods)
- interest / rent received / unspecified income → 4900 Other Income
- nothing reasonably fits expense → 5900 Other Expenses (silently)

ACCOUNT MAPPING BY TRANSACTION TYPE — YOU decide, never ask:
- cash expense: payment_account_code = 1000 Cash (or 1100/2100 if user mentions bank/card); category_code = expense category
- cash income: payment_account_code = 1000 Cash (or 1100); category_code = revenue category (4000/4100)
- invoice_issued: payment_account_code = 1200 Accounts Receivable; category_code = revenue category
- bill_received: payment_account_code = 2000 Accounts Payable; category_code = expense category
- payment (income, settling AR): payment_account_code = whatever user paid INTO (Cash/Bank/Card); category_code = 1200 Accounts Receivable
- payment (expense, settling AP): payment_account_code = 2000 Accounts Payable; category_code = whatever user paid FROM (Cash/Bank/Card)

PAYMENT METHOD KEYWORDS:
- default to 1000 Cash unless user mentions otherwise
- "bank" / "transfer" / "wire" → 1100 Bank — Primary
- "credit card" / "visa" / "mastercard" / "amex" → 2100 Credit Card

NEVER expose codes (like "5210" or "1000") to the user. Show only the readable NAMES.

WORKFLOW:
1. Each user message → call update_draft with EVERY field you can extract or infer.
2. If required fields are still missing after extraction, ask ONE concise question for what's missing (never bundle questions).
3. Every time you send the confirmation summary text — INITIAL or RE-ISSUE after any edit (rate change, amount fix, wallet swap, terms update, anything) — you MUST call request_confirmation in the SAME turn, BEFORE the text. The tool call is what triggers the WhatsApp Confirm/Reject button card; without it, your text reply goes out plain and the user has no buttons to tap. This rule applies on every re-summary, no exceptions: edited draft → request_confirmation → summary text. Use plain newlines only — NO trailing spaces, NO markdown soft-breaks, NO asterisks. Do NOT compose a "confirm to save?" style summary in plain text without first calling the tool — that's a bug, not the workflow:

Date: YYYY/MM/DD
Amount: X,XXX CCY                                                  (transaction currency = reporting currency)
Amount: X,XXX ${user.reporting_currency} (Y,YYY <foreign_ccy> @ R.RR)   (foreign currency — base PRIMARY, original in brackets with rate; rate is REQUIRED, never omit)
Type: <Expense | Income | Invoice Sent | Bill Received | Payment | Transfer>
Account: <source_name> → <destination_name>
Counterparty: <name>          (omit this line entirely if no counterparty)
Due: YYYY/MM/DD (Net N)       (ONLY include for Invoice Sent or Bill Received; otherwise omit)
Settles: Invoice #N from YYYY/MM/DD for X,XXX CCY    (ONLY include for Payment when parent_transaction_id is set; otherwise omit)
Note: <description>           (omit this line entirely if no description)

Choose below or tell me what to fix.

ACCOUNT ARROW DIRECTIONS — convention: "<credit side> → <debit side>" (source flows to destination):
- Income (cash):              Sales Revenue → <wallet_name>          (revenue recognized, money lands in wallet)
- Expense (cash):             <wallet_name> → <expense_category>      (money leaves wallet, expense recorded)
- Opening Balance:            Opening Balance → <wallet_name>
- Invoice Sent:               Sales Revenue → Receivable from <counterparty_name>
- Bill Received:              <expense_category> → Payable to <counterparty_name>
- Payment (income):           Receivable from <counterparty_name> → <wallet_name>   (receivable cleared, cash in)
- Payment (expense):          <wallet_name> → Payable to <counterparty_name>        (cash out, payable cleared)
- Transfer (between wallets): <source_wallet> → <destination_wallet>
- Advance Out (money given):  <wallet_name> → Receivable from <counterparty_name>   (cash out, receivable created)
- Advance In (money received): Payable to <counterparty_name> → <wallet_name>       (payable created, cash in)

The key principle: for ANY income, the revenue/receivable side comes FIRST, the wallet/asset increase comes SECOND. NEVER write "Cash → Sales Revenue" for an income transaction — that's backward.

For invoice/bill/payment flows, ALWAYS include the counterparty name on the receivable/payable side of the arrow — never write the bare phrase "Accounts Receivable" or "Accounts Payable" alone. This makes it clear who owes whom. Example: "Account: Receivable from Jameel Crest Gems → Sales Revenue".

4. User replies yes/save/ok/confirm/Confirm (case-insensitive — they may have tapped a button) → call save_transaction. The tool now pushes to ERPNext and returns an erpnext_name field (e.g. "ACC-JV-2026-00001"). Reply with EXACTLY these two lines, using that name:

Saved ✓
Ref: <erpnext_name>

5. User wants to change something → call update_draft with corrections, re-issue the summary.
6. User says cancel/forget it/never mind/reject/Reject (case-insensitive — they may have tapped a button) → call cancel_transaction, reply briefly: "Cancelled. Send me the next transaction whenever you're ready."

CONVERSATION STYLE:
- WhatsApp: short, plain text, no markdown asterisks/headers.
- TERSE: Aim for the fewest words that convey the answer. The user is busy.
- NO TRAILING PLEASANTRIES. Don't end replies with "Let me know if you need anything else", "Hope that helps", "Feel free to ask", etc. — these are noise. End on the answer.
- NO "How to use WhatsApp" instructions. The user knows how to share contacts, tap buttons, etc. Don't explain UI.
- NO FILLER WORDS. Skip "Sure!", "Of course!", "Great question!", "Absolutely!". Just answer.
- Acknowledgments are OK but ONE word: "Got it." / "Saved." / "Done." Not full sentences.
- LINE BREAKS: when a reply has multiple distinct ideas (a statement, a question, an example, a hint), put each on its OWN LINE using a real newline. Don't pack them into a single paragraph. Example:
   BAD: "You don't have any wallets yet. Would you like to add some? Just say 'add wallet BBL THB' to start."
   GOOD: "You don't have any wallets yet.
   Would you like to add some?
   e.g. 'add wallet BBL THB'"
   This applies to ANY reply with multiple sentences — questions, examples, hints, follow-ups all go on their own line.
- Never invent fields the user didn't provide. If a field is genuinely ambiguous, ask once.
- Don't dump the chart of accounts at the user. Don't show codes.

CONTEXT:
- Today's date: ${today}
- User's default currency: ${user.default_currency}
- User's country: ${user.country}
- Default tax rate: ${user.default_tax_rate ?? 'none'}

CURRENT DRAFT (in progress):
${draftJson}`;
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

async function saveConversationState(userId, { draft, recentMessages, state }) {
  const now = new Date().toISOString();
  await query(
    `UPDATE conversations
     SET draft_transaction = $1, recent_messages = $2, state = $3, last_message_at = $4, updated_at = $5
     WHERE user_id = $6`,
    [
      draft ? JSON.stringify(draft) : null,
      JSON.stringify(recentMessages || []),
      state || 'idle',
      now,
      now,
      userId,
    ]
  );
}

async function resetConversation(userId) {
  await saveConversationState(userId, { draft: null, recentMessages: [], state: 'idle' });
}

function validateDraft(draft) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (draft[field] == null || draft[field] === '') missing.push(field);
  }
  const tt = draft.transaction_type;

  // category_code is required for everything except wallet-to-wallet transfers
  if (tt !== 'transfer' && (draft.category_code == null || draft.category_code === '')) {
    missing.push('category_code');
  }
  // counterparty_name is required for invoice/bill flows (they need a Customer/Supplier in ERPNext)
  if ((tt === 'invoice_issued' || tt === 'bill_received') && !draft.counterparty_name) {
    missing.push('counterparty_name');
  }
  return missing;
}

async function executeTool(toolName, args, ctx) {
  switch (toolName) {
    case 'update_draft':
      ctx.draft = { ...ctx.draft, ...args };
      console.log(`• [conversation] [${ts()}] tool=update_draft draft=${JSON.stringify(ctx.draft)}`);
      return { ok: true, current_draft: ctx.draft };

    case 'request_confirmation': {
      const missing = validateDraft(ctx.draft);
      if (missing.length) {
        return {
          ok: false,
          error: `Required fields still missing: ${missing.join(', ')}. Ask the user for them before requesting confirmation.`,
        };
      }
      // ERPNEXT-PIVOT TEMP: counterparty + wallet checks were removed (they referenced dropped tables).
      // Will be re-added as ERPNext-backed checks during incremental rebuild.
      ctx.confirmationRequested = true;
      console.log(`• [conversation] [${ts()}] tool=request_confirmation user_id=${ctx.user.id}`);
      return { ok: true };
    }

    case 'save_transaction': {
      const missing = validateDraft(ctx.draft);
      if (missing.length) {
        return { ok: false, error: `Cannot save; missing required fields: ${missing.join(', ')}.` };
      }
      try {
        const erp = erpnext.forUser(ctx.user);
        const { draft } = ctx;
        const tt = draft.transaction_type || 'cash';

        // ── INVOICE_ISSUED → ERPNext Sales Invoice ────────────────────
        if (tt === 'invoice_issued') {
          if (!draft.counterparty_name) {
            return { ok: false, error: 'invoice requires counterparty_name' };
          }

          const customerName = await resolveOrCreateCustomer(ctx.user, erp, draft.counterparty_name, {
            currency: draft.currency,
            phone: draft.counterparty_phone,
            email: draft.counterparty_email,
          });

          const itemCode = await ensureGenericSalesItem(erp);

          // Resolve income account from category_code (4000 → 4110 - Sales - TTC)
          const incomeAccount = await resolveErpAccount(
            ctx.user, erp, draft.category_code, ctx.user.reporting_currency
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

          // Multi-currency: if invoice currency != company currency, ERPNext needs
          //   (a) conversion_rate so it can compute base totals, AND
          //   (b) a Receivable account in the invoice's currency (debit_to).
          //       Without (b), ERPNext rejects with "Party Account currency and
          //       document currency should be same".
          if (draft.currency !== ctx.user.reporting_currency) {
            invoicePayload.conversion_rate = draft.exchange_rate || 1;
            invoicePayload.debit_to = await resolvePartyAccount(erp, 'Receivable', draft.currency);
          }

          const result = await erp.createSalesInvoice(invoicePayload);
          const erpName = result.data?.name;

          ctx.saved = { erpnext_name: erpName };
          ctx.savedIds = [...(ctx.savedIds || []), erpName];
          ctx.draft = {};
          ctx.confirmationRequested = false;

          console.log(
            `• [conversation] [${ts()}] saved Sales Invoice to ERPNext: ${erpName} ` +
              `(${draft.amount} ${draft.currency} for ${customerName}, due ${dueDate})`
          );
          return { ok: true, erpnext_name: erpName, doctype: 'Sales Invoice' };
        }

        // ── CASH (income/expense) → ERPNext Journal Entry ─────────────
        // Resolve cash-side account (defaults to '1000' Cash)
        const cashCode = draft.payment_account_code || '1000';
        const cashAccount = await resolveErpAccount(ctx.user, erp, cashCode, draft.currency);

        const categoryAccount = await resolveErpAccount(
          ctx.user, erp, draft.category_code, draft.currency
        );

        if (!cashAccount || !categoryAccount) {
          return {
            ok: false,
            error: `Could not find ERPNext accounts (cash=${cashCode}→${cashAccount}, category=${draft.category_code}→${categoryAccount})`,
          };
        }

        const entries =
          draft.direction === 'expense'
            ? [
                { account: categoryAccount, debit_in_account_currency: draft.amount },
                { account: cashAccount, credit_in_account_currency: draft.amount },
              ]
            : [
                { account: cashAccount, debit_in_account_currency: draft.amount },
                { account: categoryAccount, credit_in_account_currency: draft.amount },
              ];

        // For the title, follow the money: expense flows cash→category;
        // income flows category→cash. (Transfers, when wired, pass source→dest directly.)
        const fromAccount = draft.direction === 'expense' ? cashAccount : categoryAccount;
        const toAccount   = draft.direction === 'expense' ? categoryAccount : cashAccount;

        const result = await erp.createJournalEntry({
          voucher_type: 'Journal Entry',
          posting_date: draft.transaction_date,
          title: buildJournalTitle({
            currency: draft.currency,
            fromAccount,
            toAccount,
          }),
          user_remark: draft.description || 'Bot entry',
          accounts: entries,
          docstatus: 1,
        });

        const erpName = result.data?.name;
        ctx.saved = { erpnext_name: erpName };
        ctx.savedIds = [...(ctx.savedIds || []), erpName];
        ctx.draft = {};
        ctx.confirmationRequested = false;

        console.log(
          `• [conversation] [${ts()}] saved JE to ERPNext: ${erpName} ` +
            `(${draft.direction} ${draft.amount} ${draft.currency})`
        );
        return { ok: true, erpnext_name: erpName, doctype: 'Journal Entry' };
      } catch (err) {
        console.error('[conversation] save error:', err.message);
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
  };

  let finalText = null;

  try {
    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      const iterStart = Date.now();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: llmMessages,
        tools: TOOLS,
        tool_choice: 'auto',
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
          llmMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
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

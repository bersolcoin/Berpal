const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('[db] DATABASE_URL is not set. Add it to .env');
  }

  // Railway internal hostname doesn't use SSL; public proxy + most managed PGs do.
  const isInternal = url.includes('.railway.internal');

  // Log the host we're connecting to (without password) for diagnostics.
  try {
    const u = new URL(url);
    console.log(`[db] connecting to ${u.hostname}:${u.port || 5432} (ssl=${!isInternal})`);
  } catch {
    console.log('[db] connecting (could not parse DATABASE_URL host)');
  }

  _pool = new Pool({
    connectionString: url,
    ssl: isInternal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
  });

  _pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return _pool;
}

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Post-pivot schema (ERPNext is the accounting backend).
 * Postgres holds: identity + auth, subscription, conversation state, sync queue, lookup caches.
 * NOT: any accounting truth (balances, invoices, payments, ledger). Those live in ERPNext.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,

  -- subscription gate (manual updates for now; Stripe webhook later)
  subscription_status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'expired'
  subscription_expires_at TEXT,                           -- ISO date

  -- ERPNext mapping (one Company per user; API creds for that user's scope)
  erpnext_company TEXT,
  erpnext_api_key TEXT,
  erpnext_api_secret TEXT,

  -- preferences cached for prompt context
  default_currency TEXT NOT NULL DEFAULT 'THB',
  reporting_currency TEXT NOT NULL DEFAULT 'THB',
  country TEXT NOT NULL DEFAULT 'TH',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'idle',
  draft_transaction TEXT,
  recent_messages TEXT NOT NULL DEFAULT '[]',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id INTEGER REFERENCES conversations(id),
  direction TEXT NOT NULL,
  body TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Outbox: replaces the old transactions table.
-- Every action (create invoice, log payment, add customer, etc.) becomes a row here.
-- A worker pushes pending rows to ERPNext, captures the returned doctype name in external_id.
CREATE TABLE IF NOT EXISTS outbox (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id INTEGER REFERENCES conversations(id),

  doctype TEXT NOT NULL,            -- e.g. 'Sales Invoice', 'Payment Entry', 'Customer', 'Account', 'Journal Entry'
  payload TEXT NOT NULL,            -- JSON body that will be POSTed to /api/resource/<doctype>
  intent TEXT,                      -- human-readable summary for logs

  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'posted' | 'failed'
  external_id TEXT,                        -- ERPNext doctype name returned (e.g. 'INV-26-00001')
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  posted_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user ON outbox(user_id);

-- Lookup cache for counterparties (Customer / Supplier in ERPNext).
-- Safe to cache because names/aliases rarely change. NOT financial data.
CREATE TABLE IF NOT EXISTS counterparty_cache (
  id SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),

  name TEXT NOT NULL,               -- display name
  nickname TEXT,                    -- fuzzy-lookup alias ('tall mike')
  phone TEXT,
  email TEXT,

  erpnext_doctype TEXT,             -- 'Customer' | 'Supplier' | both as separate rows if needed
  erpnext_name TEXT,                -- ERPNext doctype name (e.g. 'Jameel Crest Gems-TTC')

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(owner_user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_cp_cache_owner ON counterparty_cache(owner_user_id);

-- Lookup cache for wallets (Account in ERPNext).
CREATE TABLE IF NOT EXISTS account_cache (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),

  name TEXT NOT NULL,               -- display name (e.g. 'BBL Savings')
  account_type TEXT,                -- 'Cash' | 'Bank' | 'Credit Card'
  currency TEXT,

  erpnext_account_name TEXT,        -- ERPNext Account name (e.g. 'BBL Savings - TTC')
  is_active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(user_id, name, currency)
);
CREATE INDEX IF NOT EXISTS idx_acc_cache_user ON account_cache(user_id);

-- OTP attempts for web-app login (phone + WhatsApp OTP).
CREATE TABLE IF NOT EXISTS otp_attempts (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_attempts(phone);

-- B2B link state — when seller and buyer are both Berpal users we mirror
-- the transaction on both sides. Seller posts the Sales Invoice in their
-- ERPNext first; buyer's Purchase Invoice is only created after the buyer
-- explicitly accepts via a WhatsApp button. This table tracks the link
-- end-to-end, including rejects / cancels for audit.
CREATE TABLE IF NOT EXISTS linked_transactions (
  id SERIAL PRIMARY KEY,

  -- Seller side (already posted at row-insert time)
  seller_user_id INTEGER NOT NULL REFERENCES users(id),
  seller_doctype TEXT NOT NULL,          -- 'Sales Invoice', 'Payment Entry', ...
  seller_doc_name TEXT NOT NULL,         -- ERPNext doc name on seller's side

  -- Buyer side (populated after buyer accepts)
  buyer_user_id INTEGER NOT NULL REFERENCES users(id),
  buyer_doctype TEXT,                    -- 'Purchase Invoice', etc.
  buyer_doc_name TEXT,

  -- Snapshot of what was proposed (so we have it even if the seller
  -- edits/cancels their invoice later)
  currency TEXT NOT NULL,
  total_amount NUMERIC NOT NULL,
  items TEXT NOT NULL,                   -- JSON: [{code, name, qty, rate, amount}, ...]
  notes TEXT,

  status TEXT NOT NULL DEFAULT 'pending_buyer_confirmation',
    -- 'pending_buyer_confirmation' = seller posted, buyer not yet responded
    -- 'confirmed'                  = buyer accepted; buyer_doc_name populated
    -- 'rejected'                   = buyer explicitly declined
    -- 'cancelled'                  = seller cancelled before buyer responded
    -- 'expired'                    = buyer didn't respond within window

  proposed_at TEXT NOT NULL,             -- when seller's invoice posted
  responded_at TEXT,                     -- when buyer accepted/rejected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_linked_seller ON linked_transactions(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_buyer ON linked_transactions(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_status ON linked_transactions(status);
CREATE INDEX IF NOT EXISTS idx_linked_seller_doc ON linked_transactions(seller_user_id, seller_doctype, seller_doc_name);

-- Unhandled-request log: every time the bot couldn't find a function to
-- match the user's input, we capture it here. Drives the feature backlog
-- (real demand from real users) and enables "we built it" notifications
-- when the gap is closed.
CREATE TABLE IF NOT EXISTS unhandled_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message_text TEXT NOT NULL,
  bot_reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending'  = newly logged, not yet triaged
    -- 'resolved' = the feature was built; user not yet notified
    -- 'notified' = user was sent the "we built it" message
    -- 'dismissed' = not building this; closed without notification
  notes TEXT,
  resolved_at TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unhandled_status ON unhandled_requests(status);
CREATE INDEX IF NOT EXISTS idx_unhandled_user ON unhandled_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_unhandled_created ON unhandled_requests(created_at);
`;

async function migrate() {
  await query(SCHEMA);
  // Idempotent additive column migrations live here. PG 9.6+ supports
  // ADD COLUMN IF NOT EXISTS so re-running migrate() is safe.
  await query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_tool_args TEXT`);

  // Onboarding fields captured at signup. Surfaced on /settings, used by
  // the bot for prompt-context (e.g. business_type changes how it asks
  // about a sale: SKU+qty for product, just description+amount for service).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS entity_type TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nature_of_business TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state_province TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code TEXT`);

  // Multi-tenancy: store the ERPNext Company abbreviation so we can compute
  // per-company namespaces (Item Group, Warehouse prefix, etc.) without
  // round-tripping to ERPNext on every request. UNIQUE because ERPNext
  // enforces uniqueness on Company.abbr too — keep PG in sync.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS erpnext_company_abbr TEXT`);
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_erpnext_company_abbr_unique'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_erpnext_company_abbr_unique
          UNIQUE (erpnext_company_abbr);
      END IF;
    END $$;
  `);

  // Counterparty cache: link to a platform user when the counterparty's
  // phone matches a Berpal user. Drives the linked-transactions B2B flow.
  await query(`ALTER TABLE counterparty_cache ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES users(id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cp_cache_linked_user ON counterparty_cache(linked_user_id)`);

  // Pending-invoice growth loop: invoices to non-users are stored with a
  // phone instead of a buyer_user_id. When that phone later signs up, the
  // post-provisioning binding step claims them. Relax buyer_user_id and
  // add a buyer_phone column for matching.
  await query(`ALTER TABLE linked_transactions ALTER COLUMN buyer_user_id DROP NOT NULL`);
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
  await query(`CREATE INDEX IF NOT EXISTS idx_linked_buyer_phone ON linked_transactions(buyer_phone) WHERE buyer_user_id IS NULL`);

  // Per-tenant chart-of-accounts cache. We seed it during provisionTenant
  // and append to it on every account creation (wallets, party accounts).
  // Users never edit ERPNext directly, so this is authoritative for the
  // app — resolvers read from here instead of round-tripping to ERPNext.
  await query(`
    CREATE TABLE IF NOT EXISTS coa_cache (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/**
 * Seed the test user defined by SEED_TEST_USER_PHONE in .env.
 * Pre-fills the ERPNext mapping from .env so the bot can talk to ERPNext immediately.
 * Idempotent — skips if the phone is already in the users table.
 */
async function seedTestUser() {
  const phone = process.env.SEED_TEST_USER_PHONE;
  if (!phone) return;

  const existing = await query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (existing.rowCount > 0) return;

  const now = new Date().toISOString();
  // Default subscription valid for ~1 year so dev/testing isn't blocked
  const expiresAt = '2027-12-31';

  const company = process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company';
  const apiKey = process.env.ERPNEXT_API_KEY || null;
  const apiSecret = process.env.ERPNEXT_API_SECRET || null;

  await query(
    `INSERT INTO users (
       phone, display_name,
       default_currency, reporting_currency, country,
       subscription_status, subscription_expires_at,
       erpnext_company, erpnext_api_key, erpnext_api_secret,
       created_at, updated_at
     ) VALUES (
       $1, 'Test User',
       'THB', 'THB', 'TH',
       'active', $2,
       $3, $4, $5,
       $6, $6
     )`,
    [phone, expiresAt, company, apiKey, apiSecret, now]
  );
  console.log(`[db] seeded test user: ${phone} → ERPNext company "${company}"`);
}

async function init() {
  await migrate();
  await seedTestUser();
  console.log('[db] ready');
}

module.exports = { query, withTransaction, init };

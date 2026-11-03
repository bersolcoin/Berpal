const fs = require('fs');
const path = require('path');
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

-- One contact can be both a Customer (we sell to them / they owe us) and a Supplier
-- (we buy from them / we owe them). Track both ERPNext records on the same row.
ALTER TABLE counterparty_cache ADD COLUMN IF NOT EXISTS erpnext_customer TEXT;
ALTER TABLE counterparty_cache ADD COLUMN IF NOT EXISTS erpnext_supplier TEXT;
UPDATE counterparty_cache SET erpnext_customer = erpnext_name
  WHERE erpnext_doctype = 'Customer' AND erpnext_customer IS NULL;
UPDATE counterparty_cache SET erpnext_supplier = erpnext_name
  WHERE erpnext_doctype = 'Supplier' AND erpnext_supplier IS NULL;

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
`;

/**
 * Feature migrations live in src/migrations/*.sql, applied in filename order after the core
 * schema. Each file must be idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS …)
 * because this runs on every boot.
 */
async function migrate() {
  await query(SCHEMA);
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
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

/** Tests only: swap in an in-memory pool (e.g. pg-mem). */
function _setPoolForTests(pool) {
  _pool = pool;
}

module.exports = { query, withTransaction, init, migrate, _setPoolForTests };

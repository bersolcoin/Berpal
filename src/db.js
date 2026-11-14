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

  erpnext_doctype TEXT,             -- 'Customer' | 'Supplier' | both as separate rows
  erpnext_name TEXT,                -- ERPNext doctype name (e.g. 'Acme Trading-TTC')

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CONSTRAINT counterparty_cache_owner_doctype_name_key
    UNIQUE(owner_user_id, erpnext_doctype, name)
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

  // Magic (magic.link) identity — issuer is Magic's stable user id;
  // wallet_address is the embedded wallet Magic creates (keys stay with Magic).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS magic_issuer TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_magic_issuer ON users(magic_issuer)`);

  // Catalog category picked at onboarding (e.g. 'gemstones') — informational;
  // what's switched on lives in business_categories (src/catalog).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS industry TEXT`);
  // Legacy: UI preferences now live on people.ui_prefs (per person).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE users ALTER COLUMN industry DROP DEFAULT`);

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

  // ── People ↔ businesses ─────────────────────────────────────────────
  // A `users` row is one BUSINESS (tenant): its ERPNext Company, API keys,
  // currency, settings. Every tenant-scoped table keys on users.id. The
  // person who signs in (phone, verified by SMS) lives in `people`; which
  // businesses they can open lives in `memberships`. One person can run
  // several businesses, and later several people (staff) can share one.
  // The session's user_id is the ACTIVE business; it's only ever set after
  // checking membership (login, switch, onboarding finalize), and page /
  // API loaders re-check it (src/auth/business.js).
  await query(`
    CREATE TABLE IF NOT EXISTS people (
      id                SERIAL PRIMARY KEY,
      phone             TEXT NOT NULL UNIQUE,
      display_name      TEXT,
      email             TEXT,
      ui_prefs          JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_business_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS memberships (
      person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'owner',      -- 'owner' (staff roles later)
      created_at  TEXT NOT NULL,
      PRIMARY KEY (person_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`);
  // Team invites. The ONLY way into someone else's business: a member
  // invites a phone number with a role; that number signs in, sees
  // "Join business" on /onboarding (or in the business switcher) and
  // accepts → a membership. No searching for businesses, no join requests
  // (a wrong approval would leak a company's books). One pending invite
  // per business + phone.
  await query(`
    CREATE TABLE IF NOT EXISTS business_invites (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone         TEXT NOT NULL,
      role          TEXT NOT NULL,                     -- admin | manager | staff
      invited_by    INTEGER REFERENCES people(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | revoked
      sms_sent_at   TEXT,
      created_at    TEXT NOT NULL,
      responded_at  TEXT
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_business_invites_pending
      ON business_invites (user_id, phone) WHERE status = 'pending'
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_business_invites_phone ON business_invites(phone) WHERE status = 'pending'`);
  // No name on invites — the person gives their own when accepting.
  await query(`ALTER TABLE business_invites DROP COLUMN IF EXISTS name`);
  // Who invited a member (set when they accept).
  await query(`ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES people(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE memberships DROP COLUMN IF EXISTS sms_sent_at`);
  await query(`ALTER TABLE people ADD COLUMN IF NOT EXISTS last_login_at TEXT`);
  // One phone can now own several businesses — users.phone is the owner's
  // contact phone, no longer unique.
  await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
  // Backfill (one-time per business): a business nobody is a member of
  // belongs to the person with its phone. Carries name / email / UI prefs
  // over to the person.
  await query(`
    INSERT INTO people (phone, display_name, email, ui_prefs, created_at, updated_at)
    SELECT DISTINCT ON (u.phone) u.phone, u.display_name, u.email, u.ui_prefs, u.created_at, u.updated_at
      FROM users u
     WHERE u.erpnext_company IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
     ORDER BY u.phone, u.id
    ON CONFLICT (phone) DO NOTHING
  `);
  await query(`
    INSERT INTO memberships (person_id, user_id, role, created_at)
    SELECT p.id, u.id, 'owner', u.created_at
      FROM users u JOIN people p ON p.phone = u.phone
     WHERE u.erpnext_company IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
    ON CONFLICT DO NOTHING
  `);

  // Counterparty cache: link to a platform user when the counterparty's
  // phone matches a Berpal user. Drives the linked-transactions B2B flow.
  await query(`ALTER TABLE counterparty_cache ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES users(id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cp_cache_linked_user ON counterparty_cache(linked_user_id)`);

  // The original UNIQUE(owner_user_id, name) constraint was too narrow —
  // a single contact can legitimately exist as BOTH a Customer and a
  // Supplier in ERPNext (eager dual-create writes both). Without doctype
  // in the unique key, supplier.js's ON CONFLICT clobbers customer.js's
  // row (including its linked_user_id), breaking the B2B notification.
  // Widen to (owner, doctype, name).
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'counterparty_cache_owner_user_id_name_key'
      ) THEN
        ALTER TABLE counterparty_cache
          DROP CONSTRAINT counterparty_cache_owner_user_id_name_key;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'counterparty_cache_owner_doctype_name_key'
      ) THEN
        ALTER TABLE counterparty_cache
          ADD CONSTRAINT counterparty_cache_owner_doctype_name_key
          UNIQUE (owner_user_id, erpnext_doctype, name);
      END IF;
    END $$;
  `);

  // Pending-invoice growth loop: invoices to non-users are stored with a
  // phone instead of a buyer_user_id. When that phone later signs up, the
  // post-provisioning binding step claims them. Relax buyer_user_id and
  // add a buyer_phone column for matching.
  await query(`ALTER TABLE linked_transactions ALTER COLUMN buyer_user_id DROP NOT NULL`);
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS buyer_phone TEXT`);
  await query(`CREATE INDEX IF NOT EXISTS idx_linked_buyer_phone ON linked_transactions(buyer_phone) WHERE buyer_user_id IS NULL`);

  // seller_paid_now lets confirmLink know whether the seller's SI was
  // already paid at the time of sale. When true, accepting the link on
  // the buyer side enqueues an unrecorded_link_payment TODO so the
  // buyer can later record which wallet they paid from. Without it,
  // the mirror PI sits as an open payable that doesn't match reality.
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS seller_paid_now BOOLEAN DEFAULT FALSE`);

  // Seller-side payment context — surfaces in the proposal message and
  // narrows the buyer's wallet-pick step (cash vs bank, in the same
  // currency). Null when the sale was on credit.
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS seller_payment_account_code TEXT`);
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS seller_wallet_label TEXT`);
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS seller_wallet_type TEXT`);

  // Twilio outbound MessageSid for the proposal — inbound button replies
  // arrive with OriginalRepliedMessageSid that we match against this to
  // route an "Accept" / "Decline" tap to the right linked_transactions row
  // even when the buyer has more than one pending link.
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS proposal_message_sid TEXT`);
  await query(`CREATE INDEX IF NOT EXISTS idx_linked_proposal_msg_sid ON linked_transactions(proposal_message_sid) WHERE proposal_message_sid IS NOT NULL`);

  // Wallet-pick follow-up state. After a buyer taps Accept and there
  // are 0 or 2+ matching wallets, the row is parked here while the bot
  // asks which wallet to use. wallet_pick_candidates is a JSON array
  // [{ label, code, name }, ...] frozen at ask time.
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS wallet_pick_candidates TEXT`);
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS wallet_pick_message_sid TEXT`);

  // Direction of the B2B link. FALSE (default) = seller-initiated:
  // the seller posted a Sales Invoice, the buyer confirms and gets the
  // mirror Purchase Invoice. TRUE = buyer-initiated: the buyer posted
  // a Purchase Invoice first, the seller confirms and gets the mirror
  // Sales Invoice. seller_* and buyer_* columns always refer to the
  // SI side and the PI side respectively (regardless of who initiated).
  await query(`ALTER TABLE linked_transactions ADD COLUMN IF NOT EXISTS initiated_by_buyer BOOLEAN DEFAULT FALSE`);

  // Relax NOT NULL on the initiator-side doc columns to support the
  // inverse (buyer-initiated) direction. In a buyer-init row the SI
  // doesn't exist at row-insert time — it's created on the seller's
  // Accept and the seller_doctype/seller_doc_name columns are filled
  // in then. Buyer-side columns were already nullable.
  await query(`ALTER TABLE linked_transactions ALTER COLUMN seller_doctype DROP NOT NULL`);
  await query(`ALTER TABLE linked_transactions ALTER COLUMN seller_doc_name DROP NOT NULL`);

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

  // Pending TODOs — a shared inbox between the bot and the web app.
  // Triggers (e.g. sales-invoice.js) enqueue rows; the bot lists them
  // on demand ("any todos?") and either resolves them inline or sends
  // the user to /todos. NO nagging — never volunteered by the bot.
  //   kind            — string discriminator (e.g. 'unknown_item_purchase')
  //   payload_json    — kind-specific data the resolver needs
  //   related_*       — denormalized link back to the source ERPNext doc
  //   bot_resolvable  — bot can walk the user through the resolution
  //   web_resolvable  — web /todos page has a form for this kind
  //   bot_prompt      — pre-rendered sentence the bot uses when listing
  // Row deletes on resolution (no status column — history lives in the
  // resolution doc the action creates).
  await query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      related_doctype TEXT,
      related_name TEXT,
      bot_resolvable INTEGER NOT NULL DEFAULT 1,
      web_resolvable INTEGER NOT NULL DEFAULT 1,
      bot_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // Dedupe: one TODO per (user, kind, related_name) — if the same
  // trigger fires twice on the same doc, the second insert no-ops.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_user_kind_related
      ON todos(user_id, kind, related_name)
      WHERE related_name IS NOT NULL
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)`);

  // Per-industry attribute schemas for the Item catalog. The LLM's
  // create_item tool looks up the user's industry and asks for each
  // required field. ERPNext-side, every schema field gets a Custom Field
  // installed on the Item doctype (site-wide; see src/erp-sync/item-custom-fields.js).
  // field_type: 'select' (uses options_json), 'data' (text), 'float',
  // 'int', 'check' (boolean). ordinal drives the ask order.
  await query(`
    CREATE TABLE IF NOT EXISTS industry_attribute_schema (
      industry      TEXT NOT NULL,
      field_key     TEXT NOT NULL,
      field_label   TEXT NOT NULL,
      field_type    TEXT NOT NULL,
      required      BOOLEAN NOT NULL DEFAULT FALSE,
      options_json  TEXT,
      ordinal       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (industry, field_key)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_industry_attr_industry ON industry_attribute_schema(industry, ordinal)`);

  // ui: 'essential' (always on item forms) | 'more' (behind "+ More
  // details") | 'system' (server-set, e.g. gem family/variety).
  await query(`ALTER TABLE industry_attribute_schema ADD COLUMN IF NOT EXISTS ui TEXT NOT NULL DEFAULT 'more'`);

  // Item category tree per industry: family → variety, with the lot-code
  // prefix used for auto-numbering (AQ → AQ1405). Mirrored per tenant as
  // ERPNext Item Groups (see src/erp-sync/item-group.js).
  // owner_user_id NULL = built-in (shared catalog); set = that business's
  // own addition (Settings → Product categories).
  await query(`
    CREATE TABLE IF NOT EXISTS item_categories (
      id             SERIAL PRIMARY KEY,
      industry       TEXT NOT NULL,
      family         TEXT NOT NULL,
      variety        TEXT NOT NULL,
      code_prefix    TEXT,
      ordinal        INTEGER NOT NULL DEFAULT 0,
      owner_user_id  INTEGER
    )
  `);
  // Upgrade the first version (PK on industry+variety, no owner).
  await query(`ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS owner_user_id INTEGER`);
  await query(`ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS id SERIAL`);
  await query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.key_column_usage
                  WHERE table_name = 'item_categories' AND constraint_name = 'item_categories_pkey'
                    AND column_name = 'variety') THEN
        ALTER TABLE item_categories DROP CONSTRAINT item_categories_pkey;
        ALTER TABLE item_categories ADD PRIMARY KEY (id);
      END IF;
    END $$
  `);
  // Top-level category per variety (Gemstones, Watches, …).
  await query(`ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Gemstones'`);

  // Top-level categories. uom = ERPNext stock unit for its lots (Carat for
  // gems, Nos = pieces, Gram); attribute_set = which industry_attribute_schema
  // fields its lots carry (NULL = none, just code/name/qty/price).
  await query(`
    CREATE TABLE IF NOT EXISTS item_category_roots (
      id             SERIAL PRIMARY KEY,
      industry       TEXT NOT NULL,
      name           TEXT NOT NULL,
      uom            TEXT NOT NULL DEFAULT 'Nos',
      attribute_set  TEXT,
      ordinal        INTEGER NOT NULL DEFAULT 0,
      owner_user_id  INTEGER
    )
  `);
  // Names are unique per business (whatever template a row came from).
  await query(`DROP INDEX IF EXISTS uq_item_category_roots_name`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_item_category_roots_owner_name
      ON item_category_roots ((COALESCE(owner_user_id, 0)), lower(name))
  `);

  await query(`DROP INDEX IF EXISTS uq_item_categories_variety`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_item_categories_owner_variety
      ON item_categories ((COALESCE(owner_user_id, 0)), lower(variety))
  `);

  // Earlier iterations let businesses edit fields/varieties; the catalog is
  // now admin-only (src/catalog/*, admin panel later) — drop those tables.
  await query(`DROP TABLE IF EXISTS category_fields`);
  await query(`DROP TABLE IF EXISTS business_hidden_varieties`);

  // Requests to extend the catalog (new category, variety, dropdown option
  // or field). Reviewed by us; approved ones get added to src/catalog/* for
  // everyone. status: pending | added | declined.
  await query(`
    CREATE TABLE IF NOT EXISTS catalog_requests (
      id             SERIAL PRIMARY KEY,
      owner_user_id  INTEGER NOT NULL,
      template       TEXT NOT NULL,
      kind           TEXT NOT NULL,
      field_key      TEXT,
      value          TEXT NOT NULL,
      note           TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at    TIMESTAMPTZ
    )
  `);

  // The product catalog is OURS (admin-only: src/catalog/*, admin panel
  // later): shared rows with owner_user_id NULL. A business only switches
  // categories on/off (business_categories); varieties and fields are
  // view-only for it.
  await query(`
    CREATE TABLE IF NOT EXISTS business_categories (
      owner_user_id  INTEGER NOT NULL,
      category_id    INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, category_id)
    )
  `);

  const gem = require('./catalog/gemstones');
  for (const [i, [key, label, type, required, options, ui]] of gem.ATTRIBUTES.entries()) {
    await query(
      `INSERT INTO industry_attribute_schema
         (industry, field_key, field_label, field_type, required, options_json, ordinal, ui)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (industry, field_key) DO UPDATE SET
         field_label = EXCLUDED.field_label,
         field_type = EXCLUDED.field_type,
         required = EXCLUDED.required,
         options_json = EXCLUDED.options_json,
         ordinal = EXCLUDED.ordinal,
         ui = EXCLUDED.ui`,
      [gem.INDUSTRY, key, label, type, required, options ? JSON.stringify(options) : null, i, ui]
    );
  }
  await query(
    `DELETE FROM industry_attribute_schema WHERE industry = $1 AND NOT (field_key = ANY($2))`,
    [gem.INDUSTRY, gem.ATTRIBUTES.map((a) => a[0])]
  );

  // Shared catalog seed — UPSERT so edits to src/catalog/* land on restart.
  for (const c of require('./catalog').CATALOG.filter((x) => !x.comingSoon)) {
    await query(
      `INSERT INTO item_category_roots (industry, name, uom, attribute_set, ordinal, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT ((COALESCE(owner_user_id, 0)), lower(name)) DO UPDATE SET
         industry = EXCLUDED.industry, uom = EXCLUDED.uom,
         attribute_set = EXCLUDED.attribute_set, ordinal = EXCLUDED.ordinal`,
      [c.key, c.name, c.uom, c.attribute_set, c.ordinal]
    );
    for (const [i, v] of c.varieties.entries()) {
      await query(
        `INSERT INTO item_categories (industry, category, family, variety, code_prefix, ordinal, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT ((COALESCE(owner_user_id, 0)), lower(variety)) DO UPDATE SET
           category = EXCLUDED.category, family = EXCLUDED.family,
           code_prefix = EXCLUDED.code_prefix, ordinal = EXCLUDED.ordinal`,
        [c.key, c.name, v.family, v.variety, v.prefix, i]
      );
    }
  }

  // One-time: an earlier version copied the catalog into each business.
  // Convert those copies into "enabled" choices on the shared rows.
  const copies = await query(
    `SELECT own.id AS own_id, own.owner_user_id, shared.id AS shared_id
       FROM item_category_roots own
       LEFT JOIN item_category_roots shared
              ON shared.owner_user_id IS NULL AND lower(shared.name) = lower(own.name)
      WHERE own.owner_user_id IS NOT NULL`
  );
  for (const c of copies.rows) {
    if (c.shared_id) {
      await query(
        `INSERT INTO business_categories (owner_user_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [c.owner_user_id, c.shared_id]
      );
    }
  }
  await query(`DELETE FROM item_categories WHERE owner_user_id IS NOT NULL`);
  await query(`DELETE FROM item_category_roots WHERE owner_user_id IS NOT NULL`);
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

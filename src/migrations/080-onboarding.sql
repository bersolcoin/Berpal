-- In-chat onboarding (src/onboarding/). An unknown WhatsApp number answers a few questions; the
-- finished answers become a users row with subscription_status = 'pending_provisioning' until an
-- operator runs scripts/provision-user.js (ERPNext Company + setup → 'active').

-- One in-progress signup per phone. answers is a JSON object (TEXT, like conversations.draft_transaction).
-- source: 'whatsapp' (open mode) or 'invite:<code>'. The row is deleted on completion or "cancel".
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  phone TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'whatsapp',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Messages per unknown phone per UTC day (day = 'YYYY-MM-DD'); past the cap the bot goes silent.
-- Old days are pruned on write.
CREATE TABLE IF NOT EXISTS onboarding_rate_limits (
  phone TEXT NOT NULL,
  day TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, day)
);

-- What onboarding collects beyond the core users columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS accountant_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accountant_phone TEXT;
-- When the user replied "I agree" to the privacy notice, and which notice text it was.
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version TEXT;
-- 'whatsapp' | 'invite:<code>' (NULL for users created before onboarding existed).
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_source TEXT;
-- Set by "delete my account"; a "DELETE" reply within a few minutes closes the account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_requested_at TEXT;

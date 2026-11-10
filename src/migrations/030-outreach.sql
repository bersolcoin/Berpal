-- Customer outreach: invoices / PromptPay QR / payment reminders sent to the user's customers.
-- promptpay_id: the user's own PromptPay id (mobile, tax id or e-wallet) printed into payment QRs.
-- reminders_enabled: opt-in for the daily reminders job (src/jobs/reminders.job.js). Off by default
-- because it messages third parties without a per-message yes from the user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS promptpay_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders_enabled INTEGER NOT NULL DEFAULT 0;

-- What we sent to whom. Used to dedupe reminders (no more than one per invoice every 3 days)
-- and to answer "did <customer> get the invoice?". Not accounting truth.
CREATE TABLE IF NOT EXISTS outreach_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  counterparty_phone TEXT,
  kind TEXT NOT NULL,               -- 'invoice' | 'reminder'
  reference TEXT,                   -- ERPNext document name, e.g. ACC-SINV-2026-00004
  sent_at TEXT NOT NULL,            -- ISO timestamp
  status TEXT NOT NULL,             -- 'sent' | 'partial' (text went, an attachment didn't) | 'failed'
  error TEXT
);
-- sent_local_date: the user's calendar date at send time (dedupe is by calendar day, not 72h).
-- files: JSON list of ERPNext File names uploaded publicly for this send; the cleanup job
--   deletes them after 2 days and clears the column.
-- message_sid: Twilio SID of the first (text-carrying) message, for the status-callback route.
ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS sent_local_date TEXT;
ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS files TEXT;
ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS message_sid TEXT;
-- customer: ERPNext Customer name; reminder dedupe and the attempt cap are per customer.
ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS customer TEXT;
CREATE INDEX IF NOT EXISTS idx_outreach_log_customer ON outreach_log(user_id, customer);
CREATE INDEX IF NOT EXISTS idx_outreach_log_sid ON outreach_log(message_sid);
CREATE INDEX IF NOT EXISTS idx_outreach_log_ref ON outreach_log(user_id, reference);

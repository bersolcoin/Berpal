-- Trust layer (src/trust/): one row per document the bot posted to ERPNext.
-- Used for the duplicate guard (same receipt / same amount + counterparty within ±3 days), the
-- anomaly stats (median amount per direction over 90 days) and the accountant review queue.
-- Not accounting truth — ERPNext is. Rows older than 180 days are pruned on write unless still
-- awaiting review (src/trust/duplicates.js).
CREATE TABLE IF NOT EXISTS trust_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctype TEXT NOT NULL,                       -- 'Journal Entry' | 'Sales Invoice' | …
  erpnext_name TEXT NOT NULL,
  direction TEXT,                              -- 'income' | 'expense' | 'transfer'
  amount NUMERIC,                              -- gross, in the document currency
  currency TEXT,
  base_amount NUMERIC,                         -- gross in the company (reporting) currency, null if no rate
  transaction_date TEXT,                       -- YYYY-MM-DD
  counterparty_name TEXT,                      -- lower-cased, trimmed, single-spaced
  receipt_hash TEXT,                           -- sha256 hex of the receipt bytes, null if none
  review_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'reviewed' | 'cancelled' (taken back by an undo: trust/review.js)
  warnings TEXT,                               -- JSON list of the card's warning lines
  created_at TEXT NOT NULL                     -- ISO timestamp
);
CREATE INDEX IF NOT EXISTS idx_trust_fp_user_date ON trust_fingerprints(user_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_trust_fp_user_hash ON trust_fingerprints(user_id, receipt_hash);
CREATE INDEX IF NOT EXISTS idx_trust_fp_review ON trust_fingerprints(user_id, review_status);

-- sha256 of the stored receipt bytes, written by src/media/index.js right after the scan, so the
-- duplicate check reads a short string instead of the blob.
ALTER TABLE media_blobs ADD COLUMN IF NOT EXISTS sha256 TEXT;

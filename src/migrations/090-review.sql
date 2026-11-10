-- Accountant review queue (src/trust/review.js): who closed a pending trust_fingerprints row,
-- when, and with what note. review_status flips 'pending' → 'reviewed' from chat (mark_reviewed);
-- reviewed rows then fall under the 180-day retention prune, pending ones never do.
-- reviewed_by is a channel label ('owner via whatsapp'), never a phone or LINE id.
ALTER TABLE trust_fingerprints ADD COLUMN IF NOT EXISTS reviewed_at TEXT;   -- ISO timestamp
ALTER TABLE trust_fingerprints ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE trust_fingerprints ADD COLUMN IF NOT EXISTS review_note TEXT;   -- trimmed, ≤ 300 chars

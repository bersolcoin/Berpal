-- Where Berpal's gem lots and ERPNext disagree, as found by the nightly comparison
-- (src/lots/reconcile.js). One row per finding: one that is still there the next night stays the
-- same row (last_seen moves on), one that is no longer found is closed. Nothing here corrects
-- anything; the digest and the accountant's review queue read the open rows.

CREATE TABLE IF NOT EXISTS lot_mismatches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'carats' | 'place' | 'value' | 'holding' | 'no_lot'
  subject TEXT NOT NULL,                 -- the lot code; the ERPNext batch for 'no_lot'; the account for 'holding'
  lot_code TEXT,                         -- null for 'holding' and 'no_lot'
  berpal TEXT,                           -- Berpal's figure (carats, cost), or its place for 'place'
  erpnext TEXT,                          -- ERPNext's
  detail TEXT NOT NULL,                  -- one sentence for the accountant
  status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lot_mismatches_user_status ON lot_mismatches(user_id, status);

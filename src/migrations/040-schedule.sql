-- Per-user daily jobs (src/jobs/*.job.js): the morning digest, reminders, …
-- Times are wall-clock in the user's own timezone, so the digest lands at 08:00 for them,
-- not 08:00 on the server.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok';
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled INTEGER NOT NULL DEFAULT 1;
-- JSON: { "<job>": { "time": "HH:MM", "enabled": bool } }. Absent job/key → the job's defaults.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_prefs TEXT;

-- One row per (user, job, local run date). The scheduler inserts it BEFORE running the job
-- (INSERT … ON CONFLICT DO NOTHING), so the UNIQUE constraint is the cross-instance lock: a
-- second instance or an overlapping tick loses the insert and never sends the same message twice.
CREATE TABLE IF NOT EXISTS job_runs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job TEXT NOT NULL,
  run_date TEXT NOT NULL,                  -- user's local date the run belongs to, YYYY-MM-DD
  started_at TEXT NOT NULL,                -- ISO timestamp
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'skipped' | 'failed'
  error TEXT,
  -- Twilio SID of the message the run sent; POST /twilio/status flips the run to failed on an
  -- async delivery failure (e.g. 63016 outside the 24h window).
  message_sid TEXT,
  -- JSON of what the job returned (counts, failures) for non-skipped runs.
  result TEXT,
  UNIQUE (user_id, job, run_date)
);
-- Columns added after the table first shipped go below, ADD COLUMN IF NOT EXISTS only (cheap,
-- no lock beyond a catalog check when present). Nothing here rewrites or re-validates on boot.
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS message_sid TEXT;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS result TEXT;
CREATE INDEX IF NOT EXISTS idx_job_runs_sid ON job_runs(message_sid);
-- The scheduler's per-tick read of recent runs filters on started_at.
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);

-- One-off, by hand, ONLY for a database created from the pre-review draft of this file
-- (job_runs.id SERIAL, FK without ON DELETE CASCADE, or no primary key). Not run on boot:
--   ALTER TABLE job_runs ALTER COLUMN id TYPE BIGINT;
--   ALTER SEQUENCE job_runs_id_seq AS BIGINT;
--   ALTER TABLE job_runs DROP CONSTRAINT IF EXISTS job_runs_user_id_fkey;
--   ALTER TABLE job_runs ADD CONSTRAINT job_runs_user_id_fkey
--     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
--   -- if the draft had no PRIMARY KEY (built column-by-column):
--   DROP INDEX IF EXISTS job_runs_id_key;
--   ALTER TABLE job_runs ADD PRIMARY KEY (id);
--   -- drop the draft's duplicate unique index once the table has the UNIQUE constraint:
--   ALTER TABLE job_runs ADD CONSTRAINT job_runs_user_id_job_run_date_key UNIQUE (user_id, job, run_date);
--   DROP INDEX IF EXISTS job_runs_user_job_date_key;

-- Receipt / bill images (and PDFs) held between WhatsApp intake and the ERPNext save.
-- Short-lived: src/media/attach.js uploads the bytes to the saved ERPNext document and deletes
-- the row; src/media/store.js prunes rows older than 7 days that were never attached (draft
-- cancelled or abandoned). Not accounting truth — the attachment lives on the ERPNext doc once saved.
CREATE TABLE IF NOT EXISTS media_blobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  filename TEXT,
  bytes BYTEA NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_blobs_user ON media_blobs(user_id);

-- ON DELETE CASCADE lives in the CREATE above. No per-boot DROP/ADD of the FK (that takes an
-- ACCESS EXCLUSIVE lock on media_blobs and a lock on users at every deploy), and no DO $$ block
-- either: pg-mem (npm test) can't run plpgsql. Only a DB that ran the first draft of this file
-- (pre-review, never deployed) lacks the cascade; fix it once by hand with:
--   ALTER TABLE media_blobs DROP CONSTRAINT media_blobs_user_id_fkey,
--     ADD CONSTRAINT media_blobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

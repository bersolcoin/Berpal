/**
 * Postgres holding pen for receipt images between intake and the ERPNext save (see
 * src/migrations/020-media.sql). Rows are deleted once attached to an ERPNext document.
 *
 * Every read/delete is scoped by user_id: media ids reach us via model output, which is shaped by
 * user-controlled text, so an id alone must never be enough to touch someone else's receipt.
 */
const { query } = require('../db');

// Blobs never attached are dropped after this long so the table can't grow without bound. A
// draft left pending longer than this loses its attachment (the transaction still saves).
const RETENTION_DAYS = 7;

function requireUser(userId) {
  if (!userId) throw new Error('media store: userId is required');
}

async function saveBlob(userId, { contentType, filename = null, bytes }) {
  requireUser(userId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  // Opportunistic prune on write: no cron needed, and ISO strings compare correctly as TEXT.
  await query('DELETE FROM media_blobs WHERE created_at < $1', [cutoff]);
  const r = await query(
    `INSERT INTO media_blobs (user_id, content_type, filename, bytes, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, contentType, filename, bytes, now.toISOString()]
  );
  return r.rows[0].id;
}

async function getBlob(userId, id) {
  requireUser(userId);
  const r = await query('SELECT * FROM media_blobs WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rows[0] || null;
}

async function deleteBlob(userId, id) {
  requireUser(userId);
  await query('DELETE FROM media_blobs WHERE id = $1 AND user_id = $2', [id, userId]);
}

module.exports = { saveBlob, getBlob, deleteBlob, RETENTION_DAYS };

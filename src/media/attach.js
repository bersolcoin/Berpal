/**
 * Attach a stored receipt image (media_blobs row) to a saved ERPNext document, then drop the blob.
 * Called by save_transaction after a successful save, with the doctype + name it returned.
 */
const store = require('./store');
const { ts } = require('../erp-sync/common');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/**
 * @param {import('../erpnext').ErpNextClient} erp  per-user client
 * @param {{ userId: number, mediaId: number, doctype: string, docname: string }} args
 *   userId is required: the blob must belong to the user whose document it's attached to.
 * @returns {Promise<{name, file_url}|null>} the ERPNext File, or null if no such blob for this user
 */
async function attachToDoc(erp, { userId, mediaId, doctype, docname }) {
  if (!userId) throw new Error('attachToDoc: userId is required');
  const blob = await store.getBlob(userId, mediaId);
  if (!blob) return null;

  const file = await erp.uploadFile({
    buffer: blob.bytes,
    filename: blob.filename || `receipt-${blob.id}.${EXT[blob.content_type] || 'bin'}`,
    contentType: blob.content_type,
    isPrivate: true,
    doctype,
    docname,
  });

  // Only delete once ERPNext has the file — a failed upload (throws above) leaves it for a retry.
  await store.deleteBlob(userId, mediaId);
  console.log(`• [media] [${ts()}] attached media ${mediaId} → ${doctype} ${docname}`);
  return file;
}

module.exports = { attachToDoc };

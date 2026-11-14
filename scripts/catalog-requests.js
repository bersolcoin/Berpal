/**
 * Review requests to extend a standard catalog template (new dropdown
 * option or new standard field), sent from Inventory → ⚙ → Fields.
 *
 *   node scripts/catalog-requests.js                 # list pending
 *   node scripts/catalog-requests.js --all           # list everything
 *   node scripts/catalog-requests.js <id> added      # mark as added
 *   node scripts/catalog-requests.js <id> declined   # mark as declined
 *
 * "added" only records the decision — add the option/field itself to
 * src/catalog/<template>.js and restart so the seed picks it up.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query } = require('../src/db');

(async () => {
  const [idArg, status] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (idArg) {
    if (!['added', 'declined', 'pending'].includes(status)) {
      console.error('Status must be: added | declined | pending');
      process.exit(1);
    }
    const r = await query(
      `UPDATE catalog_requests SET status = $1, reviewed_at = now() WHERE id = $2 RETURNING id`,
      [status, parseInt(idArg, 10)]
    );
    console.log(r.rowCount ? `Request ${idArg} → ${status}` : `No request ${idArg}`);
    process.exit(0);
  }

  const all = process.argv.includes('--all');
  const r = await query(
    `SELECT q.id, q.status, q.template, q.kind, q.field_key, q.value, q.note, q.created_at,
            u.display_name, u.erpnext_company
       FROM catalog_requests q LEFT JOIN users u ON u.id = q.owner_user_id
      ${all ? '' : "WHERE q.status = 'pending'"}
      ORDER BY q.created_at`
  );
  if (!r.rowCount) {
    console.log(all ? 'No requests.' : 'No pending requests.');
    process.exit(0);
  }
  for (const q of r.rows) {
    const what = q.kind === 'option' ? `option "${q.value}" for ${q.field_key}` : `new field "${q.value}"`;
    console.log(
      `#${q.id} [${q.status}] ${q.template}: ${what}` +
        `${q.note ? ` — ${q.note}` : ''}  (${q.erpnext_company || q.display_name}, ${q.created_at.toISOString().slice(0, 10)})`
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

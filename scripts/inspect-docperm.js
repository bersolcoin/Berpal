/**
 * Show what roles have what permissions on a given ERPNext doctype.
 * Diagnoses "User X does not have doctype access via role permission"
 * errors — if Purchase User has no `create=1` row on Supplier, that's
 * the smoking gun.
 *
 *   node scripts/inspect-docperm.js Supplier
 *   node scripts/inspect-docperm.js Customer
 *   node scripts/inspect-docperm.js "Sales Invoice"
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getAdminClient } = require('../src/erp-admin');

(async () => {
  const doctype = process.argv[2];
  if (!doctype) {
    console.error('Usage: node scripts/inspect-docperm.js <Doctype>');
    process.exit(1);
  }
  const admin = getAdminClient();

  const r = await admin.listResource('DocPerm', {
    filters: [['parent', '=', doctype]],
    fields: ['role', 'permlevel', 'read', 'write', 'create', 'delete', 'submit', 'cancel', 'amend'],
    limit: 100,
  });
  const rows = r.data || [];
  if (!rows.length) {
    console.log(`No DocPerm rows on ${doctype}. This means EVERY user is blocked from this doctype unless they have System Manager.`);
    process.exit(0);
  }
  console.log(`DocPerm for ${doctype}:`);
  console.log('  role                       lvl  R W C D Sub Cncl Amnd');
  for (const p of rows) {
    const flag = (v) => (v ? '✓' : '·');
    console.log(
      `  ${(p.role + '                            ').slice(0, 26)} ${p.permlevel}    ` +
      `${flag(p.read)} ${flag(p.write)} ${flag(p.create)} ${flag(p.delete)}  ${flag(p.submit)}   ${flag(p.cancel)}    ${flag(p.amend)}`
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

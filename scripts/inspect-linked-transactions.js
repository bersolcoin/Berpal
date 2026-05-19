/**
 * Inspect linked_transactions + counterparty links to debug B2B flow.
 *
 *   node scripts/inspect-linked-transactions.js              # everything pending
 *   node scripts/inspect-linked-transactions.js --all        # all rows incl. resolved
 *   node scripts/inspect-linked-transactions.js --phone +X   # filter by buyer phone
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const phoneIdx = args.indexOf('--phone');
  const phoneFilter = phoneIdx >= 0 ? args[phoneIdx + 1] : null;

  console.log('═══ USERS (id, phone, company) ═══');
  const u = await query(
    `SELECT id, phone, erpnext_company, business_type
       FROM users
      ORDER BY id`
  );
  for (const r of u.rows) {
    console.log(`  user.id=${r.id}  ${r.phone}  ${r.erpnext_company || '(no company)'}  type=${r.business_type || '-'}`);
  }

  console.log('\n═══ LINKED_TRANSACTIONS ═══');
  const where = [];
  const params = [];
  if (!showAll) where.push(`status IN ('pending_buyer_confirmation', 'pending_buyer_signup')`);
  if (phoneFilter) {
    params.push(phoneFilter);
    where.push(`buyer_phone = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lt = await query(
    `SELECT id, status, seller_user_id, seller_doctype, seller_doc_name,
            buyer_user_id, buyer_phone, currency, total_amount, created_at
       FROM linked_transactions
       ${whereSql}
       ORDER BY id DESC
       LIMIT 30`,
    params
  );
  if (!lt.rowCount) {
    console.log('  (no rows)');
  } else {
    for (const r of lt.rows) {
      console.log(
        `  id=${r.id}  status=${r.status}\n` +
        `    seller: user.id=${r.seller_user_id} ${r.seller_doctype}:${r.seller_doc_name}\n` +
        `    buyer:  user.id=${r.buyer_user_id || '(none)'} phone=${r.buyer_phone || '(none)'}\n` +
        `    ${r.total_amount} ${r.currency}  created=${r.created_at}`
      );
    }
  }

  console.log('\n═══ COUNTERPARTY_CACHE — rows with linked_user_id ═══');
  const cc = await query(
    `SELECT owner_user_id, name, erpnext_name, erpnext_doctype, phone, linked_user_id
       FROM counterparty_cache
      WHERE linked_user_id IS NOT NULL
         ${phoneFilter ? `OR phone = $1` : ''}
      ORDER BY owner_user_id, id
      LIMIT 50`,
    phoneFilter ? [phoneFilter] : []
  );
  if (!cc.rowCount) {
    console.log('  (no linked counterparties — that\'s why B2B messages don\'t fire)');
  } else {
    for (const r of cc.rows) {
      console.log(
        `  owner.user_id=${r.owner_user_id}  ${r.erpnext_doctype}:${r.name}\n` +
        `    erpnext: ${r.erpnext_name}\n` +
        `    phone: ${r.phone || '(none)'}  linked_user_id: ${r.linked_user_id || '(NULL - not linked)'}`
      );
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

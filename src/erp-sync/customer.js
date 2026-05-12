/**
 * Resolve a counterparty name to its ERPNext Customer record name.
 *
 * Order of operations:
 *   1. counterparty_cache hit → return immediately (no API call)
 *   2. Exact-name match in ERPNext → cache + return
 *   3. Create new Customer in ERPNext (with currency/phone/email if known) → cache + return
 *
 * Always caches the resolved name back to Postgres so future lookups skip ERPNext.
 */

const { query } = require('../db');
const { ts } = require('../log');

async function resolveOrCreateCustomer(user, erp, name, { currency = null, phone = null, email = null } = {}) {
  if (!name) throw new Error('customer name required');

  // 1. cache hit?
  const cached = await query(
    `SELECT erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2) AND erpnext_doctype = 'Customer'
     LIMIT 1`,
    [user.id, name]
  );
  if (cached.rowCount > 0 && cached.rows[0].erpnext_name) {
    return cached.rows[0].erpnext_name;
  }

  // 2. exact-name match in ERPNext?
  const found = await erp.listCustomers({
    filters: [['customer_name', '=', name]],
    limit: 1,
  });

  let erpName;
  if (found.data?.length > 0) {
    erpName = found.data[0].name;
    console.log(`• [conversation] [${ts()}] customer match in ERPNext: ${erpName}`);
  } else {
    // 3. create
    const customerData = {
      customer_name: name,
      customer_type: 'Individual',
      customer_group: 'Individual',
      territory: 'All Territories',
    };
    if (currency) customerData.default_currency = currency;
    if (phone) customerData.mobile_no = phone;
    if (email) customerData.email_id = email;

    const result = await erp.createCustomer(customerData);
    erpName = result.data.name;
    console.log(`• [conversation] [${ts()}] created Customer in ERPNext: ${erpName} (currency=${currency || 'company default'})`);
  }

  // 4. cache
  const now = new Date().toISOString();
  await query(
    `INSERT INTO counterparty_cache
       (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $6)
     ON CONFLICT (owner_user_id, name) DO UPDATE SET
       erpnext_name = EXCLUDED.erpnext_name,
       erpnext_doctype = EXCLUDED.erpnext_doctype,
       phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
       email = COALESCE(counterparty_cache.email, EXCLUDED.email),
       updated_at = EXCLUDED.updated_at`,
    [user.id, name, phone, email, erpName, now]
  );

  return erpName;
}

module.exports = { resolveOrCreateCustomer };

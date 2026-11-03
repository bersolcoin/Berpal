/**
 * Counterparties (contacts) — people/businesses the user trades with.
 *
 * The `counterparty_cache` row is the bot's stable handle (its `id` is what the LLM passes
 * around as counterparty_id). It links to the ERPNext Customer and/or Supplier record, which
 * are created lazily: a contact becomes a Customer the first time we invoice them, a Supplier
 * the first time we get a bill from them.
 */
const { query } = require('./db');
const { ts } = require('./erp-sync/common');

const ROLE_COLUMN = { Customer: 'erpnext_customer', Supplier: 'erpnext_supplier' };

function rowToContact(row) {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname || null,
    phone: row.phone || null,
    email: row.email || null,
    is_customer: !!row.erpnext_customer,
    is_supplier: !!row.erpnext_supplier,
  };
}

async function upsert(user, { name, nickname = null, phone = null, email = null, customer = null, supplier = null }) {
  const now = new Date().toISOString();
  const r = await query(
    `INSERT INTO counterparty_cache
       (owner_user_id, name, nickname, phone, email, erpnext_customer, erpnext_supplier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (owner_user_id, name) DO UPDATE SET
       nickname = COALESCE(EXCLUDED.nickname, counterparty_cache.nickname),
       phone = COALESCE(EXCLUDED.phone, counterparty_cache.phone),
       email = COALESCE(EXCLUDED.email, counterparty_cache.email),
       erpnext_customer = COALESCE(EXCLUDED.erpnext_customer, counterparty_cache.erpnext_customer),
       erpnext_supplier = COALESCE(EXCLUDED.erpnext_supplier, counterparty_cache.erpnext_supplier),
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [user.id, name, nickname, phone, email, customer, supplier, now]
  );
  return r.rows[0];
}

async function getById(user, id) {
  const r = await query('SELECT * FROM counterparty_cache WHERE id = $1 AND owner_user_id = $2', [id, user.id]);
  return r.rows[0] || null;
}

async function findByName(user, name) {
  if (!name) return null;
  const r = await query(
    `SELECT * FROM counterparty_cache
     WHERE owner_user_id = $1 AND (LOWER(name) = LOWER($2) OR LOWER(nickname) = LOWER($2))
     ORDER BY id LIMIT 1`,
    [user.id, name]
  );
  return r.rows[0] || null;
}

/**
 * Pull Customers/Suppliers matching `term` from ERPNext into the cache so records created
 * outside the bot (ERPNext UI, imports) are findable too.
 */
async function syncFromErp(user, erp, term) {
  const like = `%${term}%`;
  const [customers, suppliers] = await Promise.all([
    erp.listCustomers({ filters: [['customer_name', 'like', like]], limit: 20 }),
    erp.listSuppliers({ filters: [['supplier_name', 'like', like]], limit: 20 }),
  ]);
  for (const c of customers.data || []) {
    await upsert(user, { name: c.customer_name, phone: c.mobile_no || null, customer: c.name });
  }
  for (const s of suppliers.data || []) {
    await upsert(user, { name: s.supplier_name, phone: s.mobile_no || null, supplier: s.name });
  }
}

/**
 * Fuzzy search by name or nickname. Returns contacts with an `exact` flag so the LLM
 * knows whether it can proceed or must show a picker.
 */
async function search(user, erp, term) {
  const t = String(term || '').trim();
  if (!t) return [];
  if (erp) {
    try {
      await syncFromErp(user, erp, t);
    } catch (err) {
      console.error(`[counterparties] ERPNext sync failed (using cache only): ${err.message}`);
    }
  }
  const r = await query(
    `SELECT * FROM counterparty_cache
     WHERE owner_user_id = $1 AND (name ILIKE $2 OR nickname ILIKE $2)
     ORDER BY name LIMIT 20`,
    [user.id, `%${t}%`]
  );
  const lower = t.toLowerCase();
  return r.rows.map((row) => ({
    ...rowToContact(row),
    exact: row.name.toLowerCase() === lower || (row.nickname || '').toLowerCase() === lower,
  }));
}

/** Add a contact without creating anything in ERPNext yet (role isn't known until they trade). */
async function createContact(user, { name, nickname = null, phone = null, email = null }) {
  if (!name) return { ok: false, error: 'name is required' };
  const existing = await findByName(user, name);
  const row = await upsert(user, { name: existing ? existing.name : name, nickname, phone, email });
  return { ok: true, existed: !!existing, contact: rowToContact(row) };
}

/**
 * The cache row a draft refers to: counterparty_id wins, else name/nickname match. null if new.
 */
async function forDraft(user, draft) {
  if (draft.counterparty_id) return getById(user, draft.counterparty_id);
  return findByName(user, draft.counterparty_name);
}

/**
 * Resolve the draft's counterparty to an ERPNext party of the given role, creating the
 * Customer/Supplier in ERPNext if this contact hasn't had that role before.
 *
 *   role: 'Customer' | 'Supplier'
 *   returns: ERPNext party name
 */
async function resolveParty(user, erp, draft, role) {
  const column = ROLE_COLUMN[role];
  let row = await forDraft(user, draft);
  if (draft.counterparty_id && !row) {
    throw new Error(`counterparty_id ${draft.counterparty_id} not found`);
  }
  const name = row ? row.name : draft.counterparty_name;
  if (!name) throw new Error(`${role.toLowerCase()} name required`);
  if (row && row[column]) return row[column];

  const nameField = role === 'Customer' ? 'customer_name' : 'supplier_name';
  const found = await erp.listResource(role, { filters: [[nameField, '=', name]], fields: ['name'], limit: 1 });

  let erpName;
  if (found.data?.length > 0) {
    erpName = found.data[0].name;
    console.log(`• [counterparties] [${ts()}] ${role} match in ERPNext: ${erpName}`);
  } else {
    const data = { [nameField]: name };
    if (draft.currency) data.default_currency = draft.currency;
    const phone = draft.counterparty_phone || row?.phone;
    const email = draft.counterparty_email || row?.email;
    if (phone) data.mobile_no = phone;
    if (email) data.email_id = email;
    const result = role === 'Customer' ? await erp.createCustomer(data) : await erp.createSupplier(data);
    erpName = result.data.name;
    console.log(`• [counterparties] [${ts()}] created ${role} in ERPNext: ${erpName}`);
  }

  await upsert(user, {
    name,
    nickname: draft.counterparty_nickname || null,
    phone: draft.counterparty_phone || null,
    email: draft.counterparty_email || null,
    [role === 'Customer' ? 'customer' : 'supplier']: erpName,
  });
  return erpName;
}

module.exports = { search, createContact, getById, findByName, forDraft, resolveParty, rowToContact };

/**
 * Per-tenant User Permission helpers.
 *
 * ERPNext's `User Permission` doctype is the per-record fence. A row
 * binds (user, doctype, value) — e.g. (bot+X@…, "Company", "SS & Co").
 * With `apply_to_all_doctypes = 1`, any doctype that has a link field
 * to that doctype auto-filters to records matching `for_value`.
 *
 * For multi-tenant isolation we set FOUR rows per bot user:
 *   1. Company        → tenant's Company
 *   2. Customer Group → "Customers - <ABBR>"
 *   3. Supplier Group → "Suppliers - <ABBR>"
 *   4. Item Group     → "Items - <ABBR>"
 *
 * The first one covers everything with a `company` field (Sales Invoice,
 * Purchase Invoice, Payment Entry, Journal Entry, Account, Cost Center,
 * Warehouse, GL Entry, Stock Entry, …). The other three fence the
 * non-Company-linked masters (Customer, Supplier, Item).
 *
 * Bot users do NOT have System Manager, so these fences actually fire.
 * Provisioning + the harden script call this with the admin client
 * (admin still has System Manager).
 */

const { ts } = require('../log');

/**
 * Insert a User Permission row if one doesn't already exist for this
 * (user, allow, for_value) triple. Idempotent.
 */
async function ensureUserPermission(admin, { user, allow, for_value, apply_to_all_doctypes = 1 }) {
  if (!user || !allow || !for_value) {
    throw new Error('ensureUserPermission needs user + allow + for_value');
  }

  const existing = await admin.listResource('User Permission', {
    filters: [
      ['user', '=', user],
      ['allow', '=', allow],
      ['for_value', '=', for_value],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (existing.data && existing.data.length > 0) return existing.data[0].name;

  const r = await admin.createResource('User Permission', {
    user,
    allow,
    for_value,
    apply_to_all_doctypes,
  });
  const name = r.data?.name;
  console.log(`• [user-perm] [${ts()}] ${user} allowed ${allow}=${for_value}${apply_to_all_doctypes ? ' (all doctypes)' : ''}`);
  return name;
}

/**
 * Apply the full per-tenant fence (Company + Customer Group + Supplier
 * Group + Item Group). Used by both provisionTenant and harden-tenant
 * script. Returns the four perm names.
 */
async function applyTenantFence(admin, { user, company, customerGroup, supplierGroup, itemGroup }) {
  const out = {};
  if (company) {
    out.company = await ensureUserPermission(admin, {
      user, allow: 'Company', for_value: company,
    });
  }
  if (customerGroup) {
    out.customerGroup = await ensureUserPermission(admin, {
      user, allow: 'Customer Group', for_value: customerGroup,
    });
  }
  if (supplierGroup) {
    out.supplierGroup = await ensureUserPermission(admin, {
      user, allow: 'Supplier Group', for_value: supplierGroup,
    });
  }
  if (itemGroup) {
    out.itemGroup = await ensureUserPermission(admin, {
      user, allow: 'Item Group', for_value: itemGroup,
    });
  }
  return out;
}

/**
 * List the User Permissions for a user — used by inspect-erp-user.js
 * to show the fence state.
 */
async function listForUser(admin, user) {
  const r = await admin.listResource('User Permission', {
    filters: [['user', '=', user]],
    fields: ['name', 'allow', 'for_value', 'apply_to_all_doctypes'],
    limit: 100,
  });
  return r.data || [];
}

module.exports = { ensureUserPermission, applyTenantFence, listForUser };

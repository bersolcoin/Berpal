/**
 * Per-company Item Group helpers.
 *
 * ERPNext Items aren't natively company-scoped — they live at the site
 * level. To isolate tenants we tag every item the bot/web creates with
 * a per-company Item Group ("Items - <ABBR>"), then filter list queries
 * by that group. This is soft isolation (display-only); a future pass
 * will harden it with ERPNext User Permissions for backend enforcement.
 *
 * Naming convention: `Items - <ABBR>` parented under `All Item Groups`.
 *   Items - TTC, Items - ACME, Items - BLMR, …
 *
 * The tenant root is a group: the industry category tree hangs under it,
 * created lazily per tenant as varieties get used:
 *   Items - ML › Gemstones - ML › Tourmaline - ML › Paraiba Tourmaline - ML
 * Single-variety families (Aquamarine) skip the family level. Queries
 * scope with tenantItemGroupFilter() ("descendants of (inclusive)"); the
 * User Permission on the root covers the whole subtree.
 */

const { ts } = require('../log');

const ROOT_GROUP = 'All Item Groups';
const _ensured = new Set();

function getCompanyItemGroupName(companyAbbr) {
  if (!companyAbbr) return null;
  return `Items - ${companyAbbr}`;
}

/**
 * Get-or-create the per-company Item Group. Returns the group name
 * regardless of whether it already existed. Idempotent + memoized.
 */
async function ensureCompanyItemGroup(erp, companyAbbr) {
  const name = getCompanyItemGroupName(companyAbbr);
  if (!name) throw new Error('companyAbbr required');
  if (_ensured.has(name)) return name;

  try {
    const existing = (await erp.getResource('Item Group', name)).data;
    // Pre-catalog tenants got a leaf root — promote it so the category
    // tree can hang under it.
    if (!existing.is_group) await erp.updateResource('Item Group', name, { is_group: 1 });
    _ensured.add(name);
    return name;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) {
      throw err;
    }
  }

  try {
    await erp.createResource('Item Group', {
      item_group_name: name,
      parent_item_group: ROOT_GROUP,
      is_group: 1,
    });
    _ensured.add(name);
    console.log(`• [item-group] [${ts()}] created Item Group "${name}"`);
  } catch (err) {
    // Race: another concurrent caller may have created it. Treat duplicate
    // as success.
    if (/already exists|DuplicateEntryError/i.test(err.message)) {
      _ensured.add(name);
      return name;
    }
    throw err;
  }

  return name;
}

/** List filter scoping Items to this tenant's whole group subtree. */
function tenantItemGroupFilter(companyAbbr) {
  const root = getCompanyItemGroupName(companyAbbr);
  return root ? [['item_group', 'descendants of (inclusive)', root]] : [];
}

/** True when an Item Group belongs to this tenant (all are " - <ABBR>"). */
function isTenantItemGroup(companyAbbr, group) {
  return !!(companyAbbr && group && group.endsWith(` - ${companyAbbr}`));
}

// Returns true when the group was newly created.
async function ensureGroup(erp, name, parent, isGroup) {
  if (_ensured.has(name)) return false;
  let created = false;
  try {
    await erp.getResource('Item Group', name);
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
    try {
      await erp.createResource('Item Group', {
        item_group_name: name,
        parent_item_group: parent,
        is_group: isGroup ? 1 : 0,
      });
      console.log(`• [item-group] [${ts()}] created Item Group "${name}" under "${parent}"`);
      created = true;
    } catch (createErr) {
      if (!/already exists|DuplicateEntryError/i.test(createErr.message)) throw createErr;
    }
  }
  _ensured.add(name);
  return created;
}

/**
 * Frappe caches each user's permitted values (incl. tree descendants) and
 * only rebuilds when one of their User Permissions is saved. New subtree
 * groups are invisible to the tenant bot until then — re-save the root's
 * Item Group permission(s) to refresh. (frappe.clear_cache isn't
 * whitelisted over REST in v16.)
 */
async function refreshItemGroupPermissionCache(adminErp, root) {
  const r = await adminErp.listResource('User Permission', {
    filters: [['allow', '=', 'Item Group'], ['for_value', '=', root]],
    fields: ['name', 'hide_descendants'],
    limit: 0,
  });
  for (const up of r.data || []) {
    await adminErp.updateResource('User Permission', up.name, { hide_descendants: up.hide_descendants || 0 });
  }
}

/**
 * Get-or-create the tenant's group for a catalog variety, building the
 * path root › category › family › variety on first use. Pass the ADMIN
 * client — tree structure is site-level, and the tenant bot's User
 * Permission is on the root (it can't create siblings of it).
 * Returns the variety group name (the Item's item_group).
 */
async function ensureVarietyItemGroup(adminErp, companyAbbr, { category, family, variety }) {
  if (!companyAbbr) throw new Error('companyAbbr required');
  const sfx = ` - ${companyAbbr}`;
  const root = await ensureCompanyItemGroup(adminErp, companyAbbr);
  const cat = `${category}${sfx}`;
  const parent = family && family !== variety ? `${family}${sfx}` : cat;
  const leaf = `${variety}${sfx}`;
  let created = await ensureGroup(adminErp, cat, root, true);
  if (parent !== cat) created = (await ensureGroup(adminErp, parent, cat, true)) || created;
  created = (await ensureGroup(adminErp, leaf, parent, false)) || created;
  if (created) await refreshItemGroupPermissionCache(adminErp, root);
  return leaf;
}

/**
 * Pull the company abbr from the user row. Used by callers that have
 * the user object but not the abbr field directly.
 */
function abbrFromUser(user) {
  return user?.erpnext_company_abbr || null;
}

module.exports = {
  getCompanyItemGroupName,
  ensureCompanyItemGroup,
  ensureVarietyItemGroup,
  tenantItemGroupFilter,
  isTenantItemGroup,
  abbrFromUser,
  ROOT_GROUP,
};

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
    await erp.getResource('Item Group', name);
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
      is_group: 0,
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
  abbrFromUser,
  ROOT_GROUP,
};

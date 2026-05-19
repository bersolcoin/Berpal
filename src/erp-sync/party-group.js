/**
 * Per-tenant Customer Group + Supplier Group helpers.
 *
 * Parallels item-group.js. ERPNext Customers and Suppliers are not
 * natively company-scoped — they live at the site level. To fence
 * tenants we tag every party with a per-tenant group, then add a
 * User Permission on Customer Group / Supplier Group so the bot can
 * only see / modify rows in its own group.
 *
 * Naming:
 *   Customer Group: "Customers - <ABBR>"  parent: "All Customer Groups"
 *   Supplier Group: "Suppliers - <ABBR>"  parent: "All Supplier Groups"
 */

const { ts } = require('../log');

const CUSTOMER_ROOT = 'All Customer Groups';
const SUPPLIER_ROOT = 'All Supplier Groups';
const _ensured = new Set();

function getCustomerGroupName(abbr) {
  return abbr ? `Customers - ${abbr}` : null;
}

function getSupplierGroupName(abbr) {
  return abbr ? `Suppliers - ${abbr}` : null;
}

async function ensureGroup(erp, doctype, nameField, name, parent) {
  if (!name) throw new Error(`${doctype} name required`);
  const key = `${doctype}|${name}`;
  if (_ensured.has(key)) return name;

  try {
    await erp.getResource(doctype, name);
    _ensured.add(key);
    return name;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) {
      throw err;
    }
  }

  try {
    await erp.createResource(doctype, {
      [nameField]: name,
      // Customer Group / Supplier Group parent field differs by doctype
      ...(doctype === 'Customer Group' ? { parent_customer_group: parent } : {}),
      ...(doctype === 'Supplier Group' ? { parent_supplier_group: parent } : {}),
      is_group: 0,
    });
    _ensured.add(key);
    console.log(`• [party-group] [${ts()}] created ${doctype} "${name}" under "${parent}"`);
  } catch (err) {
    if (/already exists|DuplicateEntryError/i.test(err.message)) {
      _ensured.add(key);
      return name;
    }
    throw err;
  }
  return name;
}

async function ensureCustomerGroup(erp, abbr) {
  return ensureGroup(erp, 'Customer Group', 'customer_group_name', getCustomerGroupName(abbr), CUSTOMER_ROOT);
}

async function ensureSupplierGroup(erp, abbr) {
  return ensureGroup(erp, 'Supplier Group', 'supplier_group_name', getSupplierGroupName(abbr), SUPPLIER_ROOT);
}

module.exports = {
  getCustomerGroupName,
  getSupplierGroupName,
  ensureCustomerGroup,
  ensureSupplierGroup,
  CUSTOMER_ROOT,
  SUPPLIER_ROOT,
};

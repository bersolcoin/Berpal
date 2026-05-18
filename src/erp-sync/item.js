/**
 * Ensure a generic catch-all Item exists in ERPNext for use as the line-item
 * placeholder on Sales / Purchase Invoices.
 *
 * ERPNext requires every invoice line to reference an Item. For one-off
 * goods/services we don't want to mint an Item per SKU — so we keep two
 * shared items: GEN-SALE for sales, GEN-PURCHASE for purchases. The actual
 * product/service description goes on the line's `description` field.
 *
 * Per-process memo so we don't hit the API repeatedly during the same run.
 *
 * Items are now tagged with the user's per-company Item Group ("Items - <ABBR>")
 * so the web app can scope inventory views per tenant. The legacy generics
 * (GEN-SALE / GEN-PURCHASE) are namespaced per tenant — each tenant gets
 * their own "GEN-SALE-<ABBR>" so they live in the right Item Group.
 */

const { ts } = require('../log');
const { ensureCompanyItemGroup, abbrFromUser } = require('./item-group');

const _ensured = new Set();

async function ensureItem(user, erp, { codeBase, name, isSales, isPurchase }) {
  const abbr = abbrFromUser(user);
  // Namespace the code per tenant so each company has its own copy.
  const code = abbr ? `${codeBase}-${abbr}` : codeBase;
  const cacheKey = `${erp.company}|${code}`;
  if (_ensured.has(cacheKey)) return code;

  try {
    await erp.getResource('Item', code);
    _ensured.add(cacheKey);
    return code;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
  }

  // Ensure the per-company Item Group exists before referencing it.
  let itemGroup = 'All Item Groups';
  if (abbr) {
    try {
      itemGroup = await ensureCompanyItemGroup(erp, abbr);
    } catch (err) {
      console.warn(`• [item] [${ts()}] item-group ensure failed, using default: ${err.message}`);
    }
  }

  await erp.createResource('Item', {
    item_code: code,
    item_name: name,
    item_group: itemGroup,
    stock_uom: 'Nos',
    is_stock_item: 0,
    is_sales_item: isSales ? 1 : 0,
    is_purchase_item: isPurchase ? 1 : 0,
    description: `Default item used by bot for ${isSales ? 'sales' : 'purchase'} line items`,
  });

  _ensured.add(cacheKey);
  console.log(`• [item] [${ts()}] created Item ${code} in ERPNext (group=${itemGroup})`);
  return code;
}

function ensureGenericSalesItem(user, erp) {
  return ensureItem(user, erp, {
    codeBase: 'GEN-SALE',
    name: 'Generic Sale',
    isSales: true,
    isPurchase: false,
  });
}

function ensureGenericPurchaseItem(user, erp) {
  return ensureItem(user, erp, {
    codeBase: 'GEN-PURCHASE',
    name: 'Generic Purchase',
    isSales: false,
    isPurchase: true,
  });
}

module.exports = { ensureGenericSalesItem, ensureGenericPurchaseItem };

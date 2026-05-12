/**
 * Ensure a generic catch-all Item exists in ERPNext for use as the line-item
 * placeholder on Sales Invoices.
 *
 * ERPNext requires every invoice line to reference an Item. For service-style
 * or one-off product sales we don't want to create an Item per gemstone — so
 * we keep one shared "GEN-SALE" item and put the actual product description
 * on the line's `description` field instead.
 *
 * Per-process memo so we don't hit the API repeatedly during the same run.
 */

const { ts } = require('../log');

const ITEM_CODE = 'GEN-SALE';
const _ensured = new Set();

async function ensureGenericSalesItem(erp) {
  if (_ensured.has(ITEM_CODE)) return ITEM_CODE;

  try {
    await erp.getResource('Item', ITEM_CODE);
    _ensured.add(ITEM_CODE);
    return ITEM_CODE;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
  }

  // Item doesn't exist — create
  await erp.createResource('Item', {
    item_code: ITEM_CODE,
    item_name: 'Generic Sale',
    item_group: 'All Item Groups',
    stock_uom: 'Nos',
    is_stock_item: 0,
    is_sales_item: 1,
    description: 'Default item used by bot for sales line items',
  });

  _ensured.add(ITEM_CODE);
  console.log(`• [conversation] [${ts()}] created Item ${ITEM_CODE} in ERPNext`);
  return ITEM_CODE;
}

module.exports = { ensureGenericSalesItem };

/**
 * GET /api/items/search?q=… — this tenant's items matching code or name,
 * for the item picker on web transaction forms. Up to 20 results.
 */

const { getCurrentUser } = require('../../../../src/auth/current-user');
const { tenantItemGroupFilter } = require('../../../../src/erp-sync/item-group');
const erpnext = require('../../../../src/erpnext');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['name', 'item_code', 'item_name', 'stock_uom', 'gem_type', 'weight_ct', 'pieces'];

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  const erp = erpnext.forUser(user);
  const base = [['disabled', '=', 0], ...tenantItemGroupFilter(user.erpnext_company_abbr)];

  // ERPNext REST has no OR filter — query code and name separately, merge.
  const queries = q
    ? [['item_code', 'like', `%${q}%`], ['item_name', 'like', `%${q}%`]].map((f) =>
        erp.listResource('Item', { filters: [...base, f], fields: FIELDS, limit: 20, orderBy: 'modified desc' })
      )
    : [erp.listResource('Item', { filters: base, fields: FIELDS, limit: 20, orderBy: 'modified desc' })];

  try {
    const results = await Promise.all(queries);
    const merged = new Map();
    for (const r of results) for (const row of r.data || []) merged.set(row.name, row);
    return Response.json({ ok: true, items: [...merged.values()].slice(0, 20) });
  } catch (err) {
    console.error('[api/items/search] failed:', err.message);
    return Response.json({ ok: false, error: 'Search failed.' }, { status: 500 });
  }
}

/**
 * GET /api/inventory?<grid query>&offset=N&limit=M — the next slice of the
 * inventory (same search / sort / filters as the page, see
 * app/(app)/inventory/grid.js), for infinite scroll. limit=0 returns just
 * the count (the filter panel's live "Show N lots").
 *   → { ok, rows, total }
 */

import { parseGridState, applyGrid } from '../../(app)/inventory/grid';

const { getCurrentUser } = require('../../../src/auth/current-user');
const { listInventory } = require('../../../src/erp-query/inventory');
const erpnext = require('../../../src/erpnext');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 500;

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const offset = Math.max(0, parseInt(params.get('offset'), 10) || 0);
  const rawLimit = parseInt(params.get('limit'), 10);
  const limit = Math.min(MAX_LIMIT, Math.max(0, Number.isFinite(rawLimit) ? rawLimit : 50));
  const state = parseGridState(params);

  try {
    const all = await listInventory(user, erpnext.forUser(user), { q: state.q });
    const { rows } = applyGrid(all, state);
    return Response.json({ ok: true, rows: rows.slice(offset, offset + limit), total: rows.length });
  } catch (err) {
    console.error('[api/inventory] failed:', err.message);
    return Response.json({ ok: false, error: 'Could not load more lots.' }, { status: 500 });
  }
}

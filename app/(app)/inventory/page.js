/**
 * /inventory — every stocked lot in a spreadsheet-style table with the
 * gem attributes, stock, value and selling price. Summary blocks on top,
 * then search. Columns sort and filter Excel-style from their headers;
 * which columns show is chosen per user (Columns button, saved in
 * people.ui_prefs). Search, sort and filters live in the URL. The first 50
 * lots render here; the table loads more as you scroll (/api/inventory).
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { getSession } from '../../../src/auth/session';
import { listInventory, inventoryTotals } from '../../../src/erp-query/inventory';
import { query } from '../../../src/db';
import PageHeader from '../_components/PageHeader';
import { Gear, Plus } from '@phosphor-icons/react/dist/ssr';
import InventoryTable from './InventoryTable';
import { resolveColumns } from './columns';
import { parseGridState, gridQuery, applyGrid } from './grid';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function InventoryPage({ searchParams }) {
  const params = (await searchParams) || {};
  const state = parseGridState(params);

  const { user, erp } = await getAppContext();
  const { phone } = await getSession();
  const [all, prefs] = await Promise.all([
    listInventory(user, erp, { q: state.q }).catch((err) => {
      console.error('[inventory] list failed:', err.message);
      return [];
    }),
    query(`SELECT ui_prefs FROM people WHERE phone = $1`, [phone]).then((r) => r.rows[0]?.ui_prefs || {}),
  ]);
  const { rows, facets } = applyGrid(all, state);

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="All your lots and stock."
        right={
          <div className="flex items-center gap-2">
            <Link
              href="/inventory/opening"
              title="Add stock"
              aria-label="Add stock"
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition"
            >
              <Plus size={18} weight="bold" />
            </Link>
            <Link
              href="/inventory/settings"
              title="Inventory settings"
              aria-label="Inventory settings"
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-500 transition"
            >
              <Gear size={18} />
            </Link>
          </div>
        }
      />

      <InventoryTable
        // A new search / sort / filter = a fresh list from the top.
        key={new URLSearchParams(gridQuery(state)).toString()}
        rows={rows.slice(0, PAGE_SIZE)}
        total={rows.length}
        pageSize={PAGE_SIZE}
        facets={facets}
        initialColumns={resolveColumns(prefs.inventory_columns)}
        initialView={prefs.inventory_view === 'cards' ? 'cards' : 'table'}
        totals={inventoryTotals(rows)}
        currency={user.default_currency}
        abbr={user.erpnext_company_abbr}
      />
    </>
  );
}

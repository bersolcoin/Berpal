/**
 * /inventory — physical items (is_stock_item=1). Shows code, name, group,
 * unit, current total stock across all warehouses, standard rate.
 *
 * Paginated 50/page. Reuses the Pagination component and the same sticky
 * right-column treatment as other list pages.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listItems, countItems } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import Pagination from '../_components/Pagination';
import { money } from '../_components/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function InventoryPage({ searchParams }) {
  const params = (await searchParams) || {};
  const page = Math.max(1, parseInt(params.page, 10) || 1);

  const { user, erp } = await getAppContext();

  const [pageResult, total] = await Promise.all([
    listItems(user, erp, {
      isStockItem: true,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => ({ rows: [], hasMore: false })),
    countItems(user, erp, { isStockItem: true }).catch(() => 0),
  ]);

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Physical items you stock — current quantities and rates."
      />

      <Card>
        {pageResult.rows.length === 0 ? (
          <Empty
            title={page === 1 ? 'No items yet' : 'Nothing on this page'}
            hint={page === 1 ? 'Tell the bot you sold or bought something and it will create the item for you.' : 'Try going back to page 1.'}
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Item</th>
                  <th className="font-medium pb-2 pr-4">Group</th>
                  <th className="font-medium pb-2 pr-4">Unit</th>
                  <th className="font-medium pb-2 pr-4 text-right">Rate</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Stock
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {pageResult.rows.map((item) => (
                  <tr key={item.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="max-w-[320px] truncate">
                        <Link
                          href={`/inventory/${encodeURIComponent(item.item_code)}`}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)] font-medium"
                          title={item.item_name}
                        >
                          {item.item_name || item.item_code}
                        </Link>
                        <div className="text-xs text-[var(--color-ink-muted)] font-mono truncate">
                          {item.item_code}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)] text-xs truncate max-w-[160px]" title={item.item_group}>
                      {item.item_group || '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)]">{item.uom}</td>
                    <td className="py-2.5 pr-4 text-right tabular">
                      {item.standard_rate ? money(item.standard_rate, user.default_currency) : <span className="text-slate-300">—</span>}
                    </td>
                    <td
                      className={`py-2.5 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${
                        item.total_stock < 0
                          ? 'text-[var(--color-negative)]'
                          : item.total_stock === 0
                          ? 'text-slate-400'
                          : 'text-slate-900'
                      }`}
                    >
                      {item.total_stock} <span className="text-xs text-slate-400">{item.uom}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          basePath="/inventory"
        />
      </Card>
    </>
  );
}

/**
 * /services — non-stock items (is_stock_item=0). Hourly rates, billable
 * deliverables, fixed-fee packages. No stock columns.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listItems, countItems } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import Pagination from '../_components/Pagination';
import { money, date, friendlyName, friendlyItemCode } from '../_components/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function ServicesPage({ searchParams }) {
  const params = (await searchParams) || {};
  const page = Math.max(1, parseInt(params.page, 10) || 1);

  const { user, erp } = await getAppContext();

  const [pageResult, total] = await Promise.all([
    listItems(user, erp, {
      isStockItem: false,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => ({ rows: [], hasMore: false })),
    countItems(user, erp, { isStockItem: false }).catch(() => 0),
  ]);

  return (
    <>
      <PageHeader
        title="Services"
        subtitle="Non-stocked items — billable hours, retainers, fixed-fee packages."
      />

      <Card>
        {pageResult.rows.length === 0 ? (
          <Empty
            title={page === 1 ? 'No services yet' : 'Nothing on this page'}
            hint={page === 1 ? 'Tell the bot what you offer and it will register it as a service.' : 'Try going back to page 1.'}
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Service</th>
                  <th className="font-medium pb-2 pr-4">Group</th>
                  <th className="font-medium pb-2 pr-4">Last updated</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Standard rate
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {pageResult.rows.map((item) => (
                  <tr key={item.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="max-w-[320px] truncate">
                        <Link
                          href={`/services/${encodeURIComponent(item.item_code)}`}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)] font-medium"
                          title={item.item_name}
                        >
                          {item.item_name || friendlyItemCode(item.item_code, user.erpnext_company_abbr)}
                        </Link>
                        <div className="text-xs text-[var(--color-ink-muted)] font-mono truncate">
                          {friendlyItemCode(item.item_code, user.erpnext_company_abbr)}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)] text-xs truncate max-w-[160px]" title={friendlyName(item.item_group, user.erpnext_company_abbr)}>
                      {friendlyName(item.item_group, user.erpnext_company_abbr) || '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)] tabular text-xs whitespace-nowrap">
                      {date(item.modified)}
                    </td>
                    <td className="py-2.5 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                      {item.standard_rate ? money(item.standard_rate, user.default_currency) : <span className="text-slate-300 font-normal">—</span>}
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
          basePath="/services"
        />
      </Card>
    </>
  );
}

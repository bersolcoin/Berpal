/**
 * /inventory/[code] — single item view with stock per warehouse, recent
 * stock movements, and recent invoice appearances.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import { getItemDetail } from '../../../../src/erp-query';
import PageHeader from '../../_components/PageHeader';
import Card from '../../_components/Card';
import Empty from '../../_components/Empty';
import { money, date, friendlyAccountName } from '../../_components/format';

export const dynamic = 'force-dynamic';

export default async function InventoryDetail({ params }) {
  const { code: codeParam } = await params;
  const itemCode = decodeURIComponent(codeParam);
  const { user, erp } = await getAppContext();

  const item = await getItemDetail(user, erp, { itemCode }).catch(() => null);
  if (!item) notFound();

  return (
    <>
      <PageHeader
        title={item.item_name || item.item_code}
        subtitle={
          <span>
            <Link href="/inventory" className="text-[var(--color-brand-accent)] hover:underline">Inventory</Link>
            {' / '}
            <span className="font-mono text-xs">{item.item_code}</span>
            {item.item_group && <span className="ml-2 text-xs">({item.item_group})</span>}
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Total stock</div>
          <div className={`text-2xl font-semibold mt-1.5 tabular ${
            item.total_stock < 0 ? 'text-[var(--color-negative)]' :
            item.total_stock === 0 ? 'text-slate-400' : 'text-slate-900'
          }`}>
            {item.total_stock} <span className="text-base text-slate-500">{item.uom}</span>
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Standard rate</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-900">
            {item.standard_rate ? money(item.standard_rate, user.default_currency) : '—'}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Warehouses with stock</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-900">
            {item.bins.filter((b) => Math.abs(b.actual) > 0.0001).length}
          </div>
        </Card>
      </div>

      {item.description && (
        <Card title="Description" className="mb-4">
          <div className="text-sm text-slate-700 prose-sm" dangerouslySetInnerHTML={{ __html: item.description }} />
        </Card>
      )}

      <Card title="Stock by warehouse" className="mb-4">
        {item.bins.length === 0 ? (
          <Empty title="No stock recorded yet" hint="Stock appears here when you receive inventory via a Purchase Invoice or Stock Entry." />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Warehouse</th>
                  <th className="font-medium pb-2 pr-4 text-right">Actual</th>
                  <th className="font-medium pb-2 pr-4 text-right">Reserved</th>
                  <th className="font-medium pb-2 pr-4 text-right">Ordered</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Projected
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {item.bins.map((b) => (
                  <tr key={b.warehouse} className="group hover:bg-slate-50 transition">
                    <td className="py-2 pl-5 pr-4 truncate max-w-[280px]" title={b.warehouse}>
                      {friendlyAccountName(b.warehouse) || b.warehouse}
                    </td>
                    <td className="py-2 pr-4 text-right tabular">{b.actual}</td>
                    <td className="py-2 pr-4 text-right tabular text-[var(--color-ink-muted)]">{b.reserved || ''}</td>
                    <td className="py-2 pr-4 text-right tabular text-[var(--color-ink-muted)]">{b.ordered || ''}</td>
                    <td className="py-2 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                      {b.projected}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Recent stock movements">
          {item.movements.length === 0 ? (
            <Empty title="No movements yet" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5">
              {item.movements.map((m) => (
                <li key={m.erpnext_name} className="px-5 py-2 flex items-center justify-between gap-3 hover:bg-slate-50 transition">
                  <div className="text-xs text-[var(--color-ink-muted)] tabular shrink-0 w-20">{date(m.posting_date)}</div>
                  <div className="flex-1 min-w-0 text-xs truncate" title={m.voucher_no}>
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1 rounded bg-slate-100 text-slate-600 mr-1.5">{m.voucher_type}</span>
                    <Link
                      href={`/transactions/${encodeURIComponent(m.voucher_type)}/${encodeURIComponent(m.voucher_no)}`}
                      className="font-mono text-[var(--color-brand-accent)] hover:underline"
                    >
                      {m.voucher_no}
                    </Link>
                  </div>
                  <div className={`text-sm tabular font-medium ${m.delta > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
                    {m.delta > 0 ? '+' : ''}{m.delta}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Sold / purchased on">
          {item.sales_appearances.length === 0 && item.purchase_appearances.length === 0 ? (
            <Empty title="No invoices yet" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5">
              {[...item.sales_appearances.map((a) => ({ ...a, kind: 'sale' })),
                ...item.purchase_appearances.map((a) => ({ ...a, kind: 'purchase' }))]
                .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
                .slice(0, 12)
                .map((a, i) => (
                  <li key={`${a.kind}-${a.invoice}-${i}`} className="px-5 py-2 flex items-center justify-between gap-3 hover:bg-slate-50 transition">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] uppercase tracking-wide font-medium px-1 rounded ${a.kind === 'sale' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                        {a.kind === 'sale' ? 'Sold' : 'Bought'}
                      </span>
                      <Link
                        href={`/transactions/${encodeURIComponent(a.kind === 'sale' ? 'Sales Invoice' : 'Purchase Invoice')}/${encodeURIComponent(a.invoice)}`}
                        className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline truncate"
                      >
                        {a.invoice}
                      </Link>
                    </div>
                    <div className="text-xs tabular text-slate-700 shrink-0">
                      {a.qty} × {money(a.rate, user.default_currency)}
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * /services/[code] — single service item. No stock; just header info and
 * recent sales appearances.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import { getItemDetail } from '../../../../src/erp-query';
import PageHeader from '../../_components/PageHeader';
import Card from '../../_components/Card';
import Empty from '../../_components/Empty';
import { money, date } from '../../_components/format';

export const dynamic = 'force-dynamic';

export default async function ServiceDetail({ params }) {
  const { code: codeParam } = await params;
  const itemCode = decodeURIComponent(codeParam);
  const { user, erp } = await getAppContext();

  const item = await getItemDetail(user, erp, { itemCode }).catch(() => null);
  if (!item) notFound();

  // Combine sales + purchase appearances, newest first.
  const appearances = [
    ...item.sales_appearances.map((a) => ({ ...a, kind: 'sale' })),
    ...item.purchase_appearances.map((a) => ({ ...a, kind: 'purchase' })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return (
    <>
      <PageHeader
        title={item.item_name || item.item_code}
        subtitle={
          <span>
            <Link href="/services" className="text-[var(--color-brand-accent)] hover:underline">Services</Link>
            {' / '}
            <span className="font-mono text-xs">{item.item_code}</span>
            {item.item_group && <span className="ml-2 text-xs">({item.item_group})</span>}
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Standard rate</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-900">
            {item.standard_rate ? money(item.standard_rate, user.default_currency) : '—'}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Times sold</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-900">
            {item.sales_appearances.length}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Unit</div>
          <div className="text-2xl font-semibold mt-1.5 text-slate-900">{item.uom || '—'}</div>
        </Card>
      </div>

      {item.description && (
        <Card title="Description" className="mb-4">
          <div className="text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: item.description }} />
        </Card>
      )}

      <Card title="Recent appearances">
        {appearances.length === 0 ? (
          <Empty title="No invoices yet" hint="This service hasn't appeared on a sale or purchase invoice yet." />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Date</th>
                  <th className="font-medium pb-2 pr-4">Type</th>
                  <th className="font-medium pb-2 pr-4">Invoice</th>
                  <th className="font-medium pb-2 pr-4 text-right">Qty × Rate</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {appearances.map((a, i) => (
                  <tr key={`${a.kind}-${a.invoice}-${i}`} className="group hover:bg-slate-50 transition">
                    <td className="py-2 pl-5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap text-xs">
                      {date(a.date)}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${
                        a.kind === 'sale' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {a.kind === 'sale' ? 'Sale' : 'Purchase'}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/transactions/${encodeURIComponent(a.kind === 'sale' ? 'Sales Invoice' : 'Purchase Invoice')}/${encodeURIComponent(a.invoice)}`}
                        className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline"
                      >
                        {a.invoice}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right tabular text-[var(--color-ink-muted)] text-xs whitespace-nowrap">
                      {a.qty} × {money(a.rate, user.default_currency)}
                    </td>
                    <td className="py-2 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                      {money(a.amount, user.default_currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

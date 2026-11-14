/**
 * /inventory/[code] — one lot: photo/video gallery, key figures (stock,
 * cost, value, selling price), the lot's attributes in catalog order, then
 * stock movements and the invoices it appears on.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import { getItemDetail } from '../../../../src/erp-query';
import { listVarieties, loadCategoryFields } from '../../../../src/catalog';
import PageHeader from '../../_components/PageHeader';
import Card from '../../_components/Card';
import Empty from '../../_components/Empty';
import { money, date, friendlyAccountName, friendlyItemCode } from '../../_components/format';
import LotGallery from './LotGallery';

export const dynamic = 'force-dynamic';

const UNIT = { Carat: 'ct', Gram: 'g', Nos: 'pcs' };
// Voucher types the transaction detail page can open; others show as text.
const OPENABLE = new Set(['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry']);
const VOUCHER_LABEL = { 'Stock Reconciliation': 'Opening stock', 'Purchase Invoice': 'Purchase', 'Sales Invoice': 'Sale' };
const num = (v, d = 2) => Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export default async function LotPage({ params }) {
  const { code: codeParam } = await params;
  const itemCode = decodeURIComponent(codeParam);
  const { user, erp } = await getAppContext();
  const abbr = user.erpnext_company_abbr;

  const item = await getItemDetail(user, erp, { itemCode }).catch(() => null);
  if (!item) notFound();
  const d = item.doc;
  const unit = UNIT[item.uom] || item.uom;

  // Attribute list from the lot's catalog category (labels + order).
  const variety = (await listVarieties(user.id)).find((v) => v.variety === d.gem_type);
  const fields = variety ? await loadCategoryFields(variety.category_id) : [];
  const details = [];
  if (d.gem_type) details.push({ label: 'Variety', value: d.gem_family && d.gem_family !== d.gem_type ? `${d.gem_family} › ${d.gem_type}` : d.gem_type });
  let sizeDone = false;
  for (const f of fields) {
    if (['meas1', 'meas2', 'meas3'].includes(f.field_key)) {
      if (sizeDone) continue;
      sizeDone = true;
      const size = [d.meas1, d.meas2, d.meas3].filter((x) => x).map((x) => num(x)).join(' × ');
      if (size) details.push({ label: 'Size', value: `${size} mm` });
      continue;
    }
    const v = d[f.field_key];
    if (v === undefined || v === null || v === '' || (f.field_type === 'check' && !v)) continue;
    const value =
      f.field_key === 'weight_ct' ? `${num(v)} ct` : f.field_type === 'check' ? 'Yes' : f.field_type === 'float' ? num(v) : String(v);
    details.push({ label: f.field_label, value });
  }

  const price = item.selling_prices[0];
  const figures = [
    { label: 'In stock', value: `${num(item.total_stock || 0)} ${unit}`, muted: !item.total_stock },
    { label: `Cost / ${unit}`, value: item.cost_rate ? money(item.cost_rate, user.default_currency) : '—' },
    { label: 'Stock value', value: item.stock_value ? money(item.stock_value, user.default_currency) : '—' },
    { label: 'Selling price', value: price ? money(price.rate, price.currency) : '—' },
  ];

  return (
    <>
      <PageHeader
        back="/inventory"
        backLabel="Back to Inventory"
        title={item.item_name || friendlyItemCode(item.item_code, abbr)}
        subtitle={
          <span>
            <span className="font-mono text-xs font-medium text-slate-700">{friendlyItemCode(item.item_code, abbr)}</span>
            {d.gem_type && <span> · {d.gem_type}</span>}
          </span>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-5">
        <div className="lg:col-span-2">
          <LotGallery image={item.image} images={item.media?.images} video={item.media?.video} alt={item.item_name} />
        </div>

        <div className="lg:col-span-3 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 bg-white border border-[var(--color-border)] rounded-xl divide-x divide-y sm:divide-y-0 divide-[var(--color-border)]">
            {figures.map((f) => (
              <div key={f.label} className="px-4 py-3">
                <div className="text-[11px] leading-4 uppercase tracking-wide text-[var(--color-ink-muted)]">{f.label}</div>
                <div className={`mt-1 text-sm leading-5 font-semibold tabular ${f.muted ? 'text-slate-400' : 'text-slate-900'}`}>{f.value}</div>
              </div>
            ))}
          </div>

          <Card title="Details">
            {details.length === 0 ? (
              <p className="text-sm text-slate-500">No details recorded.</p>
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                {details.map((x) => (
                  <div key={x.label} className="flex items-baseline justify-between gap-4 py-2 border-b border-[var(--color-border)] last:border-0 sm:[&:nth-last-child(2)]:border-0">
                    <dt className="text-xs text-[var(--color-ink-muted)]">{x.label}</dt>
                    <dd className="text-sm text-slate-900 text-right tabular">{x.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          {item.bins.length > 1 && (
            <Card title="Stock by warehouse">
              <ul className="text-sm divide-y divide-[var(--color-border)] -my-2">
                {item.bins.map((b) => (
                  <li key={b.warehouse} className="py-2 flex justify-between">
                    <span>{friendlyAccountName(b.warehouse, abbr)}</span>
                    <span className="tabular">{num(b.actual)} {unit}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Stock movements">
          {item.movements.length === 0 ? (
            <Empty title="No movements yet" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5 -my-2">
              {item.movements.map((m) => (
                <li key={m.erpnext_name} className="px-5 py-2 flex items-center justify-between gap-3">
                  <div className="text-xs text-[var(--color-ink-muted)] tabular shrink-0 w-24">{date(m.posting_date)}</div>
                  <div className="flex-1 min-w-0 text-xs truncate">
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 mr-1.5">
                      {VOUCHER_LABEL[m.voucher_type] || m.voucher_type}
                    </span>
                    {OPENABLE.has(m.voucher_type) ? (
                      <Link
                        href={`/transactions/${encodeURIComponent(m.voucher_type)}/${encodeURIComponent(m.voucher_no)}`}
                        className="font-mono text-[var(--color-brand-accent)] hover:underline"
                      >
                        {m.voucher_no}
                      </Link>
                    ) : (
                      <span className="font-mono text-slate-500">{m.voucher_no}</span>
                    )}
                  </div>
                  {m.voucher_type === 'Stock Reconciliation' ? (
                    // A stock count sets the balance ("= X") rather than adding to it.
                    <div className="text-sm tabular font-medium text-slate-600">= {num(m.balance_after)} {unit}</div>
                  ) : (
                    <div className={`text-sm tabular font-medium ${m.delta > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
                      {m.delta > 0 ? '+' : '−'}{num(Math.abs(m.delta))} {unit}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Bought / sold">
          {item.sales_appearances.length === 0 && item.purchase_appearances.length === 0 ? (
            <Empty title="No invoices yet" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5 -my-2">
              {[
                ...item.sales_appearances.map((a) => ({ ...a, kind: 'sale' })),
                ...item.purchase_appearances.map((a) => ({ ...a, kind: 'purchase' })),
              ]
                .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
                .slice(0, 12)
                .map((a, i) => (
                  <li key={`${a.kind}-${a.invoice}-${i}`} className="px-5 py-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${a.kind === 'sale' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
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
                      {num(a.qty)} {unit} × {money(a.rate, user.default_currency)}
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

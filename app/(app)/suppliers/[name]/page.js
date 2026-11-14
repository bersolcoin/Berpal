/**
 * /suppliers/[name] — single supplier detail (mirror of customer detail).
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import {
  getCounterpartyDetails,
  getBalanceWithCounterparty,
} from '../../../../src/erp-query';
import PageHeader from '../../_components/PageHeader';
import Card from '../../_components/Card';
import Empty from '../../_components/Empty';
import { money, date, friendlyPartyName } from '../../_components/format';

export const dynamic = 'force-dynamic';

export default async function SupplierDetail({ params }) {
  const { name: nameParam } = await params;
  const supplierName = decodeURIComponent(nameParam);
  const { user, erp } = await getAppContext();

  const [details, balance, history] = await Promise.all([
    getCounterpartyDetails(user, erp, { partyName: supplierName, partyType: 'Supplier' }).catch(() => null),
    getBalanceWithCounterparty(user, erp, { partyType: 'Supplier', partyName: supplierName }).catch(() => null),
    fetchSupplierHistory(erp, supplierName).catch(() => []),
  ]);

  const supplier = details?.supplier;
  if (!supplier) notFound();

  return (
    <>
      <PageHeader back="/suppliers" backLabel="Back to Suppliers"
        title={supplier.display_name || friendlyPartyName(supplierName, user.erpnext_company_abbr)}
        subtitle={
          <span>
            <Link href="/suppliers" className="text-[var(--color-brand-accent)] hover:underline">
              Suppliers
            </Link>
            {supplier.group && <> / {supplier.group}</>}
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Outstanding (AP)</div>
          <BalanceList totals={balance?.totals?.outstandingByCurrency || {}} tone="negative" />
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Advances paid</div>
          <BalanceList totals={balance?.totals?.advancesByCurrency || {}} tone="neutral" />
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Net</div>
          <BalanceList totals={balance?.netByCurrency || {}} tone="negative" />
          <div className="text-[10px] text-[var(--color-ink-muted)] mt-2">positive = you owe them</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Contact" className="lg:col-span-1">
          <dl className="text-sm space-y-2">
            <Row label="Phone" value={supplier.phone} />
            <Row label="Email" value={supplier.email} />
            <Row label="Currency" value={supplier.default_currency} />
            <Row label="Group" value={supplier.group} />
          </dl>
        </Card>

        <Card
          title="Open bills"
          right={<span className="text-xs text-[var(--color-ink-muted)]">{balance?.invoices?.length || 0}</span>}
          className="lg:col-span-2"
        >
          {!balance?.invoices?.length ? (
            <Empty title="No open bills" />
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                    <th className="font-medium pb-2 pl-5 pr-4">Bill</th>
                    <th className="font-medium pb-2 pr-4">Posted</th>
                    <th className="font-medium pb-2 pr-4">Due</th>
                    <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {balance.invoices.map((inv) => (
                    <tr key={inv.erpnext_name} className="group hover:bg-slate-50 transition">
                      <td className="py-2 pl-5 pr-4 whitespace-nowrap">
                        <Link
                          href={`/transactions/${encodeURIComponent('Purchase Invoice')}/${encodeURIComponent(inv.erpnext_name)}`}
                          className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline"
                        >
                          {inv.erpnext_name}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">{date(inv.posting_date)}</td>
                      <td className="py-2 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">{date(inv.due_date)}</td>
                      <td className="py-2 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">{money(inv.outstanding_amount, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="All transactions" className="mt-4">
        {history.length === 0 ? (
          <Empty title="No transaction history" />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Date</th>
                  <th className="font-medium pb-2 pr-4">Type</th>
                  <th className="font-medium pb-2 pr-4">Reference</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {history.map((h) => (
                  <tr key={`${h.doctype}/${h.erpnext_name}`} className="group hover:bg-slate-50 transition">
                    <td className="py-2 pl-5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">{date(h.posting_date)}</td>
                    <td className="py-2 pr-4">
                      <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">{h.kind}</span>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <Link
                        href={`/transactions/${encodeURIComponent(h.doctype)}/${encodeURIComponent(h.erpnext_name)}`}
                        className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline"
                      >
                        {h.erpnext_name}
                      </Link>
                    </td>
                    <td className="py-2 pl-4 pr-5 text-right tabular whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">{money(h.amount, h.currency)}</td>
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

async function fetchSupplierHistory(erp, supplierName) {
  const [pi, pe] = await Promise.all([
    erp.listResource('Purchase Invoice', {
      filters: [['company', '=', erp.company], ['supplier', '=', supplierName], ['docstatus', '!=', 2]],
      fields: ['name', 'posting_date', 'currency', 'grand_total', 'status', 'docstatus'],
      limit: 50,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Payment Entry', {
      filters: [
        ['company', '=', erp.company],
        ['party_type', '=', 'Supplier'],
        ['party', '=', supplierName],
        ['docstatus', '!=', 2],
      ],
      fields: ['name', 'posting_date', 'paid_amount', 'paid_to_account_currency', 'docstatus'],
      limit: 50,
      orderBy: 'posting_date desc, name desc',
    }),
  ]);

  const out = [];
  for (const r of pi.data || []) {
    out.push({
      doctype: 'Purchase Invoice',
      erpnext_name: r.name,
      kind: 'Purchase',
      posting_date: r.posting_date,
      currency: r.currency,
      amount: Number(r.grand_total) || 0,
    });
  }
  for (const r of pe.data || []) {
    out.push({
      doctype: 'Payment Entry',
      erpnext_name: r.name,
      kind: 'Payment',
      posting_date: r.posting_date,
      currency: r.paid_to_account_currency,
      amount: Number(r.paid_amount) || 0,
    });
  }
  out.sort((a, b) => (b.posting_date || '').localeCompare(a.posting_date || ''));
  return out;
}

function BalanceList({ totals, tone }) {
  const entries = Object.entries(totals).filter(([, v]) => Math.abs(v) > 0.005);
  if (entries.length === 0) {
    return <div className="text-2xl font-semibold mt-1.5 tabular text-slate-300">—</div>;
  }
  const toneClass = tone === 'positive' ? 'text-[var(--color-positive)]' : tone === 'negative' ? 'text-[var(--color-negative)]' : 'text-slate-900';
  return (
    <div className="mt-1.5 space-y-0.5">
      {entries.map(([ccy, amt]) => (
        <div key={ccy} className={`text-xl font-semibold tabular ${amt < 0 ? 'text-[var(--color-positive)]' : toneClass}`}>
          {money(amt, ccy)}
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="text-right text-slate-900">{value || <span className="text-slate-300">—</span>}</dd>
    </div>
  );
}

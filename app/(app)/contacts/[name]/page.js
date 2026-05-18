/**
 * /contacts/[name] — unified contact view. Shows AR, AP, and balance, plus
 * open invoices, open bills, and merged transaction history. Replaces the
 * separate /customers/[name] and /suppliers/[name] detail pages for the
 * normal nav path (those URLs still resolve via the old pages).
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

export default async function ContactDetail({ params }) {
  const { name: nameParam } = await params;
  const contactName = decodeURIComponent(nameParam);
  const { user, erp } = await getAppContext();

  const [details, custBalance, supBalance, salesHistory, purchaseHistory, allPayments] =
    await Promise.all([
      getCounterpartyDetails(user, erp, { partyName: contactName, partyType: 'Both' }).catch(() => null),
      getBalanceWithCounterparty(user, erp, { partyType: 'Customer', partyName: contactName }).catch(() => null),
      getBalanceWithCounterparty(user, erp, { partyType: 'Supplier', partyName: contactName }).catch(() => null),
      fetchInvoiceHistory(erp, contactName, 'Sales Invoice', 'customer').catch(() => []),
      fetchInvoiceHistory(erp, contactName, 'Purchase Invoice', 'supplier').catch(() => []),
      fetchPaymentHistory(erp, contactName).catch(() => []),
    ]);

  const customer = details?.customer;
  const supplier = details?.supplier;
  if (!customer && !supplier) notFound();

  const displayName = customer?.display_name || supplier?.display_name || contactName;
  const phone = customer?.phone || supplier?.phone;
  const email = customer?.email || supplier?.email;
  const defaultCurrency = customer?.default_currency || supplier?.default_currency;
  const group = customer?.group || supplier?.group;

  const ar = custBalance?.totals?.outstandingByCurrency || {};
  const ap = supBalance?.totals?.outstandingByCurrency || {};
  const balance = computeBalance(ar, ap);

  const history = mergeHistory([
    ...salesHistory.map((s) => ({ ...s, kind: 'Invoice', doctype: 'Sales Invoice' })),
    ...purchaseHistory.map((p) => ({ ...p, kind: 'Purchase', doctype: 'Purchase Invoice' })),
    ...allPayments,
  ]);

  return (
    <>
      <PageHeader
        title={friendlyPartyName(displayName)}
        subtitle={
          <span>
            <Link href="/contacts" className="text-[var(--color-brand-accent)] hover:underline">Contacts</Link>
            {group && <> / {group}</>}
            <RoleBadgesInline hasCustomer={!!customer} hasSupplier={!!supplier} />
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">AR — they owe you</div>
          <BalanceList totals={ar} tone="positive" />
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">AP — you owe them</div>
          <BalanceList totals={ap} tone="negative" />
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Net balance</div>
          <BalanceList totals={balance} tone="balance" />
          <div className="text-[10px] text-[var(--color-ink-muted)] mt-2">positive = net receivable from them</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Contact" className="lg:col-span-1">
          <dl className="text-sm space-y-2">
            <Row label="Phone" value={phone} />
            <Row label="Email" value={email} />
            <Row label="Currency" value={defaultCurrency} />
            <Row label="Group" value={group} />
          </dl>
        </Card>

        <Card
          title="Open invoices (AR)"
          right={<span className="text-xs text-[var(--color-ink-muted)]">{custBalance?.invoices?.length || 0}</span>}
          className="lg:col-span-1"
        >
          {!custBalance?.invoices?.length ? (
            <Empty title="None open" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5">
              {custBalance.invoices.map((inv) => (
                <li key={inv.erpnext_name} className="px-5 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 transition">
                  <Link
                    href={`/transactions/${encodeURIComponent('Sales Invoice')}/${encodeURIComponent(inv.erpnext_name)}`}
                    className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline truncate"
                  >
                    {inv.erpnext_name}
                  </Link>
                  <span className="tabular text-sm font-medium text-[var(--color-positive)] shrink-0">
                    {money(inv.outstanding_amount, inv.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Open bills (AP)"
          right={<span className="text-xs text-[var(--color-ink-muted)]">{supBalance?.invoices?.length || 0}</span>}
          className="lg:col-span-1"
        >
          {!supBalance?.invoices?.length ? (
            <Empty title="None open" />
          ) : (
            <ul className="text-sm divide-y divide-[var(--color-border)] -mx-5">
              {supBalance.invoices.map((inv) => (
                <li key={inv.erpnext_name} className="px-5 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 transition">
                  <Link
                    href={`/transactions/${encodeURIComponent('Purchase Invoice')}/${encodeURIComponent(inv.erpnext_name)}`}
                    className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline truncate"
                  >
                    {inv.erpnext_name}
                  </Link>
                  <span className="tabular text-sm font-medium text-[var(--color-negative)] shrink-0">
                    {money(inv.outstanding_amount, inv.currency)}
                  </span>
                </li>
              ))}
            </ul>
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
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {history.map((h) => (
                  <tr key={`${h.doctype}/${h.erpnext_name}`} className="group hover:bg-slate-50 transition">
                    <td className="py-2 pl-5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap text-xs">
                      {date(h.posting_date)}
                    </td>
                    <td className="py-2 pr-4">
                      <KindBadge kind={h.kind} />
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <Link
                        href={`/transactions/${encodeURIComponent(h.doctype)}/${encodeURIComponent(h.erpnext_name)}`}
                        className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline"
                      >
                        {h.erpnext_name}
                      </Link>
                    </td>
                    <td className={`py-2 pl-4 pr-5 text-right tabular whitespace-nowrap font-medium sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${signClass(h.kind)}`}>
                      {money(h.amount, h.currency)}
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

// ─── Data helpers ────────────────────────────────────────────────────

async function fetchInvoiceHistory(erp, partyName, doctype, partyField) {
  const r = await erp.listResource(doctype, {
    filters: [['company', '=', erp.company], [partyField, '=', partyName], ['docstatus', '!=', 2]],
    fields: ['name', 'posting_date', 'currency', 'grand_total', 'status', 'docstatus'],
    limit: 50,
    orderBy: 'posting_date desc, name desc',
  });
  return (r.data || []).map((row) => ({
    erpnext_name: row.name,
    posting_date: row.posting_date,
    currency: row.currency,
    amount: Number(row.grand_total) || 0,
    status: row.docstatus === 0 ? 'Draft' : row.status,
  }));
}

async function fetchPaymentHistory(erp, partyName) {
  // Payment Entry can be either Customer or Supplier party; fetch both.
  const [cust, sup] = await Promise.all([
    erp.listResource('Payment Entry', {
      filters: [
        ['company', '=', erp.company],
        ['party_type', '=', 'Customer'],
        ['party', '=', partyName],
        ['docstatus', '!=', 2],
      ],
      fields: ['name', 'posting_date', 'paid_amount', 'paid_from_account_currency', 'docstatus'],
      limit: 50,
      orderBy: 'posting_date desc, name desc',
    }).then((r) => (r.data || []).map((p) => ({
      erpnext_name: p.name,
      doctype: 'Payment Entry',
      kind: 'Receipt',
      posting_date: p.posting_date,
      currency: p.paid_from_account_currency,
      amount: Number(p.paid_amount) || 0,
    }))).catch(() => []),
    erp.listResource('Payment Entry', {
      filters: [
        ['company', '=', erp.company],
        ['party_type', '=', 'Supplier'],
        ['party', '=', partyName],
        ['docstatus', '!=', 2],
      ],
      fields: ['name', 'posting_date', 'paid_amount', 'paid_to_account_currency', 'docstatus'],
      limit: 50,
      orderBy: 'posting_date desc, name desc',
    }).then((r) => (r.data || []).map((p) => ({
      erpnext_name: p.name,
      doctype: 'Payment Entry',
      kind: 'Payment',
      posting_date: p.posting_date,
      currency: p.paid_to_account_currency,
      amount: Number(p.paid_amount) || 0,
    }))).catch(() => []),
  ]);
  return [...cust, ...sup];
}

function mergeHistory(arr) {
  return arr.sort((a, b) => (b.posting_date || '').localeCompare(a.posting_date || ''));
}

function computeBalance(ar, ap) {
  const out = {};
  const all = new Set([...Object.keys(ar), ...Object.keys(ap)]);
  for (const ccy of all) {
    const net = (ar[ccy] || 0) - (ap[ccy] || 0);
    if (Math.abs(net) > 0.005) out[ccy] = net;
  }
  return out;
}

// ─── Tiny presentational helpers ─────────────────────────────────────

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="text-right text-slate-900">{value || <span className="text-slate-300">—</span>}</dd>
    </div>
  );
}

function BalanceList({ totals, tone }) {
  const entries = Object.entries(totals || {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (entries.length === 0) {
    return <div className="text-2xl font-semibold mt-1.5 tabular text-slate-300">—</div>;
  }
  return (
    <div className="mt-1.5 space-y-0.5">
      {entries.map(([ccy, amt]) => {
        let cls = 'text-slate-900';
        if (tone === 'positive') cls = 'text-[var(--color-positive)]';
        if (tone === 'negative') cls = 'text-[var(--color-negative)]';
        if (tone === 'balance') cls = amt < 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]';
        return (
          <div key={ccy} className={`text-xl font-semibold tabular ${cls}`}>
            {money(amt, ccy)}
          </div>
        );
      })}
    </div>
  );
}

function RoleBadgesInline({ hasCustomer, hasSupplier }) {
  // Dual-sided is the default — only flag single-sided contacts.
  if (hasCustomer && hasSupplier) return null;
  if (hasCustomer) {
    return <span className="ml-2 inline-block text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Customer only</span>;
  }
  if (hasSupplier) {
    return <span className="ml-2 inline-block text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Supplier only</span>;
  }
  return null;
}

function KindBadge({ kind }) {
  const map = {
    Invoice: 'bg-blue-100 text-blue-700',
    Purchase: 'bg-orange-100 text-orange-700',
    Receipt: 'bg-green-100 text-green-700',
    Payment: 'bg-amber-100 text-amber-700',
  };
  return (
    <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${map[kind] || 'bg-slate-100 text-slate-700'}`}>
      {kind}
    </span>
  );
}

function signClass(kind) {
  if (kind === 'Invoice' || kind === 'Receipt') return 'text-[var(--color-positive)]';
  if (kind === 'Purchase' || kind === 'Payment') return 'text-[var(--color-negative)]';
  return 'text-slate-700';
}

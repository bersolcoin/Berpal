/**
 * /customers — list of all customers with their open AR balance.
 * Click a row to drill into customer detail (open invoices, ledger).
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listCustomersWithAR } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import { money } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const { user, erp } = await getAppContext();
  const customers = await listCustomersWithAR(user, erp);

  return (
    <>
      <PageHeader back="/contacts" backLabel="Back to Contacts"
        title="Customers"
        subtitle="People who owe you money. Customers with open invoices appear first."
      />

      <Card>
        {customers.length === 0 ? (
          <Empty
            title="No customers yet"
            hint="Tell the bot about a sale and it will create the customer for you."
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Customer</th>
                  <th className="font-medium pb-2 pr-4">Phone</th>
                  <th className="font-medium pb-2 pr-4 text-right">Open invoices</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {customers.map((c) => (
                  <tr key={c.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="flex items-center gap-2 max-w-[300px]">
                        <Link
                          href={`/customers/${encodeURIComponent(c.erpnext_name)}`}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)] font-medium truncate"
                          title={c.customer_name}
                        >
                          {c.customer_name}
                        </Link>
                        {c.linked_user_id && (
                          <span
                            className="shrink-0 text-[11px] leading-none font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                            title="This customer is also a Berpal user — transactions can auto-mirror with their account."
                            aria-label="Linked Berpal user"
                          >
                            ⇄
                          </span>
                        )}
                        {c.default_currency && (
                          <span className="shrink-0 text-[10px] text-[var(--color-ink-muted)] uppercase tracking-wide">{c.default_currency}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">{c.mobile_no || '—'}</td>
                    <td className="py-2.5 pr-4 text-right tabular text-[var(--color-ink-muted)]">
                      {c.open_invoice_count > 0 ? c.open_invoice_count : ''}
                    </td>
                    <td className="py-2.5 pl-4 pr-5 text-right whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                      <BalanceCell totals={c.outstanding_by_currency} />
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

function BalanceCell({ totals }) {
  const entries = Object.entries(totals).filter(([, v]) => Math.abs(v) > 0.005);
  if (entries.length === 0) return <span className="text-[var(--color-ink-muted)]">—</span>;
  return (
    <div className="space-y-0.5">
      {entries.map(([ccy, amt]) => (
        <div key={ccy} className="tabular text-[var(--color-positive)] font-medium">
          {money(amt, ccy)}
        </div>
      ))}
    </div>
  );
}

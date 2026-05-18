/**
 * /contacts — unified Customers + Suppliers, with AR, AP, and Balance
 * columns. Click a row to drill into the contact detail.
 *
 * Replaces the separate /customers and /suppliers nav items (those URLs
 * still resolve as filtered views via the legacy pages).
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listContacts } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import SearchBox from '../_components/SearchBox';
import { money } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function ContactsPage({ searchParams }) {
  const params = (await searchParams) || {};
  const q = typeof params.q === 'string' ? params.q : '';
  const { user, erp } = await getAppContext();
  const contacts = await listContacts(user, erp, { q });

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle="Everyone you do business with — customers, suppliers, or both."
        right={<SearchBox placeholder="Search contacts…" />}
      />

      <Card>
        {contacts.length === 0 ? (
          <Empty
            title={q ? 'No matches' : 'No contacts yet'}
            hint={q ? `No contacts match "${q}". Try a different spelling.` : 'Tell the bot about a sale or purchase and it will create the contact for you.'}
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Contact</th>
                  <th className="font-medium pb-2 pr-4">Phone</th>
                  <th className="font-medium pb-2 pr-4 text-right">AR</th>
                  <th className="font-medium pb-2 pr-4 text-right">AP</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {contacts.map((c) => (
                  <tr key={c.key} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="flex items-center gap-2 max-w-[300px]">
                        <Link
                          href={`/contacts/${encodeURIComponent(c.display_name)}`}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)] font-medium truncate"
                          title={c.display_name}
                        >
                          {c.display_name}
                        </Link>
                        <RoleBadges contact={c} />
                        {c.linked_user_id && (
                          <span
                            className="shrink-0 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                            title="This contact is also a Berpal user — transactions auto-mirror via WhatsApp."
                          >
                            ⇄ Linked
                          </span>
                        )}
                        {c.default_currency && (
                          <span className="shrink-0 text-[10px] text-[var(--color-ink-muted)] uppercase tracking-wide">
                            {c.default_currency}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">
                      {c.phone || '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <CurrencyStack totals={c.ar_by_currency} tone="positive" />
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <CurrencyStack totals={c.ap_by_currency} tone="negative" />
                    </td>
                    <td className="py-2.5 pl-4 pr-5 text-right whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
                      <CurrencyStack totals={c.balance_by_currency} tone="balance" />
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

/**
 * Role badge — only shown when a contact is SINGLE-sided (Customer-only
 * or Supplier-only). Dual-sided is the default now (eager creation), so
 * surfacing "Both" everywhere would be visual noise.
 */
function RoleBadges({ contact }) {
  const hasCustomer = !!contact.customer_erpnext_name;
  const hasSupplier = !!contact.supplier_erpnext_name;
  if (hasCustomer && hasSupplier) return null;
  if (hasCustomer) {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
        Customer only
      </span>
    );
  }
  if (hasSupplier) {
    return (
      <span className="shrink-0 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
        Supplier only
      </span>
    );
  }
  return null;
}

function CurrencyStack({ totals, tone }) {
  const entries = Object.entries(totals || {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (entries.length === 0) return <span className="text-[var(--color-ink-muted)]">—</span>;
  return (
    <div className="space-y-0.5">
      {entries.map(([ccy, amt]) => {
        let cls = 'text-slate-700';
        if (tone === 'positive') cls = 'text-[var(--color-positive)] font-medium';
        if (tone === 'negative') cls = 'text-[var(--color-negative)] font-medium';
        if (tone === 'balance') {
          cls = amt < 0
            ? 'text-[var(--color-negative)] font-medium'
            : 'text-[var(--color-positive)] font-medium';
        }
        return (
          <div key={ccy} className={`tabular ${cls}`}>
            {money(amt, ccy)}
          </div>
        );
      })}
    </div>
  );
}

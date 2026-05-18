/**
 * Overview — at-a-glance dashboard. Three cards across the top (cash, AR,
 * AP totals) and a recent activity feed underneath.
 *
 * All read-only. The bot is the write path; if numbers look wrong, the user
 * fixes them by talking to the bot, not by editing here.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { convertToBase } from '../_lib/convert';
import {
  getCashBankBalance,
  listCustomersWithAR,
  listSuppliersWithAP,
  listRecentTransactions,
} from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import TransactionsTable from '../_components/TransactionsTable';
import { money, compactMoney, Flag } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { user, erp } = await getAppContext();
  const base = user.default_currency || 'USD';

  const [cash, customers, suppliers, recent] = await Promise.all([
    getCashBankBalance(user, erp).catch(() => ({ wallets: [], totals_by_currency: {} })),
    listCustomersWithAR(user, erp).catch(() => []),
    listSuppliersWithAP(user, erp).catch(() => []),
    listRecentTransactions(user, erp, { limit: 10 }).catch(() => ({ rows: [], hasMore: false })),
  ]);

  const arByCurrency = sumByCurrency(customers, 'outstanding_by_currency');
  const apByCurrency = sumByCurrency(suppliers, 'outstanding_by_currency');

  const [cashStat, arStat, apStat] = await Promise.all([
    convertToBase(cash.totals_by_currency || {}, base),
    convertToBase(arByCurrency, base),
    convertToBase(apByCurrency, base),
  ]);

  return (
    <>
      <PageHeader
        title={`Hi${user.display_name ? `, ${user.display_name.split(' ')[0]}` : ''}`}
        subtitle="A snapshot of your cash, who owes you, and what you owe."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Stat title="Cash & bank" subtitle="Across all wallets" stat={cashStat} base={base} href="/wallets" tone="neutral" />
        <Stat title="Receivables" subtitle="Customers owe you" stat={arStat} base={base} href="/customers" tone="positive" />
        <Stat title="Payables" subtitle="You owe suppliers" stat={apStat} base={base} href="/suppliers" tone="negative" />
      </div>

      <Card
        title="Recent activity"
        right={
          <Link href="/transactions" className="text-xs text-[var(--color-brand-accent)] hover:underline">
            View all →
          </Link>
        }
      >
        {recent.rows.length === 0 ? (
          <Empty title="No transactions yet" hint="Try messaging the bot on WhatsApp to record your first sale or expense." />
        ) : (
          <TransactionsTable rows={recent.rows} defaultCurrency={base} />
        )}
      </Card>
    </>
  );
}

function sumByCurrency(rows, field) {
  const out = {};
  for (const r of rows || []) {
    for (const [ccy, amt] of Object.entries(r[field] || {})) {
      out[ccy] = (out[ccy] || 0) + amt;
    }
  }
  return out;
}

function Stat({ title, subtitle, stat, base, href, tone }) {
  const toneClass =
    tone === 'positive'
      ? 'text-[var(--color-positive)]'
      : tone === 'negative'
      ? 'text-[var(--color-negative)]'
      : 'text-slate-900';

  // Show every currency in the breakdown (including base) so the user can
  // always see the raw numbers behind the headline. Sort base first.
  const breakdown = Object.entries(stat.perCurrency || {})
    .filter(([, v]) => Math.abs(v) > 0.005)
    .sort(([a], [b]) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  const empty = breakdown.length === 0;

  return (
    <Link
      href={href}
      className="block bg-white border border-[var(--color-border)] rounded-xl p-5 hover:shadow-sm hover:border-slate-300 transition"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <span className="text-xs text-[var(--color-ink-muted)]">→</span>
      </div>
      {subtitle && <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">{subtitle}</p>}

      <div className="mt-3">
        {empty ? (
          <div className="text-3xl font-semibold text-slate-300 tabular">—</div>
        ) : (
          <div className={`text-3xl font-semibold tabular ${toneClass}`}>
            {compactMoney(stat.value, base, { approx: stat.isApprox })}
          </div>
        )}

        {breakdown.length > 0 && (
          <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
            <ul className="space-y-1.5">
              {breakdown.map(([ccy, amt]) => (
                <li key={ccy} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Flag currency={ccy} className="w-5 h-5 shrink-0" />
                    <span className="text-[var(--color-ink-muted)] font-medium tracking-wide">{ccy}</span>
                  </span>
                  <span className={`tabular font-medium ${amt < 0 ? 'text-[var(--color-negative)]' : 'text-slate-700'}`}>
                    {money(amt, ccy)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Link>
  );
}


/**
 * /expenses — where the money is going. Lists all leaf Expense accounts
 * with the period-to-date amount spent in each. Click any row to drill
 * into the ledger for that expense category.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { convertToBase } from '../_lib/convert';
import { getExpenseSummary } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import { money, compactMoney, accountUrl, friendlyAccountName, Flag } from '../_components/format';

export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  const { user, erp } = await getAppContext();
  const base = user.default_currency || 'USD';

  const { accounts, totals_by_currency } = await getExpenseSummary(user, erp);
  const totalStat = await convertToBase(totals_by_currency, base);

  // Show only accounts with non-zero spend by default; users can drill into
  // empty categories from the chart of accounts if they need to.
  const active = accounts.filter((a) => Math.abs(a.balance) > 0.005);

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Operating expenses only — cost of goods sold lives under Accounts as it sits above the gross-profit line."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Total spent</div>
          {totalStat.value < 0.005 && Object.keys(totalStat.perCurrency).length === 0 ? (
            <div className="text-3xl font-semibold text-slate-300 tabular mt-2">—</div>
          ) : (
            <div className="text-3xl font-semibold text-[var(--color-negative)] tabular mt-2">
              {compactMoney(totalStat.value, base, { approx: totalStat.isApprox })}
            </div>
          )}
          {Object.keys(totals_by_currency).length > 0 && (
            <div className="mt-4 pt-3 border-t border-[var(--color-border)] space-y-1.5">
              {Object.entries(totals_by_currency).map(([ccy, amt]) => (
                <div key={ccy} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Flag currency={ccy} className="w-5 h-5 shrink-0" />
                    <span className="text-[var(--color-ink-muted)] font-medium tracking-wide">{ccy}</span>
                  </span>
                  <span className="tabular font-medium text-slate-700">{money(amt, ccy)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Active categories</div>
          <div className="text-3xl font-semibold mt-2 tabular text-slate-900">{active.length}</div>
          <div className="text-xs text-[var(--color-ink-muted)] mt-1">out of {accounts.length} total</div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Largest single spend</div>
          {active.length === 0 ? (
            <div className="text-3xl font-semibold text-slate-300 tabular mt-2">—</div>
          ) : (
            <>
              <div className="text-xl font-semibold mt-2 text-slate-900 truncate">
                {friendlyAccountName(active[0].erpnext_name)}
              </div>
              <div className="text-sm text-[var(--color-ink-muted)] mt-1 tabular">
                {money(active[0].balance, active[0].currency)}
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title="By category" right={<span className="text-xs text-[var(--color-ink-muted)]">Largest first</span>}>
        {accounts.length === 0 ? (
          <Empty
            title="No expense categories yet"
            hint="Categories appear as soon as you record an expense — tell the bot something like “paid 500 thb for electricity”."
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Category</th>
                  <th className="font-medium pb-2 pr-4">Code</th>
                  <th className="font-medium pb-2 pr-4">Currency</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {accounts.map((a) => (
                  <tr key={a.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="max-w-[260px] truncate">
                        <Link
                          href={accountUrl(a)}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)] font-medium"
                          title={friendlyAccountName(a.erpnext_name)}
                        >
                          {friendlyAccountName(a.erpnext_name) || a.account_name}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-xs font-mono text-[var(--color-ink-muted)]">{a.account_number || '—'}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)]">{a.currency}</td>
                    <td className={`py-2.5 pl-4 pr-5 text-right tabular whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${
                      Math.abs(a.balance) < 0.005 ? 'text-slate-300 font-normal' : 'text-[var(--color-negative)] font-medium'
                    }`}>
                      {Math.abs(a.balance) < 0.005 ? '—' : money(a.balance, a.currency)}
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

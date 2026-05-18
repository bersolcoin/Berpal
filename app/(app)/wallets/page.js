/**
 * /wallets — Cash, Bank and Credit Card accounts with current balance.
 * Click a row to drill into the ledger view (/accounts/[name]).
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { getCashBankBalance } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import { money, friendlyAccountName, accountUrl } from '../_components/format';

export const dynamic = 'force-dynamic';

const TYPE_BADGE = {
  Cash: 'bg-green-100 text-green-700',
  Bank: 'bg-blue-100 text-blue-700',
  'Credit Card': 'bg-amber-100 text-amber-700',
};

export default async function WalletsPage() {
  const { user, erp } = await getAppContext();
  const { wallets, totals_by_currency } = await getCashBankBalance(user, erp);

  return (
    <>
      <PageHeader
        title="Wallets"
        subtitle="Cash, bank and credit card accounts. Tap any wallet to see its ledger."
      />

      {Object.keys(totals_by_currency).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {Object.entries(totals_by_currency).map(([ccy, amt]) => (
            <Card key={ccy}>
              <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Total {ccy}</div>
              <div className={`text-xl font-semibold mt-1.5 tabular ${amt < 0 ? 'text-[var(--color-negative)]' : 'text-slate-900'}`}>
                {money(amt, ccy)}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card>
        {wallets.length === 0 ? (
          <Empty
            title="No wallets yet"
            hint='Tell the bot "create a cash wallet in USD" or it will be auto-created on your first transaction.'
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Wallet</th>
                  <th className="font-medium pb-2 pr-4">Type</th>
                  <th className="font-medium pb-2 pr-4">Currency</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {wallets.map((w) => (
                  <tr key={w.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2.5 pl-5 pr-4">
                      <div className="max-w-[260px] truncate">
                        <Link
                          href={accountUrl(w)}
                          className="text-slate-900 hover:text-[var(--color-brand-accent)]"
                          title={friendlyAccountName(w.erpnext_name) || w.account_name}
                        >
                          {friendlyAccountName(w.erpnext_name) || w.account_name}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${TYPE_BADGE[w.account_type] || 'bg-slate-100 text-slate-700'}`}>
                        {w.account_type}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-muted)]">{w.currency}</td>
                    <td className={`py-2.5 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${w.balance < 0 ? 'text-[var(--color-negative)]' : 'text-slate-900'}`}>
                      {money(w.balance, w.currency)}
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

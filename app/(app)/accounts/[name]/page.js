/**
 * /accounts/[name] — General Ledger view for a single account.
 *
 * Works for any account: wallets, expense buckets, AR control, AP control,
 * income categories, equity. Shows opening balance, running balance through
 * each entry, and links each entry back to its source voucher.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import { getAccountLedger, resolveAccountParam } from '../../../../src/erp-query';
import PageHeader from '../../_components/PageHeader';
import Card from '../../_components/Card';
import Empty from '../../_components/Empty';
import { money, date, friendlyAccountName, friendlyAccountList } from '../../_components/format';

export const dynamic = 'force-dynamic';

export default async function AccountLedgerPage({ params }) {
  const { name: nameParam } = await params;
  const rawParam = decodeURIComponent(nameParam);
  const { user, erp } = await getAppContext();

  // Param may be an account number (clean URL) or a full ERPNext name.
  // resolveAccountParam handles both.
  const accountName = await resolveAccountParam(erp, rawParam);
  if (!accountName) notFound();

  let ledger;
  try {
    ledger = await getAccountLedger(user, erp, { accountName, limit: 200 });
  } catch (err) {
    if (err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <PageHeader back="/accounts" backLabel="Back to Accounts"
        title={friendlyAccountName(ledger.account, user.erpnext_company_abbr) || ledger.account_name}
        subtitle={
          <span>
            <Link href="/accounts" className="text-[var(--color-brand-accent)] hover:underline">
              Chart of accounts
            </Link>
            {' / '}
            <span>{ledger.account_type || ledger.root_type}</span>
            {ledger.currency && <span className="ml-2 text-xs">({ledger.currency})</span>}
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Current balance</div>
          <div className={`text-2xl font-semibold mt-1.5 tabular ${ledger.closing_balance < 0 ? 'text-[var(--color-negative)]' : 'text-slate-900'}`}>
            {money(ledger.closing_balance, ledger.currency || user.default_currency)}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Opening (before shown entries)</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-700">
            {money(ledger.opening_balance, ledger.currency || user.default_currency)}
          </div>
        </Card>
        <Card>
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Entries</div>
          <div className="text-2xl font-semibold mt-1.5 tabular text-slate-700">{ledger.entries.length}</div>
        </Card>
      </div>

      <Card title="Ledger entries" right={<span className="text-xs text-[var(--color-ink-muted)]">Newest first</span>}>
        {ledger.entries.length === 0 ? (
          <Empty title="No entries yet" hint="This account hasn't been used in any transaction." />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  <th className="font-medium pb-2 pl-5 pr-4">Date</th>
                  <th className="font-medium pb-2 pr-4">Voucher</th>
                  <th className="font-medium pb-2 pr-4">Against</th>
                  <th className="font-medium pb-2 pr-4 text-right">Debit</th>
                  <th className="font-medium pb-2 pr-4 text-right">Credit</th>
                  <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {ledger.entries.map((e) => (
                  <tr key={e.erpnext_name} className="group hover:bg-slate-50 transition">
                    <td className="py-2 pl-5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">{date(e.posting_date)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <Link
                        href={`/transactions/${encodeURIComponent(e.voucher_type)}/${encodeURIComponent(e.voucher_no)}`}
                        className="font-mono text-xs text-[var(--color-brand-accent)] hover:underline"
                      >
                        {e.voucher_no}
                      </Link>
                      <div className="text-[10px] text-[var(--color-ink-muted)] uppercase tracking-wide">{e.voucher_type}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-600 max-w-xs truncate" title={friendlyAccountList(e.against, user.erpnext_company_abbr)}>
                      {friendlyAccountList(e.against, user.erpnext_company_abbr) || '—'}
                    </td>
                    <td className="py-2 pr-4 text-right tabular text-slate-700 whitespace-nowrap">
                      {e.debit ? money(e.debit, ledger.currency || user.default_currency) : ''}
                    </td>
                    <td className="py-2 pr-4 text-right tabular text-slate-700 whitespace-nowrap">
                      {e.credit ? money(e.credit, ledger.currency || user.default_currency) : ''}
                    </td>
                    <td className={`py-2 pl-4 pr-5 text-right tabular font-medium whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${e.balance < 0 ? 'text-[var(--color-negative)]' : 'text-slate-900'}`}>
                      {money(e.balance, ledger.currency || user.default_currency)}
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

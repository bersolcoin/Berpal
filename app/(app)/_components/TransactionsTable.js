/**
 * Shared transactions table — used by /transactions (full) and the
 * dashboard's recent-activity card (truncated). Pass an array of normalized
 * rows from listRecentTransactions().
 */

import Link from 'next/link';
import { money, date, friendlyPartyName } from './format';

export default function TransactionsTable({ rows, defaultCurrency }) {
  return (
    <div className="overflow-x-auto -mx-5">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            <th className="font-medium pb-2 pl-5 pr-4">Date</th>
            <th className="font-medium pb-2 pr-4">Type</th>
            <th className="font-medium pb-2 pr-4">Party / Memo</th>
            <th className="font-medium pb-2 pr-4">Reference</th>
            <th className="font-medium pb-2 pl-4 pr-5 text-right sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)]">
              Amount
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((t) => (
            <tr key={`${t.doctype}/${t.erpnext_name}`} className="group hover:bg-slate-50 transition">
              <td className="py-2.5 pl-5 pr-4 text-[var(--color-ink-muted)] tabular whitespace-nowrap">
                {date(t.posting_date)}
              </td>
              <td className="py-2.5 pr-4">
                <KindBadge kind={t.kind} />
              </td>
              <td className="py-2.5 pr-4">
                <div className="max-w-[240px] truncate">
                  <Link
                    href={`/transactions/${encodeURIComponent(t.doctype)}/${encodeURIComponent(t.erpnext_name)}`}
                    className="text-slate-900 hover:text-[var(--color-brand-accent)]"
                    title={friendlyPartyName(t.party) || t.raw?.title || ''}
                  >
                    {friendlyPartyName(t.party) || t.raw?.title || '—'}
                  </Link>
                </div>
              </td>
              <td className="py-2.5 pr-4 text-xs text-[var(--color-ink-muted)] font-mono whitespace-nowrap">
                {t.erpnext_name}
              </td>
              <td
                className={`py-2.5 pl-4 pr-5 text-right tabular whitespace-nowrap sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${signClass(
                  t.kind
                )}`}
              >
                {t.currency ? money(t.amount, t.currency) : money(t.amount, defaultCurrency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindBadge({ kind }) {
  const map = {
    Invoice: 'bg-blue-100 text-blue-700',
    Purchase: 'bg-orange-100 text-orange-700',
    Expense: 'bg-rose-100 text-rose-700',
    Receipt: 'bg-green-100 text-green-700',
    Payment: 'bg-amber-100 text-amber-700',
    Cash: 'bg-slate-100 text-slate-700',
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${
        map[kind] || 'bg-slate-100 text-slate-700'
      }`}
    >
      {kind}
    </span>
  );
}

function signClass(kind) {
  if (kind === 'Receipt' || kind === 'Invoice') return 'text-[var(--color-positive)]';
  if (kind === 'Payment' || kind === 'Expense' || kind === 'Purchase') return 'text-[var(--color-negative)]';
  return 'text-slate-700';
}

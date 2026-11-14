/**
 * Shared transactions table — used by /transactions (full) and the
 * dashboard's recent-activity card (truncated). Pass an array of normalized
 * rows from listRecentTransactions().
 *
 * From | → | To columns: the accounts or party value moved between
 * (credit → debit). Amounts are signed and coloured from the company's
 * view: green + money in, red − money out, grey for transfers between
 * wallets.
 */

import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { money, date, friendlyPartyName, friendlyTitle, friendlyAccountName } from './format';

export default function TransactionsTable({ rows, defaultCurrency, abbr = null }) {
  return (
    <div className="overflow-x-auto -mx-5">
      {/* Fixed layout: From and To share equal widths; long names truncate with "…". */}
      <table className="w-full min-w-[760px] text-sm table-fixed">
        <colgroup>
          <col className="w-32" />
          <col className="w-24" />
          <col />
          <col className="w-8" />
          <col />
          <col className="w-40" />
          <col className="w-40" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            <th className="font-medium pb-2 pl-5 pr-4">Date</th>
            <th className="font-medium pb-2 px-2 text-center">Type</th>
            <th className="font-medium pb-2 pr-2">From</th>
            <th className="pb-2" aria-label="to"></th>
            <th className="font-medium pb-2 pl-2 pr-4">To</th>
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
              <td className="py-2.5 px-2 text-center">
                <KindBadge kind={t.kind} />
              </td>
              <FlowCells t={t} abbr={abbr} />
              <td className="py-2.5 pr-4 text-xs text-[var(--color-ink-muted)] font-mono whitespace-nowrap overflow-hidden text-ellipsis">
                {t.erpnext_name}
              </td>
              <td
                className={`py-2.5 pl-4 pr-5 text-right tabular whitespace-nowrap font-medium sticky right-0 bg-white group-hover:bg-slate-50 shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.06)] ${
                  DIRECTION[t.direction]?.className || DIRECTION.neutral.className
                }`}
              >
                {DIRECTION[t.direction]?.sign || ''}
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

// Company point of view: money in (+, green), out (−, red), moved between
// own wallets or non-cash (no sign, grey).
const DIRECTION = {
  in: { sign: '+ ', className: 'text-[var(--color-positive)]' },
  out: { sign: '− ', className: 'text-[var(--color-negative)]' },
  transfer: { sign: '', className: 'text-slate-500' },
  neutral: { sign: '', className: 'text-slate-700' },
};

/** Names in a flow side: first one, "+N" when several. */
function sideLabel(names, abbr) {
  if (!names?.length) return '—';
  const first = friendlyAccountName(names[0], abbr);
  return names.length > 1 ? `${first} +${names.length - 1}` : first;
}

/** From | → | To cells; both names link to the transaction. */
function FlowCells({ t, abbr }) {
  const href = `/transactions/${encodeURIComponent(t.doctype)}/${encodeURIComponent(t.erpnext_name)}`;
  const flow = t.flow || {};
  const hasFlow = flow.from?.length || flow.to?.length;
  // Rows without a known flow fall back to party / title in From.
  const from = hasFlow ? sideLabel(flow.from, abbr) : friendlyPartyName(t.party, abbr) || friendlyTitle(t.raw?.title, abbr) || '—';
  const to = hasFlow ? sideLabel(flow.to, abbr) : '—';
  const link = 'block truncate text-slate-900 hover:text-[var(--color-brand-accent)]';
  return (
    <>
      <td className="py-2.5 pr-2 overflow-hidden">
        <Link href={href} className={link} title={from}>{from}</Link>
      </td>
      <td className="py-2.5 text-center">
        <ArrowRight size={13} className="inline-block text-slate-400" aria-label="to" />
      </td>
      <td className="py-2.5 pl-2 pr-4 overflow-hidden">
        <Link href={href} className={link} title={to}>{to}</Link>
      </td>
    </>
  );
}

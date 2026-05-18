'use client';

/**
 * One inbox row — invoice proposed by a seller, awaiting buyer's
 * Accept / Decline. On either action, calls the API and removes itself
 * from the list (via router.refresh()).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { money, date, friendlyPartyName } from '../_components/format';

export default function InboxItem({ link }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // 'accepted' | 'rejected' | null
  const [error, setError] = useState('');

  async function act(action) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/links/${link.id}/${action}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not complete.');
        return;
      }
      setResult(action === 'confirm' ? 'accepted' : 'rejected');
      // Let the toast linger briefly, then refresh the list.
      setTimeout(() => router.refresh(), 1200);
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div
        className={`p-4 rounded-xl border ${
          result === 'accepted'
            ? 'border-emerald-200 bg-emerald-50'
            : 'border-slate-200 bg-slate-50'
        }`}
      >
        <p className="text-sm">
          {result === 'accepted'
            ? `✅ Added to your books. Refreshing…`
            : `Declined. Refreshing…`}
        </p>
      </div>
    );
  }

  const sellerLabel =
    friendlyPartyName(link.seller.company) || link.seller.name || 'A Berpal user';
  const items = Array.isArray(link.items) ? link.items : [];

  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900">From {sellerLabel}</div>
          <div className="text-xs text-[var(--color-ink-muted)]">
            Their ref: <span className="font-mono">{link.sellerDocName}</span> · proposed {date(link.proposedAt)}
          </div>
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
          LINK-{link.id}
        </span>
      </header>

      <div className="px-5 py-3">
        {items.length === 0 ? (
          <p className="text-sm text-slate-700">Amount: <span className="tabular font-medium">{money(link.totalAmount, link.currency)}</span></p>
        ) : (
          <ul className="text-sm space-y-1">
            {items.map((it, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-slate-700 truncate">
                  <span className="tabular">{it.qty}×</span> {it.description}
                </span>
                <span className="tabular text-slate-600 shrink-0">
                  @ {money(it.rate, link.currency)} = {money(it.amount, link.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex justify-between items-baseline">
          <span className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">Total</span>
          <span className="text-lg font-semibold tabular text-slate-900">{money(link.totalAmount, link.currency)}</span>
        </div>
      </div>

      <footer className="px-5 py-3 border-t border-[var(--color-border)] bg-slate-50 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => act('reject')}
          disabled={busy}
          className="px-4 py-2 text-sm text-slate-700 border border-slate-300 bg-white rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
        >
          Decline
        </button>
        <button
          type="button"
          onClick={() => act('confirm')}
          disabled={busy}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 font-medium"
        >
          {busy ? 'Working…' : 'Accept'}
        </button>
      </footer>

      {error && <p className="px-5 py-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

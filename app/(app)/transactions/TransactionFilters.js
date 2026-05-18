'use client';

/**
 * Filter toolbar for /transactions. URL is the source of truth — every
 * change pushes a new query string and Next.js re-renders the server
 * page with the new params. Pagination preserves the active filter set
 * via the Pagination component's `query` prop.
 *
 * Search input is debounced ~400ms so typing doesn't spam navigation.
 */

import { useEffect, useState, useTransition, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { MagnifyingGlass, X } from '@phosphor-icons/react';

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'Invoice', label: 'Invoices' },
  { value: 'Purchase', label: 'Purchases' },
  { value: 'Receipt', label: 'Receipts' },
  { value: 'Payment', label: 'Payments' },
  { value: 'Expense', label: 'Expenses' },
  { value: 'Cash', label: 'Cash entries' },
];

export default function TransactionFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  // Local input state for the search box (debounced before pushing to URL).
  const [q, setQ] = useState(params.get('q') || '');
  const qTimer = useRef(null);

  // Keep input in sync when URL changes externally (back/forward).
  useEffect(() => {
    setQ(params.get('q') || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function pushParams(updates) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    // Reset to page 1 on any filter change — old page numbers won't be
    // meaningful in the new filtered slice.
    next.delete('page');
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  function onSearchChange(v) {
    setQ(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => pushParams({ q: v.trim() }), 400);
  }

  function clearAll() {
    if (qTimer.current) clearTimeout(qTimer.current);
    setQ('');
    startTransition(() => router.push(pathname));
  }

  const activeCount =
    (params.get('type') ? 1 : 0) +
    (params.get('from') ? 1 : 0) +
    (params.get('to') ? 1 : 0) +
    (params.get('q') ? 1 : 0);

  return (
    <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-2 flex-wrap">
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">Search</label>
        <div className="relative">
          <MagnifyingGlass
            size={14}
            weight="regular"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            type="text"
            value={q}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="party, ref, memo…"
            className="w-full pl-8 pr-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white"
          />
        </div>
      </div>

      <div className="min-w-[160px]">
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">Type</label>
        <select
          value={params.get('type') || ''}
          onChange={(e) => pushParams({ type: e.target.value })}
          className="select-arrow w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">From</label>
        <input
          type="date"
          value={params.get('from') || ''}
          onChange={(e) => pushParams({ from: e.target.value })}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white tabular"
        />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">To</label>
        <input
          type="date"
          value={params.get('to') || ''}
          onChange={(e) => pushParams({ to: e.target.value })}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white tabular"
        />
      </div>

      {activeCount > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 px-2 py-2 self-end"
          title="Clear all filters"
        >
          <X size={12} weight="bold" />
          Clear ({activeCount})
        </button>
      )}
    </div>
  );
}

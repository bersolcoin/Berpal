'use client';

/**
 * Business switcher at the top of the sidebar — shows the business you're
 * working in; the menu lists every business you can open (A–Z) and "New
 * business" (→ /onboarding?new=1: set one up, or Join business for
 * invites to your number). Waiting invites show as a count on New
 * business and a blue dot on the field.
 *
 * Switching posts to /api/businesses/switch (members only) and reloads
 * the whole app on /dashboard, so nothing from the previous business
 * lingers in the page or the router cache.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CaretUpDown, Check, Plus } from '@phosphor-icons/react';

export default function CompanySwitcher({ currentId, currentName, businesses = [], inviteCount = 0 }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(null);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const list = businesses.length ? businesses : [{ id: currentId, name: currentName }];

  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  async function switchTo(id) {
    if (id === currentId) return setOpen(false);
    setSwitching(id);
    setError('');
    try {
      const res = await fetch('/api/businesses/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not switch.');
      window.location.assign('/dashboard');
    } catch (err) {
      setError(err.message);
      setSwitching(null);
    }
  }

  return (
    <div ref={ref} className="relative mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentName}
        className="w-full flex items-center gap-2 h-9 pl-3 pr-2 rounded-lg border border-slate-200 bg-white text-left text-sm font-medium text-slate-800 hover:border-slate-400 transition"
      >
        <span className="flex-1 truncate">{currentName}</span>
        {inviteCount > 0 && <span className="w-2 h-2 rounded-full bg-[var(--color-brand-accent)] shrink-0" title="Invites waiting" />}
        <CaretUpDown size={14} className="shrink-0 text-slate-400" />
      </button>

      {open && (
        <div role="menu" className="absolute left-0 right-0 z-50 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5">
          <div className="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)]">Your businesses</div>
          <div className="max-h-64 overflow-auto">
            {list.map((b) => (
              <button
                key={b.id}
                type="button"
                role="menuitem"
                onClick={() => switchTo(b.id)}
                disabled={switching != null}
                title={b.name}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm hover:bg-slate-50 disabled:opacity-60"
              >
                <span className={`flex-1 truncate ${b.id === currentId ? 'font-medium text-slate-900' : 'text-slate-700'}`}>{b.name}</span>
                {b.id === currentId && <Check size={13} weight="bold" className="text-slate-900" />}
                {switching === b.id && (
                  <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-slate-500 animate-spin" />
                )}
              </button>
            ))}
          </div>
          {error && <div className="px-2 py-1 text-xs text-red-600">{error}</div>}
          <div className="my-1.5 border-t border-slate-100" />
          <Link
            href="/onboarding?new=1"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-slate-700 hover:bg-slate-50"
          >
            <Plus size={14} />
            <span className="flex-1 truncate">New business</span>
            {/* Invites to your number are listed there, under Join business. */}
            {inviteCount > 0 && (
              <span
                title={`${inviteCount} invite${inviteCount === 1 ? '' : 's'} waiting`}
                className="min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--color-brand-accent)] text-white text-[11px] inline-flex items-center justify-center tabular"
              >
                {inviteCount}
              </span>
            )}
          </Link>
        </div>
      )}
    </div>
  );
}

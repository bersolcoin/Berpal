'use client';

/**
 * Reusable URL-state search input. Debounces ~400ms before pushing the
 * value to the page's query string as `q`. Reads initial value from the
 * current URL so back/forward navigation is consistent.
 *
 * Drop on any list page to add search. Server-side query reads
 * `searchParams.q` and filters accordingly.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { MagnifyingGlass, X } from '@phosphor-icons/react';

export default function SearchBox({ placeholder = 'Search…' }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [q, setQ] = useState(params.get('q') || '');
  const timer = useRef(null);

  useEffect(() => {
    setQ(params.get('q') || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function push(value) {
    const next = new URLSearchParams(params);
    if (value && value.trim()) next.set('q', value.trim());
    else next.delete('q');
    next.delete('page'); // reset to page 1 on new search
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  function onChange(v) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(v), 400);
  }

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    setQ('');
    push('');
  }

  return (
    <div className="relative w-full sm:w-80">
      <MagnifyingGlass
        size={14}
        weight="regular"
        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
      />
      <input
        type="text"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-8 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white"
      />
      {q && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </div>
  );
}

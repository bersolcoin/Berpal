/**
 * Numbered pagination — Prev | 1 ... 4 5 [6] 7 8 ... 23 | Next
 *
 * Preserves any other query-string params (filters, search, etc.) so
 * future filter UI plugs in without touching this component.
 *
 * Props:
 *   page:      current 1-based page
 *   pageSize:  rows per page
 *   total:     total row count (number)
 *   basePath:  the route to link to (e.g. '/transactions')
 *   query:     other query params to preserve { type: 'Invoice', from: '...' }
 */

import Link from 'next/link';

const SIBLINGS = 2; // how many page links to show on each side of current

export default function Pagination({ page, pageSize, total, basePath, query = {} }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const items = buildPageItems(page, totalPages);
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <nav className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3">
      <div className="text-xs text-[var(--color-ink-muted)] tabular">
        Showing <span className="font-medium text-slate-700">{start}</span>–
        <span className="font-medium text-slate-700">{end}</span> of{' '}
        <span className="font-medium text-slate-700">{total.toLocaleString()}</span>
      </div>

      <ul className="flex items-center gap-1">
        <li>
          <PageLink
            page={page - 1}
            disabled={page <= 1}
            basePath={basePath}
            query={query}
            className="px-3"
          >
            ← Prev
          </PageLink>
        </li>
        {items.map((item, i) =>
          item === '…' ? (
            <li key={`gap-${i}`} className="px-2 text-[var(--color-ink-muted)] text-sm">
              …
            </li>
          ) : (
            <li key={item}>
              <PageLink
                page={item}
                active={item === page}
                basePath={basePath}
                query={query}
              >
                {item}
              </PageLink>
            </li>
          )
        )}
        <li>
          <PageLink
            page={page + 1}
            disabled={page >= totalPages}
            basePath={basePath}
            query={query}
            className="px-3"
          >
            Next →
          </PageLink>
        </li>
      </ul>
    </nav>
  );
}

function PageLink({ page, active, disabled, basePath, query, className = '', children }) {
  const baseClass =
    'inline-flex items-center justify-center min-w-[34px] h-[34px] px-2.5 text-sm rounded-md border transition tabular';
  if (disabled) {
    return (
      <span
        className={`${baseClass} ${className} border-transparent text-slate-300 cursor-not-allowed`}
      >
        {children}
      </span>
    );
  }
  if (active) {
    return (
      <span
        className={`${baseClass} ${className} border-slate-900 bg-slate-900 text-white font-medium`}
      >
        {children}
      </span>
    );
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') params.set(k, String(v));
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  const href = qs ? `${basePath}?${qs}` : basePath;
  return (
    <Link
      href={href}
      className={`${baseClass} ${className} border-slate-200 text-slate-700 hover:bg-slate-100`}
    >
      {children}
    </Link>
  );
}

function buildPageItems(current, total) {
  // Always show first, last, current, and SIBLINGS around current.
  // Insert "…" wherever there's a gap.
  const pages = new Set([1, total, current]);
  for (let i = 1; i <= SIBLINGS; i++) {
    if (current - i > 1) pages.add(current - i);
    if (current + i < total) pages.add(current + i);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('…');
    out.push(sorted[i]);
  }
  return out;
}

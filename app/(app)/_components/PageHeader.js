/**
 * Page header — title + optional subtitle on the left; on the right an
 * optional slot for actions (e.g. a date range picker, an export button)
 * and, on sub-pages, a [←] back button (`back` = href) at the far right.
 */
import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr';

export default function PageHeader({ title, subtitle, right, back, backLabel = 'Back' }) {
  return (
    <header className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-[var(--color-ink-muted)] mt-1">{subtitle}</p>
        )}
      </div>
      {(right || back) && (
        <div className="shrink-0 flex items-center gap-2">
          {right}
          {back && (
            <Link
              href={back}
              aria-label={backLabel}
              title={backLabel}
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:border-slate-500 transition"
            >
              <ArrowLeft size={18} />
            </Link>
          )}
        </div>
      )}
    </header>
  );
}

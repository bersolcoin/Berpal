/**
 * Page header — title + optional subtitle + optional right-side slot for
 * actions (e.g. a date range picker, an export button later).
 */
export default function PageHeader({ title, subtitle, right }) {
  return (
    <header className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-[var(--color-ink-muted)] mt-1">{subtitle}</p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </header>
  );
}

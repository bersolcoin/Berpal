/**
 * Empty state — used inside Card bodies when there's no data yet.
 */
export default function Empty({ title = 'Nothing here yet', hint }) {
  return (
    <div className="text-center py-10">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint && <p className="text-xs text-[var(--color-ink-muted)] mt-1.5">{hint}</p>}
    </div>
  );
}

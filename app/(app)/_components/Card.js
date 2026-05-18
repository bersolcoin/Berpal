/**
 * Card surface — a subtle white panel with optional title and right slot.
 */
export default function Card({ title, right, children, className = '' }) {
  return (
    <section
      className={`bg-white border border-[var(--color-border)] rounded-xl ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          {title && <h2 className="text-sm font-medium text-slate-700">{title}</h2>}
          {right && <div>{right}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

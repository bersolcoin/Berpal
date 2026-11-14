'use client';

/**
 * Inventory as cards — the only view on mobile, and an option on desktop
 * (Table / Cards switch). Photo first; then code + status dot, variety, the
 * key details in a 3-across grid — weight, pieces, shape / colour, clarity —
 * and the selling price. Fixed — the Columns chooser only shapes the
 * table. Everything else is on the lot page or in the table.
 *
 * Mobile: one card per row, photo on the left. Desktop: a grid with the
 * photo on top.
 */

import { Image as ImageIcon, VideoCamera } from '@phosphor-icons/react';
import { money, friendlyItemCode } from '../_components/format';
import { StatusDot, detailText } from './cells';

// The card's key details — kept short on purpose. Fixed slots (empty
// ones show '—') so every card lines up the same way.
const CARD_DETAILS = ['weight', 'pieces', 'shape', 'base_color', 'clarity'];

export default function InventoryCards({ rows, ctx, onOpen, className = '' }) {
  if (rows.length === 0) {
    return <div className={`py-12 text-center text-sm text-slate-500 ${className}`}>No lots match.</div>;
  }

  return (
    <div className={`grid grid-cols-1 gap-2 md:grid-cols-3 md:gap-4 lg:grid-cols-4 2xl:grid-cols-5 ${className}`}>
      {rows.map((r) => {
        return (
          <button
            key={r.name}
            type="button"
            onClick={() => onOpen(r)}
            className="group flex md:flex-col gap-3 md:gap-0 p-2.5 md:p-0 text-left bg-white border border-[var(--color-border)] rounded-xl overflow-hidden hover:border-slate-400 hover:shadow-sm transition"
          >
            <div className="relative shrink-0 w-20 h-20 md:w-full md:h-auto md:aspect-square rounded-lg md:rounded-none bg-slate-100 overflow-hidden">
              {r.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.image} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.02] transition" />
              ) : (
                <span className="w-full h-full flex items-center justify-center text-slate-300">
                  <ImageIcon size={24} />
                </span>
              )}
              {r.media?.video && (
                <span className="absolute bottom-1 right-1 md:bottom-2 md:right-2 w-6 h-6 rounded-full bg-black/55 text-white flex items-center justify-center">
                  <VideoCamera size={13} />
                </span>
              )}
            </div>

            <div className="flex-1 min-w-0 flex flex-col md:p-3">
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate font-mono text-xs font-medium text-slate-900">{friendlyItemCode(r.item_code, ctx.abbr)}</span>
                <StatusDot status={r.status} />
              </div>
              <div className="mt-0.5 text-sm font-medium text-slate-800 truncate">{r.gem_type || r.item_name}</div>
              <div className="mt-1 grid grid-cols-3 gap-x-2 gap-y-0.5 text-xs text-slate-500">
                {CARD_DETAILS.map((k) => (
                  <span key={k} className="truncate">{detailText(k, r, ctx) || '—'}</span>
                ))}
              </div>
              {r.selling_price ? (
                <div className="mt-auto pt-1.5 text-sm font-semibold text-slate-900 tabular text-right md:text-left">
                  {money(r.selling_price, r.selling_currency || ctx.currency)}
                </div>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

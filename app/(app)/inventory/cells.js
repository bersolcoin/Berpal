/**
 * How inventory values display — shared by the table and the cards.
 *   cell(key, row, ctx)        → table cell content (JSX or text)
 *   detailText(key, row, ctx)  → short text for a card's detail line ('' = skip)
 *   StatusPill / StatusDot     → stock status, full or compact
 */

import { Image as ImageIcon, VideoCamera } from '@phosphor-icons/react';
import { money, date, friendlyItemCode } from '../_components/format';
import { STATUS_LABELS } from './columns';

export const STATUS_TONE = {
  in_stock: 'bg-emerald-50 text-emerald-700',
  partly_sold: 'bg-amber-50 text-amber-800',
  sold: 'bg-slate-100 text-slate-500',
};

export function StatusPill({ status }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.in_stock;
  return (
    <span className={`inline-flex items-center h-6 px-2.5 rounded-full text-xs font-medium ${tone}`}>
      {STATUS_LABELS[status] || STATUS_LABELS.in_stock}
    </span>
  );
}
export const num = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

export function cell(key, r, { currency, abbr }) {
  switch (key) {
    case 'image':
      return r.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.image} alt="" loading="lazy" className="w-9 h-9 rounded-md object-cover bg-slate-100 border border-slate-200" />
      ) : (
        <span className="w-9 h-9 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-300">
          <ImageIcon size={16} />
        </span>
      );
    case 'code':
      return <span className="font-mono text-xs font-medium text-slate-900">{friendlyItemCode(r.item_code, abbr)}</span>;
    case 'name':
      return r.item_name;
    case 'variety':
      return r.gem_type;
    case 'family':
      return r.gem_family;
    case 'media': {
      const imgs = (r.image ? 1 : 0) + (r.media?.images?.length || 0);
      return (
        <span className="inline-flex items-center gap-2 text-xs text-slate-500">
          {imgs > 0 && <span className="inline-flex items-center gap-0.5"><ImageIcon size={13} />{imgs}</span>}
          {r.media?.video && <VideoCamera size={14} />}
        </span>
      );
    }
    case 'created':
      return date(r.creation);
    case 'weight':
      return num(r.weight_ct);
    case 'pieces':
      return r.pieces ?? '';
    case 'meas1':
    case 'meas2':
    case 'meas3':
      return r[key] ? num(r[key]) : '';
    case 'status':
      return <StatusPill status={r.status} />;
    case 'calibrated':
      return r.calibrated ? 'Yes' : '';
    case 'cost_rate':
      return r.cost_rate ? money(r.cost_rate, currency) : '';
    case 'stock_value':
      return r.stock_value ? money(r.stock_value, currency) : '';
    case 'selling_price':
      return r.selling_price ? money(r.selling_price, r.selling_currency || currency) : '';
    default:
      return r[key] ?? '';
  }
}


const DOT_TONE = { in_stock: 'bg-emerald-500', partly_sold: 'bg-amber-500', sold: 'bg-slate-300' };

/** Compact status: a coloured dot (label on hover / for screen readers). */
export function StatusDot({ status }) {
  const label = STATUS_LABELS[status] || STATUS_LABELS.in_stock;
  return (
    <span title={label} className="inline-flex items-center">
      <span className={`w-2.5 h-2.5 rounded-full ${DOT_TONE[status] || DOT_TONE.in_stock}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Card detail-line text for a column ('' when empty or shown elsewhere on the card). */
export function detailText(key, r, ctx) {
  switch (key) {
    case 'weight':
      return r.weight_ct ? `${num(r.weight_ct)} ct` : '';
    case 'pieces':
      return r.pieces ? `${r.pieces} pcs` : '';
    case 'meas1':
    case 'meas2':
    case 'meas3':
      return ''; // combined as L × W × H by the card
    case 'calibrated':
      return r.calibrated ? 'Calibrated' : '';
    case 'cost_rate':
      return r.cost_rate ? `Cost ${money(r.cost_rate, ctx.currency)}` : '';
    case 'stock_value':
      return r.stock_value ? `Value ${money(r.stock_value, ctx.currency)}` : '';
    case 'created':
      return r.creation ? `Added ${date(r.creation)}` : '';
    case 'certificate_no':
      return r.certificate_no ? `Cert ${r.certificate_no}` : '';
    case 'media':
      return '';
    default: {
      const v = cell(key, r, ctx);
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }
  }
}

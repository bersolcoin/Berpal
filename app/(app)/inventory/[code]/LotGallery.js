'use client';

/**
 * Lot media: a large square viewer with a thumbnail strip below — photos
 * and (if any) the video, which plays inline when selected.
 */

import { useState } from 'react';
import { Image as ImageIcon, Play } from '@phosphor-icons/react';

export default function LotGallery({ image, images = [], video = null, alt = '' }) {
  const items = [
    ...[image, ...images].filter(Boolean).map((src) => ({ type: 'image', src })),
    ...(video ? [{ type: 'video', src: video }] : []),
  ];
  const [active, setActive] = useState(0);
  const current = items[active];

  if (!items.length) {
    return (
      <div className="aspect-square rounded-xl border border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center text-slate-400">
        <ImageIcon size={36} />
        <span className="text-xs mt-2">No photos yet</span>
      </div>
    );
  }

  return (
    <div>
      <div className="aspect-square rounded-xl overflow-hidden border border-[var(--color-border)] bg-slate-50">
        {current.type === 'video' ? (
          <video key={current.src} src={current.src} controls autoPlay muted loop playsInline className="w-full h-full object-contain bg-black" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={current.src} alt={alt} className="w-full h-full object-contain" />
        )}
      </div>
      {items.length > 1 && (
        <div className="mt-3 grid grid-cols-5 gap-2">
          {items.map((m, i) => (
            <button
              key={m.src}
              type="button"
              onClick={() => setActive(i)}
              aria-label={m.type === 'video' ? 'Play video' : `Photo ${i + 1}`}
              className={`relative aspect-square rounded-lg overflow-hidden border-2 transition ${
                i === active ? 'border-slate-900' : 'border-transparent hover:border-slate-300'
              }`}
            >
              {m.type === 'video' ? (
                <span className="w-full h-full flex items-center justify-center bg-slate-900 text-white">
                  <Play size={18} weight="fill" />
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.src} alt="" loading="lazy" className="w-full h-full object-cover bg-slate-100" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

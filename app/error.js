'use client';

/**
 * Top-level error boundary. Placed at app/ so it sits ABOVE the
 * (app)/layout (Shell) — when triggered, the Shell does NOT render,
 * just this interstitial. Used to swallow ERPNext upstream failures
 * (502/503/504 — usually Railway cold-start) and show a calm
 * "backend unreachable" panel with a retry button.
 *
 * Errors thrown in /login, /onboarding, or anywhere else in app/* also
 * land here. ERPNext-specific errors get the dedicated copy; everything
 * else falls through to a generic "something went wrong" message.
 *
 * Detection is by error.message pattern because Next.js only preserves
 * `message` (and `digest`) across the server/client error boundary —
 * custom Error subclasses don't survive serialization. The `[erpnext`
 * prefix is set by ErpNextClient._fetch in src/erpnext.js.
 */

import { useEffect } from 'react';
import { ArrowClockwise, WifiSlash, Warning } from '@phosphor-icons/react';

function isErpUpstreamError(err) {
  const m = err?.message || '';
  return m.includes('[erpnext ') && /HTTP 5\d{2}/.test(m);
}

export default function RootError({ error, reset }) {
  useEffect(() => {
    console.error('[app error boundary]', error);
  }, [error]);

  if (isErpUpstreamError(error)) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-md w-full text-center space-y-4 bg-white border border-amber-200 rounded-xl p-6 shadow-sm">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-100 text-amber-600">
            <WifiSlash size={24} weight="regular" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900">Accounting backend is unreachable</h2>
          <p className="text-sm text-slate-600 leading-relaxed">
            Our accounting backend didn't respond. This is almost always a brief
            outage — it usually comes back within 30 seconds. Try again in a moment.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => reset()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 font-medium"
            >
              <ArrowClockwise size={14} weight="bold" /> Try again
            </button>
            <a
              href="/health"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm text-slate-700 border border-slate-300 bg-white rounded-lg hover:bg-slate-50 font-medium"
            >
              See diagnostics
            </a>
          </div>
          <details className="text-left">
            <summary className="text-[11px] text-slate-400 cursor-pointer select-none">
              Technical details
            </summary>
            <p className="text-[11px] text-slate-500 font-mono break-all mt-2 px-2 leading-snug">
              {error?.message}
            </p>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full text-center space-y-4 bg-white border border-red-200 rounded-xl p-6 shadow-sm">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 text-red-600">
          <Warning size={24} weight="regular" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900">Something went wrong</h2>
        <p className="text-sm text-slate-600">{error?.message || 'An unexpected error occurred.'}</p>
        <button
          onClick={() => reset()}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 font-medium"
        >
          <ArrowClockwise size={14} weight="bold" /> Try again
        </button>
      </div>
    </div>
  );
}

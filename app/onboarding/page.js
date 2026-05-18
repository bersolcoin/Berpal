/**
 * Onboarding entry — server component handles the session gate, the
 * 3-step form runs as a client island (OnboardingFlow).
 *
 * Bounces back to /login if no phone, forwards to /dashboard if already
 * provisioned.
 *
 * DEV BYPASS: append `?debug=true` (NODE_ENV !== 'production' only) to
 * preview the form without going through login → OTP. Submitting the
 * form WILL still fail at /api/onboarding without a real session — the
 * bypass is for UI preview only.
 */

import { redirect } from 'next/navigation';
import { getSession } from '../../src/auth/session';
import { query } from '../../src/db';
import OnboardingFlow from './OnboardingFlow';

export const dynamic = 'force-dynamic';

const isDev = process.env.NODE_ENV !== 'production';

export default async function OnboardingPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const debug = isDev && sp.debug === 'true';

  const sess = await getSession();
  if (!debug) {
    if (!sess.phone) redirect('/login');
    // sess.onboarded may be stale (cookie issued before the user was
    // reset). Re-check the DB before bouncing back to /dashboard.
    if (sess.onboarded && sess.user_id) {
      const r = await query(
        `SELECT erpnext_company FROM users WHERE id = $1`,
        [sess.user_id]
      );
      if (r.rows[0]?.erpnext_company) redirect('/dashboard');
      // Stale cookie — fall through to onboarding. Mark session as
      // un-onboarded so we don't loop on subsequent visits.
      sess.onboarded = false;
      await sess.save();
    }
  }

  return (
    <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
      {debug && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900">
          <strong>Debug preview.</strong> Auth bypass enabled (?debug=true).
          Form is fully interactive but submitting will fail — there&rsquo;s no real session.
        </div>
      )}

      <img src="/logo.svg" alt="Berpal" className="w-9 h-9 mb-8" />
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Set up your business</h1>
      <p className="text-sm text-slate-600 mb-2">
        A few quick questions to set up your accounting workspace. Most fields are optional and editable later.
      </p>
      {sess.phone && (
        <p className="text-xs text-slate-400 mb-8">
          Signed in as <strong className="text-slate-600">{sess.phone}</strong>
        </p>
      )}
      {!sess.phone && <div className="mb-8" />}

      <OnboardingFlow />
    </main>
  );
}

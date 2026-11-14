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
import { listBusinesses, loadActiveBusiness, pickBusiness } from '../../src/auth/business';
const { listInvitesForPhone } = require('../../src/team');
import OnboardingStart from './OnboardingStart';

export const dynamic = 'force-dynamic';

const isDev = process.env.NODE_ENV !== 'production';
const ONBOARDING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export default async function OnboardingPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const debug = isDev && sp.debug === 'true';

  const sess = await getSession();
  if (!debug) {
    if (!sess.phone) redirect('/login');
    // sess.onboarded may be stale (cookie issued before the user was
    // reset). Re-check the DB before bouncing back to /dashboard.
    // Note: can't sess.save() in a server component (Next 15+); the
    // stale cookie just sits unread until /api/onboarding overwrites
    // it on next submit.
    // ?new=1 (sidebar → New business) always shows the form; otherwise a
    // person who already runs a business goes to it.
    if (sp.new !== '1') {
      if (sess.onboarded && (await loadActiveBusiness(sess.phone, sess.user_id))) redirect('/dashboard');
      // Active business gone (wiped / no longer a member) but they have
      // others — open one (a route handler, since pages can't set cookies).
      const other = await pickBusiness(sess.phone);
      if (other) redirect(`/api/businesses/open?id=${other}`);
      // None — fall through to render the onboarding form.
    }

    // 30-minute onboarding window for first-time sign-ups. If they sat on
    // this screen too long (or came back hours later), force re-login so we
    // don't trust a stale session for Company creation. Someone already in
    // a business (adding another) has a normal signed-in session.
    if (sess.onboarding_started_at && !sess.onboarded) {
      const startedMs = Date.parse(sess.onboarding_started_at);
      if (Number.isFinite(startedMs) && Date.now() - startedMs > ONBOARDING_WINDOW_MS) {
        redirect('/login?expired=1');
      }
    }
  }

  const hasBusiness = !debug && (await listBusinesses(sess.phone)).length > 0;
  const invites = debug ? [] : await listInvitesForPhone(sess.phone);
  const displayName = debug
    ? ''
    : (await query(`SELECT display_name FROM people WHERE phone = $1`, [sess.phone])).rows[0]?.display_name || '';

  return (
    <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
      {debug && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900">
          <strong>Debug preview.</strong> Auth bypass enabled (?debug=true).
          Form is fully interactive but submitting will fail — there&rsquo;s no real session.
        </div>
      )}

      <img src="/logo.svg" alt="Berpal" className="w-9 h-9 mb-8" />
      <OnboardingStart phone={sess.phone || null} hasBusiness={hasBusiness} displayName={displayName} invites={invites} />
    </main>
  );
}

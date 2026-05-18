/**
 * Root route — session-aware redirect.
 *
 * Logged in & onboarded → /dashboard
 * Logged in but not yet onboarded → /onboarding
 * Logged out → /login
 *
 * If you want a marketing landing page later, move that content here and
 * gate the redirect behind an explicit "Sign in" CTA.
 */

import { redirect } from 'next/navigation';
import { getSession } from '../src/auth/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const sess = await getSession();
  if (sess.user_id && sess.onboarded) redirect('/dashboard');
  if (sess.phone) redirect('/onboarding');
  redirect('/login');
}

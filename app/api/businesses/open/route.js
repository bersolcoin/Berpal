/**
 * GET /api/businesses/open?id=N — open one of the signed-in person's
 * businesses and land on /dashboard. Used by /onboarding when the
 * session's business is gone but the person has others (pages can't set
 * cookies; route handlers can). Members only — anything else goes to
 * /onboarding.
 */

import { NextResponse } from 'next/server';

const { getSession } = require('../../../../src/auth/session');
const { loadActiveBusiness, rememberBusiness } = require('../../../../src/auth/business');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const sess = await getSession();
  if (!sess.phone) return NextResponse.redirect(new URL('/login', url));

  const business = await loadActiveBusiness(sess.phone, parseInt(url.searchParams.get('id'), 10));
  if (!business) return NextResponse.redirect(new URL('/onboarding?new=1', url));

  sess.user_id = business.id;
  sess.onboarded = true;
  delete sess.onboarding_started_at;
  await sess.save();
  await rememberBusiness(sess.phone, business.id);
  return NextResponse.redirect(new URL('/dashboard', url));
}

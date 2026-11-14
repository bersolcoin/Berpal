/**
 * POST /api/auth/verify-otp
 * Body: { phone, code }
 * On success: sets a session cookie (the phone = the signed-in person) and
 * opens their last-used business; a person with no business yet goes to
 * /onboarding.
 */

const { verifyOtp } = require('../../../../src/auth/otp');
const { getSession } = require('../../../../src/auth/session');
const { ensurePerson, pickBusiness } = require('../../../../src/auth/business');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/\s+/g, '');
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const phone = normalizePhone(body.phone);
  const code = body.code ? String(body.code).trim() : null;

  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return Response.json({ ok: false, error: 'Invalid phone.' }, { status: 400 });
  }
  if (!code) {
    return Response.json({ ok: false, error: 'Missing code.' }, { status: 400 });
  }

  const result = await verifyOtp(phone, code);
  if (!result.ok) {
    return Response.json(result, { status: 401 });
  }

  // The person (created on first sign-in) and the business to open.
  const person = await ensurePerson(phone, { login: true });
  const businessId = await pickBusiness(phone);

  // Set session. With a business: open it. Without: onboarding, which
  // provisions under this phone; stamp onboarding_started_at — /onboarding
  // enforces a 30-minute window before forcing re-login.
  const sess = await getSession();
  sess.phone = phone;
  if (businessId) {
    sess.user_id = businessId;
    sess.onboarded = true;
    delete sess.onboarding_started_at;
  } else {
    sess.user_id = null;
    sess.onboarded = false;
    sess.onboarding_started_at = new Date().toISOString();
  }
  await sess.save();

  return Response.json({
    ok: true,
    onboarded: !!businessId,
    display_name: person?.display_name || null,
  });
}

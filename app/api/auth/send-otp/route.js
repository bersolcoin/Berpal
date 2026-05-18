/**
 * POST /api/auth/send-otp
 * Body: { phone: "+66..." }
 * Generates a 6-digit code, stores hash, sends via WhatsApp.
 */

const { sendOtp } = require('../../../../src/auth/otp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/\s+/g, '');
}

export async function POST(request) {
  let phone;
  try {
    const json = await request.json();
    phone = normalizePhone(json.phone);
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return Response.json(
      { ok: false, error: 'Please enter your phone in international format (e.g. +66838883866).' },
      { status: 400 }
    );
  }

  const result = await sendOtp(phone, { channel: 'whatsapp' });
  if (!result.ok) {
    return Response.json(result, { status: 400 });
  }
  return Response.json({ ok: true, expires_at: result.expires_at });
}

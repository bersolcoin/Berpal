/**
 * POST /api/onboarding
 *
 * Requires an OTP-verified session (session.phone). Validates the full
 * onboarding form, then calls provisionTenant which handles ERPNext
 * Company + User + API keys + starter wallets + Opening Balance JEs +
 * Postgres user row in one shot.
 *
 * Body shape:
 *   {
 *     business_type:     'service' | 'product' | 'both',
 *     entity_type:       'individual' | 'company',
 *     business_name:     string,
 *     nature_of_business?: string,
 *     country:           ISO code,
 *     default_currency:  ISO 4217 (3 letters),
 *     tax_id?:           string,
 *     address_line1?, address_line2?, city?, state_province?, postal_code?,
 *     display_name:      string,
 *     email?:            string,
 *     cash: { name?: string, currency?: string, opening_balance?: number },
 *     banks: [{ name, currency?, opening_balance? }, ...]
 *   }
 */

const { provisionTenant } = require('../../../src/erp-sync/provision');
const { getSession } = require('../../../src/auth/session');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUSINESS_TYPES = new Set(['service', 'product', 'both']);
const ENTITY_TYPES = new Set(['individual', 'company']);
const ISO_CURRENCY = /^[A-Z]{3}$/;
const ISO_COUNTRY = /^[A-Z]{2}$/;

function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toNum(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const ONBOARDING_WINDOW_MS = 30 * 60 * 1000;

export async function POST(request) {
  const sess = await getSession();
  if (!sess.phone) {
    return Response.json({ ok: false, error: 'Not signed in. Please request a new OTP.' }, { status: 401 });
  }
  // 30-min onboarding window — refuse submits with a stale session.
  if (sess.onboarding_started_at) {
    const startedMs = Date.parse(sess.onboarding_started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > ONBOARDING_WINDOW_MS) {
      return Response.json(
        { ok: false, error: 'Onboarding session expired. Please sign in again.', expired: true },
        { status: 401 }
      );
    }
  }
  // Don't trust sess.onboarded alone — it may be stale after a reset.
  // Re-check the DB; only block if there's a live ERPNext binding.
  if (sess.onboarded && sess.user_id) {
    const { query } = require('../../../src/db');
    const r = await query(`SELECT erpnext_company FROM users WHERE id = $1`, [sess.user_id]);
    if (r.rows[0]?.erpnext_company) {
      return Response.json({ ok: false, error: 'Already onboarded.', dashboard: '/dashboard' }, { status: 409 });
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const business_type = toStr(body.business_type);
  const entity_type = toStr(body.entity_type);
  const business_name = toStr(body.business_name);
  const nature_of_business = toStr(body.nature_of_business);
  const country = toStr(body.country)?.toUpperCase();
  const default_currency = toStr(body.default_currency)?.toUpperCase();
  const tax_id = toStr(body.tax_id);
  const address_line1 = toStr(body.address_line1);
  const address_line2 = toStr(body.address_line2);
  const city = toStr(body.city);
  const state_province = toStr(body.state_province);
  const postal_code = toStr(body.postal_code);
  const display_name = toStr(body.display_name);
  const email = toStr(body.email);

  // Validation
  if (!business_type || !BUSINESS_TYPES.has(business_type)) {
    return Response.json({ ok: false, error: 'Please pick a business type.' }, { status: 400 });
  }
  if (!entity_type || !ENTITY_TYPES.has(entity_type)) {
    return Response.json({ ok: false, error: 'Please pick an entity type.' }, { status: 400 });
  }
  if (!business_name || business_name.length < 2) {
    return Response.json({ ok: false, error: 'Business name is required.' }, { status: 400 });
  }
  if (!country || !ISO_COUNTRY.test(country)) {
    return Response.json({ ok: false, error: 'Country is required.' }, { status: 400 });
  }
  if (!default_currency || !ISO_CURRENCY.test(default_currency)) {
    return Response.json({ ok: false, error: 'Currency must be a 3-letter ISO code (e.g. USD, THB).' }, { status: 400 });
  }
  if (!display_name) {
    return Response.json({ ok: false, error: 'Please tell us your name.' }, { status: 400 });
  }

  // Unified wallets list — each entry has its own type (cash/bank), name,
  // currency, opening balance. User can have multiple cash buckets in
  // different currencies (e.g. THB cash drawer + USD cash drawer).
  const wallets = Array.isArray(body.wallets)
    ? body.wallets
        .filter((w) => w && toStr(w.name))
        .map((w) => ({
          type: w.type === 'bank' ? 'bank' : 'cash',
          name: toStr(w.name),
          currency: (toStr(w.currency) || default_currency).toUpperCase(),
          opening_balance: toNum(w.opening_balance),
        }))
    : [];

  if (wallets.length === 0) {
    return Response.json(
      { ok: false, error: 'Please add at least one cash or bank wallet.' },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await provisionTenant({
      phone: sess.phone,
      display_name,
      business_name,
      country,
      currency: default_currency,
      email,
      business_type,
      entity_type,
      nature_of_business,
      tax_id,
      address_line1,
      address_line2,
      city,
      state_province,
      postal_code,
      wallets,
    });
  } catch (err) {
    // Full stack + ERPNext response (if any) for backend debugging.
    console.error('[onboarding] provisionTenant threw:');
    console.error(err);
    if (err.response) console.error('[onboarding] err.response:', JSON.stringify(err.response).slice(0, 800));
    return Response.json({ ok: false, error: `Provisioning failed: ${err.message}` }, { status: 500 });
  }

  if (!result.ok) {
    console.error(`[onboarding] provisionTenant returned ok=false: ${result.error} (partial=${JSON.stringify(result.partial)})`);
    return Response.json({ ok: false, error: result.error, partial: result.partial }, { status: 500 });
  }

  sess.user_id = result.user_id;
  sess.onboarded = true;
  await sess.save();

  // If suppliers parked invoices for this phone before signup, redirect
  // straight to /inbox so the user can deal with them up front. Otherwise
  // straight to /dashboard.
  const next = result.pending_invoices_count > 0 ? '/inbox' : '/dashboard';

  return Response.json({
    ok: true,
    user_id: result.user_id,
    erpnext_company: result.erpnext_company,
    business_type: result.business_type,
    wallets: result.wallets,
    pending_invoices_count: result.pending_invoices_count || 0,
    dashboard: next,
  });
}

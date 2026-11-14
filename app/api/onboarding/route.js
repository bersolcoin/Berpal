/**
 * POST /api/onboarding
 *
 * Requires an OTP-verified session (session.phone). Sets up a new business
 * for that person — their first, or another one next to those they have.
 * Validates the full onboarding form, then calls provisionTenant which
 * handles ERPNext Company + User + API keys + starter wallets + Opening
 * Balance JEs + the Postgres business row and membership in one shot. Responds with an NDJSON progress stream;
 * the client then calls /api/onboarding/finalize to bind the session.
 *
 * Body shape:
 *   {
 *     business_type:     'service' | 'product' | 'both',
 *     catalog_template:  'gemstones'   (catalog category to switch on; required unless service),
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
const CATALOG_TEMPLATES = new Set(['gemstones']); // live catalog categories
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
  // 30-min onboarding window for first-time sign-ups — refuse submits with
  // a stale session. (Adding another business: normal signed-in session.)
  if (sess.onboarding_started_at && !sess.onboarded) {
    const startedMs = Date.parse(sess.onboarding_started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > ONBOARDING_WINDOW_MS) {
      return Response.json(
        { ok: false, error: 'Onboarding session expired. Please sign in again.', expired: true },
        { status: 401 }
      );
    }
  }
  // Already running a business is fine — this sets up another one
  // (sidebar → New business); provisioning adds it alongside.

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const business_type = toStr(body.business_type);
  const catalog_template = toStr(body.catalog_template);
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
  // One name per person across all their businesses: someone who already
  // has one keeps it, whatever the form sends.
  const { query } = require('../../../src/db');
  const known = (await query(`SELECT display_name FROM people WHERE phone = $1`, [sess.phone])).rows[0]?.display_name;
  const display_name = known || toStr(body.display_name);
  const email = toStr(body.email);

  // Validation
  if (!business_type || !BUSINESS_TYPES.has(business_type)) {
    return Response.json({ ok: false, error: 'Please pick a business type.' }, { status: 400 });
  }
  // Goods businesses pick a starter for their product categories.
  if (business_type !== 'service' && !CATALOG_TEMPLATES.has(catalog_template)) {
    return Response.json({ ok: false, error: 'Please pick how to start your product categories.' }, { status: 400 });
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

  // Provision, streaming progress as NDJSON — one JSON object per line:
  //   { type: 'progress', step, detail? }   (step: company|access|workspace|wallets|finish)
  //   { type: 'done', ok: true, next }
  //   { type: 'error', error }
  // The session can't be updated once a streamed response has started, so
  // the client calls POST /api/onboarding/finalize after 'done'.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      try {
        const result = await provisionTenant({
          phone: sess.phone,
          display_name,
          business_name,
          country,
          currency: default_currency,
          email,
          business_type,
          catalog_template: business_type === 'service' ? null : catalog_template,
          entity_type,
          nature_of_business,
          tax_id,
          address_line1,
          address_line2,
          city,
          state_province,
          postal_code,
          wallets,
          onProgress: (step, detail) => send({ type: 'progress', step, ...(detail ? { detail } : {}) }),
        });
        if (!result.ok) {
          console.error(`[onboarding] provisionTenant returned ok=false: ${result.error} (partial=${JSON.stringify(result.partial)})`);
          send({ type: 'error', error: result.error });
        } else {
          // Suppliers may have parked invoices for this phone before signup —
          // land on /inbox so the user deals with them up front.
          send({ type: 'done', ok: true, next: result.pending_invoices_count > 0 ? '/inbox' : '/dashboard' });
        }
      } catch (err) {
        // Full stack + ERPNext response (if any) for backend debugging.
        console.error('[onboarding] provisionTenant threw:');
        console.error(err);
        if (err.response) console.error('[onboarding] err.response:', JSON.stringify(err.response).slice(0, 800));
        send({ type: 'error', error: `Provisioning failed: ${err.message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
  });
}

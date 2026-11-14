/**
 * Load the signed-in, onboarded user for an API route.
 *
 *   const user = await getCurrentUser();
 *   if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
 *
 * Returns the ACTIVE BUSINESS's full users row (erp-sync handlers read
 * business_type, industry, erpnext_company_abbr, …) with
 * reporting_currency defaulted, or null when there's no session, the
 * signed-in person isn't a member of it, or it has no ERPNext binding.
 */

const { getSession } = require('./session');
const { loadActiveBusiness } = require('./business');

async function getCurrentUser() {
  const sess = await getSession();
  if (!sess.user_id || !sess.phone) return null;
  const user = await loadActiveBusiness(sess.phone, sess.user_id);
  if (!user) return null;
  user.reporting_currency = user.reporting_currency || user.default_currency;
  return user;
}

module.exports = { getCurrentUser };

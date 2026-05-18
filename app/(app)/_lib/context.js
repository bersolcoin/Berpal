/**
 * Per-request context loader for the authenticated app shell.
 *
 *   const { user, erp } = await getAppContext();
 *
 * Wrapped in React.cache so calls within the same request share the result
 * — both the (app) layout and each page can call this without double-hitting
 * Postgres or building two ERPNext clients.
 */

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '../../../src/auth/session';
import { query } from '../../../src/db';
const erpnext = require('../../../src/erpnext');

export const getAppContext = cache(async () => {
  const sess = await getSession();
  if (!sess.phone) redirect('/login');
  if (!sess.user_id || !sess.onboarded) redirect('/onboarding');

  const r = await query(
    `SELECT id, phone, email, display_name, default_currency, country,
            erpnext_company, erpnext_company_abbr,
            erpnext_api_key, erpnext_api_secret,
            business_type, entity_type, nature_of_business, tax_id,
            address_line1, address_line2, city, state_province, postal_code
       FROM users WHERE id = $1`,
    [sess.user_id]
  );
  const user = r.rows[0];
  if (!user) redirect('/login');

  // The user's session cookie may say "onboarded=true" but the DB row
  // could've been wiped (admin ran reset-user-onboarding.js, ERPNext
  // creds rotated, etc). If there's no ERPNext binding, mark the
  // session as un-onboarded and send them back through /onboarding —
  // otherwise erpnext.forUser would throw "missing api_key / api_secret".
  if (!user.erpnext_company || !user.erpnext_api_key || !user.erpnext_api_secret) {
    sess.onboarded = false;
    await sess.save();
    redirect('/onboarding');
  }

  const erp = erpnext.forUser(user);
  return { user, erp };
});

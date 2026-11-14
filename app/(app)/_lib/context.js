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
const { loadActiveBusiness } = require('../../../src/auth/business');
const erpnext = require('../../../src/erpnext');

export const getAppContext = cache(async () => {
  const sess = await getSession();
  if (!sess.phone) redirect('/login');
  if (!sess.user_id || !sess.onboarded) redirect('/onboarding');

  // `user` = the active business (users row). Only loads when the signed-in
  // person (sess.phone) is a member of it and it has an ERPNext binding.
  // Otherwise — wiped business, removed membership, rotated creds — send
  // them to /onboarding, which re-checks and offers their businesses /
  // setting one up. (Can't sess.save() here: Next 15+ blocks cookie writes
  // from server components.)
  const user = await loadActiveBusiness(sess.phone, sess.user_id);
  if (!user) redirect('/onboarding');

  const erp = erpnext.forUser(user);
  return { user, erp };
});

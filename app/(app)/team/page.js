/**
 * /team — the people who can use the active business (name, phone, role)
 * and invites still waiting. [+] invites a phone number; they accept after
 * signing in with it ("Join business" on /onboarding). Owner / admin
 * only — others are sent to the dashboard. Roles: owner / admin / manager
 * / staff (src/team.js).
 */

import { redirect } from 'next/navigation';
import { getAppContext } from '../_lib/context';
import { getSession } from '../../../src/auth/session';
import PageHeader from '../_components/PageHeader';
import AddMember from './AddMember';
import TeamList from './TeamList';

const { listTeam, smsEnabled, canManageTeam } = require('../../../src/team');
const { listBusinesses } = require('../../../src/auth/business');

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const { user } = await getAppContext();
  const { phone } = await getSession();
  // Owner / admin only (the sidebar hides Team for everyone else).
  const role = (await listBusinesses(phone)).find((b) => b.id === user.id)?.role;
  if (!canManageTeam(role)) redirect('/dashboard');
  const { members, invites } = await listTeam(user.id);

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`People who can use ${user.erpnext_company}.`}
        right={<AddMember defaultCountry={user.country} smsOn={smsEnabled()} />}
      />
      <TeamList members={members} invites={invites} myPhone={phone} smsOn={smsEnabled()} />
    </>
  );
}

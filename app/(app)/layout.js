/**
 * Authenticated app shell. Auth check + user fetch lives here (server side);
 * the actual chrome (sidebar, mobile drawer, active link state) lives in
 * Shell, a client component.
 */

import { getAppContext } from './_lib/context';
import { countPendingLinks } from '../../src/erp-query';
import Shell from './_components/Shell';

export const dynamic = 'force-dynamic';

export default async function AppShellLayout({ children }) {
  const { user } = await getAppContext();
  const pendingInboxCount = await countPendingLinks(user.id).catch(() => 0);

  const safeUser = {
    display_name: user.display_name,
    phone: user.phone,
    erpnext_company: user.erpnext_company,
    business_type: user.business_type,
  };

  return (
    <Shell user={safeUser} pendingInboxCount={pendingInboxCount}>
      {children}
    </Shell>
  );
}

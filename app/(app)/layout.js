/**
 * Authenticated app shell. Auth check + user fetch lives here (server side);
 * the actual chrome (sidebar, mobile drawer, active link state) lives in
 * Shell, a client component.
 */

import { getAppContext } from './_lib/context';
import { countPendingLinks } from '../../src/erp-query';
import { query } from '../../src/db';
import Shell from './_components/Shell';

export const dynamic = 'force-dynamic';

export default async function AppShellLayout({ children }) {
  const { user, erp } = await getAppContext();

  // ERPNext health check — fail-fast so a 5xx upstream renders the global
  // "backend unreachable" interstitial in app/error.js instead of letting
  // child pages quietly fall back to empty data via their per-query
  // .catch() handlers. One small Company-by-name listResource is enough
  // to detect 502 cold-starts AND auth/permission breakage in one shot.
  // NO try/catch — the error MUST bubble past this segment to hit the
  // app/ error boundary (same-segment errors don't reach (app)/error.js).
  await erp.listResource('Company', {
    filters: [['name', '=', erp.company]],
    fields: ['name'],
    limit: 1,
  });

  const [pendingInboxCount, pendingTodosCount] = await Promise.all([
    countPendingLinks(user.id).catch(() => 0),
    query(`SELECT COUNT(*)::int AS n FROM todos WHERE user_id = $1`, [user.id])
      .then((r) => r.rows[0]?.n || 0)
      .catch(() => 0),
  ]);

  const safeUser = {
    display_name: user.display_name,
    phone: user.phone,
    erpnext_company: user.erpnext_company,
    business_type: user.business_type,
  };

  return (
    <Shell
      user={safeUser}
      pendingInboxCount={pendingInboxCount}
      pendingTodosCount={pendingTodosCount}
    >
      {children}
    </Shell>
  );
}

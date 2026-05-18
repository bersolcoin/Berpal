/**
 * /inbox — invoices proposed by suppliers, waiting for buyer's accept/reject.
 *
 * After onboarding, users with one or more pending invoices land here first
 * (instead of /dashboard). They can also reach this page later via the
 * sidebar.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listPendingLinks } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Empty from '../_components/Empty';
import InboxItem from './InboxItem';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const { user } = await getAppContext();
  const links = await listPendingLinks(user.id, { limit: 100 }).catch(() => []);

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle={
          links.length > 0
            ? `${links.length} invoice${links.length === 1 ? '' : 's'} from your suppliers waiting for review.`
            : 'No pending invoices right now.'
        }
        right={
          <Link
            href="/dashboard"
            className="text-xs text-[var(--color-brand-accent)] hover:underline"
          >
            Skip to dashboard →
          </Link>
        }
      />

      {links.length === 0 ? (
        <div className="bg-white border border-[var(--color-border)] rounded-xl">
          <Empty
            title="Nothing waiting"
            hint="When a supplier on Berpal records a sale to you, it'll show up here for you to accept or decline."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {links.map((link) => (
            <InboxItem key={link.id} link={link} />
          ))}
        </div>
      )}
    </>
  );
}

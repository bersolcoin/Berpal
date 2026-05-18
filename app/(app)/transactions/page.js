/**
 * /transactions — merged stream of all four accounting doctypes, newest first.
 * URL-state pagination: ?page=N (1-based). Filter params will plug into the
 * same URL pattern when added (?type=, ?from=, ?to=, ?q=).
 */

import { getAppContext } from '../_lib/context';
import { listRecentTransactions, countRecentTransactions } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import TransactionsTable from '../_components/TransactionsTable';
import Pagination from '../_components/Pagination';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function TransactionsPage({ searchParams }) {
  const params = (await searchParams) || {};
  const page = Math.max(1, parseInt(params.page, 10) || 1);

  const { user, erp } = await getAppContext();

  const [pageResult, total] = await Promise.all([
    listRecentTransactions(user, erp, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => ({ rows: [], hasMore: false })),
    countRecentTransactions(user, erp).catch(() => 0),
  ]);

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="All invoices, purchases, payments and journal entries — newest first."
      />

      <Card>
        {pageResult.rows.length === 0 ? (
          <Empty
            title={page === 1 ? 'No transactions yet' : 'Nothing on this page'}
            hint={page === 1 ? 'Send the bot a message on WhatsApp to get started.' : 'Try going back to page 1.'}
          />
        ) : (
          <TransactionsTable rows={pageResult.rows} defaultCurrency={user.default_currency} />
        )}

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          basePath="/transactions"
        />
      </Card>
    </>
  );
}

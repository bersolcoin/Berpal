/**
 * /transactions — merged stream of all four accounting doctypes, newest first.
 * URL-state pagination + filters: ?page=N + ?type= + ?from= + ?to= + ?q=
 * Pagination preserves all filter params automatically.
 */

import { getAppContext } from '../_lib/context';
import { listRecentTransactions, countRecentTransactions } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import Empty from '../_components/Empty';
import TransactionsTable from '../_components/TransactionsTable';
import Pagination from '../_components/Pagination';
import TransactionFilters from './TransactionFilters';
import NewTransactionMenu from './NewTransactionMenu';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function TransactionsPage({ searchParams }) {
  const params = (await searchParams) || {};
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const filters = {
    type: typeof params.type === 'string' ? params.type : '',
    from: typeof params.from === 'string' ? params.from : '',
    to:   typeof params.to === 'string' ? params.to : '',
    q:    typeof params.q === 'string' ? params.q : '',
  };
  const hasPostFilters = !!(filters.type || filters.q);

  const { user, erp } = await getAppContext();

  const [pageResult, total] = await Promise.all([
    listRecentTransactions(user, erp, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      filters,
    }).catch(() => ({ rows: [], hasMore: false })),
    countRecentTransactions(user, erp, { filters }).catch(() => 0),
  ]);

  // Pagination's "Showing X-Y of Z" is only accurate when post-filters
  // (type/q) aren't active. When they are, hide the total — the count
  // is the pre-filter date-range universe, not the filtered slice.
  const totalForPagination = hasPostFilters ? null : total;

  // Preserve filter params on every pagination link so navigating pages
  // doesn't drop the active filter.
  const pageQuery = {};
  if (filters.type) pageQuery.type = filters.type;
  if (filters.from) pageQuery.from = filters.from;
  if (filters.to) pageQuery.to = filters.to;
  if (filters.q) pageQuery.q = filters.q;

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="All invoices, purchases, payments and journal entries — newest first."
        right={<NewTransactionMenu />}
      />

      <TransactionFilters />

      <Card>
        {pageResult.rows.length === 0 ? (
          <Empty
            title={page === 1 ? 'No transactions match' : 'Nothing on this page'}
            hint={
              page === 1
                ? hasPostFilters
                  ? 'Try clearing or relaxing the filters.'
                  : 'Send the bot a message on WhatsApp to get started.'
                : 'Try going back to page 1.'
            }
          />
        ) : (
          <TransactionsTable rows={pageResult.rows} defaultCurrency={user.default_currency} abbr={user.erpnext_company_abbr} />
        )}

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={totalForPagination ?? pageResult.rows.length + (pageResult.hasMore ? 1 : 0)}
          basePath="/transactions"
          query={pageQuery}
        />
      </Card>
    </>
  );
}

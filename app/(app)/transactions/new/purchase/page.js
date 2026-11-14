/**
 * /transactions/new/purchase — record a purchase (supplier bill) from the
 * web. Loads the pick-lists server-side; the form itself is client-side
 * and posts to /api/purchases.
 */

import { getAppContext } from '../../../_lib/context';
import { getCashBankBalance } from '../../../../../src/erp-query/cash-bank-balance';
import { listVarieties, loadCategoryFields } from '../../../../../src/catalog';
import PageHeader from '../../../_components/PageHeader';
import PurchaseForm from './PurchaseForm';

export const dynamic = 'force-dynamic';

export default async function NewPurchasePage() {
  const { user, erp } = await getAppContext();
  const [suppliers, balances, varieties] = await Promise.all([
    erp
      .listResource('Supplier', {
        filters: [['disabled', '=', 0]],
        fields: ['name', 'supplier_name'],
        limit: 500,
        orderBy: 'supplier_name asc',
      })
      .then((r) => (r.data || []).map((s) => s.supplier_name || s.name))
      .catch(() => []),
    getCashBankBalance(user, erp).catch(() => ({ wallets: [] })),
    listVarieties(user.id),
  ]);

  // Detail fields per category (catalog-defined).
  const categoryIds = [...new Set(varieties.map((v) => v.category_id))];
  const schemas = Object.fromEntries(
    await Promise.all(
      categoryIds.map(async (id) => [id, await loadCategoryFields(id)])
    )
  );

  const wallets = balances.wallets.map((w) => ({
    account: w.erpnext_name,
    name: w.account_name,
    type: w.account_type,
    currency: w.currency,
    balance: w.balance,
  }));

  return (
    <>
      <PageHeader back="/transactions" backLabel="Back to Transactions" title="New purchase" subtitle="Record lots bought from a supplier." />
      <PurchaseForm
        suppliers={suppliers}
        wallets={wallets}
        schemas={schemas}
        varieties={varieties}
        defaultCurrency={user.default_currency}
      />
    </>
  );
}

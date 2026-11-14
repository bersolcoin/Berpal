/**
 * /inventory/settings — the product categories Caratpal supports (gear on
 * /inventory). Cards with an Active toggle (at least one stays active);
 * each opens /inventory/settings/category/<key>. The catalog itself is
 * admin-only — businesses switch categories on/off and send requests.
 */

import { getAppContext } from '../../_lib/context';
import { listCategories, listVarieties, loadCategoryFields, listRequests, UNITS } from '../../../../src/catalog';
import PageHeader from '../../_components/PageHeader';
import CategoriesManager from './CategoriesManager';

export const dynamic = 'force-dynamic';

export default async function InventorySettingsPage() {
  const { user } = await getAppContext();
  const [categories, varieties, requests] = await Promise.all([
    listCategories(user.id),
    listVarieties(user.id, { allCategories: true }),
    listRequests(user.id),
  ]);
  const counts = Object.fromEntries(
    await Promise.all(
      categories
        .filter((c) => c.id)
        .map(async (c) => [
          c.key,
          {
            varieties: varieties.filter((v) => v.category_id === c.id).length,
            fields: (await loadCategoryFields(c.id)).length,
          },
        ])
    )
  );

  return (
    <>
      <PageHeader
        back="/inventory"
        backLabel="Back to Inventory"
        title="Product categories"
        subtitle="Categories Caratpal supports. Turn on the ones you deal in — at least one stays active."
      />
      <CategoriesManager initialCategories={categories} counts={counts} initialRequests={requests} units={UNITS} />
    </>
  );
}

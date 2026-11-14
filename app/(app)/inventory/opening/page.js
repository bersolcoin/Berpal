/**
 * /inventory/opening — add opening stock: lots the business already holds
 * that didn't come from a purchase in Caratpal. Valued at cost in the
 * company currency. Posts to /api/inventory/opening.
 */

import { getAppContext } from '../../_lib/context';
import { listVarieties, loadCategoryFields } from '../../../../src/catalog';
import PageHeader from '../../_components/PageHeader';
import OpeningStockForm from './OpeningStockForm';

export const dynamic = 'force-dynamic';

export default async function OpeningStockPage() {
  const { user } = await getAppContext();
  const varieties = await listVarieties(user.id);
  const categoryIds = [...new Set(varieties.map((v) => v.category_id))];
  const schemas = Object.fromEntries(
    await Promise.all(categoryIds.map(async (id) => [id, await loadCategoryFields(id)]))
  );

  return (
    <>
      <PageHeader
        back="/inventory"
        backLabel="Back to Inventory"
        title="Opening stock"
        subtitle="Lots you already hold that didn’t come from a purchase here — e.g. stock on hand when you started, or lots from your old system."
      />
      <OpeningStockForm varieties={varieties} schemas={schemas} currency={user.default_currency} />
    </>
  );
}

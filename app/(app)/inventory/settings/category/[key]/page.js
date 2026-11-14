/**
 * /inventory/settings/category/[key] — one catalog category: header with
 * the Active toggle, and view-only Varieties | Attributes tabs (?tab=attributes).
 */

import { notFound } from 'next/navigation';
import { getAppContext } from '../../../../_lib/context';
import {
  listCategories,
  listVarieties,
  loadCategoryFields,
  listRequests,
  UNITS,
  FIELD_TYPES,
} from '../../../../../../src/catalog';
import CategoryDetail from './CategoryDetail';

export const dynamic = 'force-dynamic';

export default async function CategoryPage({ params, searchParams }) {
  const { key } = await params;
  const sp = (await searchParams) || {};
  const { user } = await getAppContext();

  const categories = await listCategories(user.id);
  const category = categories.find((c) => c.key === key && !c.comingSoon);
  if (!category) notFound();

  const [varieties, fields, requests] = await Promise.all([
    listVarieties(user.id, { allCategories: true }).then((vs) => vs.filter((v) => v.category_id === category.id)),
    loadCategoryFields(category.id),
    listRequests(user.id),
  ]);
  const template = category.attribute_set || category.name;

  return (
    <>
      <CategoryDetail
        category={category}
        othersActive={categories.filter((c) => c.enabled && c.key !== key).length}
        varieties={varieties}
        fields={fields}
        initialRequests={requests.filter((r) => r.template === template)}
        tab={sp.tab === 'attributes' ? 'attributes' : 'varieties'}
        units={UNITS}
        fieldTypes={FIELD_TYPES}
      />
    </>
  );
}

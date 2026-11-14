'use client';

/**
 * One category's page: [←] title (unit + counts, Active toggle on the right),
 * Varieties | Attributes tabs as links (?tab=), and this category's requests.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Stack, SlidersHorizontal } from '@phosphor-icons/react';
import {
  CategoryToggle,
  VarietiesView,
  AttributesView,
  RequestsList,
  unitWord,
} from '../../CatalogViews';
import PageHeader from '../../../../_components/PageHeader';

export default function CategoryDetail({ category, othersActive, varieties, fields, initialRequests, tab, units, fieldTypes }) {
  const [requests, setRequests] = useState(initialRequests);
  const base = `/inventory/settings/category/${category.key}`;
  const onRequested = (r) => setRequests((rs) => [r, ...rs]);
  const tabClass = (t) =>
    `inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-md transition ${
      tab === t ? 'bg-white text-slate-900 shadow-sm font-medium' : 'text-slate-600 hover:text-slate-900'
    }`;

  return (
    <div className="max-w-5xl">
      <PageHeader
        back="/inventory/settings"
        backLabel="Back to Product categories"
        title={category.name}
        subtitle={`Priced per ${unitWord(units, category.uom)} · ${varieties.length} varieties · ${fields.length} attributes`}
        right={<CategoryToggle category={category} othersActive={othersActive} />}
      />

      <nav className="inline-flex p-1 mb-5 rounded-lg bg-slate-100" aria-label="Category sections">
        <Link href={base} className={tabClass('varieties')} aria-current={tab === 'varieties' ? 'page' : undefined}>
          <Stack size={15} /> Varieties
        </Link>
        <Link href={`${base}?tab=attributes`} className={tabClass('attributes')} aria-current={tab === 'attributes' ? 'page' : undefined}>
          <SlidersHorizontal size={15} /> Attributes
        </Link>
      </nav>

      <section className="bg-white border border-[var(--color-border)] rounded-xl px-5 py-4 mb-5">
        {tab === 'attributes' ? (
          <AttributesView category={category} fields={fields} fieldTypes={fieldTypes} onRequested={onRequested} />
        ) : (
          <VarietiesView category={category} varieties={varieties} onRequested={onRequested} />
        )}
      </section>

      <RequestsList requests={requests} />
    </div>
  );
}

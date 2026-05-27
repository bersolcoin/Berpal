/**
 * /todos — pending follow-up questions about past transactions.
 *
 * Triggers across the app (e.g. sales-invoice.js → unknown_item_purchase)
 * enqueue rows into the todos table. The user resolves them at their pace,
 * either here or by asking the bot ("any todos?"). No nagging — these
 * never get pushed; the user always pulls.
 *
 * This first slice is read-only: shows the question + a link to the
 * source doc. Per-kind resolution forms come in the next slice.
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listTodos } from '../../../src/todos';
import PageHeader from '../_components/PageHeader';
import Empty from '../_components/Empty';
import { friendlyAccountName } from '../_components/format';

export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  unknown_item_purchase: 'Missing purchase record',
};

function relatedHref(doctype, name) {
  if (!doctype || !name) return null;
  return `/transactions/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
}

export default async function TodosPage() {
  const { user } = await getAppContext();
  const rows = await listTodos(user.id, { limit: 200 }).catch(() => []);

  return (
    <>
      <PageHeader
        title="Todos"
        subtitle={
          rows.length > 0
            ? `${rows.length} pending follow-up${rows.length === 1 ? '' : 's'}.`
            : 'Nothing pending. New follow-ups show up here when transactions need extra context.'
        }
      />

      {rows.length === 0 ? (
        <div className="bg-white border border-[var(--color-border)] rounded-xl">
          <Empty
            title="All caught up"
            hint="When something needs your attention (e.g. a sale of an item with no purchase record), it'll appear here for you to fill in at your pace."
          />
        </div>
      ) : (
        <div className="bg-white border border-[var(--color-border)] rounded-xl divide-y divide-[var(--color-border)]">
          {rows.map((t) => {
            const sourceHref = relatedHref(t.related_doctype, t.related_name);
            return (
              <div key={t.id} className="p-4 sm:p-5 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded">
                    {KIND_LABEL[t.kind] || t.kind}
                  </span>
                  <span className="text-xs text-slate-400 whitespace-nowrap">
                    {new Date(t.created_at).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <p className="text-sm text-slate-800 leading-relaxed">{t.bot_prompt}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
                  <Link
                    href={`/todos/${t.id}`}
                    className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
                  >
                    Resolve →
                  </Link>
                  {sourceHref && (
                    <Link
                      href={sourceHref}
                      className="inline-block text-xs text-[var(--color-brand-accent)] hover:underline"
                    >
                      {t.related_doctype}: {friendlyAccountName(t.related_name) || t.related_name}
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

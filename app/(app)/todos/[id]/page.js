/**
 * /todos/[id] — resolution form for one pending TODO.
 *
 * Server component: loads the todo + the wallet list (for the "paid_from"
 * dropdown on the Bought-after-Berpal branch) and hands them to the
 * client-side form.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../_lib/context';
import { getTodo } from '../../../../src/todos';
import PageHeader from '../../_components/PageHeader';
import ResolveForm from './ResolveForm';
import ResolveLinkPaymentForm from './ResolveLinkPaymentForm';

export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  unknown_item_purchase: 'Missing purchase record',
  unrecorded_link_payment: 'Payment to record',
};

export default async function TodoDetailPage({ params }) {
  const { id: idParam } = await params;
  const todoId = parseInt(idParam, 10);
  if (!todoId) notFound();

  const { user, erp } = await getAppContext();
  const todo = await getTodo(user.id, todoId);
  if (!todo) notFound();

  // Wallets (Cash / Bank / Credit Card leaves) and the supplier list.
  // Independent try/catch so one failure doesn't blank the other —
  // earlier they were Promise.all'd which made a Supplier-side error
  // also wipe the wallet dropdown.
  let wallets = [];
  let suppliers = [];
  try {
    const r = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_type', 'in', ['Cash', 'Bank', 'Credit Card']],
        ['is_group', '=', 0],
      ],
      fields: ['name', 'account_name', 'account_type', 'account_currency'],
      limit: 100,
    });
    wallets = (r.data || []).map((w) => ({
      erpnext_name: w.name,
      account_name: w.account_name,
      account_type: w.account_type,
      currency: w.account_currency,
    }));
    console.log(`[todos/[id]] loaded ${wallets.length} wallet account(s)`);
  } catch (err) {
    console.warn('[todos/[id]] wallet list failed:', err.message);
  }
  try {
    const r = await erp.listResource('Supplier', {
      fields: ['name', 'supplier_name', 'default_currency'],
      orderBy: 'supplier_name asc',
      limit: 500,
    });
    suppliers = (r.data || []).map((s) => ({
      erpnext_name: s.name,
      supplier_name: s.supplier_name,
      default_currency: s.default_currency || null,
    }));
    console.log(`[todos/[id]] loaded ${suppliers.length} supplier(s)`);
  } catch (err) {
    console.warn('[todos/[id]] supplier list failed:', err.message);
  }

  return (
    <>
      <PageHeader
        title="Resolve todo"
        subtitle={KIND_LABEL[todo.kind] || todo.kind}
        right={
          <Link
            href="/todos"
            className="text-sm text-[var(--color-ink-muted)] hover:text-slate-900"
          >
            ← Back to todos
          </Link>
        }
      />

      <div className="bg-white border border-[var(--color-border)] rounded-xl p-5 mb-4">
        <p className="text-sm text-slate-800 leading-relaxed">{todo.bot_prompt}</p>
        {todo.related_doctype && todo.related_name && (
          <Link
            href={`/transactions/${encodeURIComponent(todo.related_doctype)}/${encodeURIComponent(todo.related_name)}`}
            className="mt-2 inline-block text-xs text-[var(--color-brand-accent)] hover:underline"
          >
            View source: {todo.related_doctype} {todo.related_name} →
          </Link>
        )}
      </div>

      {todo.kind === 'unrecorded_link_payment' ? (
        <ResolveLinkPaymentForm
          todoId={todo.id}
          payload={todo.payload}
          wallets={wallets}
        />
      ) : (
        <ResolveForm
          todoId={todo.id}
          kind={todo.kind}
          payload={todo.payload}
          wallets={wallets}
          suppliers={suppliers}
          defaultCurrency={user.default_currency || 'USD'}
          reportingCurrency={user.reporting_currency || user.default_currency || 'USD'}
        />
      )}
    </>
  );
}

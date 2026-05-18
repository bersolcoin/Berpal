/**
 * /transactions/[doctype]/[name]
 *
 * Detail view for any of the four accounting doctypes. Doctype slug is the
 * literal ERPNext name URL-encoded ("Sales Invoice", "Payment Entry", ...).
 * Renders different inner content per type but shares a common header.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppContext } from '../../../_lib/context';
import PageHeader from '../../../_components/PageHeader';
import Card from '../../../_components/Card';
import { money, date, friendlyAccountName, friendlyPartyName } from '../../../_components/format';

export const dynamic = 'force-dynamic';

const SUPPORTED = new Set(['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry']);

export default async function TransactionDetail({ params }) {
  const { doctype: dtParam, name: nameParam } = await params;
  const doctype = decodeURIComponent(dtParam);
  const name = decodeURIComponent(nameParam);

  if (!SUPPORTED.has(doctype)) notFound();

  const { erp } = await getAppContext();

  let doc;
  try {
    const r = await erp.getResource(doctype, name);
    doc = r.data;
  } catch (err) {
    if (err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <PageHeader
        title={titleFor(doctype, doc)}
        subtitle={
          <span>
            <Link href="/transactions" className="text-[var(--color-brand-accent)] hover:underline">
              Transactions
            </Link>
            {' / '}
            <span className="font-mono text-xs">{name}</span>
          </span>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {headerStats(doctype, doc).map((s) => (
          <Card key={s.label}>
            <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">{s.label}</div>
            <div className="text-xl font-semibold mt-1.5 tabular text-slate-900">{s.value}</div>
            {s.sub && <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{s.sub}</div>}
          </Card>
        ))}
      </div>

      {doctype === 'Sales Invoice' || doctype === 'Purchase Invoice' ? (
        <InvoiceDetail doc={doc} />
      ) : doctype === 'Payment Entry' ? (
        <PaymentDetail doc={doc} />
      ) : (
        <JournalDetail doc={doc} />
      )}
    </>
  );
}

function titleFor(doctype, doc) {
  if (doctype === 'Sales Invoice') return `Invoice — ${friendlyPartyName(doc.customer)}`;
  if (doctype === 'Purchase Invoice') return `Purchase — ${friendlyPartyName(doc.supplier)}`;
  if (doctype === 'Payment Entry') {
    const verb = doc.payment_type === 'Receive' ? 'Receipt from' : 'Payment to';
    return `${verb} ${friendlyPartyName(doc.party) || ''}`.trim();
  }
  if (doctype === 'Journal Entry') return doc.title || `Cash entry`;
  return doctype;
}

function headerStats(doctype, doc) {
  const stats = [];
  if (doctype === 'Sales Invoice' || doctype === 'Purchase Invoice') {
    stats.push({ label: 'Total', value: money(doc.grand_total, doc.currency) });
    stats.push({
      label: 'Outstanding',
      value: money(doc.outstanding_amount, doc.currency),
      sub: doc.outstanding_amount > 0 ? `Due ${date(doc.due_date)}` : 'Settled',
    });
    stats.push({ label: 'Posted', value: date(doc.posting_date), sub: doc.status });
  } else if (doctype === 'Payment Entry') {
    const ccy = doc.payment_type === 'Receive' ? doc.paid_from_account_currency : doc.paid_to_account_currency;
    stats.push({ label: 'Amount', value: money(doc.paid_amount, ccy) });
    stats.push({ label: 'Posted', value: date(doc.posting_date) });
    stats.push({ label: 'Status', value: doc.docstatus === 0 ? 'Draft' : 'Submitted' });
  } else if (doctype === 'Journal Entry') {
    stats.push({ label: 'Total', value: Number(doc.total_debit || 0).toLocaleString() });
    stats.push({ label: 'Posted', value: date(doc.posting_date) });
    stats.push({ label: 'Status', value: doc.docstatus === 0 ? 'Draft' : 'Submitted' });
  }
  return stats;
}

function InvoiceDetail({ doc }) {
  const items = doc.items || [];
  const taxes = doc.taxes || [];
  return (
    <>
      <Card title="Line items">
        {items.length === 0 ? (
          <div className="text-sm text-[var(--color-ink-muted)]">No line items.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                <th className="font-medium pb-2 pr-4">Item</th>
                <th className="font-medium pb-2 pr-4">Description</th>
                <th className="font-medium pb-2 pr-4 text-right">Qty</th>
                <th className="font-medium pb-2 pr-4 text-right">Rate</th>
                <th className="font-medium pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {items.map((it) => (
                <tr key={it.name}>
                  <td className="py-2 pr-4 font-mono text-xs">{it.item_code}</td>
                  <td className="py-2 pr-4">{it.description?.replace(/<[^>]*>/g, '') || it.item_name}</td>
                  <td className="py-2 pr-4 text-right tabular">{it.qty}</td>
                  <td className="py-2 pr-4 text-right tabular">{money(it.rate, doc.currency)}</td>
                  <td className="py-2 text-right tabular">{money(it.amount, doc.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--color-border)]">
                <td colSpan={4} className="py-2 pr-4 text-right text-sm font-medium">Total</td>
                <td className="py-2 text-right tabular font-semibold">{money(doc.grand_total, doc.currency)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      {doc.conversion_rate && doc.conversion_rate !== 1 && (
        <div className="mt-4 text-xs text-[var(--color-ink-muted)]">
          Exchange rate at posting: 1 {doc.currency} = {doc.conversion_rate} {doc.company_currency || ''}
        </div>
      )}

      {taxes.length > 0 && (
        <Card title="Taxes" className="mt-4">
          <ul className="text-sm space-y-1">
            {taxes.map((t) => (
              <li key={t.name} className="flex justify-between">
                <span>{t.description}</span>
                <span className="tabular">{money(t.tax_amount, doc.currency)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function PaymentDetail({ doc }) {
  const refs = doc.references || [];
  const ccy = doc.payment_type === 'Receive' ? doc.paid_from_account_currency : doc.paid_to_account_currency;
  return (
    <>
      <Card title="Money movement">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">From</div>
            <div className="mt-1.5 font-medium">{friendlyAccountName(doc.paid_from)}</div>
            <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{doc.paid_from_account_currency}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">To</div>
            <div className="mt-1.5 font-medium">{friendlyAccountName(doc.paid_to)}</div>
            <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{doc.paid_to_account_currency}</div>
          </div>
        </div>
        {doc.source_exchange_rate && doc.source_exchange_rate !== 1 && (
          <div className="mt-4 text-xs text-[var(--color-ink-muted)]">
            Conversion rate: 1 {doc.paid_from_account_currency} = {doc.source_exchange_rate} {doc.paid_to_account_currency}
          </div>
        )}
      </Card>

      {refs.length > 0 && (
        <Card title="Allocated to" className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                <th className="font-medium pb-2 pr-4">Reference</th>
                <th className="font-medium pb-2 pr-4">Type</th>
                <th className="font-medium pb-2 text-right">Allocated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {refs.map((r) => (
                <tr key={r.name}>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/transactions/${encodeURIComponent(r.reference_doctype)}/${encodeURIComponent(r.reference_name)}`}
                      className="text-[var(--color-brand-accent)] hover:underline font-mono text-xs"
                    >
                      {r.reference_name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-xs">{r.reference_doctype}</td>
                  <td className="py-2 text-right tabular">{money(r.allocated_amount, ccy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function JournalDetail({ doc }) {
  const accounts = doc.accounts || [];
  return (
    <Card title="Account entries">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            <th className="font-medium pb-2 pr-4">Account</th>
            <th className="font-medium pb-2 pr-4 text-right">Debit</th>
            <th className="font-medium pb-2 text-right">Credit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {accounts.map((a) => (
            <tr key={a.name}>
              <td className="py-2 pr-4">
                <Link
                  href={`/accounts/${encodeURIComponent(a.account)}`}
                  className="hover:text-[var(--color-brand-accent)]"
                >
                  {friendlyAccountName(a.account)}
                </Link>
                <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{a.account_currency}</div>
              </td>
              <td className="py-2 pr-4 text-right tabular">{a.debit_in_account_currency ? money(a.debit_in_account_currency, a.account_currency) : ''}</td>
              <td className="py-2 text-right tabular">{a.credit_in_account_currency ? money(a.credit_in_account_currency, a.account_currency) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.user_remark && (
        <div className="mt-4 pt-3 border-t border-[var(--color-border)] text-sm">
          <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide mb-1">Remark</div>
          {doc.user_remark}
        </div>
      )}
    </Card>
  );
}

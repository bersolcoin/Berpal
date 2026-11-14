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
import { money, date, friendlyAccountName, friendlyPartyName, friendlyItemCode, friendlyTitle } from '../../../_components/format';
import { PencilSimple } from '@phosphor-icons/react/dist/ssr';
import DeleteButton from './DeleteButton';

export const dynamic = 'force-dynamic';

const SUPPORTED = new Set(['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry']);

export default async function TransactionDetail({ params }) {
  const { doctype: dtParam, name: nameParam } = await params;
  const doctype = decodeURIComponent(dtParam);
  const name = decodeURIComponent(nameParam);

  if (!SUPPORTED.has(doctype)) notFound();

  const { user, erp } = await getAppContext();

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
      <PageHeader back="/transactions" backLabel="Back to Transactions"
        title={titleFor(doctype, doc, user.erpnext_company_abbr)}
        subtitle={<span className="font-mono text-xs">{name}</span>}
        right={
          <>
            {/* Editing a submitted voucher = cancel + amend — not built yet. */}
            <button
              type="button"
              disabled
              title="Editing coming soon"
              className="inline-flex items-center gap-1.5 h-10 px-3 text-sm text-slate-400 rounded-lg border border-slate-200 bg-white cursor-not-allowed"
            >
              <PencilSimple size={14} /> Edit
            </button>
            <DeleteButton doctype={doctype} name={name} />
          </>
        }
      />

      <SummaryStrip {...headerStats(doctype, doc, user.default_currency)} />

      {doctype === 'Sales Invoice' || doctype === 'Purchase Invoice' ? (
        <InvoiceDetail doc={doc} abbr={user.erpnext_company_abbr} />
      ) : doctype === 'Payment Entry' ? (
        <PaymentDetail doc={doc} abbr={user.erpnext_company_abbr} />
      ) : (
        <JournalDetail doc={doc} abbr={user.erpnext_company_abbr} companyCurrency={user.default_currency} />
      )}
    </>
  );
}

function titleFor(doctype, doc, abbr) {
  if (doctype === 'Sales Invoice') return `Invoice — ${friendlyPartyName(doc.customer, abbr)}`;
  if (doctype === 'Purchase Invoice') return `Purchase — ${friendlyPartyName(doc.supplier, abbr)}`;
  if (doctype === 'Payment Entry') {
    const verb = doc.payment_type === 'Receive' ? 'Receipt from' : 'Payment to';
    return `${verb} ${friendlyPartyName(doc.party, abbr) || ''}`.trim();
  }
  if (doctype === 'Journal Entry') return friendlyTitle(doc.title, abbr) || `Cash entry`;
  return doctype;
}

/**
 * Compact one-line summary: label-over-value items with dividers on the
 * left, the status pill on the right (vertically centred, no label).
 * Fixed line boxes (label 16px, value 20px) keep top and bottom padding equal.
 */
function SummaryStrip({ items, status }) {
  return (
    <div className="flex flex-wrap items-stretch mb-5 bg-white border border-[var(--color-border)] rounded-xl">
      <div className="flex flex-wrap items-stretch divide-x divide-[var(--color-border)]">
        {items.map((s) => (
          <div key={s.label} className="px-5 py-3 min-w-[140px] flex flex-col justify-center">
            <div className="text-[11px] leading-4 uppercase tracking-wide text-[var(--color-ink-muted)]">{s.label}</div>
            <div className="mt-1 h-5 flex items-center gap-1.5 text-sm leading-5 font-semibold tabular text-slate-900 whitespace-nowrap">
              {s.value}
              {s.sub && <span className="text-xs font-normal text-[var(--color-ink-muted)]">{s.sub}</span>}
            </div>
          </div>
        ))}
      </div>
      {status && (
        <div className="ml-auto px-5 py-3 flex items-center">
          <StatusPill status={status} />
        </div>
      )}
    </div>
  );
}

// Draft grey · pending (unpaid / partly paid / overdue) yellow ·
// submitted / paid green · cancelled red.
const STATUS_TONE = {
  Draft: 'bg-slate-100 text-slate-600',
  Submitted: 'bg-emerald-50 text-emerald-700',
  Paid: 'bg-emerald-50 text-emerald-700',
  Completed: 'bg-emerald-50 text-emerald-700',
  Unpaid: 'bg-amber-50 text-amber-800',
  'Partly Paid': 'bg-amber-50 text-amber-800',
  Overdue: 'bg-amber-50 text-amber-800',
  Pending: 'bg-amber-50 text-amber-800',
  Cancelled: 'bg-red-50 text-red-700',
};

function StatusPill({ status }) {
  return (
    <span className={`inline-flex items-center h-7 px-3 rounded-full text-xs font-medium ${STATUS_TONE[status] || 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
}

function statusLabel(doc) {
  return doc.docstatus === 0 ? 'Draft' : doc.docstatus === 2 ? 'Cancelled' : 'Submitted';
}

// Items: Posted, then the money figures. Status is returned separately
// (shown as a pill at the strip's right end).
function headerStats(doctype, doc, companyCurrency) {
  const items = [{ label: 'Posted', value: date(doc.posting_date) }];
  let status = statusLabel(doc);
  if (doctype === 'Sales Invoice' || doctype === 'Purchase Invoice') {
    if (doc.docstatus === 1) status = doc.status || 'Submitted';
    items.push({ label: 'Total', value: money(doc.grand_total, doc.currency) });
    items.push({
      label: 'Outstanding',
      value: money(doc.outstanding_amount, doc.currency),
      sub: doc.outstanding_amount > 0 ? `Due ${date(doc.due_date)}` : 'Settled',
    });
  } else if (doctype === 'Payment Entry') {
    const ccy = doc.payment_type === 'Receive' ? doc.paid_from_account_currency : doc.paid_to_account_currency;
    items.push({ label: 'Amount', value: money(doc.paid_amount, ccy) });
  } else if (doctype === 'Journal Entry') {
    // Journal totals are in the company currency.
    items.push({ label: 'Total', value: money(doc.total_debit || 0, companyCurrency) });
  }
  return { items, status };
}

function InvoiceDetail({ doc, abbr }) {
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
                  <td className="py-2 pr-4 font-mono text-xs">{friendlyItemCode(it.item_code, abbr)}</td>
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

function PaymentDetail({ doc, abbr }) {
  const refs = doc.references || [];
  const ccy = doc.payment_type === 'Receive' ? doc.paid_from_account_currency : doc.paid_to_account_currency;
  return (
    <>
      <Card title="Money movement">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">From</div>
            <div className="mt-1.5 font-medium">{friendlyAccountName(doc.paid_from, abbr)}</div>
            <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{doc.paid_from_account_currency}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-ink-muted)] uppercase tracking-wide">To</div>
            <div className="mt-1.5 font-medium">{friendlyAccountName(doc.paid_to, abbr)}</div>
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

function JournalDetail({ doc, abbr, companyCurrency }) {
  const accounts = doc.accounts || [];
  // A line in another currency shows its own amount, then rate + company value.
  const amountCell = (a, side) => {
    const own = side === 'debit' ? a.debit_in_account_currency : a.credit_in_account_currency;
    const base = side === 'debit' ? a.debit : a.credit;
    if (!own) return null;
    const foreign = a.account_currency && a.account_currency !== companyCurrency;
    return (
      <>
        <div>{money(own, a.account_currency || companyCurrency)}</div>
        {foreign && (
          <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            @ {Number(a.exchange_rate || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} = {money(base, companyCurrency)}
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <Card title="Account entries" className="mb-5">
        <div className="overflow-x-auto -mx-5">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                <th className="font-medium pb-2 pl-5 pr-4">Account</th>
                <th className="font-medium pb-2 pr-4 text-right">Debit</th>
                <th className="font-medium pb-2 pr-5 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {accounts.map((a) => (
                <tr key={a.name} className="align-top">
                  <td className="py-2.5 pl-5 pr-4">
                    <Link href={`/accounts/${encodeURIComponent(a.account)}`} className="hover:text-[var(--color-brand-accent)]">
                      {friendlyAccountName(a.account, abbr)}
                    </Link>
                    <div className="text-xs text-[var(--color-ink-muted)] mt-0.5">{a.account_currency}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular">{amountCell(a, 'debit')}</td>
                  <td className="py-2.5 pr-5 text-right tabular">{amountCell(a, 'credit')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--color-border)] font-medium">
                <td className="py-2.5 pl-5 pr-4 text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Total ({companyCurrency})
                </td>
                <td className="py-2.5 pr-4 text-right tabular">{money(doc.total_debit || 0, companyCurrency)}</td>
                <td className="py-2.5 pr-5 text-right tabular">{money(doc.total_credit || 0, companyCurrency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {doc.user_remark && (
        <Card title="Remark">
          <p className="text-sm text-slate-700 whitespace-pre-line">{friendlyTitle(doc.user_remark, abbr)}</p>
        </Card>
      )}
    </>
  );
}

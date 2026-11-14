/**
 * /accounts — full chart of accounts grouped by root_type
 * (Asset, Liability, Equity, Income, Expense). Each leaf is a link to its
 * ledger view at /accounts/[name].
 */

import Link from 'next/link';
import { getAppContext } from '../_lib/context';
import { listAccounts } from '../../../src/erp-query';
import PageHeader from '../_components/PageHeader';
import Card from '../_components/Card';
import { friendlyAccountName, accountUrl } from '../_components/format';

export const dynamic = 'force-dynamic';

const ROOT_ORDER = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
const ROOT_TONE = {
  Asset: 'text-blue-700',
  Liability: 'text-amber-700',
  Equity: 'text-purple-700',
  Income: 'text-green-700',
  Expense: 'text-rose-700',
};

export default async function AccountsPage() {
  const { user, erp } = await getAppContext();
  const { groups } = await listAccounts(user, erp);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        subtitle="The full accounting structure for your business. Tap any account to see its ledger."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ROOT_ORDER.map((rt) => {
          const accounts = groups[rt] || [];
          if (accounts.length === 0) return null;
          return (
            <Card key={rt} title={<span className={`font-semibold ${ROOT_TONE[rt]}`}>{rt}</span>}>
              <AccountTree accounts={accounts} abbr={user.erpnext_company_abbr} />
            </Card>
          );
        })}
      </div>
    </>
  );
}

function AccountTree({ accounts, abbr }) {
  const byParent = new Map();
  for (const a of accounts) {
    const p = a.parent_account || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(a);
  }
  const erpNames = new Set(accounts.map((a) => a.erpnext_name));
  const roots = accounts.filter((a) => !a.parent_account || !erpNames.has(a.parent_account));

  return (
    <ul className="text-sm space-y-0.5">
      {roots.map((r) => (
        <Node key={r.erpnext_name} node={r} byParent={byParent} depth={0} abbr={abbr} />
      ))}
    </ul>
  );
}

function Node({ node, byParent, depth, abbr }) {
  const children = byParent.get(node.erpnext_name) || [];
  return (
    <li>
      <div
        className={`flex items-center justify-between py-1 ${
          node.is_group ? 'text-slate-700 font-medium' : 'text-slate-900'
        }`}
        style={{ paddingLeft: depth * 16 }}
      >
        {node.is_group ? (
          <span>{friendlyAccountName(node.erpnext_name, abbr)}</span>
        ) : (
          <Link
            href={accountUrl(node)}
            className="hover:text-[var(--color-brand-accent)] flex items-center gap-2"
          >
            <span>{friendlyAccountName(node.erpnext_name, abbr)}</span>
            {node.currency && (
              <span className="text-[10px] text-[var(--color-ink-muted)] font-normal">{node.currency}</span>
            )}
          </Link>
        )}
        {node.account_type && !node.is_group && (
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)]">{node.account_type}</span>
        )}
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <Node key={c.erpnext_name} node={c} byParent={byParent} depth={depth + 1} abbr={abbr} />
          ))}
        </ul>
      )}
    </li>
  );
}

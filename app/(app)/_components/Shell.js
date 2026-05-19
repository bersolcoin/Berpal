'use client';

/**
 * App shell chrome — handles sidebar rendering, active-link highlighting,
 * and the mobile hamburger drawer. The actual data fetching stays in the
 * server-side layout; this just lays out the chrome around `children`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  House,
  Tray,
  ArrowsLeftRight,
  Wallet,
  Receipt,
  Package,
  Briefcase,
  UsersThree,
  ListBullets,
  ListChecks,
  Gear,
  List,
  X,
  HandCoins,
  ShoppingBag,
} from '@phosphor-icons/react';
import LogoutButton from './LogoutButton';

/**
 * Nav items have an optional `showFor` set — controls which business_type
 * values reveal them. Items without `showFor` show for everyone.
 *
 *   product → has inventory; non-stocked items rarely
 *   service → has services; no physical goods
 *   both    → has both
 *   null/undefined (legacy) → show both as fallback
 */
const ICON_SIZE = 18;
const ICON_WEIGHT = 'regular';

const NAV = [
  { href: '/dashboard', label: 'Overview', Icon: House },
  { href: '/inbox', label: 'Inbox', Icon: Tray, badgeKey: 'pendingInboxCount', badgeTone: 'emerald' },
  { href: '/todos', label: 'Todos', Icon: ListChecks, badgeKey: 'pendingTodosCount', badgeTone: 'orange' },
  { href: '/transactions', label: 'Transactions', Icon: ArrowsLeftRight },
  { href: '/transactions?type=Invoice', label: 'Sales', Icon: HandCoins },
  { href: '/transactions?type=Purchase', label: 'Purchases', Icon: ShoppingBag },
  { href: '/wallets', label: 'Wallets', Icon: Wallet },
  { href: '/expenses', label: 'Expenses', Icon: Receipt },
  { href: '/inventory', label: 'Inventory', Icon: Package, showFor: new Set(['product', 'both', null]) },
  { href: '/services', label: 'Services', Icon: Briefcase, showFor: new Set(['service', 'both', null]) },
  { href: '/contacts', label: 'Contacts', Icon: UsersThree },
  { href: '/accounts', label: 'Accounts', Icon: ListBullets },
  { href: '/settings', label: 'Settings', Icon: Gear },
];

const BADGE_TONE = {
  emerald: 'bg-emerald-600 text-white',
  orange: 'bg-orange-500 text-white',
};

export default function Shell({ user, pendingInboxCount = 0, pendingTodosCount = 0, children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const badges = { pendingInboxCount, pendingTodosCount };
  const businessType = user.business_type || null;
  const visibleNav = NAV.filter(
    (item) => !item.showFor || item.showFor.has(businessType)
  );

  return (
    <div className="md:flex md:min-h-screen">
      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between bg-white border-b border-[var(--color-border)] px-4 py-3">
        <button
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
          className="p-2 -ml-2 rounded hover:bg-slate-100 text-slate-700"
        >
          <List size={20} weight={ICON_WEIGHT} />
        </button>
        <img src="/logo.svg" alt="Berpal" className="w-6 h-6" />
        <div className="w-10" /> {/* Spacer to balance hamburger */}
      </header>

      {/* Drawer backdrop (mobile only) */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-40"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — drawer on mobile, fixed column on md+ */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-50 w-64 md:w-60 shrink-0
          border-r border-[var(--color-border)] bg-white flex flex-col
          transform transition-transform md:transform-none
          ${drawerOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
      >
        <div className="px-5 py-5 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <img src="/logo.svg" alt="Berpal" className="w-6 h-6" />
            <div className="text-xs text-[var(--color-ink-muted)] mt-2 truncate max-w-[160px]">
              {user.erpnext_company}
            </div>
          </div>
          <button
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="md:hidden p-2 -mr-2 rounded hover:bg-slate-100 text-slate-500"
          >
            <X size={18} weight={ICON_WEIGHT} />
          </button>
        </div>

        <nav className="flex-1 px-2 py-4 overflow-y-auto">
          <ul className="space-y-0.5">
            {visibleNav.map((item) => {
              const active = isActive(pathname, searchParams, item.href);
              const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
              const Icon = item.Icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <Icon
                      size={ICON_SIZE}
                      weight={active ? 'fill' : ICON_WEIGHT}
                      className={active ? 'text-white' : 'text-slate-500'}
                    />
                    <span className="flex-1">{item.label}</span>
                    {badgeCount > 0 && (
                      <span
                        className={`shrink-0 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-[10px] leading-none font-semibold rounded-full ${
                          active ? 'bg-white text-slate-900' : (BADGE_TONE[item.badgeTone] || BADGE_TONE.emerald)
                        }`}
                      >
                        {badgeCount}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="px-3 py-3 border-t border-[var(--color-border)]">
          <div className="px-2 py-1 text-xs text-[var(--color-ink-muted)] truncate">
            {user.display_name || user.phone}
          </div>
          <LogoutButton />
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-8 py-6 md:py-8">{children}</div>
      </main>
    </div>
  );
}

/**
 * `/dashboard` matches exactly. Other top-level routes match their prefix
 * so /contacts/abc-trading still highlights "Contacts".
 *
 * Items can also encode a query (e.g. /transactions?type=Invoice for
 * "Sales"). When the href has a query, both pathname and the type filter
 * must match. The plain /transactions item then suppresses itself when
 * type is Invoice or Purchase so the more-specific item wins.
 */
function isActive(pathname, searchParams, href) {
  if (!pathname) return false;
  const [hrefPath, hrefQuery] = href.split('?');
  if (hrefPath === '/dashboard') return pathname === '/dashboard';

  const pathMatch = pathname === hrefPath || pathname.startsWith(hrefPath + '/');
  if (!pathMatch) return false;

  if (hrefQuery) {
    const wanted = new URLSearchParams(hrefQuery).get('type');
    return searchParams?.get('type') === wanted;
  }
  if (hrefPath === '/transactions') {
    const t = searchParams?.get('type');
    if (t === 'Invoice' || t === 'Purchase') return false;
  }
  return true;
}


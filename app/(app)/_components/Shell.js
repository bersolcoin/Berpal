'use client';

/**
 * App shell chrome — handles sidebar rendering, active-link highlighting,
 * and the mobile hamburger drawer. The actual data fetching stays in the
 * server-side layout; this just lays out the chrome around `children`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
const NAV = [
  { href: '/dashboard', label: 'Overview', icon: '◉' },
  { href: '/inbox', label: 'Inbox', icon: '✉', badgeKey: 'pendingInboxCount' },
  { href: '/transactions', label: 'Transactions', icon: '⇅' },
  { href: '/wallets', label: 'Wallets', icon: '⊙' },
  { href: '/expenses', label: 'Expenses', icon: '↓' },
  { href: '/inventory', label: 'Inventory', icon: '⊟', showFor: new Set(['product', 'both', null]) },
  { href: '/services', label: 'Services', icon: '◍', showFor: new Set(['service', 'both', null]) },
  { href: '/contacts', label: 'Contacts', icon: <PeopleIcon /> },
  { href: '/accounts', label: 'Accounts', icon: '☰' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Shell({ user, pendingInboxCount = 0, children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  const badges = { pendingInboxCount };
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
          <Hamburger />
        </button>
        <div className="text-base font-semibold tracking-tight">Berpal</div>
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
            <div className="text-xl font-semibold tracking-tight">Berpal</div>
            <div className="text-xs text-[var(--color-ink-muted)] mt-0.5 truncate max-w-[160px]">
              {user.erpnext_company}
            </div>
          </div>
          <button
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="md:hidden p-2 -mr-2 rounded hover:bg-slate-100 text-slate-500"
          >
            <Close />
          </button>
        </div>

        <nav className="flex-1 px-2 py-4 overflow-y-auto">
          <ul className="space-y-0.5">
            {visibleNav.map((item) => {
              const active = isActive(pathname, item.href);
              const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
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
                    <span
                      className={`w-4 text-center ${
                        active ? 'text-white' : 'text-slate-400'
                      }`}
                    >
                      {item.icon}
                    </span>
                    <span className="flex-1">{item.label}</span>
                    {badgeCount > 0 && (
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                          active ? 'bg-white text-slate-900' : 'bg-emerald-600 text-white'
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
 */
function isActive(pathname, href) {
  if (!pathname) return false;
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(href + '/');
}

function PeopleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.5" />
      <path d="M2 13.5c.5-2.5 2-4 4-4s3.5 1.5 4 4" />
      <circle cx="11" cy="4" r="1.8" />
      <path d="M10 9c1.8 0 3.4 1.4 4 4" />
    </svg>
  );
}

function Hamburger() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Close() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

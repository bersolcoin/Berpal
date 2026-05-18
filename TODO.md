# Berpal — TODO

Living roadmap. Tick `[x]` as items complete. Order top-down by priority.
Both Claude and you can read and update this file across sessions.

---

## 🚧 In progress

_(nothing right now — pick from "Upcoming" below)_

---

## 🧪 Just landed — needs end-to-end test

### Multi-tenancy hardening (Phase 1)
- Per-company Item Group "Items - <ABBR>" auto-created during `provisionTenant`
- Bot's `ensureGenericSalesItem` / `ensureGenericPurchaseItem` now tag created Items with the user's group
- Web `/inventory` and `/services` filter by the user's item group
- Company `abbr` is now collision-checked at provision time (`AG` → `AG2` if taken)
- New PG column `users.erpnext_company_abbr` (UNIQUE)
- Backfill script: `node scripts/backfill-company-abbr.js`

### Pending-invoices growth loop (Phase 2½)
- `linked_transactions.buyer_user_id` is now nullable; new `buyer_phone` column for matching unsigned-up phones
- When a seller sends a Sales Invoice to a phone with no matching Berpal user, row parked as `pending_buyer_signup`
- `provisionTenant` now ends with a `bindPendingByPhone` step — claims all parked invoices for the new user's phone and bumps them to `pending_buyer_confirmation`
- Onboarding response routes to `/inbox` instead of `/dashboard` when `pending_invoices_count > 0`
- New `/inbox` page lists pending invoices with Accept / Decline buttons per row
- Sidebar shows Inbox with a live count badge (green pill, refreshes on every page nav)
- API: `POST /api/links/[id]/confirm` and `POST /api/links/[id]/reject` — same code path as the WhatsApp accept/reject

### Linked transactions B2B flow (Phase 2)
- New PG table `linked_transactions` (seller doc + buyer doc + status + items)
- New PG column `counterparty_cache.linked_user_id` — set automatically when a counterparty's phone matches another Berpal user
- **/customers** and **/suppliers** show a green "⇄ Linked" badge for matched counterparties
- Sales Invoice handler: after posting, if customer is linked, inserts a `linked_transactions` row and sends a WhatsApp proposal to the buyer:
  > "🔗 Test Trading Company says they sold you: …
  >  Reply 'yes LINK-N' to accept or 'no LINK-N' to decline."
- Bot inbound: `tryHandleLinkCommand` intercepts buyer's `yes LINK-N` / `no LINK-N` reply BEFORE the LLM
- On accept: mirror Purchase Invoice created in buyer's ERPNext (resolves seller as Supplier, uses per-tenant GEN-PURCHASE item, per-currency Creditors account), `linked_transactions.status='confirmed'` with `buyer_doc_name`
- On reject: status='rejected', seller notified via WhatsApp
- Seller gets a confirmation/reject WhatsApp notification either way

**To test the linked B2B flow:**
1. Both test users (TTC user1 +66838883866, DG user2 +85258608836) must be joined to the Twilio WhatsApp sandbox
2. From TTC's WhatsApp: *"sold 5ct paraiba to Jameel for 2000 usd"* — but for testing, use Jameel's name with phone +85258608836 (so the bot's customer creation matches DG)
3. Confirm on TTC's side → DG receives the proposal message
4. DG replies *"yes LINK-1"* → mirror Purchase Invoice created in DG's ERPNext; both sides get a confirmation
5. Verify in `/transactions` on both accounts

---

## 📋 Upcoming

### 1. Multi-step onboarding with business-type capture ✅
**Why**: Tailor the UI to what the user actually does. Service businesses don't need an Inventory tab. ERPNext is always provisioned with `enable_perpetual_inventory: 1` so `business_type` is a pure UX flag — togglable later with zero ERPNext migration.

- [x] Update `provisionTenant`: always set `enable_perpetual_inventory: 1` on the new Company (regardless of business_type)
- [x] Add `business_type` column to `users` table (enum: `service` / `product` / `both`)
- [x] Add other onboarding columns: `entity_type`, `nature_of_business`, `tax_id`, `address_line1/2`, `city`, `state_province`, `postal_code`
- [x] Refactor `/onboarding` into 3 steps in one page (client state, no extra routes):
  - [x] Step 1: business type + entity type + business name + nature
  - [x] Step 2: country + currency + tax id + address (structured)
  - [x] Step 3: your name + email + cash wallet + 0..N banks (with opening balances)
  - [x] Back / Continue navigation with progress indicator
- [x] Pass full payload to `/api/onboarding` → persist all fields in same UPSERT
- [x] `getAppContext()` returns business_type + all onboarding fields alongside user
- [x] Surface `business_type` + new fields on `/settings` (read-only display; editable later in #8)
- [x] Reusable `CountryPicker` (flag dropdown for non-phone use) + `CurrencyPicker`
- [x] IP-detected country + auto-suggested default currency by country
- [x] Cash + bank accounts auto-created in ERPNext as part of provisioning
- [x] Opening balance JEs posted automatically when non-zero (FX-aware for non-default-currency wallets)

### 2. Conditional inventory + services menu ✅
- [x] Pass `business_type` from layout into `Shell.js`
- [x] Hide `/inventory` nav link when `business_type === 'service'`
- [x] Hide `/services` nav link when `business_type === 'product'`
- [x] `both` (and legacy null) show both
- [x] Added `scripts/set-business-type.js` for seeding test users

### 3. Inventory + Services pages (read-only, ERPNext-backed) ✅
- [x] New query helper `src/erp-query/items-list.js` — wraps ERPNext `Item` + `Bin`
- [x] New query helper `src/erp-query/item-detail.js` — header + bins per warehouse + Stock Ledger Entries + invoice appearances
- [x] `/inventory` list page (paginated 50/page, sticky stock column)
- [x] `/inventory/[code]` detail page (stock per warehouse, recent movements, sold/bought on)
- [x] `/services` list page (mirror of /inventory but non-stock)
- [x] `/services/[code]` detail page (header + recent invoice appearances)
- [ ] Search by code/name (URL `?q=`) — deferred to filters pass (#6)
- [ ] **Multi-tenancy note**: ERPNext Item is site-global, not company-scoped. All users currently see all items. Will need User Permissions or per-company Item Group during provisioning to fix.

### 4. Bot awareness of business_type
**Why**: Bot should not ask service users for SKU/qty; should not let product users sell without specifying an item.

- [ ] Bot reads `business_type` at conversation init (already in users table after #1)
- [ ] Prompt rules conditional on business_type
- [ ] Replace `GEN-SALE` placeholder Item with real Items from inventory for product/both
- [ ] `lookup_item` tool (parallel to `lookup_counterparty`) for product/both

### 5. Remaining ERPNext doctype handlers
- [ ] Transfer JE (wallet→wallet, single user) — uses existing `buildJournalTitle` helper
- [ ] Advance Payment Entry (`advance_given` / `advance_received`)

### 6. Filters + pagination on more list pages
- [ ] `/transactions` filters: `?type=`, `?from=`, `?to=`, `?q=` (Pagination component already preserves query)
- [ ] `/customers`, `/suppliers`, `/expenses` — add `?q=` search + pagination
- [ ] `/accounts/[name]` ledger — paginate (currently capped at 200 entries)

### 7. Live OTP delivery (Meta approval pending)
- [ ] Twilio Content Template `berpal_otp_v3` — confirm Meta approved it
- [ ] Flip `TWILIO_ENV=live` in `.env` (gating in `src/auth/otp.js` handles the rest automatically)
- [ ] Update `/login` page hint copy to remove sandbox-join instructions

### 8. Editing (write-side web)
**Why**: Bot is primary write path, but web edits cover edge cases (fix wrong customer name, delete bad entry, etc.)

- [ ] `/customers/[name]/edit` — name, group, contact
- [ ] `/suppliers/[name]/edit` — same
- [ ] Delete/void transactions
- [ ] Confirm modal pattern (reusable)

### 9. Deploy + production hardening
**URL architecture (decided 2026-05-18)**: subdomain-per-app. Berpal lives at
`berpal.ber.fun` (or `app.ber.fun` if we want to keep berpal.com elsewhere).
Apex `ber.fun` reserved for a marketing/landing page. Future apps get their
own subdomains. Zero code changes needed — no Next.js basePath gymnastics.

- [ ] Deploy web + bot to Railway (or Vercel for web, Railway for bot)
- [ ] DNS: A record / CNAME for `berpal.ber.fun` → deployment target
- [ ] Set `APP_URL=https://berpal.ber.fun` in production env
- [ ] Set Twilio WhatsApp webhook URL to `https://berpal.ber.fun/api/webhook`
- [ ] Stable webhook URL means we can finally retire ngrok for live testing
- [ ] `SESSION_SECRET` rotation strategy
- [ ] Error monitoring (Sentry or equivalent)
- [ ] Log retention policy (no chat content in prod logs)
- [ ] Health-check endpoint
- [ ] Audit for any localhost-baked assumptions (done once 2026-05-18 — clean.
      Only `whatsapp.js` had a placeholder URL, now env-driven via `APP_URL`)

### 10. Commit hygiene
- [ ] Group the big uncommitted blob into clean commits before next major feature:
  - [ ] Web app scaffold (Next 16 + Tailwind + auth + layout)
  - [ ] Web dashboard pages
  - [ ] Purchase Invoice + supplier handlers
  - [ ] Opening Balance JE + wallet auto-creation
  - [ ] Helper scripts (provision.js, check-erpnext-perms.js, etc.)

---

## ✅ Done

### Web app foundation
- [x] Next.js 16 + React 19 + Tailwind v3 setup (v4 ditched — Turbopack/lightningcss on Windows is fragile)
- [x] App Router with `(app)` route group for authenticated shell
- [x] Auth: OTP via WhatsApp (sandbox) with bcrypt-hashed codes, 10min TTL, rate limits
- [x] iron-session cookies (`berpal_session`)
- [x] `/login` with country picker (libphonenumber-js + ipapi.co IP geo) → OTP step
- [x] `/onboarding` single-step form → `provisionTenant`
- [x] Smart `/` router (session-aware redirect)
- [x] Sidebar shell with mobile hamburger drawer + active-link highlight
- [x] Logout

### Tenant provisioning
- [x] `provisionTenant`: ERPNext Company + User + API keys + FX account + Postgres user row, idempotent on phone
- [x] Interactive CLI `scripts/provision.js`

### Dashboard read-only pages
- [x] `/dashboard` — Cash/AR/AP stats (default currency headline w/ ~approx prefix, per-currency breakdown with flag rows), recent activity
- [x] `/transactions` — list with paginated 50/page (URL `?page=N`)
- [x] `/transactions/[doctype]/[name]` — detail with line items / refs / accounts per doctype
- [x] `/wallets` — Cash/Bank/CC accounts with balances
- [x] `/expenses` — operating expenses only (COGS correctly excluded)
- [x] `/accounts` — chart of accounts tree
- [x] `/accounts/[name-or-number]` — ledger with running balance (URL accepts account_number or full name)
- [x] `/customers` + `/customers/[name]` — list with AR + detail
- [x] `/suppliers` + `/suppliers/[name]` — list with AP + detail
- [x] `/settings` — profile + business + WhatsApp bot info

### Shared components
- [x] `Shell` (sidebar + mobile drawer + active highlight)
- [x] `PageHeader`, `Card`, `Empty`
- [x] `TransactionsTable` (shared by dashboard + /transactions)
- [x] `Pagination` (modular: basePath + query props)
- [x] `Flag` (flag-icons SVG sprites)
- [x] `format.js` helpers (money, compactMoney with k/m, date, friendlyAccountName, accountUrl, etc.)
- [x] FX cache (`convertToBase` with React.cache, uses frankfurter.app)

### Polish
- [x] Mobile-responsive sidebar (hamburger drawer)
- [x] Active-page highlight in sidebar
- [x] Horizontally-scrollable tables with sticky right value column + left padding
- [x] Text ellipsis-truncation on long names (no wrapping)
- [x] Stat card breakdown rows: flag + currency code + amount, sorted with default currency first
- [x] Approximation prefix `~` when multi-currency totals are converted
- [x] Compact format for big numbers (`$1.5k`, `฿1.5m`) above 10k threshold

### ERPNext doctype handlers
- [x] Sales Invoice (write + read, FX-aware, per-currency Debtor auto-creation)
- [x] Purchase Invoice
- [x] Payment Entry (Receive + Pay, with invoice allocation; ERPNext handles FX gain/loss natively)
- [x] Journal Entry (cash income/expense, `buildJournalTitle` multi-currency aware)
- [x] Opening Balance JE
- [x] Auto per-currency wallet creation for Payment Entry
- [x] Counterparty cache + fuzzy short-name resolution

### Query helpers
- [x] `open-invoices`, `balance-with-counterparty`, `cash-bank-balance`, `counterparty-details`
- [x] `recent-transactions` (+ count for pagination), `account-ledger` (+ resolveAccountParam)
- [x] `customer-list` (with AR), `supplier-list` (with AP), `accounts-list`, `expense-summary`

### Other
- [x] `business_type` UX renaming: Invoice / Purchase / Expense / Receipt / Payment / Cash (was Bill / Journal)
- [x] Cost of Goods Sold filtered out of `/expenses`

---

## 💡 Ideas / parking lot

_(not committed to building — capture and forget until they re-surface)_

- Dark mode — follow `prefers-color-scheme` automatically (Tailwind's `dark:`
  variant + a small ThemeProvider). Design tokens in globals.css already use
  CSS custom properties so a `:root.dark { … }` block can swap them cleanly.
  Per-user override (Light / Dark / System) in /settings later.
- P&L view (Revenue → COGS → Gross Profit → Operating Expenses → Net Profit) — would be a real first "report"
- Balance Sheet view
- Cash-flow forecast view (based on open invoices + due dates)
- Customer statement PDF (send via WhatsApp)
- Multi-warehouse-aware bot prompts ("which warehouse?" only when >1 exists)
- Recurring transactions / templates
- Tax handling (VAT/GST per region)
- ERPNext webhook → bot for sync-back when user edits via ERPNext UI directly
- Audit log table for who-edited-what (compliance)
- Self-serve invite users to the same Company (multi-user per tenant)
- Backup/export (CSV download of any list page)

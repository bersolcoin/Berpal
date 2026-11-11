# Parcel and lot stock: build plan and state

**Design:** [parcel-lot-stock-design.md](parcel-lot-stock-design.md). **Owner decisions:** [parcel-lot-stock-decisions.md](parcel-lot-stock-decisions.md) (none answered yet; the build follows the recommendations, each behind a setting or a single module, so an answer changes one place).

**Status (11 November 2026): built. All four lanes are in, reviewed and wired together; `npm test` passes 629 of 629 (393 before the lanes). Everything on the ERPNext side is proven against the test double only: the proof on a live site (Phase 0, below) has not been run. Nothing is committed; the work sits uncommitted on the branch `feat/gem-lots`.**

## What exists

| File | State |
|---|---|
| `src/migrations/100-lots.sql`, `105-lot-op-guards.sql`, `110-lot-reconcile.sql` | `users.niche`, `users.lot_cost_method`; tables `lots`, `lot_ops`, `lot_op_lines`, `lot_custody`, `lot_certificates`; the guards on unfinished operations; what the nightly comparison found |
| `src/lots/index.js` | Constants, helpers, the contracts (`LotLine`, `StockOp`, `ResolvedInput`, `ResolvedOutput`, `ResolvedOp`, `RunResult`), `today(user)` and the module map |
| `src/lots/gate.js` | The confirmation gate for lot drafts: `plan`, `requestConfirmation`, `saveTransaction`, `retry`, `settle`. Read it first: it shows how every lane's functions are called |
| `src/lots/store.js`, `cost.js`, `resolve.js` | Lane A. The lot rows and the operation life cycle (the only writer of the lot tables), the cost arithmetic, a draft resolved against the lots on record |
| `src/lots/erp.js`, `stock-entry.js`, `execute.js`, `recover.js`, `src/jobs/lots-recover.job.js` | Lane B. Masters, batches, the Stock Entry payloads, the resumable runner, and the nightly job that settles operations ERPNext never answered |
| `src/lots/draft.js`, `card.js`, `src/prompt/65-lots.js`, tools `update_stock_op`, `query_lots`, `query_lot_history`, `set_lot_details`, `set_gem_settings` | Lane C. What the model may put on a draft, the confirmation card, the gem part of the prompt |
| `src/lots/undo.js`, `custody.js`, `reconcile.js`, `digest.js`, `src/jobs/lots-reconcile.job.js`, tool `query_custody` | Lane D. Take back the newest operation, who holds what and what is overdue, the nightly comparison with ERPNext, the digest lines, stock documents in the accountant's review queue |
| Hooks | `request_confirmation` and `save_transaction` hand a lot draft to the gate; tools that export `niche: 'gems'` are shown only to a gem account (`toolsFor(user)`); `retry_stock_op`; `erp.cancelDoc`; category 5010 maps to account 5118 |
| `test/fake-erpnext.js` | Batches, batch-wise valuation, Stock Entries (Material Receipt, Material Issue, Material Transfer, Repack), invoices with `update_stock` and batch rows, cancel, remarks search, Stock Ledger Entry and GL Entry |
| `test/lots-*.test.js` (15 files), `test/fake-erpnext-lots.test.js`, `test/lots-helpers.js` | 272 tests. `test/lots-flow.test.js` is the integration pass: the worked example L12 → L17 through the model's own tools (`request_confirmation`, `save_transaction`, `retry_stock_op`), a save ERPNext never answered and its retry, an undo, and an account without lots |

## Contracts (signatures live in the stubs; this is who owns what)

| Call | Lane | Meaning |
|---|---|---|
| `draft.prepare(user, draft)` | C | Normalise lot lines and `stock_op` in place; error string or null. Idempotent |
| `erp.feeToStock(user, draft)` | B | Pure: what of the fee goes into the stones, company currency |
| `resolve.resolveDraft(user, draft, { feeCapitalised })` | A | `{ ok, op }` or `{ ok: false, error }`. Reads only; same answer at card time and save time |
| `cost.*` | A | Pure arithmetic: shares, output costs, cost of a part, weight tolerance, yield and its warnings |
| `store.*` | A (hardening only) | Operation life cycle and the lot rows |
| `erp.preflight(user, erp, op)` | B | Read-only: is every input in ERPNext where Berpal thinks it is? |
| `erp.ensureSetup`, `ensureBatch`, `accounts`, `voucherStock` | B | Masters, batches, accounts, reading a document's stock effect |
| `stock-entry.repack / transfer / issue` | B | Pure Stock Entry payload builders |
| `execute.steps(op, draft)`, `execute.run(user, erp, { op, draft, reference })` | B | The step plan and the resumable runner; returns `RunResult` |
| `recover.recoverUser(user, erp, opts)` | B | Reconcile unfinished operations with what ERPNext really holds; never posts |
| `card.build(user, draft, op, getErp)` | C | The confirmation card `{ lines }` |
| `undo.resolve / card / run` | D | Undo of the newest operation on its lots; cancels documents in reverse |
| `custody.out / overdue` | D | Who holds what, how long, what is overdue |
| `reconcile.run / open` | D | Nightly comparison of Berpal's lots with ERPNext |
| `digest.lines(user, opts)` | D | Lines for the daily digest |
| `review.markStockPosted(erp, { user, doc, op, undoing, reference, warnings })` | D | Stock entries into the accountant's review queue |

### How an operation is recorded

`store.beginOp` ('pending') → `store.recordStep` per posted document ('partial') → `store.postOp` with the actuals read back from ERPNext ('posted'), or `store.failOp` when nothing was posted. Undo: `store.markUndoing` → `store.markDocCancelled` per document → `store.reverseOp` ('undone'). `actuals = { inputs: { [code]: { cost } }, outputs: { [code]: { cost, item, batch } } }`. One unfinished operation per user blocks every other lot operation until it is retried or undone.

### What each kind posts (lane B builds it, everyone relies on it)

| Kind | Documents, in order |
|---|---|
| buy | Purchase Invoice, `update_stock`, one batch row per lot line into Stores (a purchase paid on the spot is refused for now, see the deviations) |
| sell | Sales Invoice, `update_stock`, one batch row per lot line from the lot's warehouse |
| split, merge | One Stock Entry, Repack |
| transform | The fee document when there is a fee (category 5010 → account 5118), then one Repack whose `additional_costs` credit 5118 by the same amount |
| move, whole lot | One Stock Entry, Material Transfer |
| move, part of a lot | One Repack that creates the new lot in the destination warehouse |
| write_off | One Stock Entry, Material Issue |

Every document carries `remarks` = `lots.remarkFor(reference, step, total)`. Before posting a step that is not recorded, the runner searches ERPNext for a submitted document with that remark (`erp.findByReference`) and records it instead of posting twice.

## Lanes and file ownership

Nobody edits a file outside their lane. A change needed elsewhere goes in the lane's report.

- **A, lot ledger:** `src/lots/cost.js`, `src/lots/resolve.js`, `src/lots/store.js` (hardening only, signatures fixed); tests `test/lots-cost.test.js`, `test/lots-resolve.test.js`, `test/lots-store.test.js`.
- **B, ERPNext side:** `src/lots/erp.js`, `stock-entry.js`, `execute.js`, `recover.js`; `src/jobs/lots-recover.job.js`; everything in `src/erp-sync/`; `test/fake-erpnext.js`, `test/fake-erpnext-lots.test.js`; tests `test/lots-erp.test.js`, `test/lots-execute.test.js`, `test/lots-recover.test.js`.
- **C, chat surface:** `src/lots/draft.js`, `src/lots/card.js`; tools `src/tools/update-stock-op.js`, `query-lots.js`, `query-lot-history.js`, `set-lot-details.js`, `set-gem-settings.js`; `src/tools/update-draft.js`, `validate.js`, `card.js`; `src/prompt/65-lots.js`, `src/prompt/60-tax-items.js`; tests `test/lots-draft.test.js`, `test/lots-card.test.js`, `test/lots-tools.test.js`.
- **D, custody and safety:** `src/lots/undo.js`, `custody.js`, `reconcile.js`, `digest.js`; `src/tools/query-custody.js`, `src/tools/list-review-queue.js`, `src/tools/mark-reviewed.js`; `src/jobs/lots-reconcile.job.js`, `src/jobs/digest.job.js`; `src/trust/review.js`; `src/migrations/110-lot-reconcile.sql`; tests `test/lots-undo.test.js`, `test/lots-custody.test.js`, `test/lots-reconcile.test.js`, `test/lots-review.test.js`.
- **Coordinator only:** `src/lots/index.js`, `src/lots/gate.js`, `src/migrations/100-lots.sql`, `test/lots-helpers.js`, `src/conversation.js`, `src/tools/index.js`, `src/tools/request-confirmation.js`, `src/tools/save-transaction.js`, `src/tools/retry-stock-op.js`, `docs/`.

Done after the lanes: a review of each lane with fixes until it held, the integration pass (`test/lots-flow.test.js`), the full test stack, and a judgement against the desired outcome.

## Conventions that bite

- Tests run on `pg-mem`: no `= ANY($1)` (build `IN ($1,$2,…)`), NUMERIC comes back as a string (`Number()` on read), do not rely on `ON DELETE CASCADE`.
- Timestamps are `new Date().toISOString()` in TEXT columns; JSON is stored as TEXT.
- Money is 2 dp (`round2` from `src/erp-sync/common.js`), carats 3 dp (`lots.round3`).
- The model never sets `stock_op`, category 5010 or the protected draft keys through `update_draft`.
- Words for the trader: plain, no ERPNext jargon. Messages a tool returns are instructions to the model, in English; the model answers in the user's language.

## Limits of the test double (what Phase 0 must prove on a real site)

- A Repack values outputs by the `basic_rate` / `basic_amount` given with `set_basic_rate_manually: 1`; real ERPNext may redistribute by quantity when the flag is ignored.
- A Material Receipt takes `basic_amount` as given.
- Cancel is refused (417) when later ledger entries depend on the document; real ERPNext may repost instead.
- An invoice with a linked payment always refuses cancel.
- Every Stock Entry row must carry `expense_account` and `cost_center`; `additional_costs` need a description and a positive amount.
- A duplicate Batch is a 409 `DuplicateEntryError`.

The code also assumes, and only a live site can confirm:

- The quantity of a batch in a warehouse is read with `erpnext.stock.doctype.batch.batch.get_batch_qty`.
- Stock Ledger Entries carry `batch_no` (true on v14; v15 moves this to the Serial and Batch Bundle unless `use_serial_batch_fields` is set).
- Valuation is kept per batch, so the cost of one lot never mixes with another lot of the same item.
- A submitted document is cancelled with `frappe.client.cancel`.
- A document can be found again by its remark with a `like` filter (Payment Entry keeps it in `custom_remarks`).

## Deviations from the design, to confirm with the owner

- A partial move is one Repack that creates a new lot at the destination (not a split followed by a move).
- "Pick the best stones and sell them" is two confirmations in the first version.
- A lot is bought on a bill and sold on an invoice. A purchase or sale as a plain cash entry is refused; the trader records the bill, then the payment.
- Category code 5010 is valid only with a transform; the gate sets it, never the model.
- One unfinished operation per user blocks every other lot operation until it is retried or undone.
- A lot created by an undone operation is deleted; its code and its (empty) batch may be used again.
- Berpal never cancels the bill or the invoice of a purchase or sale of lots. The accountant cancels it in ERPNext first; the chat says so.
- When ERPNext does not answer and nothing can be found there, the operation waits for the trader ("retry" or take it back). The nightly job never posts and never guesses; the digest lists it as not finished.
- Lot tracking can be switched off from chat (only with no stones on record) but not on; switching on is done when the account is set up. The cost method is locked once a lot has been sorted or worked on, not at the first purchase.
- For a gem account the default date of an entry is the trader's local date. Other accounts keep the UTC date, as before.
- `set_lot_details` changes the description, the prices and the certificate of a lot at once, without a card. It refuses the treatment, the VAT-exempt flag and the supplier document.

## Known gaps

- No test drives a real model. The gate does not depend on the model (the card's signature has to match and "yes" has to arrive on a later turn), but that the model asks well in Thai and English is unproven.
- The nightly comparison leaves out the lots an unfinished operation is changing; they are checked the night after it is finished.
- An operation that was still 'pending' and is closed by the nightly job is not announced to the trader.
- When a lot line changes after a card was sent, the model is first told the amount no longer matches, and only then that a new card is needed: one extra round trip.
- The gem prompt is about 23,500 characters against 15,900 for the core, and the tool list about 33,100 against 22,100. Fine for the current model; worth a look if the model changes.
- The scheduler `stop()` test in `test/jobs.test.js` has failed once under load (timing); it passes in every run since.

## New questions for the owner

- May the trader change the treatment, the VAT-exempt flag or the supplier document of a lot from chat, or does that stay with the accountant?
- Should every account get the local default date? Today a non-gem trader in Bangkok who writes between midnight and 07:00 gets yesterday's date unless they say one.
- Is a purchase of stones paid on the spot common enough to need one card for the bill and the payment together?

## Out of scope for this build

Phase 4 (tax and paperwork, needs the accountant), stones held on memo from others, combined pick-and-sell, undo of purchase and sales invoices that carry lots, fees that arrive late.

## Gate before real use

Phase 0: the proof on a live ERPNext v14 site. It needs credentials that only the owner adds to the local `.env`. Until then every ERPNext behaviour here is proven against the test double only, and no gem trader should be put on it.

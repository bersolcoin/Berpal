/**
 * Trust layer (src/trust): duplicate guard, anomaly flags, accountant-review Comments, and how
 * the card's warning lines interact with the confirmation signature.
 * In-memory ERPNext (test/fake-erpnext.js) + Postgres (pg-mem), driven through executeTool.
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;
delete process.env.TRUST_LARGE_AMOUNT_FLOOR;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const { executeTool } = require('../src/tools');
const { cardSignature } = require('../src/tools/request-confirmation');
const { WARNING_HEADER } = require('../src/tools/card');
const download = require('../src/media/download');
const { _setClientForTests } = require('../src/media/openai-client');
const mediaIntake = require('../src/media');
const trust = require('../src/trust');
const duplicates = require('../src/trust/duplicates');
const { anomalies } = require('../src/trust/anomalies');
const review = require('../src/trust/review');

const erp = new FakeErpNext();
let phoneSeq = 0;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const card = (iso) => iso.replace(/-/g, '/');
const D = addDays(TODAY, -10); // a date well inside every window, not stale, not future

async function newUser() {
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ($1, $2, 'k', 's', 'THB', 'THB', 'TH', $3, $3) RETURNING *`,
    [`+6690000${++phoneSeq}`, COMPANY, now]
  );
  return r.rows[0];
}

/** One tool call with a fresh per-turn ctx, like conversation.handle. */
async function tool(user, name, draft, args = {}) {
  const ctx = { user, draft: { ...draft }, saved: null, cancelled: false, confirmationRequested: false };
  const result = await executeTool(name, args, ctx);
  return { result, ctx };
}

/** End of a card turn, as handle() does it: arm the card the user is now looking at. */
function endTurn(ctx) {
  const d = { ...ctx.draft };
  if (ctx.confirmationRequested) d.confirmation_pending = d.confirmation_sig;
  return d;
}

async function confirmAndSave(user, draft) {
  const c = await tool(user, 'request_confirmation', draft);
  assert.equal(c.result.ok, true, `request_confirmation: ${c.result.error}`);
  const s = await tool(user, 'save_transaction', endTurn(c.ctx));
  assert.equal(s.result.ok, true, `save_transaction: ${s.result.error}`);
  return { card: c.result.card, saved: s.result };
}

const cashExpense = (extra = {}) => ({
  transaction_type: 'cash', direction: 'expense', amount: 185, currency: 'THB', transaction_date: D,
  category_code: 5100, wallet_skipped: true, description: 'coffee', ...extra,
});

const IMAGE_A = Buffer.from('receipt-bytes-A');
const IMAGE_B = Buffer.from('receipt-bytes-B');
const SCAN = {
  document_type: 'receipt', merchant: 'Starbucks', date: D, total: 185, currency: 'THB',
  tax_amount: null, tax_rate: null, vat_claimable: null, invoice_number: null, due_date: null,
  payment_method: 'cash', items_summary: 'latte', confidence: 0.95,
};

/** Media intake of one photo with the given bytes; returns the stored media id. */
async function scan(user, bytes) {
  download._setDownloaderForTests(async () => bytes);
  const r = await mediaIntake.intake(user, {
    NumMedia: '1', MediaContentType0: 'image/jpeg', MediaUrl0: 'https://api.twilio.com/x/Media/1',
  }, 'coffee');
  assert.equal(r.mediaIds.length, 1);
  return r.mediaIds[0];
}

before(async () => {
  erp.install();
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  _setClientForTests({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(SCAN) } }] }) } },
    audio: { transcriptions: { create: async () => ({ text: '' }) } },
  });
});

// ── Duplicate guard ───────────────────────────────────────────────────

test('duplicate by receipt hash: intake hashes the bytes, a re-sent photo gets a hard warning', async () => {
  const user = await newUser();
  const m1 = await scan(user, IMAGE_A);
  const blob = await db.query('SELECT sha256 FROM media_blobs WHERE id = $1', [m1]);
  assert.equal(blob.rows[0].sha256, duplicates.contentHash(IMAGE_A));

  const first = await confirmAndSave(user, cashExpense({ receipt_media_id: m1 }));
  assert.equal(first.card.warning_lines.length, 0);
  const fp = await db.query('SELECT * FROM trust_fingerprints WHERE user_id = $1', [user.id]);
  assert.equal(fp.rows.length, 1);
  assert.equal(fp.rows[0].receipt_hash, duplicates.contentHash(IMAGE_A));
  assert.equal(fp.rows[0].erpnext_name, first.saved.erpnext_name);

  // Same photo again, new blob id — and a different amount, so only the hash can match.
  const m2 = await scan(user, IMAGE_A);
  assert.notEqual(m2, m1);
  const again = await tool(user, 'request_confirmation', cashExpense({ receipt_media_id: m2, amount: 190 }));
  assert.equal(again.result.ok, true);
  assert.deepEqual(again.result.card.warning_lines, [
    WARNING_HEADER, `- This receipt was already recorded as ${first.saved.erpnext_name} on ${card(D)}`,
  ]);
  assert.deepEqual(again.result.card.lines.slice(-2), again.result.card.warning_lines);
  assert.equal(again.ctx.draft.receipt_hash, duplicates.contentHash(IMAGE_A));
  // Not a block: confirming the card saves it.
  const s = await tool(user, 'save_transaction', endTurn(again.ctx));
  assert.equal(s.result.ok, true, s.result.error);

  // A different photo: no warning.
  const m3 = await scan(user, IMAGE_B);
  const other = await tool(user, 'request_confirmation', cashExpense({ receipt_media_id: m3, amount: 77 }));
  assert.deepEqual(other.result.card.warning_lines, []);
  assert.equal('trust_warnings' in other.ctx.draft, false);
});

test('similar by amount + currency + counterparty: ±3 days in, 4 days out', async () => {
  const user = await newUser();
  await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-SIM-1', direction: 'expense',
    amount: 5000, currency: 'THB', baseAmount: 5000, transactionDate: D, counterpartyName: 'Acme Co',
  });
  const similarLine = `Looks similar to ACC-JV-SIM-1 (5,000 THB, ${card(D)})`;
  const warn = async (extra) => (await trust.assess(user, cashExpense({ amount: 5000, counterparty_name: 'Acme Co', ...extra }))).warnings;

  assert.ok((await warn({ transaction_date: addDays(D, 3) })).includes(similarLine), '+3 days is inside');
  assert.ok((await warn({ transaction_date: addDays(D, -3) })).includes(similarLine), '-3 days is inside');
  assert.ok((await warn({ counterparty_name: '  ACME   co ' })).includes(similarLine), 'name is normalised');
  assert.ok(!(await warn({ transaction_date: addDays(D, 4) })).includes(similarLine), '+4 days is outside');
  assert.ok(!(await warn({ transaction_date: addDays(D, -4) })).includes(similarLine), '-4 days is outside');
  assert.ok(!(await warn({ amount: 5001 })).includes(similarLine), 'different amount');
  assert.ok(!(await warn({ currency: 'USD', exchange_rate: 35 })).includes(similarLine), 'different currency');
  assert.ok(!(await warn({ counterparty_name: 'Other Co' })).includes(similarLine), 'different counterparty');
  assert.deepEqual(await warn({ counterparty_name: null }), [], 'no counterparty, no similar check');
  assert.ok(!(await warn({ direction: 'income', transaction_type: 'advance_received' })).includes(similarLine), 'money back is not a duplicate');
  assert.ok(!(await warn({ transaction_type: 'payment', parent_invoice_name: 'ACC-JV-SIM-1' })).includes(similarLine),
    'paying the very document is not a duplicate of it');
  assert.ok((await warn({ transaction_type: 'payment', parent_invoice_name: 'ACC-PINV-OTHER' })).includes(similarLine));
  // Other users' postings never match.
  const stranger = await newUser();
  assert.deepEqual((await trust.assess(stranger, cashExpense({ amount: 5000, counterparty_name: 'Acme Co' }))).warnings
    .filter((w) => w.startsWith('Looks similar')), []);
});

// ── Anomaly flags (pure) ──────────────────────────────────────────────

const U = { id: 1, reporting_currency: 'THB' };
const T = '2026-06-15';
const base = { transaction_type: 'cash', direction: 'expense', currency: 'THB', transaction_date: T };
const stats = (extra = {}) => ({ today: T, medians: {}, walletIsCash: false, newPayee: false, ...extra });
const flags = (draft, s) => anomalies(U, { ...base, ...draft }, stats(s));

test('anomaly: unusually large vs the 90-day median, above the floor', () => {
  const medians = { expense: { median: 1500, count: 5 } };
  assert.deepEqual(flags({ amount: 25000 }, { medians }), ['Unusually large: 25,000 THB vs typical 1,500 THB']);
  assert.deepEqual(flags({ amount: 16000 }, { medians }), [], '> 10× but under the 20,000 floor');
  assert.deepEqual(flags({ amount: 25000 }, { medians: { expense: { median: 3000, count: 5 } } }), [], 'under 10×');
  assert.deepEqual(flags({ amount: 25000 }, { medians: { expense: { median: 1500, count: 2 } } }), [], 'too few samples');
  assert.deepEqual(flags({ amount: 25000, direction: 'income' }, { medians }), [], 'median is per direction');
  // Foreign amounts compare in the reporting currency.
  assert.deepEqual(flags({ amount: 1000, currency: 'USD', exchange_rate: 36 }, { medians }), ['Unusually large: 36,000 THB vs typical 1,500 THB']);
  assert.deepEqual(flags({ amount: 25000, direction: 'transfer', transaction_type: 'transfer' }, { medians: { transfer: { median: 1500, count: 5 } } }),
    [], 'transfers between own wallets are never "unusually large"');
  for (const garbage of ['abc', '-5', '  ', 'NaN']) {
    process.env.TRUST_LARGE_AMOUNT_FLOOR = garbage;
    assert.deepEqual(flags({ amount: 16000 }, { medians }), [], `garbage floor ${JSON.stringify(garbage)} → default 20,000`);
  }
  process.env.TRUST_LARGE_AMOUNT_FLOOR = '5000';
  try {
    assert.deepEqual(flags({ amount: 16000 }, { medians }), ['Unusually large: 16,000 THB vs typical 1,500 THB']);
  } finally {
    delete process.env.TRUST_LARGE_AMOUNT_FLOOR;
  }
});

test('anomaly: future and stale dates', () => {
  assert.deepEqual(flags({ amount: 100, transaction_date: addDays(T, 1) }), [`Date is in the future: ${card(addDays(T, 1))}`]);
  assert.deepEqual(flags({ amount: 100, transaction_date: T }), []);
  assert.deepEqual(flags({ amount: 100, transaction_date: addDays(T, -91) }), [`Date is over 90 days ago: ${card(addDays(T, -91))}`]);
  assert.deepEqual(flags({ amount: 100, transaction_date: addDays(T, -90) }), []);
});

test('anomaly: large round cash amount', () => {
  assert.deepEqual(flags({ amount: 20000 }, { walletIsCash: true }), ['Large round cash amount: 20,000 THB']);
  assert.deepEqual(flags({ amount: 10000 }, { walletIsCash: true }), ['Large round cash amount: 10,000 THB']);
  assert.deepEqual(flags({ amount: 20500 }, { walletIsCash: true }), [], 'not a multiple of 1000');
  assert.deepEqual(flags({ amount: 9000 }, { walletIsCash: true }), [], 'under 10,000');
  assert.deepEqual(flags({ amount: 20000 }, { walletIsCash: false }), [], 'bank wallet');
  assert.deepEqual(flags({ amount: 20000, direction: 'income' }, { walletIsCash: true }), [], 'income');
});

test('anomaly: new payee, first outgoing payment at or above the floor', () => {
  assert.deepEqual(flags({ amount: 25000, counterparty_name: 'Newco' }, { newPayee: true }), ['New payee, first payment']);
  assert.deepEqual(flags({ amount: 25000, transaction_type: 'payment' }, { newPayee: true }), ['New payee, first payment']);
  assert.deepEqual(flags({ amount: 15000 }, { newPayee: true }), [], 'under the floor');
  assert.deepEqual(flags({ amount: 25000 }, { newPayee: false }), [], 'known payee');
  assert.deepEqual(flags({ amount: 25000, direction: 'income' }, { newPayee: true }), [], 'incoming');
  assert.deepEqual(flags({ amount: 25000, transaction_type: 'bill_received' }, { newPayee: true }), [], 'a bill moves no money');
});

test('anomaly order is most severe first; the card shows at most 3, duplicates on top', async () => {
  assert.deepEqual(flags({ amount: 30000, transaction_date: addDays(T, 2) }, {
    medians: { expense: { median: 1000, count: 4 } }, walletIsCash: true, newPayee: true,
  }), [
    `Date is in the future: ${card(addDays(T, 2))}`,
    'Unusually large: 30,000 THB vs typical 1,000 THB',
    'New payee, first payment',
    'Large round cash amount: 30,000 THB',
  ]);

  const user = await newUser();
  const fut = addDays(TODAY, 5);
  for (const [i, amt] of [900, 1000, 1100].entries()) {
    await duplicates.recordFingerprint({
      userId: user.id, doctype: 'Journal Entry', erpnextName: `ACC-JV-SMALL-${i}`, direction: 'expense',
      amount: amt, currency: 'THB', baseAmount: amt, transactionDate: D, counterpartyName: `shop ${i}`,
    });
  }
  await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-TWIN', direction: 'expense',
    amount: 30000, currency: 'THB', baseAmount: 30000, transactionDate: fut, counterpartyName: 'Big Supplier',
  });
  const { warnings } = await trust.assess(user, cashExpense({ amount: 30000, transaction_date: fut, counterparty_name: 'Big Supplier' }));
  assert.deepEqual(warnings, [
    `Looks similar to ACC-JV-TWIN (30,000 THB, ${card(fut)})`,
    `Date is in the future: ${card(fut)}`,
    // The median includes the twin itself: 900, 1000, 1100, 30000 → 1,050.
    'Unusually large: 30,000 THB vs typical 1,050 THB',
  ]);
});

// ── Review status ─────────────────────────────────────────────────────

test('markPosted: review Comment on the ERPNext doc (with the card warnings) and a pending row', async () => {
  const user = await newUser();
  const plain = await confirmAndSave(user, cashExpense({ amount: 321, counterparty_name: 'Review Shop' }));
  let comment = erp.all('Comment').find((c) => c.reference_name === plain.saved.erpnext_name);
  assert.ok(comment, 'Comment created');
  assert.equal(comment.comment_type, 'Comment');
  assert.equal(comment.reference_doctype, plain.saved.doctype);
  assert.equal(comment.content, review.REVIEW_NOTE);

  // Same amount + counterparty again: the soft warning shows on the card and lands in the Comment.
  const dup = await confirmAndSave(user, cashExpense({ amount: 321, counterparty_name: 'Review Shop' }));
  const line = `Looks similar to ${plain.saved.erpnext_name} (321 THB, ${card(D)})`;
  assert.ok(dup.card.lines.includes(`- ${line}`));
  comment = erp.all('Comment').find((c) => c.reference_name === dup.saved.erpnext_name);
  // Comment content is HTML in ERPNext: <br> between lines, text escaped.
  assert.equal(comment.content, `${review.REVIEW_NOTE}<br>Warnings shown to the user:<br>- ${line}`);
  assert.equal(review.commentText(['<b>x</b> & "y"']), `${review.REVIEW_NOTE}<br>Warnings shown to the user:<br>- &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;`);

  const pending = await review.listPending(user.id);
  assert.deepEqual(pending.map((p) => [p.erpnext_name, p.warnings]), [
    [plain.saved.erpnext_name, []],
    [dup.saved.erpnext_name, [line]],
  ]);
  const rows = await db.query("SELECT review_status FROM trust_fingerprints WHERE user_id = $1", [user.id]);
  assert.deepEqual(rows.rows.map((r) => r.review_status), ['pending', 'pending']);
  assert.deepEqual(await review.listPending((await newUser()).id), [], 'scoped to the user');
});

test('save still succeeds when the review Comment fails', async () => {
  const user = await newUser();
  const real = erp.create;
  erp.create = function (doctype, d) {
    if (doctype === 'Comment') throw new Error('Comment rejected');
    return real.call(this, doctype, d);
  };
  let saved;
  try {
    ({ saved } = await confirmAndSave(user, cashExpense({ amount: 444 })));
  } finally {
    erp.create = real;
  }
  assert.ok(erp.get('Journal Entry', saved.erpnext_name), 'document posted');
  assert.equal(erp.all('Comment').some((c) => c.reference_name === saved.erpnext_name), false);
  assert.deepEqual((await review.listPending(user.id)).map((p) => p.erpnext_name), [saved.erpnext_name]);
});

// ── Warnings and the confirmation signature ──────────────────────────

test('warnings are signed: stable across identical cards, a changed set re-arms the card', async () => {
  const user = await newUser();
  const draft = cashExpense({ amount: 2500, counterparty_name: 'Sig Shop' });
  const noWarn = await tool(user, 'request_confirmation', draft);
  assert.equal('trust_warnings' in noWarn.ctx.draft, false, 'no warnings → no key, signature as before');

  await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-SIG-1', direction: 'expense',
    amount: 2500, currency: 'THB', baseAmount: 2500, transactionDate: D, counterpartyName: 'Sig Shop',
  });
  // Turn 1: card with a warning. Turn 2: the user says yes and the model re-sends the same card.
  const t1 = await tool(user, 'request_confirmation', draft);
  assert.deepEqual(t1.ctx.draft.trust_warnings, [`Looks similar to ACC-JV-SIG-1 (2,500 THB, ${card(D)})`]);
  assert.notEqual(t1.ctx.draft.confirmation_sig, noWarn.ctx.draft.confirmation_sig, 'warnings are in the signature');
  const t2 = await tool(user, 'request_confirmation', endTurn(t1.ctx));
  assert.equal(t2.result.ok, true, t2.result.error);
  assert.equal(t2.ctx.draft.confirmation_sig, t1.ctx.draft.confirmation_sig, 'identical cards sign the same');
  assert.match(t2.result.note, /ALREADY sent/);
  const s = await tool(user, 'save_transaction', t2.ctx.draft);
  assert.equal(s.result.ok, true, s.result.error);

  // The warning set changes between the card and the reply (here: a new matching posting).
  const u2 = await newUser();
  const d2 = cashExpense({ amount: 2500, counterparty_name: 'Sig Shop' });
  const a = await tool(u2, 'request_confirmation', d2);
  await duplicates.recordFingerprint({
    userId: u2.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-SIG-2', direction: 'expense',
    amount: 2500, currency: 'THB', baseAmount: 2500, transactionDate: D, counterpartyName: 'Sig Shop',
  });
  const b = await tool(u2, 'request_confirmation', endTurn(a.ctx));
  assert.notEqual(b.ctx.draft.confirmation_sig, a.ctx.draft.confirmation_sig);
  assert.doesNotMatch(b.result.note, /ALREADY sent/, 'a new card goes out instead of a save');
  // The user's "yes" was to the old card: saving the re-warned draft is refused until re-confirmed.
  const refused = await tool(u2, 'save_transaction', b.ctx.draft);
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.error, /changed after the confirmation card/);
  assert.equal(cardSignature(b.ctx.draft), b.ctx.draft.confirmation_sig);
});

test('new payee from the DB: stable across turns, gone once paid or for an old contact', async () => {
  const user = await newUser();
  const pay = cashExpense({ amount: 25000.5, counterparty_name: 'Fresh Vendor' });
  const once = (await trust.assess(user, pay)).warnings;
  assert.deepEqual(once, ['New payee, first payment']);
  assert.deepEqual((await trust.assess(user, pay)).warnings, once, 'same answer on the confirming turn');

  await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-FRESH', direction: 'expense',
    amount: 10, currency: 'THB', baseAmount: 10, transactionDate: addDays(D, -20), counterpartyName: 'fresh vendor',
  });
  assert.deepEqual((await trust.assess(user, pay)).warnings, [], 'paid before');

  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  await db.query(
    `INSERT INTO counterparty_cache (owner_user_id, name, created_at, updated_at) VALUES ($1, 'Old Friend', $2, $2)`,
    [user.id, old]
  );
  assert.deepEqual((await trust.assess(user, { ...pay, counterparty_name: 'Old Friend' })).warnings, [], 'long-known contact');
});

test('the model can neither forge nor clear the warnings: update_draft strips them, a cleared set blocks the save', async () => {
  const user = await newUser();
  await duplicates.recordFingerprint({
    userId: user.id, doctype: 'Journal Entry', erpnextName: 'ACC-JV-GATE-1', direction: 'expense',
    amount: 3300, currency: 'THB', baseAmount: 3300, transactionDate: D, counterpartyName: 'Gate Shop',
  });
  const line = `Looks similar to ACC-JV-GATE-1 (3,300 THB, ${card(D)})`;
  const c = await tool(user, 'request_confirmation', cashExpense({ amount: 3300, counterparty_name: 'Gate Shop' }));
  // The warning reaches the lines the model is told to send verbatim, under the header, last.
  assert.deepEqual(c.result.card.lines.slice(-2), [WARNING_HEADER, `- ${line}`]);
  assert.equal('trust_warnings' in c.result.draft, false, 'not echoed as a draft field');
  const armed = endTurn(c.ctx);

  // Confirming turn: the model tries to wipe the warnings / plant a hash, then save.
  const u = await tool(user, 'update_draft', armed, { trust_warnings: [], receipt_hash: 'f'.repeat(64) });
  assert.equal(u.result.ok, true);
  assert.deepEqual(u.ctx.draft.trust_warnings, [line], 'trust_warnings unchanged by the model');
  assert.equal('receipt_hash' in u.ctx.draft, false, 'receipt_hash not planted');
  assert.equal('trust_warnings' in u.result.current_draft, false);

  // Even if the warnings went missing some other way, the signature no longer matches.
  const cleared = { ...armed };
  delete cleared.trust_warnings;
  const refused = await tool(user, 'save_transaction', cleared);
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.error, /changed after the confirmation card/);

  // Forged warnings on a fresh card are replaced by the server's own.
  const forged = await tool(user, 'request_confirmation', { ...cashExpense({ amount: 3300, counterparty_name: 'Gate Shop' }), trust_warnings: ['All good'] });
  assert.deepEqual(forged.ctx.draft.trust_warnings, [line]);

  const ok = await tool(user, 'save_transaction', u.ctx.draft);
  assert.equal(ok.result.ok, true, ok.result.error);
});

test('a failing trust check never blocks the card', async () => {
  const user = await newUser();
  const real = trust.assess;
  trust.assess = async () => { throw new Error('db down'); };
  try {
    const { result, ctx } = await tool(user, 'request_confirmation', cashExpense({ trust_warnings: ['stale'] }));
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.card.warning_lines, []);
    assert.equal('trust_warnings' in ctx.draft, false, 'stale warnings are dropped, not re-signed');
  } finally {
    trust.assess = real;
  }
});

test('a card reply that leaves out the ⚠ lines gets them appended at the end of the turn', () => {
  const { withTrustWarnings } = require('../src/conversation');
  const warnings = ['This receipt was already recorded as ACC-SINV-00001 on 2026/10/20', 'Unusually large: 50,000 vs typical 1,200'];
  const base = { confirmationRequested: true, saved: null, cancelled: false, draft: { trust_warnings: warnings } };
  const card = 'Expense\nAmount: 50,000 THB\nAccount: Cash → Other Expenses\n\nReply yes to save.';

  // Dropped entirely → appended under the header.
  const fixed = withTrustWarnings(base, card);
  assert.ok(fixed.startsWith(card));
  assert.ok(fixed.includes(WARNING_HEADER));
  for (const w of warnings) assert.ok(fixed.includes(`- ${w}`));

  // Rendered verbatim by the model → untouched.
  const full = `${card}\n\n${WARNING_HEADER}\n${warnings.map((w) => `- ${w}`).join('\n')}`;
  assert.equal(withTrustWarnings(base, full), full);

  // Only one dropped → only that one appended.
  const partial = `${card}\n\n${WARNING_HEADER}\n- ${warnings[0]}`;
  const repaired = withTrustWarnings(base, partial);
  assert.ok(repaired.includes(`- ${warnings[1]}`));
  assert.equal(repaired.split(warnings[0]).length, 2);

  // No card this turn, or a save/cancel → never appended.
  assert.equal(withTrustWarnings({ ...base, confirmationRequested: false }, card), card);
  assert.equal(withTrustWarnings({ ...base, saved: { erpnext_name: 'X' } }, card), card);
  assert.equal(withTrustWarnings({ ...base, draft: {} }, card), card);
});

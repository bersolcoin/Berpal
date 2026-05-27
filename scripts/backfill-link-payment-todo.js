/**
 * Backfill an unrecorded_link_payment TODO for an already-confirmed
 * linked_transactions row whose buyer never recorded the matching
 * Payment Entry on their side.
 *
 *   node scripts/backfill-link-payment-todo.js --link 2
 *
 * Use this for links confirmed BEFORE the seller_paid_now field
 * existed, or any row where the buyer-side payment is missing.
 *
 * Idempotent — the todos table has a UNIQUE(user_id, kind, related_name)
 * index, so re-running for the same link is a no-op.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { createTodo } = require('../src/todos');

(async () => {
  await init();

  const args = process.argv.slice(2);
  let linkId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--link') linkId = parseInt(args[i + 1], 10);
  }
  if (!linkId) {
    console.error('Usage: node scripts/backfill-link-payment-todo.js --link <id>');
    process.exit(1);
  }

  const r = await query(
    `SELECT id, seller_user_id, buyer_user_id, buyer_doctype, buyer_doc_name,
            currency, total_amount, status
       FROM linked_transactions WHERE id = $1`,
    [linkId]
  );
  if (!r.rowCount) {
    console.error(`No linked_transactions row with id=${linkId}`);
    process.exit(2);
  }
  const link = r.rows[0];

  if (link.status !== 'confirmed') {
    console.error(`Link is ${link.status}, not confirmed. Nothing to backfill.`);
    process.exit(3);
  }
  if (!link.buyer_user_id || !link.buyer_doc_name) {
    console.error(`Link is missing buyer_user_id or buyer_doc_name.`);
    process.exit(3);
  }
  if (link.buyer_doctype !== 'Purchase Invoice') {
    console.error(`Backfill only supports Purchase Invoice mirrors, got ${link.buyer_doctype}.`);
    process.exit(3);
  }

  // Pull the seller label for the prompt text.
  const seller = (await query(
    `SELECT erpnext_company FROM users WHERE id = $1`,
    [link.seller_user_id]
  )).rows[0];
  const sellerLabel = seller?.erpnext_company || 'the seller';

  console.log(`Backfilling LINK-${link.id}:`);
  console.log(`  buyer.user_id = ${link.buyer_user_id}`);
  console.log(`  PI ref        = ${link.buyer_doc_name}`);
  console.log(`  amount        = ${link.total_amount} ${link.currency}`);
  console.log(`  seller        = ${sellerLabel}`);

  const todoId = await createTodo({
    userId: link.buyer_user_id,
    kind: 'unrecorded_link_payment',
    payload: {
      link_id: link.id,
      purchase_invoice_ref: link.buyer_doc_name,
      seller_label: sellerLabel,
      amount: Number(link.total_amount) || 0,
      currency: link.currency,
    },
    relatedDoctype: 'Purchase Invoice',
    relatedName: link.buyer_doc_name,
  });

  if (todoId) {
    console.log(`\n✓ TODO id=${todoId} enqueued. The buyer can resolve it at /todos/${todoId}.`);
  } else {
    console.log(`\n• A todo for this PI already exists (idempotent skip). Check /todos.`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

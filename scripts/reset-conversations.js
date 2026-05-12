/**
 * Maintenance script: clears all conversation state.
 *   - Wipes draft_transaction and recent_messages on every conversation row
 *   - Deletes everything in the messages audit log (dev mode only)
 *
 * Does NOT touch users, counterparties, transactions, or chart_of_accounts.
 *
 * Run:
 *   npm run reset
 *   (or)
 *   node scripts/reset-conversations.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  const now = new Date().toISOString();

  const convResult = await query(
    `UPDATE conversations
     SET draft_transaction = NULL,
         recent_messages = '[]',
         state = 'idle',
         last_message_at = NULL,
         updated_at = $1`,
    [now]
  );

  const msgResult = await query('DELETE FROM messages');

  console.log('');
  console.log(`[reset] cleared ${convResult.rowCount} conversation(s) — drafts + message history`);
  console.log(`[reset] deleted ${msgResult.rowCount} audit-log message row(s)`);
  console.log('[reset] done');
  process.exit(0);
})().catch((err) => {
  console.error('[reset] error:', err);
  process.exit(1);
});

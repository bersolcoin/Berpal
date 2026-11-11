/**
 * Nightly tidy-up of a gem trader's stock operations that stopped half way (src/lots/recover.js):
 * documents ERPNext has but Berpal did not record are recorded, an operation whose documents are
 * all there is finished, one that never posted anything is closed. It posts nothing new and
 * messages nobody: what still needs the trader (retry or undo) is said in the chat and the digest.
 *
 * Called by src/jobs/scheduler.js at most once per user per day with deps = { erp, now, ... }.
 * It runs before lots-reconcile, which skips a user while an operation is unfinished.
 */
const lots = require('../lots');
const recover = require('../lots/recover');
const { ts } = require('../erp-sync/common');

async function run(user, deps = {}) {
  const done = await recover.recoverUser(user, deps.erp, { now: deps.now || new Date() });
  if (!done.length) return { skipped: true, note: 'no unfinished stock operation' };

  const count = (action) => done.filter((d) => d.action === action).length;
  const note = done.map((d) => `${d.reference} ${d.action}`).join(', ');
  console.log(`• [lots] [${ts()}] recover user_id=${user.id} ${done.map((d) => `${d.reference} ${d.action} (${d.detail})`).join('; ')}`);
  return { operations: done.length, posted: count('posted'), failed: count('failed'), recorded: count('recorded'), waiting: count('waiting'), note };
}

module.exports = { name: 'lots-recover', defaultTime: '02:00', window: 240, timeoutMs: 5 * 60000, enabled: (user) => lots.isGems(user), run };

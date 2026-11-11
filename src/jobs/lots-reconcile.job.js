/**
 * Nightly comparison of a gem trader's lots with ERPNext (src/lots/reconcile.js): carats, place
 * and value per lot, and the valuation holding account. It only reports: what it finds waits in
 * lot_mismatches for the morning digest and the accountant's review queue. Nobody is messaged
 * from here, and a clean night leaves nothing behind but the job_runs row.
 *
 * Called by src/jobs/scheduler.js at most once per user per day with deps = { erp, now, ... }.
 * A user with a stock operation that is only partly saved (or partly undone) is skipped: the
 * two sides are expected to differ until it is finished. One that starts while the run is reading
 * is caught inside reconcile.run, which leaves those lots (and any lot ERPNext could not be asked
 * about) alone and reports them as `unchecked`.
 */
const lots = require('../lots');
const store = require('../lots/store');
const reconcile = require('../lots/reconcile');
const { ts } = require('../erp-sync/common');

async function run(user, deps = {}) {
  const unfinished = await store.unfinishedOps(user.id);
  if (unfinished.length) return { skipped: true, note: `stock operation ${unfinished[0].reference} is not finished` };

  const r = await reconcile.run(user, deps.erp);
  const n = r.mismatches.length;
  const unchecked = r.unchecked || [];
  const left = unchecked.length ? `, ${unchecked.length} not checked (${unchecked.slice(0, 5).join(', ')}${unchecked.length > 5 ? ', …' : ''})` : '';
  if (!n && !r.closed && !unchecked.length) return { checked: r.checked, mismatches: 0, note: 'clean' };
  const note = `${r.checked} lot(s) checked, ${n} mismatch(es) open (${r.opened} new), ${r.closed} closed${left}`;
  console.log(`• [lots] [${ts()}] reconcile user_id=${user.id} ${note}`);
  return {
    checked: r.checked, mismatches: n, opened: r.opened, closed: r.closed, kinds: [...new Set(r.mismatches.map((m) => m.kind))], note,
    ...(unchecked.length ? { unchecked } : {}),
  };
}

module.exports = { name: 'lots-reconcile', defaultTime: '02:30', window: 240, timeoutMs: 10 * 60000, enabled: (user) => lots.isGems(user), run };

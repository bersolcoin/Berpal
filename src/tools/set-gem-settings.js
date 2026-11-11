const { query } = require('../db');
const store = require('../lots/store');
const lots = require('../lots');
const { ts } = require('../erp-sync/common');

// Only for accounts that already keep lots: switching it ON is provisioning's business, so the
// tool is not offered to anyone else.
const definition = {
  name: 'set_gem_settings',
  description:
    'Gem lots: choose how the cost of a lot is shared when it is sorted or cut (cost_method: "value" = by what the trader says each part is worth, the default; "weight" = by carats), or switch lot tracking OFF (only when no stones are on record; it cannot be switched back on from chat). Call ONLY when the user asks for it. The cost method cannot change once a lot has been sorted or worked on.',
  parameters: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'false = switch lot tracking off. true changes nothing.' },
      cost_method: { type: 'string', enum: lots.COST_METHODS },
    },
  },
};

const fail = (error) => ({ ok: false, error });

async function execute(args, ctx) {
  const { user } = ctx;
  const hasSwitch = typeof args.enabled === 'boolean';
  if (args.enabled != null && !hasSwitch) return fail('enabled must be true or false.');
  const method = args.cost_method == null || args.cost_method === '' ? null : typeof args.cost_method === 'string' ? args.cost_method.trim().toLowerCase() : '';
  if (method !== null && !lots.COST_METHODS.includes(method)) return fail(`cost_method must be ${lots.COST_METHODS.join(' or ')}.`);
  if (!hasSwitch && !method) return fail('Nothing to set: pass enabled=false and / or cost_method.');

  // Lot tracking is set up for an account by provisioning, never from chat (the tool is not even
  // offered to other accounts; this holds when it is reached some other way).
  if (!lots.isGems(user)) return fail('Lot tracking is not available on this account. Nothing was changed.');
  const on = hasSwitch ? args.enabled : true;

  if (!on) {
    // Stones on record would be stranded: nothing but the lot tools can sell or move them.
    const open = await store.unfinishedOps(user.id);
    if (open.length) return fail(`Stock operation ${open[0].reference} is not finished. Finish it (retry_stock_op) or take it back before switching lot tracking off.`);
    const held = (await store.listLots(user.id, { status: 'active', limit: 500 })).filter((l) => l.carats > 0);
    if (held.length) {
      const carats = lots.round3(held.reduce((s, l) => s + l.carats, 0));
      return fail(`Lot tracking cannot be switched off while there are stones on record: ${held.length} lot(s), ${carats} ct (${held.slice(0, 5).map((l) => l.code).join(', ')}${held.length > 5 ? ', …' : ''}). They have to be sold or written off first.`);
    }
  }
  if (method && method !== lots.costMethod(user)) {
    // Lots sorted or cut so far carry costs shared the old way; a change would mix the two. A
    // purchase, a sale or a move shares nothing, so those do not fix the method.
    const used = await store.countOps(user.id, { kinds: ['split', 'transform'], status: ['posted', 'pending', 'partial', 'undoing'] });
    if (used > 0) return fail(`The way cost is shared cannot change any more: ${used} sorting / cutting operation(s) are already recorded with "${lots.costMethod(user)}". It stays as it is.`);
  }

  const r = await query(
    `UPDATE users SET niche = $1, lot_cost_method = COALESCE($2, lot_cost_method), updated_at = $3 WHERE id = $4
     RETURNING niche, lot_cost_method`,
    [on ? lots.NICHE : null, method, new Date().toISOString(), user.id]
  );
  // Keep this turn's user row current: the tool list and the lot gate read it.
  Object.assign(ctx.user, r.rows[0]);
  console.log(`• [tools] [${ts()}] tool=set_gem_settings user_id=${user.id} niche=${r.rows[0].niche} lot_cost_method=${r.rows[0].lot_cost_method}`);
  return {
    ok: true,
    lot_tracking: on,
    cost_method: on ? lots.costMethod(ctx.user) : null,
    ...(!on ? { note: 'Lot tracking is now off for this account.' } : {}),
  };
}

module.exports = { definition, execute, niche: 'gems' };

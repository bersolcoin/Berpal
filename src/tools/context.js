const erpnext = require('../erpnext');

/** Lazily build the per-user ERPNext client for this turn (chitchat turns never need one). */
function getErp(ctx) {
  if (!ctx.erp) ctx.erp = erpnext.forUser(ctx.user);
  return ctx.erp;
}

module.exports = { getErp };

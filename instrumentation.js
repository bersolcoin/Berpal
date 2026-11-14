/**
 * Next.js calls `register()` once when the Node.js server boots — perfect
 * spot to run our DB migration so any new columns / tables are in place
 * before the first request lands.
 */
export async function register() {
  // Only run on the Node.js runtime (not edge). Skip in build mode.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Lazy require so this file stays light for non-Node runtimes / build steps.
  const db = require('./src/db');
  try {
    await db.init();
    console.log('[instrumentation] db initialized');
  } catch (err) {
    console.error('[instrumentation] db init failed:', err.message);
    // Don't throw — let the server boot and surface a clear error on first
    // request instead of crashing silently here.
  }

  // Install/refresh ERPNext Custom Fields for Item industry attributes.
  // Idempotent — skips per-field when they already exist. Failures here
  // are non-fatal: a missing Custom Field manifests later as a clear
  // ERPNext write error, not a boot failure.
  try {
    const { installItemCustomFields } = require('./src/erp-sync/item-custom-fields');
    const { ensureAllowNegativeStock } = require('./src/erp-sync/stock');
    const { getAdminClient } = require('./src/erp-admin');
    const adminErp = getAdminClient();
    await installItemCustomFields(adminErp);
    // Allow negative stock so first-sale-of-new-item flows don't block.
    await ensureAllowNegativeStock(adminErp);
  } catch (err) {
    console.error('[instrumentation] boot hooks failed:', err.message);
  }
}

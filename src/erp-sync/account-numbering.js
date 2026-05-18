/**
 * Auto-derive the next sensible account_number for a new leaf under a
 * given parent group. Keeps the bot's auto-created accounts consistent
 * with ERPNext's "Standard with Numbers" convention (parent 1100 →
 * children 1110, 1120, 1130 …).
 *
 *   getNextAccountNumber(erp, parentAccountName)
 *     → returns "1130" when parent is "1100 - Cash In Hand - TTC" and
 *       existing children are "1110" and "1120"
 *     → returns null when the parent has no account_number (unnumbered
 *       chart), so callers know to skip the field
 */

async function getNextAccountNumber(erp, parentAccountName) {
  if (!parentAccountName) return null;

  // 1. Fetch the parent's account_number.
  let parentNum;
  try {
    const p = await erp.getResource('Account', parentAccountName);
    parentNum = p.data?.account_number;
  } catch {
    return null;
  }
  if (!parentNum) return null;
  const parentN = parseInt(parentNum, 10);
  if (!Number.isFinite(parentN)) return null;

  // 2. Find the max numbered sibling under this parent.
  const sibs = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['parent_account', '=', parentAccountName],
    ],
    fields: ['name', 'account_number'],
    limit: 500,
  });
  let maxN = parentN;
  for (const s of sibs.data || []) {
    const n = parseInt(s.account_number, 10);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }

  // 3. Step of 10, matching ERPNext's "Standard with Numbers" convention.
  //    If parent is 1100 and max sibling is 1120, return 1130.
  const next = maxN === parentN ? parentN + 10 : maxN + 10;
  return String(next);
}

module.exports = { getNextAccountNumber };

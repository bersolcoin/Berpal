/**
 * Loose name matching for counterparty lookups.
 *
 * Business names drift between channels: a customer typed as "SS & Co"
 * on WhatsApp may have been stored as "SS and co" in ERPNext (ERPNext
 * permits "&" but our earlier code paths normalized it away). Without
 * a tolerant match, the LLM-time existence check at conversation time
 * misses and the bot re-asks for the phone on every sale.
 *
 * Normalization rules — keep deliberately small:
 *   1. Lowercase
 *   2. " & " ↔ " and "  (most common drift)
 *   3. Collapse whitespace and punctuation
 *
 * Skipped on purpose: business-suffix stripping ("Ltd" / "Inc" / "Co").
 * Those carry identity and aren't safe to drop in a fuzzy match.
 */

function normalizeNameForMatch(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase().trim();
  // & ↔ and (both directions normalize TO " and ")
  s = s.replace(/\s*&\s*/g, ' and ');
  // strip punctuation that's purely decorative
  s = s.replace(/[.,'"()]/g, ' ');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Match two names loosely. True when either name (normalized) contains
 * the other, e.g. "SS & co" ~ "ss and co llc".
 */
function namesLooselyMatch(a, b) {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * From a list of candidate rows with a .name field, return the subset
 * that loosely matches the query name. Used to filter PG cache rows
 * fetched without their own LIKE filter (we normalize JS-side rather
 * than wrestle SQL into "&" ↔ "and" awareness).
 */
function filterByNameMatch(rows, query, nameKey = 'name') {
  const nq = normalizeNameForMatch(query);
  if (!nq) return [];
  return rows.filter((r) => {
    const nn = normalizeNameForMatch(r[nameKey]);
    return nn && (nn.includes(nq) || nq.includes(nn));
  });
}

module.exports = {
  normalizeNameForMatch,
  namesLooselyMatch,
  filterByNameMatch,
};

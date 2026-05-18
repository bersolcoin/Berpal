/**
 * Multi-currency aggregator for headline stats.
 *
 * Given a per-currency totals map like { USD: 7000, THB: 245000 } and a
 * base currency, returns { value, isApprox, perCurrency }:
 *   - value:        sum converted into base currency (best-effort)
 *   - isApprox:     true if any conversion happened (so the UI can prefix ~)
 *   - perCurrency:  the original totals, unchanged (for the breakdown row)
 *
 * Uses frankfurter.app via src/exchange.js. Rates are cached per-request via
 * React.cache so the dashboard doesn't fetch the same USD→THB three times.
 */

import { cache } from 'react';
const { fetchRate } = require('../../../src/exchange');

const getRate = cache(async (from, to) => {
  if (from === to) return 1;
  const r = await fetchRate(from, to);
  if (r.error) return null;
  return r.rate;
});

export async function convertToBase(perCurrency, baseCurrency) {
  const entries = Object.entries(perCurrency || {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (entries.length === 0) {
    return { value: 0, isApprox: false, perCurrency: {} };
  }

  let value = 0;
  let isApprox = false;

  for (const [ccy, amt] of entries) {
    if (ccy === baseCurrency) {
      value += amt;
      continue;
    }
    const rate = await getRate(ccy, baseCurrency);
    if (rate == null) {
      // Couldn't convert — flag approx and skip the contribution rather than
      // silently dropping it. The per-currency breakdown still shows it.
      isApprox = true;
      continue;
    }
    value += amt * rate;
    isApprox = true;
  }

  return { value, isApprox, perCurrency };
}

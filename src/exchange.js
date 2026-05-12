/**
 * Foreign-exchange rate lookup via frankfurter.app — free, no API key, ECB reference rates.
 * Supports historical rates for any past weekday (rates not published on weekends).
 */

const BASE_URL = 'https://api.frankfurter.app';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isValidIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Fetch the rate from one currency to another for a given date.
 * Returns { rate, source, date_used, error? }.
 *
 * `date_used` is the date frankfurter actually returned a rate for —
 * it can shift back if you ask for a weekend (no FX market that day).
 */
async function fetchRate(fromCurrency, toCurrency, date = null) {
  if (!fromCurrency || !toCurrency) {
    return { error: 'from_currency and to_currency are required' };
  }
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();

  if (from === to) {
    return { rate: 1.0, source: 'same_currency', date_used: date || todayIso() };
  }

  const dateParam = date && isValidIsoDate(date) ? date : todayIso();
  const url = `${BASE_URL}/${dateParam}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return { error: `frankfurter ${response.status}: ${response.statusText}` };
    }
    const data = await response.json();
    const rate = data?.rates?.[to];
    if (typeof rate !== 'number') {
      return { error: `no rate for ${from}->${to} on ${dateParam}` };
    }
    return {
      rate,
      source: 'frankfurter',
      date_used: data.date || dateParam,
    };
  } catch (err) {
    return { error: `fetch failed: ${err.message}` };
  }
}

module.exports = { fetchRate };

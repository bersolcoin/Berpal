/**
 * Display helpers — money formatting, dates, etc.
 *
 * `money(amount, currency)` uses Intl.NumberFormat with currency symbol,
 * 0–2 fraction digits depending on size, tabular-friendly.
 */

const CURRENCY_FRACTION_DIGITS = {
  JPY: 0, KRW: 0, IDR: 0, VND: 0,
};

export function money(amount, currency = 'USD') {
  const n = Number(amount) || 0;
  const fractionDigits = CURRENCY_FRACTION_DIGITS[currency] ?? 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(fractionDigits)}`;
  }
}

/**
 * Compact currency: $1.5k, ฿2.3m, etc. Use for headline stats where a precise
 * cent amount would be visual noise. Falls back to full-precision `money()`
 * for amounts under 10,000 where compact notation looks weird ("$1.2k" for
 * a $1234 figure rounds away meaningful precision).
 */
export function compactMoney(amount, currency = 'USD', { approx = false } = {}) {
  const n = Number(amount) || 0;
  const abs = Math.abs(n);
  if (abs < 10000) {
    const plain = money(n, currency);
    return approx ? `~${plain}` : plain;
  }
  try {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
    return approx ? `~${formatted}` : formatted;
  } catch {
    const compact = compactNumber(n);
    return `${approx ? '~' : ''}${currency} ${compact}`;
  }
}

function compactNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'b';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'm';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}

export function date(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * ISO 4217 currency → ISO 3166-1 alpha-2 country (lowercase, for flag-icons).
 * For multi-country currencies (EUR), the most representative country flag
 * is used; flag-icons also exports an "eu" sprite for the EU itself.
 */
const CURRENCY_TO_COUNTRY = {
  USD: 'us', EUR: 'eu', GBP: 'gb', JPY: 'jp', CNY: 'cn',
  HKD: 'hk', THB: 'th', SGD: 'sg', INR: 'in', AUD: 'au',
  CAD: 'ca', KRW: 'kr', IDR: 'id', MYR: 'my', VND: 'vn',
  PHP: 'ph', AED: 'ae', CHF: 'ch', NZD: 'nz', ZAR: 'za',
  BRL: 'br', MXN: 'mx', RUB: 'ru', TRY: 'tr', SAR: 'sa',
  PKR: 'pk', BDT: 'bd', LKR: 'lk', NPR: 'np', TWD: 'tw',
  NOK: 'no', SEK: 'se', DKK: 'dk', PLN: 'pl', CZK: 'cz',
  HUF: 'hu', ILS: 'il', EGP: 'eg', NGN: 'ng', KES: 'ke',
};

export function currencyToCountry(currency) {
  return CURRENCY_TO_COUNTRY[String(currency || '').toUpperCase()] || null;
}

/**
 * <Flag country="us" /> — renders a flag-icons span. Use the `country` prop
 * for ISO codes, or `currency` for ISO 4217 currency codes (auto-converted).
 *
 * Defaults to a 1em-square sprite so it sits inline with text. Set `square`
 * to false for the standard 4:3 aspect.
 */
export function Flag({ country, currency, square = true, className = '' }) {
  const code = country
    ? String(country).toLowerCase()
    : currencyToCountry(currency);
  if (!code) {
    return <span className={`inline-block w-4 h-4 rounded-sm bg-slate-200 ${className}`} aria-hidden="true" />;
  }
  return (
    <span
      className={`fi fi-${code}${square ? ' fis' : ''} rounded-sm ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * Strip ERPNext's account-name decoration: "1110 - Cash - TTC" → "Cash"
 */
export function friendlyAccountName(erpName) {
  if (!erpName) return '';
  const parts = String(erpName).split(' - ');
  if (parts.length >= 3) return parts.slice(1, -1).join(' - ');
  return erpName;
}

/**
 * Build the /accounts/[name] URL. Prefer the account_number (clean URL like
 * /accounts/1110) and fall back to URL-encoding the full ERPNext name when
 * a number isn't available (e.g. group accounts).
 *
 *   accountUrl({ account_number: '1110', erpnext_name: '1110 - Cash - TTC' })
 *     → '/accounts/1110'
 *   accountUrl({ erpnext_name: 'Application of Funds (Assets) - TTC' })
 *     → '/accounts/Application%20of%20Funds...'
 */
export function accountUrl(account) {
  if (!account) return '/accounts';
  const num = account.account_number;
  if (num && String(num).trim()) {
    return `/accounts/${encodeURIComponent(String(num).trim())}`;
  }
  const fallback = account.erpnext_name || account.name;
  return `/accounts/${encodeURIComponent(fallback)}`;
}

/**
 * Strip the company suffix from a customer/supplier name if any.
 */
export function friendlyPartyName(name) {
  if (!name) return '';
  return String(name).replace(/\s+-\s+[A-Z]{2,5}$/, '');
}

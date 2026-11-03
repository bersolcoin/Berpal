/**
 * Thin ERPNext REST client. One client per user (each user has their own API creds + Company).
 *
 * Pattern:
 *   const erp = erpnext.forUser(userRow);   // userRow has erpnext_url, erpnext_api_key, erpnext_api_secret, erpnext_company
 *   await erp.listCustomers();
 *   await erp.createCustomer({...});
 *   await erp.callMethod('erpnext.accounts.utils.get_balance_on', { account: '...', date: '...' });
 *
 * All methods throw on non-2xx with a message that includes the ERPNext error body.
 * Callers should try/catch and surface a friendly message to the user.
 */

const ERPNEXT_BASE_URL =
  process.env.ERPNEXT_URL ? process.env.ERPNEXT_URL.replace(/\/$/, '') : null;

function buildAuthHeader(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) {
    throw new Error('[erpnext] missing api_key / api_secret on user');
  }
  return `token ${apiKey}:${apiSecret}`;
}

/**
 * Resolve the base URL to use. Per-user override wins, otherwise process env default.
 * (Per-user URLs become useful if/when users self-host their own ERPNext later — for v1
 * they all share the platform's instance.)
 */
function resolveBaseUrl(user) {
  return (
    (user && user.erpnext_url ? String(user.erpnext_url).replace(/\/$/, '') : null) ||
    ERPNEXT_BASE_URL
  );
}

// A hung ERPNext (or wkhtmltopdf) must not hang a WhatsApp turn or a scheduler pass with it.
const REQUEST_TIMEOUT_MS = 30000;

/** Our timeout, plus the caller's signal (e.g. the scheduler's deps.signal) when given. */
function withTimeout(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function stripHtml(text) {
  return String(text)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class ErpNextClient {
  constructor(user) {
    this.user = user;
    this.baseUrl = resolveBaseUrl(user);
    if (!this.baseUrl) {
      throw new Error('[erpnext] no base URL — set ERPNEXT_URL in .env or users.erpnext_url');
    }
    this.authHeader = buildAuthHeader(user.erpnext_api_key, user.erpnext_api_secret);
    this.company = user.erpnext_company || null;
  }

  async _fetch(method, path, body = null, { signal = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const opts = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: withTimeout(signal, timeoutMs),
    };
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw this._httpError(method, path, res.status, json);
    return json;
  }

  _httpError(method, path, status, json) {
    // ERPNext error responses include either `exception` or `_server_messages`.
    // HTML error pages (proxies, wkhtmltopdf crashes) are mostly markup — strip it so the
    // 200 chars we keep are the readable part.
    const msg =
      json.exception ||
      json._server_messages ||
      (json.raw ? stripHtml(json.raw).slice(0, 200) || `HTTP ${status}` : `HTTP ${status}`);
    const err = new Error(`[erpnext ${method} ${path}] ${msg}`);
    err.status = status;
    err.response = json;
    return err;
  }

  /**
   * GET a binary payload (PDFs). Kept separate from _fetch so JSON callers never see a Buffer,
   * and so the body is read as bytes — res.text() would mangle anything non-UTF-8.
   */
  async _fetchBinary(path, { signal = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    // PDF rendering (wkhtmltopdf) can hang on a bad print format; don't let a tool call hang with it.
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader, Accept: '*/*' },
      signal: withTimeout(signal, timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      throw this._httpError('GET', path, res.status, json);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** POST multipart/form-data (file uploads). fetch sets the boundary header itself from FormData. */
  async _fetchMultipart(path, form, { signal = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
      body: form,
      signal: withTimeout(signal, timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw this._httpError('POST', path, res.status, json);
    return json;
  }

  // ── Generic ──────────────────────────────────────────────────────────

  /** Fetch a single resource by name: GET /api/resource/<doctype>/<name> */
  getResource(doctype, name, fields = null) {
    const qs = fields ? `?fields=${encodeURIComponent(JSON.stringify(fields))}` : '';
    return this._fetch('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}${qs}`);
  }

  /** List resources: GET /api/resource/<doctype>?filters=...&fields=... */
  listResource(doctype, { filters = null, fields = null, limit = 20, orderBy = null } = {}) {
    const params = [];
    if (filters) params.push(`filters=${encodeURIComponent(JSON.stringify(filters))}`);
    if (fields) params.push(`fields=${encodeURIComponent(JSON.stringify(fields))}`);
    if (limit) params.push(`limit_page_length=${limit}`);
    if (orderBy) params.push(`order_by=${encodeURIComponent(orderBy)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this._fetch('GET', `/api/resource/${encodeURIComponent(doctype)}${qs}`);
  }

  createResource(doctype, data) {
    return this._fetch('POST', `/api/resource/${encodeURIComponent(doctype)}`, data);
  }

  updateResource(doctype, name, data) {
    return this._fetch('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, data);
  }

  deleteResource(doctype, name) {
    return this._fetch('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  }

  /** Call any whitelisted Frappe method (e.g. for balance, reports). */
  callMethod(methodPath, args = {}) {
    // Frappe convention: /api/method/<dotted.path>?arg=val&...
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v == null) continue;
      params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const qs = params.toString();
    return this._fetch('GET', `/api/method/${methodPath}${qs ? '?' + qs : ''}`);
  }

  // ── Convenience wrappers (most-used doctypes) ──────────────────────

  // ── Files / print ─────────────────────────────────────────────────

  /**
   * Render a document through an ERPNext Print Format and return the PDF bytes.
   * `format` is the Print Format name; omitted → ERPNext's default for the doctype ("Standard").
   */
  async getPdf(doctype, name, { format, signal = null } = {}) {
    const params = new URLSearchParams({ doctype, name });
    if (format) params.set('format', format);
    params.set('no_letterhead', '0');
    const buf = await this._fetchBinary(`/api/method/frappe.utils.print_format.download_pdf?${params}`, { signal });
    // A misconfigured print setup can answer 200 with an HTML error page; never ship that as a "PDF".
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      const snippet = stripHtml(buf.subarray(0, 2000).toString('utf8')).slice(0, 200);
      throw new Error(`[erpnext] print of ${doctype} ${name} did not return a PDF${snippet ? `: ${snippet}` : ''}`);
    }
    return buf;
  }

  /**
   * Upload a file to ERPNext's File doctype, optionally attached to a document.
   * isPrivate=false makes it reachable without auth at `${baseUrl}${file_url}` — that's what
   * lets Twilio fetch it as WhatsApp media, so pick unguessable filenames for anything sensitive.
   *   returns { file_url, name }
   */
  async uploadFile({ buffer, filename, contentType = 'application/octet-stream', isPrivate = true, doctype = null, docname = null, signal = null }) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), filename);
    form.append('file_name', filename);
    form.append('is_private', isPrivate ? '1' : '0');
    if (doctype && docname) {
      form.append('doctype', doctype);
      form.append('docname', docname);
    }
    const r = await this._fetchMultipart('/api/method/upload_file', form, { signal });
    const file = r.message || {};
    return { file_url: file.file_url, name: file.name };
  }

  getMe() {
    return this.callMethod('frappe.auth.get_logged_user').then((r) => r.message);
  }

  listCompanies(fields = ['name', 'abbr', 'default_currency', 'country']) {
    return this.listResource('Company', { fields });
  }

  // Customers / Suppliers
  listCustomers(opts = {}) {
    return this.listResource('Customer', { fields: ['name', 'customer_name', 'mobile_no'], ...opts });
  }
  getCustomer(name) {
    return this.getResource('Customer', name);
  }
  createCustomer(data) {
    // Sensible defaults for a fresh Customer record
    const payload = {
      customer_type: 'Individual',
      customer_group: 'Individual',
      territory: 'All Territories',
      ...data,
    };
    return this.createResource('Customer', payload);
  }

  listSuppliers(opts = {}) {
    return this.listResource('Supplier', { fields: ['name', 'supplier_name', 'mobile_no'], ...opts });
  }
  createSupplier(data) {
    const payload = {
      supplier_type: 'Individual',
      supplier_group: 'All Supplier Groups',
      ...data,
    };
    return this.createResource('Supplier', payload);
  }

  // Accounts (chart of accounts entries)
  listAccounts(opts = {}) {
    return this.listResource('Account', {
      fields: ['name', 'account_name', 'account_type', 'account_currency', 'is_group', 'parent_account', 'company'],
      filters: this.company ? [['company', '=', this.company]] : null,
      limit: 200,
      ...opts,
    });
  }
  createAccount(data) {
    const payload = { company: this.company, ...data };
    return this.createResource('Account', payload);
  }

  /** Get the balance on an Account as of a given date (default today). */
  getAccountBalance(accountName, date = null) {
    return this.callMethod('erpnext.accounts.utils.get_balance_on', {
      account: accountName,
      date: date || new Date().toISOString().slice(0, 10),
      company: this.company,
    });
  }

  // Invoices / Payments / Journal — created later as we wire each tool

  createSalesInvoice(data) {
    return this.createResource('Sales Invoice', { company: this.company, ...data });
  }
  createPurchaseInvoice(data) {
    return this.createResource('Purchase Invoice', { company: this.company, ...data });
  }
  createPaymentEntry(data) {
    return this.createResource('Payment Entry', { company: this.company, ...data });
  }
  createJournalEntry(data) {
    return this.createResource('Journal Entry', { company: this.company, ...data });
  }
}

/** Build a per-user client. user must have erpnext_api_key + erpnext_api_secret + erpnext_company. */
function forUser(user) {
  return new ErpNextClient(user);
}

module.exports = { forUser, ErpNextClient };

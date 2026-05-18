/**
 * Admin-level ERPNext client. Uses ERPNEXT_API_KEY / ERPNEXT_API_SECRET
 * from .env which (in this deployment) are the system manager creds — enough
 * to create Companies, Users, and generate API keys for new users.
 *
 * Distinct from src/erpnext.js's per-user client (which is constructed
 * with one user's keys, scoped to that user's permissions).
 */

class ErpAdminClient {
  constructor() {
    this.baseUrl = (process.env.ERPNEXT_URL || '').replace(/\/$/, '');
    if (!this.baseUrl) throw new Error('[erp-admin] ERPNEXT_URL not set');

    const key = process.env.ERPNEXT_API_KEY;
    const secret = process.env.ERPNEXT_API_SECRET;
    if (!key || !secret) {
      throw new Error('[erp-admin] ERPNEXT_API_KEY / ERPNEXT_API_SECRET not set');
    }
    this.authHeader = `token ${key}:${secret}`;
  }

  async _fetch(method, path, body = null) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const opts = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg =
        json.exception ||
        json._server_messages ||
        (json.raw ? json.raw.slice(0, 300) : `HTTP ${res.status}`);
      const err = new Error(`[erp-admin ${method} ${path}] ${msg}`);
      err.status = res.status;
      err.response = json;
      throw err;
    }
    return json;
  }

  getResource(doctype, name, fields = null) {
    const qs = fields ? `?fields=${encodeURIComponent(JSON.stringify(fields))}` : '';
    return this._fetch('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}${qs}`);
  }

  listResource(doctype, { filters = null, fields = null, limit = 20 } = {}) {
    const params = [];
    if (filters) params.push(`filters=${encodeURIComponent(JSON.stringify(filters))}`);
    if (fields) params.push(`fields=${encodeURIComponent(JSON.stringify(fields))}`);
    if (limit) params.push(`limit_page_length=${limit}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return this._fetch('GET', `/api/resource/${encodeURIComponent(doctype)}${qs}`);
  }

  createResource(doctype, data) {
    return this._fetch('POST', `/api/resource/${encodeURIComponent(doctype)}`, data);
  }

  updateResource(doctype, name, data) {
    return this._fetch('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, data);
  }

  callMethod(methodPath, args = {}) {
    // POST body form for whitelisted methods that mutate.
    return this._fetch('POST', `/api/method/${methodPath}`, args);
  }

  callMethodGet(methodPath, args = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v == null) continue;
      params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const qs = params.toString();
    return this._fetch('GET', `/api/method/${methodPath}${qs ? '?' + qs : ''}`);
  }
}

let _singleton = null;
function getAdminClient() {
  if (!_singleton) _singleton = new ErpAdminClient();
  return _singleton;
}

module.exports = { getAdminClient, ErpAdminClient };

/**
 * Startup env validation (src/config.js): required vars, production rules, the TWILIO_ENV
 * sender choice, ERPNEXT_URL normalisation, and that messages never echo values.
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv, assertEnv } = require('../src/config');

/** A complete dev env; tests override or delete from a copy. */
function base(extra = {}) {
  return {
    DATABASE_URL: 'postgresql://u:pw-secret@db:5432/berpal',
    OPENAI_API_KEY: 'sk-secret-openai',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'tok-secret-twilio',
    ERPNEXT_URL: 'https://erp.example.com',
    TWILIO_ENV: 'sandbox',
    TWILIO_WHATSAPP_NUMBER_SANDBOX: 'whatsapp:+14155238886',
    TWILIO_DIGEST_CONTENT_SID: 'HXd',
    TWILIO_INVOICE_CONTENT_SID: 'HXi',
    TWILIO_REMINDER_CONTENT_SID: 'HXr',
    ERPNEXT_API_KEY: 'k',
    ERPNEXT_API_SECRET: 's',
    ...extra,
  };
}

/** A complete production env. */
function prod(extra = {}) {
  return base({
    NODE_ENV: 'production',
    TWILIO_ENV: 'live',
    TWILIO_WHATSAPP_NUMBER_LIVE: 'whatsapp:+6620000000',
    PUBLIC_BASE_URL: 'https://bot.example.com',
    TWILIO_CONFIRMATION_CONTENT_SID: 'HXc',
    ...extra,
  });
}

function without(env, ...names) {
  const copy = { ...env };
  for (const n of names) delete copy[n];
  return copy;
}

test('complete dev env: ok, no errors, no warnings', () => {
  const r = validateEnv(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('complete production env: ok', () => {
  const r = validateEnv(prod());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
});

test('each always-required var is reported by name when missing or blank', () => {
  for (const name of ['DATABASE_URL', 'OPENAI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'ERPNEXT_URL']) {
    for (const env of [without(base(), name), base({ [name]: '  ' })]) {
      const r = validateEnv(env);
      assert.equal(r.ok, false, name);
      assert.deepEqual(r.errors, [`${name} is not set`]);
    }
  }
});

test('empty env lists every required var at once', () => {
  const r = validateEnv({});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 6); // five vars + the sandbox sender
  assert.ok(r.errors.some((e) => e.includes('TWILIO_WHATSAPP_NUMBER_SANDBOX')));
});

test('ERPNEXT_URL: trailing slashes normalised, non-http and garbage rejected', () => {
  assert.deepEqual(validateEnv(base()).normalized, {});
  const r = validateEnv(base({ ERPNEXT_URL: 'https://erp.example.com//' }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized.ERPNEXT_URL, 'https://erp.example.com');

  assert.deepEqual(validateEnv(base({ ERPNEXT_URL: 'erp.example.com' })).errors, ['ERPNEXT_URL is not a valid URL']);
  assert.deepEqual(validateEnv(base({ ERPNEXT_URL: 'ftp://erp.example.com' })).errors, ['ERPNEXT_URL must be an http(s) URL']);
  // http is fine (local ERPNext); only callback URLs must be https in production.
  assert.equal(validateEnv(prod({ ERPNEXT_URL: 'http://erpnext:8000' })).ok, true);
});

test('sender: sandbox uses *_SANDBOX, falls back to legacy, errors without either', () => {
  assert.equal(validateEnv(base()).ok, true);
  const legacy = without(base({ TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155238886' }), 'TWILIO_WHATSAPP_NUMBER_SANDBOX');
  assert.equal(validateEnv(legacy).ok, true);
  // TWILIO_ENV unset means sandbox, as in src/twilio-client.js.
  assert.equal(validateEnv(without(base(), 'TWILIO_ENV')).ok, true);
  const none = validateEnv(without(base(), 'TWILIO_WHATSAPP_NUMBER_SANDBOX'));
  assert.deepEqual(none.errors, ['TWILIO_ENV=sandbox needs TWILIO_WHATSAPP_NUMBER_SANDBOX (or the legacy TWILIO_WHATSAPP_NUMBER)']);
});

test('sender: live needs *_LIVE or legacy; the sandbox number alone is not enough', () => {
  const live = base({ TWILIO_ENV: 'LIVE', TWILIO_WHATSAPP_NUMBER_LIVE: 'whatsapp:+6620000000' });
  assert.equal(validateEnv(live).ok, true);
  const sandboxOnly = validateEnv(base({ TWILIO_ENV: 'live' }));
  assert.deepEqual(sandboxOnly.errors, ['TWILIO_ENV=live needs TWILIO_WHATSAPP_NUMBER_LIVE (without it the bot sends from TWILIO_WHATSAPP_NUMBER_SANDBOX)']);
  const nothing = validateEnv(without(base({ TWILIO_ENV: 'live' }), 'TWILIO_WHATSAPP_NUMBER_SANDBOX'));
  assert.deepEqual(nothing.errors, ['TWILIO_ENV=live needs TWILIO_WHATSAPP_NUMBER_LIVE (or the legacy TWILIO_WHATSAPP_NUMBER)']);
  // Legacy number works for live only when *_SANDBOX is unset: src/twilio-client.js picks
  // LIVE || SANDBOX || legacy, so with SANDBOX set it would send from the sandbox.
  const legacyOnly = without(base({ TWILIO_ENV: 'live', TWILIO_WHATSAPP_NUMBER: 'whatsapp:+6620000000' }), 'TWILIO_WHATSAPP_NUMBER_SANDBOX');
  assert.equal(validateEnv(legacyOnly).ok, true);
  const legacyPlusSandbox = validateEnv(base({ TWILIO_ENV: 'live', TWILIO_WHATSAPP_NUMBER: 'whatsapp:+6620000000' }));
  assert.equal(legacyPlusSandbox.ok, false);
  assert.ok(legacyPlusSandbox.errors[0].includes('sends from TWILIO_WHATSAPP_NUMBER_SANDBOX'));
});

test('sender: validateEnv agrees with resolveFromNumber() in src/twilio-client.js', () => {
  // resolveFromNumber isn't exported; it runs at module load and logs `from=<number>`, so
  // re-require the module per case and read that line.
  const NAMES = ['TWILIO_ENV', 'TWILIO_WHATSAPP_NUMBER_SANDBOX', 'TWILIO_WHATSAPP_NUMBER_LIVE', 'TWILIO_WHATSAPP_NUMBER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
  const S = 'whatsapp:+1000', L = 'whatsapp:+2000', G = 'whatsapp:+3000';
  const cases = [];
  for (const mode of [undefined, 'sandbox', 'live', 'LIVE', ' live']) {
    for (const s of [undefined, S]) for (const l of [undefined, L]) for (const g of [undefined, G]) {
      cases.push({ TWILIO_ENV: mode, TWILIO_WHATSAPP_NUMBER_SANDBOX: s, TWILIO_WHATSAPP_NUMBER_LIVE: l, TWILIO_WHATSAPP_NUMBER: g });
    }
  }
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  const { log, warn } = console;
  let logged = [];
  console.log = (...a) => logged.push(a.join(' '));
  console.warn = () => {};
  try {
    for (const c of cases) {
      for (const n of NAMES) delete process.env[n];
      for (const [k, v] of Object.entries(c)) if (v !== undefined) process.env[k] = v;
      const modPath = require.resolve('../src/twilio-client');
      delete require.cache[modPath];
      logged = [];
      require('../src/twilio-client');
      const line = logged.find((l) => l.startsWith('[twilio] env='));
      const m = line && line.match(/ from=(.*)$/);
      const real = m && m[1] !== '(none)' ? m[1] : null;
      const r = validateEnv(base(c));
      const label = JSON.stringify(c);
      if (r.ok) {
        // Whatever config accepted is what twilio-client sends from, and live never means sandbox.
        const name = require('../src/config').senderFor(base(c)).name;
        assert.equal(real, c[name], label);
        if (String(c.TWILIO_ENV || '').toLowerCase() === 'live') assert.notEqual(real, S, label);
      }
    }
  } finally {
    console.log = log; console.warn = warn;
    for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    delete require.cache[require.resolve('../src/twilio-client')];
  }
});

test('sender: unknown TWILIO_ENV is an error; a number without whatsapp: is a warning', () => {
  assert.deepEqual(validateEnv(base({ TWILIO_ENV: 'prod' })).errors, ['TWILIO_ENV must be "sandbox" or "live"']);
  // twilio-client.js doesn't trim, so " live" would silently run on the sandbox number.
  assert.deepEqual(validateEnv(base({ TWILIO_ENV: ' live' })).errors, ['TWILIO_ENV must be "sandbox" or "live"']);
  const r = validateEnv(base({ TWILIO_WHATSAPP_NUMBER_SANDBOX: '+14155238886' }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.startsWith('TWILIO_WHATSAPP_NUMBER_SANDBOX should start with "whatsapp:"')));
});

test('production: needs an https callback URL', () => {
  const none = validateEnv(without(prod(), 'PUBLIC_BASE_URL'));
  assert.equal(none.ok, false);
  assert.ok(none.errors[0].startsWith('NODE_ENV=production needs PUBLIC_BASE_URL or TWILIO_WEBHOOK_URL'));

  assert.deepEqual(validateEnv(prod({ PUBLIC_BASE_URL: 'http://bot.example.com' })).errors, ['PUBLIC_BASE_URL must be https in production']);

  // TWILIO_WEBHOOK_URL alone satisfies the webhook but warns about the status callback.
  const hookOnly = validateEnv(without(prod({ TWILIO_WEBHOOK_URL: 'https://bot.example.com/webhook' }), 'PUBLIC_BASE_URL'));
  assert.equal(hookOnly.ok, true);
  assert.ok(hookOnly.warnings.some((w) => w.startsWith('PUBLIC_BASE_URL is not set')));

  // Dev accepts http (ngrok) and no URL at all; a malformed one is an error everywhere.
  assert.equal(validateEnv(base({ PUBLIC_BASE_URL: 'http://localhost:3000' })).ok, true);
  assert.deepEqual(validateEnv(base({ TWILIO_WEBHOOK_URL: 'not a url' })).errors, ['TWILIO_WEBHOOK_URL is not a valid URL']);
});

test('production: confirmation template required, LOG_MESSAGES and SEED_TEST_USER_PHONE refused', () => {
  assert.ok(validateEnv(without(prod(), 'TWILIO_CONFIRMATION_CONTENT_SID')).errors[0].startsWith('TWILIO_CONFIRMATION_CONTENT_SID is not set'));
  assert.ok(validateEnv(prod({ LOG_MESSAGES: 'TRUE' })).errors[0].startsWith('LOG_MESSAGES must not be true'));
  assert.equal(validateEnv(prod({ LOG_MESSAGES: 'false' })).ok, true);
  assert.ok(validateEnv(prod({ SEED_TEST_USER_PHONE: '+12025550100' })).errors[0].startsWith('SEED_TEST_USER_PHONE must be unset'));
  assert.equal(validateEnv(prod({ SEED_TEST_USER_PHONE: '' })).ok, true);
  // None of these apply outside production.
  assert.equal(validateEnv(base({ LOG_MESSAGES: 'true', SEED_TEST_USER_PHONE: '+12025550100' })).ok, true);
});

test('production on the sandbox warns', () => {
  const r = validateEnv(prod({ TWILIO_ENV: 'sandbox' }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('TWILIO_ENV=sandbox')));
});

test('warnings: missing template SIDs and ERPNext default credentials degrade, not fail', () => {
  const r = validateEnv(without(base(), 'TWILIO_DIGEST_CONTENT_SID', 'TWILIO_INVOICE_CONTENT_SID', 'TWILIO_REMINDER_CONTENT_SID', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET'));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 5);
  for (const name of ['TWILIO_DIGEST_CONTENT_SID', 'TWILIO_INVOICE_CONTENT_SID', 'TWILIO_REMINDER_CONTENT_SID', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET']) {
    assert.ok(r.warnings.some((w) => w.startsWith(`${name} is not set`)), name);
  }
});

test('messages never contain secret values', () => {
  const env = prod({
    PUBLIC_BASE_URL: 'http://pw-secret-host.example.com',
    ERPNEXT_URL: 'ftp://pw-secret-erp',
    LOG_MESSAGES: 'true',
    SEED_TEST_USER_PHONE: '+19995550123',
    TWILIO_ENV: 'live',
    TWILIO_WHATSAPP_NUMBER_LIVE: '+6620000000',
  });
  const r = validateEnv(env);
  const all = [...r.errors, ...r.warnings].join('\n');
  for (const v of ['pw-secret', 'sk-secret', 'tok-secret', '+19995550123', '+6620000000']) {
    assert.ok(!all.includes(v), `leaked ${v}`);
  }
});

test('assertEnv: logs one line per problem and exits 1; applies normalisation when ok', () => {
  const lines = { warn: [], error: [] };
  const log = { warn: (l) => lines.warn.push(l), error: (l) => lines.error.push(l) };
  let code = null;
  assertEnv({ env: without(base(), 'OPENAI_API_KEY', 'DATABASE_URL'), exit: (c) => { code = c; }, log });
  assert.equal(code, 1);
  assert.deepEqual(lines.error.slice(0, 2), ['[config] ✖ DATABASE_URL is not set', '[config] ✖ OPENAI_API_KEY is not set']);

  code = null;
  const env = base({ ERPNEXT_URL: 'https://erp.example.com/' });
  const r = assertEnv({ env, exit: (c) => { code = c; }, log });
  assert.equal(code, null);
  assert.equal(r.ok, true);
  assert.equal(env.ERPNEXT_URL, 'https://erp.example.com');
});

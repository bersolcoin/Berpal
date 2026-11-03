/**
 * LLM conversation harness — does GPT actually pick the right tools?
 *
 * Runs scripted WhatsApp conversations through conversation.handle() with the REAL OpenAI
 * model, while ERPNext (test/fake-erpnext.js) and Postgres (pg-mem) stay in memory.
 * Frankfurter FX lookups are stubbed to a fixed rate so runs are deterministic.
 *
 *   npm run test:llm            needs OPENAI_API_KEY in .env; costs a few cents (gpt-4o-mini)
 *   VERBOSE=1 npm run test:llm  also prints the bot's internal tool logs
 *
 * Not part of `npm test`: it needs network + a paid key, and model output is not fully
 * deterministic. Treat a failure as "look at the transcript", not as a red build.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ERPNEXT_URL = 'http://erp.test';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to .env and rerun.');
  process.exit(2);
}

const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');

// Quiet the bot's own logging unless asked for.
const realLog = console.log;
if (!process.env.VERBOSE) {
  console.log = (...a) => {
    if (typeof a[0] === 'string' && (a[0].startsWith('• [') || a[0].startsWith('['))) return;
    realLog(...a);
  };
}

// ── Observe tool calls: patch the registry BEFORE conversation.js captures executeTool ──
const toolsModule = require('../src/tools');
const calls = [];
const origExecute = toolsModule.executeTool;
toolsModule.executeTool = async (name, args, ctx) => {
  const result = await origExecute(name, args, ctx);
  calls.push({ name, args, result });
  return result;
};
const conversation = require('../src/conversation');

const FX_RATE = 32.5;
const erp = new FakeErpNext();
erp.install();
const erpFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('frankfurter')) {
    const u = new URL(url);
    const from = u.searchParams.get('from') || u.searchParams.get('base') || 'USD';
    const to = (u.searchParams.get('to') || u.searchParams.get('symbols') || 'THB').split(',')[0];
    const body = { amount: 1, base: from, date: TODAY, rates: { [to]: FX_RATE } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return erpFetch(url, opts);
};

let user;
async function setup() {
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, display_name, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ('+66000', 'Harness', $1, 'k', 's', 'THB', 'THB', 'TH', $2, $2) RETURNING *`,
    [COMPANY, now]
  );
  user = r.rows[0];
}

// ── Scenario runner ─────────────────────────────────────────────────────
const failures = [];
let turnCount = 0;

function check(label, ok, detail = '') {
  realLog(`      ${ok ? '✔' : '✖'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * step: { say, expect: { tools?: [names that must be called], noTools?: true,
 *         confirmation?: bool, reply?: RegExp, after?: () => void } }
 * `say` may be a function of the previous reply, for answering pickers.
 */
async function scenario(title, steps) {
  realLog(`\n■ ${title}`);
  let lastReply = '';
  for (const step of steps) {
    const text = typeof step.say === 'function' ? step.say(lastReply) : step.say;
    calls.length = 0;
    turnCount++;
    let result;
    try {
      result = await conversation.handle(user, text);
    } catch (err) {
      realLog(`   › ${text}\n   ✖ handle() threw: ${err.message}`);
      failures.push(`${title}: handle threw`);
      return;
    }
    if (typeof result === 'string') result = { text: result, isConfirmation: false };
    lastReply = result.text;
    const toolNames = calls.map((c) => c.name);
    const shown = calls.map((c) => (c.name === 'update_draft' ? `update_draft${JSON.stringify(c.args)}` : c.name));
    realLog(`   › ${text}`);
    realLog(`     tools: ${shown.length ? shown.join(' → ') : '(none)'}${result.isConfirmation ? '   [confirmation card]' : ''}`);
    realLog(`     « ${result.text.replace(/\n/g, '\n       ')}`);
    const failed = calls.filter((c) => c.result && c.result.ok === false);
    for (const f of failed) realLog(`     ⚠ ${f.name} returned error: ${f.result.error}`);

    const e = step.expect || {};
    for (const t of e.tools || []) check(`called ${t}`, toolNames.includes(t), `got ${toolNames.join(', ') || 'none'}`);
    if (e.noTools) check('no tools called', toolNames.length === 0, toolNames.join(', '));
    if (e.confirmation != null) check(`confirmation card ${e.confirmation ? 'sent' : 'not sent'}`, result.isConfirmation === e.confirmation);
    if (e.reply) check(`reply matches ${e.reply}`, e.reply.test(result.text));
    if (e.after) {
      try {
        e.after(result);
      } catch (err) {
        check(err.message, false);
      }
    }
  }
}

function assertEq(label, actual, expected) {
  check(`${label} = ${JSON.stringify(expected)}`, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const yes = 'Confirm';
const usdBank = () => erp.all('Account').find((a) => a.account_type === 'Bank' && a.account_currency === 'USD');

(async () => {
  await setup();
  const t0 = Date.now();

  await scenario('Chitchat does not touch the draft', [
    { say: 'hello', expect: { noTools: true, confirmation: false } },
    { say: "what's the weather like", expect: { noTools: true, reply: /bookkeeping|transaction|books/i } },
  ]);

  await scenario('Add wallets by name', [
    { say: 'add wallet BBL Savings THB', expect: { tools: ['create_user_account'], confirmation: false, reply: /BBL/ } },
    { say: 'add new bank DBS USD', expect: { tools: ['create_user_account'],
      after: () => check('a USD bank account exists in ERPNext', !!usdBank()) } },
  ]);

  await scenario('Opening balance for a new wallet', [
    { say: 'I have KBank with 20000 baht in it', expect: { tools: ['create_user_account'], confirmation: true, reply: /20,000/ } },
    { say: yes, expect: { tools: ['save_transaction'], reply: /Saved/,
      after: () => {
        assertEq('KBank balance', erp.balanceOn('KBank - TC', TODAY), 20000);
        assertEq('Opening Balance Equity', erp.balanceOn('3300 - Opening Balance Equity - TC', TODAY), -20000);
      } } },
  ]);

  await scenario('Cash expense picks a wallet, then saves a journal entry', [
    { say: 'paid 850 for lunch', expect: { tools: ['update_draft', 'list_user_accounts'] } },
    // Either it asked which wallet (answer "cash") or it already picked one and sent the card.
    { say: (r) => (/which wallet|\b1\./i.test(r) ? 'cash' : yes),
      expect: { after: () => {} } },
    { say: (r) => (/Saved/.test(r) ? 'thanks' : yes),
      expect: { after: () => {
        assertEq('Entertainment Expenses', erp.balanceOn('5204 - Entertainment Expenses - TC', TODAY), 850);
      } } },
  ]);

  await scenario('USD sale on terms to a new customer', [
    { say: 'sold ruby 7.68ct to Jameel Crest Gems for 45000 USD net 30',
      expect: { tools: ['update_draft', 'lookup_counterparty'], confirmation: false, reply: /contact|number|phone|skip/i } },
    // The server fetches the rate itself; the card must show the real one, not a guess.
    { say: 'skip', expect: { tools: ['request_confirmation'], confirmation: true, reply: /45,000 USD/,
      after: (r) => check('card shows the fetched rate 32.50', /@ 32\.50?\b/.test(r.text), r.text.split('\n').find((l) => l.startsWith('Amount'))) } },
    { say: yes, expect: { tools: ['save_transaction'], reply: /ACC-SINV/,
      after: () => {
        const inv = erp.all('Sales Invoice')[0];
        check('sales invoice exists', !!inv);
        if (inv) {
          assertEq('invoice currency', inv.currency, 'USD');
          assertEq('debit_to', inv.debit_to, 'Debtors USD - TC');
          assertEq('conversion_rate', inv.conversion_rate, FX_RATE);
          assertEq('description', inv.items[0].description.toLowerCase().includes('ruby'), true);
        }
      } } },
  ]);

  await scenario('Query open receivables', [
    { say: "what's outstanding?", expect: { tools: ['query_open_invoices'], confirmation: false, reply: /45,000|45000/ } },
    { say: 'how much does Jameel owe me?', expect: { tools: ['lookup_counterparty', 'query_balance_with_counterparty'], reply: /45,000|45000/ } },
  ]);

  await scenario('Customer pays the invoice into the USD bank', [
    { say: 'Jameel paid 45000 USD into DBS', expect: { tools: ['query_open_invoices'] } },
    { say: (r) => (/which|reply with a number|1\./i.test(r) && !/Choose below/i.test(r) ? '1' : yes), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes),
      expect: { after: () => {
        const pe = erp.all('Payment Entry')[0];
        check('payment entry exists', !!pe);
        assertEq('invoice outstanding', erp.all('Sales Invoice')[0]?.outstanding_amount, 0);
        assertEq('USD bank balance', usdBank() ? erp.balanceOn(usdBank().name, TODAY) : null, 45000);
      } } },
    { say: 'how much does Jameel owe me now?', expect: { tools: ['query_balance_with_counterparty'], reply: /nothing|0|settled|no outstanding/i } },
  ]);

  await scenario('Bill from a supplier', [
    { say: 'got a bill from Acme Supplies for 12000 baht for stones, due in 15 days, their ref ACME-77',
      expect: { tools: ['update_draft'], reply: /contact|number|phone|skip|12,000 THB/i } },
    // Either it asked for the supplier's contact (give it) or it already sent the card (confirm).
    { say: (r) => (/Choose below/.test(r) ? yes : '+66 81 234 5678'), expect: {} },
    { say: (r) => (/Saved/.test(r) ? 'ok' : yes), expect: {} },
    // A real user would tap Confirm again if the card came back; allow one retry.
    { say: (r) => (/Saved|Anytime|Done/.test(r) ? 'ok' : yes),
      expect: { after: () => {
        const bill = erp.all('Purchase Invoice')[0];
        check('purchase invoice exists', !!bill);
        if (bill) assertEq('bill_no', bill.bill_no, 'ACME-77');
      } } },
    { say: "what's due this month?", expect: { tools: ['query_upcoming'], reply: /Acme/ } },
  ]);

  await scenario('Cancel mid-draft', [
    { say: 'paid 300 for taxi', expect: { tools: ['update_draft'] } },
    { say: 'never mind, cancel that', expect: { tools: ['cancel_transaction'], reply: /cancel/i } },
    { say: 'how much have I spent this year?', expect: { tools: ['query_transaction_summary'], reply: /12,850|12850/ } },
  ]);

  await scenario('Cash position', [
    { say: 'how much money do I have?', expect: { tools: ['query_cash_bank_balance'], reply: /KBank/ } },
  ]);

  realLog(`\n${turnCount} turns in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length) {
    realLog(`\n✖ ${failures.length} check(s) failed:`);
    for (const f of failures) realLog(`  - ${f}`);
    process.exit(1);
  }
  realLog('\n✔ all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});

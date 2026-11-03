/**
 * LLM tool registry: one file per tool, each exporting { definition, execute(args, ctx) }.
 */
const tools = [
  require('./update-draft'),
  require('./request-confirmation'),
  require('./save-transaction'),
  require('./cancel-transaction'),
  require('./fetch-exchange-rate'),
  require('./lookup-counterparty'),
  require('./create-contact'),
  require('./list-user-accounts'),
  require('./create-user-account'),
  require('./query-open-invoices'),
  require('./query-upcoming'),
  require('./query-balance-with-counterparty'),
  require('./query-transaction-summary'),
  require('./query-cash-bank-balance'),
];

const TOOLS = tools.map((t) => ({ type: 'function', function: t.definition }));
const byName = new Map(tools.map((t) => [t.definition.name, t]));

async function executeTool(name, args, ctx) {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await tool.execute(args || {}, ctx);
  } catch (err) {
    console.error(`[tools] ${name} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { TOOLS, executeTool };

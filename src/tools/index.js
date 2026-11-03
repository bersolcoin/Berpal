/**
 * LLM tool registry: one file per tool, each exporting { definition, execute(args, ctx) }.
 * Every *.js in this directory is a tool except the helpers listed in NOT_TOOLS.
 */
const fs = require('fs');
const path = require('path');

const NOT_TOOLS = new Set(['index.js', 'context.js', 'validate.js', 'card.js']);

const tools = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !NOT_TOOLS.has(f))
  .sort()
  .map((f) => require(path.join(__dirname, f)))
  .filter((t) => t && t.definition && typeof t.execute === 'function');

const TOOLS = tools.map((t) => ({ type: 'function', function: t.definition }));
const byName = new Map(tools.map((t) => [t.definition.name, t]));
if (byName.size !== tools.length) throw new Error('[tools] duplicate tool name');

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

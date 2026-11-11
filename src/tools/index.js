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

// A tool module may also export `niche` (e.g. 'gems'): it is then offered only to users whose
// users.niche matches, and refused for everyone else even if the model names it. A general tool
// may export `nicheDefinitions` ({ gems: definition }): the schema a user of that niche sees instead.
const asTool = (t, niche) => ({ type: 'function', function: (niche && t.nicheDefinitions && t.nicheDefinitions[niche]) || t.definition });
const TOOLS = tools.filter((t) => !t.niche).map((t) => asTool(t));
const byName = new Map(tools.map((t) => [t.definition.name, t]));
if (byName.size !== tools.length) throw new Error('[tools] duplicate tool name');

/** The tools this user's model sees: the general ones plus those of the user's niche. */
function toolsFor(user) {
  const niche = user && user.niche;
  return niche ? tools.filter((t) => !t.niche || t.niche === niche).map((t) => asTool(t, niche)) : TOOLS;
}

async function executeTool(name, args, ctx) {
  const tool = byName.get(name);
  if (!tool || (tool.niche && tool.niche !== (ctx && ctx.user && ctx.user.niche))) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(args || {}, ctx);
  } catch (err) {
    console.error(`[tools] ${name} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { TOOLS, toolsFor, executeTool };

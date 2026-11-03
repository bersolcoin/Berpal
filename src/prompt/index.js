/**
 * Feature-specific system-prompt sections. Each *.js here (except index.js) exports either a
 * string or a function ({ user, draft, today }) => string. Sections are appended to the core
 * prompt in filename order, so prefix files with a number to control placement.
 */
const fs = require('fs');
const path = require('path');

const sections = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort()
  .map((f) => ({ file: f, section: require(path.join(__dirname, f)) }));

function render(ctx) {
  return sections
    .map(({ section }) => (typeof section === 'function' ? section(ctx) : section))
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .join('\n\n');
}

module.exports = { render, count: sections.length };

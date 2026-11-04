'use strict';
const { parseAnsiLine } = require('../public/ansi');
const {
  codexModelField,
  hasCodexModelAndDirectory,
  inspectCodexScreen,
} = require('../public/native-status');

// Status-line items are configurable, including their order. Keep the current
// native footer boundary separate from the interpretation of those items.
function codexFooter(raw) {
  return codexInteraction(raw).footer;
}
function codexInteraction(raw) {
  const rows = String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(parseAnsiLine);
  return inspectCodexScreen(
    rows.map((row) => row.map((span) => span.text).join('')),
    rows,
  );
}
module.exports = { codexFooter, codexModelField, hasCodexModelAndDirectory, codexInteraction };

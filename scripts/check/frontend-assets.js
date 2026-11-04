'use strict';
// Roamgate's check-web-assets.mjs also checks eager assets separately from lazy
// features. Swift uses ordered classic scripts, so audit its actual startup bundle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createFrontendAssets } = require('../../lib/frontend-assets');

function checkFrontendAssets(directory = path.resolve(__dirname, '../../public')) {
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const bundle = createFrontendAssets(directory).startup();
  assert(bundle, 'Missing startup bundle');
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"?]+)[^"]*"/g)].map((match) => match[1]);
  const separate = scripts
    .filter((file) => !bundle.files.includes(file))
    .map((file) => fs.readFileSync(path.join(directory, file)));
  for (const file of scripts)
    assert(
      !/^vendor\/(?:code-editor|highlight|mermaid|diff)\//.test(file) &&
        !file.endsWith('-worker.js'),
      `Keep optional renderer dependencies lazy: ${file}`,
    );
  const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"?]+)[^"]*"/g)].map(
    (match) => match[1],
  );
  const stats = {
    startupBytes: bundle.data.length + separate.reduce((total, data) => total + data.length, 0),
    startupGzipBytes:
      gzipSync(bundle.data, { level: 6 }).length +
      separate.reduce((total, data) => total + gzipSync(data, { level: 6 }).length, 0),
    stylesheetBytes: styles.reduce(
      (total, file) => total + fs.statSync(path.join(directory, file)).size,
      0,
    ),
    startupScripts: scripts.length,
  };
  // Allow modest growth around the measured baseline; larger changes need an
  // explicit budget review rather than silently loading heavy features at startup.
  assert(stats.startupBytes <= 1536 * 1024, `Startup JS exceeds 1536 KiB: ${stats.startupBytes}`);
  assert(
    stats.startupGzipBytes <= 420 * 1024,
    `Startup gzip exceeds 420 KiB: ${stats.startupGzipBytes}`,
  );
  assert(
    stats.stylesheetBytes <= 256 * 1024,
    `Initial CSS exceeds 256 KiB: ${stats.stylesheetBytes}`,
  );
  return stats;
}
if (require.main === module) console.log(JSON.stringify(checkFrontendAssets()));
module.exports = { checkFrontendAssets };

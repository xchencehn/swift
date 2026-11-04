'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function sources(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(name);
    return entry.isFile() && (name.endsWith('.js') || name.endsWith('.mjs')) ? [name] : [];
  });
}
require('./repository');
if (process.exitCode) process.exit(process.exitCode);
const files = [
  'server.js',
  ...['bin', 'lib', 'public', 'desktop/ui', 'runtime', 'scripts', 'test'].flatMap(sources),
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Checked ${files.length} JavaScript files.`);

for (const [command, args] of [
  [process.execPath, ['scripts/build/terminal-assets.js', '--check']],
  [process.execPath, ['scripts/build/build-code-editor.js', '--check']],
  [process.execPath, ['scripts/build/generate-provider-capabilities.mjs', '--check']],
  [process.execPath, ['scripts/build/generate-protocol-types.mjs', '--check']],
  [process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
require('node:child_process').execFileSync(
  process.execPath,
  ['scripts/build/generate-harness-files.js', '--check'],
  { cwd: root, stdio: 'inherit' },
);

'use strict';
// Preserve the upstream async directory owner; only compile TypeScript and wrap its export.
const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(
  path.join(
    root,
    'third_party/deepseek-harness/upstream/packages/client/ui-sidebar-files/src/client/directory-node.ts',
  ),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const output =
  '/* MIT, Copyright (c) 2026 DeepSeek. See LICENSE in this directory. Generated; do not edit. */\n' +
  '(function(root){const exports = {};\n' +
  compiled +
  '\nroot.HarnessDirectoryNode = exports.DirectoryNode;\n}(globalThis));\n';
const target = path.join(root, 'public/vendor/deepseek-harness/directory-node.js');
const license = fs.readFileSync(path.join(root, 'third_party/deepseek-harness/LICENSE'), 'utf8');
const licenseTarget = path.join(path.dirname(target), 'LICENSE');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output)
    throw new Error('Run node scripts/build/generate-harness-files.js');
  if (!fs.existsSync(licenseTarget) || fs.readFileSync(licenseTarget, 'utf8') !== license)
    throw new Error('Run node scripts/build/generate-harness-files.js');
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
  fs.writeFileSync(licenseTarget, license);
}

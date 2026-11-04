#!/usr/bin/env node
'use strict';
// Explicit distribution inputs exclude private Android properties, keys and local state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const version = require('../../package.json').version;
const output =
  process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) ||
  path.join(root, 'artifacts', 'release', version);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-'));
const name = `swift-${version}`;
const directory = path.join(temporary, name);
const entries = [
  'server.js',
  'bin',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'desktop/README.md',
  'lib',
  'public',
  'deploy/windows',
  'deploy/preview',
  'deploy/install.sh',
  'deploy/cleanup-legacy-environment.py',
  'deploy/swift.sh',
  'deploy/herdr',
  'runtime/herdr',
  'deploy/codex',
  'runtime/codex',
  'deploy/swift-runtime.sh',
  'deploy/templates/swift.service',
  'deploy/templates/swift-runtime.service',
  'data/commands',
  'shared',
  'third_party/deepseek-harness',
  'docs',
];
function copy(relative) {
  const source = path.join(root, relative),
    target = path.join(directory, relative);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Distribution input must be a regular file: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, stat.mode & 0o777);
}
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const inputs = tracked.filter((file) =>
  entries.some((entry) => file === entry || file.startsWith(entry + '/')),
);
for (const entry of entries)
  if (!inputs.some((file) => file === entry || file.startsWith(entry + '/')))
    throw new Error(`Missing release input: ${entry}`);

try {
  fs.mkdirSync(output, { recursive: true });
  for (const file of inputs) copy(file);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const source = require('../lib/source-fingerprint').sourceFingerprint(root);
  const metadata = { version, ...source, node: process.version, artifacts: [] };
  fs.writeFileSync(
    path.join(directory, 'VERSION.json'),
    JSON.stringify({ version, ...source }, null, 2) + '\n',
  );

  const archive = `${name}-server.tar.gz`;
  execFileSync('tar', ['-czf', path.join(output, archive), '-C', temporary, name]);
  const files = [archive];
  for (const flavor of process.argv.includes('--server-only') ? [] : ['chat', 'terminal']) {
    const filename = `swift-${flavor}-release.apk`;
    fs.copyFileSync(
      path.join(root, 'android/app/build/outputs/apk', flavor, 'release', filename),
      path.join(output, filename),
    );
    files.push(filename);
  }
  for (const filename of files) {
    const buffer = fs.readFileSync(path.join(output, filename));
    metadata.artifacts.push({
      filename,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  const server = metadata.artifacts.find((item) => item.filename === archive);
  fs.writeFileSync(
    path.join(output, 'server-latest.json'),
    JSON.stringify({ version, ...server }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(output, 'SHA256SUMS'),
    metadata.artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join(''),
  );
  console.log(
    `Packaged ${files.length} artifacts with SHA-256 checksums in ${path.relative(root, output)} (dirty=${dirty}).`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

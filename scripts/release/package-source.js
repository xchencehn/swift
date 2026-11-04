#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
const source = sourceFingerprint(root);
if (source.dirty) throw new Error('Commit the source before creating a public source archive.');
const { version } = require('../../package.json');
const output = path.join(root, 'artifacts/release', version, 'source');
const filename = `swift-${version}-source.tar.gz`;
fs.mkdirSync(output, { recursive: true });
execFileSync(
  'git',
  [
    'archive',
    '--format=tar.gz',
    `--prefix=swift-${version}/`,
    `--output=${path.join(output, filename)}`,
    source.revision,
  ],
  { cwd: root },
);
const bytes = fs.readFileSync(path.join(output, filename));
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      version,
      ...source,
      filename,
      bytes: bytes.length,
      sha256,
    },
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
console.log(`Public source archive: ${path.relative(root, path.join(output, filename))}`);

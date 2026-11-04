'use strict';
const fs = require('node:fs'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function sourceFingerprint(root) {
  const hash = crypto.createHash('sha256');
  const names = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const name of [...new Set(names)].sort()) {
    hash.update(name + '\0');
    const file = require('node:path').join(root, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) hash.update(fs.readFileSync(file));
    else hash.update('deleted');
  }
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    treeSha256: hash.digest('hex'),
  };
}
module.exports = { sourceFingerprint };

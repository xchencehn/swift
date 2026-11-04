'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const checked = new Map();
/** Select only an approved Swift runtime; npm and older runtime fallbacks remain explicit at callers. */
function managedCodexBinary({
  root = process.env.SWIFT_CODEX_ROOT || path.join(os.homedir(), '.local/share/swift/codex'),
} = {}) {
  try {
    const base = fs.realpathSync(root),
      release = fs.realpathSync(path.join(base, 'current'));
    if (path.dirname(release) !== path.join(base, 'releases')) return null;
    const approvals = JSON.parse(fs.readFileSync(path.join(base, 'approved.json'), 'utf8'));
    const manifestBytes = fs.readFileSync(path.join(release, 'runtime-manifest.json'));
    const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
    if (sha(manifestBytes) !== approvals[path.basename(release)]?.manifestSha256) return null;
    const manifest = JSON.parse(manifestBytes),
      executable = path.join(release, 'bin/codex'),
      stat = fs.statSync(executable);
    if (manifest.schema !== 1 || !manifest.files?.['bin/codex'] || !stat.isFile()) return null;
    fs.accessSync(executable, fs.constants.X_OK);
    const identity = [stat.ino, stat.size, stat.mtimeMs, manifest.files['bin/codex'].sha256].join(
      ':',
    );
    if (checked.get(executable) !== identity) {
      if (sha(fs.readFileSync(executable)) !== manifest.files['bin/codex'].sha256) return null;
      checked.clear();
      checked.set(executable, identity);
    }
    return executable;
  } catch {
    return null;
  }
}
module.exports = { managedCodexBinary };

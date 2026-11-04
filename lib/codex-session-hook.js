'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BEGIN = '# BEGIN SWIFT CODEX SESSION OWNER\n',
  END = '# END SWIFT CODEX SESSION OWNER\n';
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

// Only Herdr's generated executable is amended. hooks.json, account settings,
// credentials and the Herdr binary are never read or modified. Rechecking also
// restores this guard if Herdr reinstalls its generated integration script.
class CodexSessionHook {
  constructor({
    helper = path.resolve(__dirname, '../runtime/codex/herdr-session-guard.py'),
    now = Date.now,
    retryMs = 20000,
  } = {}) {
    Object.assign(this, { helper, now, retryMs });
    this.checks = new Map();
    this.inflight = new Map();
  }
  async ensure(home) {
    if (this.inflight.has(home)) return this.inflight.get(home);
    if (this.checks.has(home) && this.now() - this.checks.get(home) < this.retryMs) return;
    const work = this.install(home).finally(() => this.inflight.delete(home));
    this.inflight.set(home, work);
    return work;
  }
  async install(home) {
    const file = path.join(home, 'herdr-agent-state.sh');
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile() || stat.size > 128 * 1024) return;
    const original = await fs.readFile(file, 'utf8');
    if (
      !original.includes('# installed by herdr\n') ||
      !original.includes('# HERDR_INTEGRATION_ID=codex\n') ||
      !original.includes('\nset -eu\n')
    )
      return;
    const begin = original.indexOf(BEGIN),
      end = original.indexOf(END);
    if (begin < 0 !== end < 0 || (begin >= 0 && end < begin)) return;
    const base = begin < 0 ? original : original.slice(0, begin) + original.slice(end + END.length);
    const block = `${BEGIN}# Check the calling process, not inherited HERDR_PANE_ID alone.\nif ! python3 ${quote(this.helper)}; then exit 0; fi\n${END}`;
    const updated = base.replace('\nset -eu\n', '\nset -eu\n' + block);
    if (updated !== original) {
      const temp = `${file}.swift-${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fs.access(this.helper);
        await fs.writeFile(temp, updated, { mode: stat.mode & 0o777, flag: 'wx' });
        const current = await fs.lstat(file);
        if (
          current.ino !== stat.ino ||
          current.mtimeMs !== stat.mtimeMs ||
          current.size !== stat.size
        )
          return;
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    this.checks.set(home, this.now());
    while (this.checks.size > 128) this.checks.delete(this.checks.keys().next().value);
  }
}
module.exports = { CodexSessionHook };

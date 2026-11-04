'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Accounts may use distinct native homes in the same Herdr session. Read only
// directory-valued fields from the verified process, never account credentials.
class CodexProcessHomes {
  constructor({ proc = '/proc' } = {}) {
    this.proc = proc;
    this.cache = new Map();
    this.archives = new Map();
  }
  async runtime(pid) {
    const stat = await fs.readFile(path.join(this.proc, String(pid), 'stat'), 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(start || '') ? `${pid}:${start}` : null;
  }
  async read(pane, info) {
    const processes = (info?.foreground_processes || []).filter(
      (item) =>
        (item.name === 'codex' || path.basename(item.argv?.[0] || '') === 'codex') &&
        Number.isSafeInteger(item.pid) &&
        item.pid > 0,
    );
    if (processes.length !== 1) return null;
    const pid = processes[0].pid,
      directory = path.join(this.proc, String(pid));
    const runtime = () => this.runtime(pid);
    try {
      const before = await runtime();
      if (!before || (/^\d+:\d+$/.test(pane.runtimeId || '') && pane.runtimeId !== before))
        return null;
      if (this.cache.has(before)) return this.cache.get(before);
      const bytes = await fs.readFile(path.join(directory, 'environ')),
        dirs = {};
      try {
        for (let at = 0; at < bytes.length;) {
          let end = bytes.indexOf(0, at);
          if (end < 0) end = bytes.length;
          const equal = bytes.indexOf(61, at);
          if (equal >= at && equal < end) {
            const key = bytes.subarray(at, equal).toString();
            if (['HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME'].includes(key))
              dirs[key] = bytes.subarray(equal + 1, end).toString();
          }
          at = end + 1;
        }
      } finally {
        bytes.fill(0);
      }
      const home = dirs.CODEX_HOME || (dirs.HOME && path.join(dirs.HOME, '.codex')),
        sqliteHome = dirs.CODEX_SQLITE_HOME || home;
      if (
        !home ||
        !sqliteHome ||
        [home, sqliteHome].some((value) => !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) ||
        (await runtime()) !== before
      )
        return null;
      const result = { home, sqliteHome, runtime: before };
      this.cache.set(before, result);
      while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
      return result;
    } catch {
      return null;
    }
  }
  async archive(pane, context) {
    const sessionId = pane.agent?.session?.value;
    if (!sessionId || !context) return null;
    const pid = Number(context.runtime.split(':')[0]),
      directory = path.join(this.proc, String(pid), 'fd'),
      key = `${context.runtime}:${sessionId}`;
    const { archiveName, validateArchive, currentArchive } = require('./codex-archive');
    try {
      if ((await this.runtime(pid)) !== context.runtime) return null;
      const current = currentArchive(context.sqliteHome, sessionId, undefined, {
        archiveHome: context.home,
      });
      if (current.known && !current.file) return null;
      const inspect = async (name) => {
        const descriptor = path.join(directory, name);
        try {
          const target = await fs.readlink(descriptor);
          if (!path.isAbsolute(target) || !archiveName(target, sessionId)) return null;
          const file = [...new Set([context.home, context.sqliteHome])]
            .map((home) => validateArchive(home, target, sessionId))
            .find(Boolean);
          if (!file || (current.known && current.file !== file)) return null;
          const [held, archive] = await Promise.all([fs.stat(descriptor), fs.stat(file)]);
          if (
            held.dev !== archive.dev ||
            held.ino !== archive.ino ||
            (await fs.readlink(descriptor)) !== target
          )
            return null;
          return { file, name };
        } catch {
          return null;
        }
      };
      let found = this.archives.has(key) ? await inspect(this.archives.get(key)) : null;
      if (!found) {
        const candidates = new Map();
        for (const name of await fs.readdir(directory)) {
          if (!/^\d+$/.test(name)) continue;
          const candidate = await inspect(name);
          if (candidate) candidates.set(candidate.file, candidate);
        }
        if (candidates.size !== 1) return null;
        found = candidates.values().next().value;
      }
      if ((await this.runtime(pid)) !== context.runtime) return null;
      this.archives.set(key, found.name);
      while (this.archives.size > 128) this.archives.delete(this.archives.keys().next().value);
      return found.file;
    } catch {
      return null;
    }
  }
}

class CodexArchiveLocator {
  constructor({ herdr, locate, homes = new CodexProcessHomes() }) {
    Object.assign(this, { herdr, base: locate, homes });
  }
  async context(pane, info) {
    if (pane.agent?.label !== 'codex') return null;
    if (!info) {
      const pid = /^\d+:\d+$/.test(pane.runtimeId || '')
        ? Number(pane.runtimeId.split(':')[0])
        : null;
      info = pid
        ? { foreground_processes: [{ pid, name: 'codex' }] }
        : await this.herdr.readProcessInfo(pane.paneId).catch(() => null);
    }
    return this.homes.read(pane, info);
  }
  async locate(pane) {
    if (!pane.agent?.session?.value) return null;
    const context = await this.context(pane);
    const file = await this.base(
      pane.agent.label,
      pane.agent.session.value,
      pane.baseCwd || pane.cwd || '',
      os.homedir(),
      context ? { codexHome: context.home, sqliteHome: context.sqliteHome } : {},
    );
    // A running native process can retain its archive after /cd or a task
    // directory move while the SQLite cwd still describes its launch. Its
    // exact open file, header, allowed root and process start prove identity.
    return file || (context ? this.homes.archive(pane, context) : null);
  }
}
module.exports = { CodexProcessHomes, CodexArchiveLocator };

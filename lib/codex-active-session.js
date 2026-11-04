'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { currentArchive, archiveName } = require('./codex-archive');
const { CodexSessionDiscovery, matchEvidence, isUserFork } = require('./codex-session-discovery');

// A resume argument is only the launch identity: /new, /resume or a durable
// rewind may change the current thread without replacing the Codex process.
// Inspect only that process's open, writable native archive, never other
// sessions in the directory or a title / newest-file heuristic.
class CodexActiveSession {
  constructor({
    home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    proc = '/proc',
    readScreen = null,
    homes = null,
    native = require('./codex-side-native').request,
  } = {}) {
    this.home = home;
    this.proc = proc;
    this.native = native;
    this.readScreen = readScreen;
    this.homes = homes;
    this.discovery = new CodexSessionDiscovery({ home });
  }
  async read(pane, info) {
    const processes = (info?.foreground_processes || []).filter(
      (item) => item.name === 'codex' && Number.isSafeInteger(item.pid) && item.pid > 0,
    );
    if (processes.length !== 1) return null;
    const directory = path.join(this.proc, String(processes[0].pid)),
      cwd = pane.baseCwd || pane.cwd;
    const before = await fs.readFile(path.join(directory, 'stat'), 'utf8');
    const start = before.slice(before.lastIndexOf(')') + 2).split(' ')[19];
    if (!/^\d+$/.test(start || '') || !path.isAbsolute(cwd || '')) return null;
    const context = this.homes && (await this.homes.read(pane, info));
    if (this.homes && !context) return null;
    const archiveHome = context?.home || this.home,
      sqliteHome = context?.sqliteHome || this.home;
    const homes = [
      ...new Set(
        (
          await Promise.all(
            [archiveHome, sqliteHome].map((home) => fs.realpath(home).catch(() => null)),
          )
        ).filter(Boolean),
      ),
    ];
    const inside = (file) =>
      homes.some((home) => /^(?:sessions|archived_sessions)[/\\]/.test(path.relative(home, file)));
    // The TUI knows its primary thread even while displaying an ephemeral side
    // conversation or retaining the writer of a newly forked persistent thread.
    const runtime = `${processes[0].pid}:${start}`;
    const identity = await this.native({ ...pane, runtimeId: runtime }, 'identity');
    if (identity) {
      const native = currentArchive(sqliteHome, identity.mainId, cwd, { archiveHome });
      const after = await fs.readFile(path.join(directory, 'stat'), 'utf8');
      if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== start) return null;
      if (native.known && native.file && inside(native.file))
        return { sessionId: identity.mainId, file: native.file, cwd, runtime };
      throw new Error('The native primary thread has no verified archive');
    }
    const descriptors = await fs.readdir(path.join(directory, 'fd'));
    if (descriptors.length > 4096) return null;
    const candidates = new Map();
    for (const descriptor of descriptors) {
      const fd = path.join(directory, 'fd', descriptor);
      try {
        const target = await fs.readlink(fd);
        if (!inside(target) || !target.endsWith('.jsonl')) continue;
        const flags = (await fs.readFile(path.join(directory, 'fdinfo', descriptor), 'utf8')).match(
          /^flags:\s*([0-7]+)/m,
        );
        if (!flags || !(Number.parseInt(flags[1], 8) & 3)) continue;
        const real = await fs.realpath(target);
        if (!inside(real)) continue;
        // Opening fd itself could follow a descriptor reused during the read.
        // Reopen its validated archive path and verify the descriptor again.
        const handle = await fs.open(real, 'r');
        let meta;
        try {
          if (!(await handle.stat()).isFile()) continue;
          const buffer = Buffer.alloc(2 * 1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, bytesRead).indexOf(10);
          if (newline < 0) continue;
          meta = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        } finally {
          await handle.close();
        }
        const payload = meta?.payload,
          sessionId = payload?.id;
        if (
          meta.type !== 'session_meta' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId || '') ||
          payload.originator !== 'codex-tui' ||
          (!['cli', 'vscode'].includes(payload.source) && !isUserFork(payload)) ||
          payload.ephemeral === true ||
          (payload.thread_source !== undefined && payload.thread_source !== 'user') ||
          !archiveName(target, sessionId)
        )
          continue;
        const native = currentArchive(sqliteHome, sessionId, cwd, { archiveHome });
        if (!native.known || native.file !== real || (await fs.readlink(fd)) !== target) continue;
        candidates.set(sessionId, {
          sessionId,
          file: native.file,
          cwd,
          runtime: `${processes[0].pid}:${start}`,
        });
      } catch {
        /* Closed, inaccessible or unverified descriptors grant no identity. */
      }
    }
    const after = await fs.readFile(path.join(directory, 'stat'), 'utf8');
    if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== start) return null;
    if (candidates.size === 1) return [...candidates.values()][0];
    // /new may retain the old writer. Do not guess using fd number or time:
    // require the existing two-anchor content proof against this exact pane.
    if (!this.readScreen || candidates.size < 2 || candidates.size > 8) return null;
    const screen = await this.readScreen(pane),
      matches = [];
    const discovery = context
      ? new CodexSessionDiscovery({ home: sqliteHome, archiveHome })
      : this.discovery;
    for (const candidate of candidates.values()) {
      const archive = await discovery.read(candidate).catch(() => null);
      if (archive && matchEvidence(archive.texts, screen)) matches.push(candidate);
    }
    return matches.length === 1 ? matches[0] : null;
  }
}
module.exports = { CodexActiveSession };

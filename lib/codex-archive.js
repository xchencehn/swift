'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stateFile(home) {
  try {
    const names = fs.readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
    names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    return names.length ? path.join(home, names[0]) : null;
  } catch {
    return null;
  }
}

function archiveName(file, sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const name = path.basename(file);
  return (
    name.endsWith(`-${sessionId}.jsonl`) ||
    new RegExp(`-${sessionId}_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.jsonl$`, 'i').test(name)
  );
}

function validateArchive(home, file, sessionId, cwd) {
  let fd;
  try {
    const real = fs.realpathSync(file);
    // Native homes may share an explicitly linked sessions directory. Resolve
    // that directory, while still rejecting individual files escaping it.
    const allowed = ['sessions', 'archived_sessions'].some((name) => {
      try {
        const relative = path.relative(fs.realpathSync(path.join(home, name)), real);
        return (
          relative &&
          !path.isAbsolute(relative) &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`)
        );
      } catch {
        return false;
      }
    });
    if (!allowed || !archiveName(real, sessionId)) return null;
    fd = fs.openSync(real, 'r');
    if (!fs.fstatSync(fd).isFile()) return null;
    // Most headers fit in one small read. Do not copy 2 MiB of tool output
    // onto the main thread every time the native current pointer is checked.
    const chunks = [];
    let bytes = 0;
    while (bytes < 2 * 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 2 * 1024 * 1024 - bytes));
      const size = fs.readSync(fd, buffer, 0, buffer.length, bytes);
      if (!size) break;
      const newline = buffer.subarray(0, size).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? size : newline));
      bytes += size;
      if (newline >= 0) break;
    }
    const meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return meta.type === 'session_meta' &&
      meta.payload?.id === sessionId &&
      (!cwd || meta.payload.cwd === cwd)
      ? real
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A native row is authoritative even when its archive is not available yet.
// Falling back to an older file in that case would silently show stale history.
function currentArchive(home, sessionId, cwd, { archiveHome = home } = {}) {
  const file = stateFile(home);
  if (!file) return { known: false, file: null };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=100');
    const hasCwd = db
      .prepare('PRAGMA table_info(threads)')
      .all()
      .some((column) => column.name === 'cwd');
    const row = db
      .prepare(`SELECT rollout_path${hasCwd ? ', cwd' : ''} FROM threads WHERE id = ?`)
      .get(sessionId);
    if (!row) return { known: false, file: null };
    // session_meta records the launch directory. Native /cd and directory
    // moves can update threads.cwd while that immutable header stays unchanged.
    // Check the requested directory against the current native row; the file
    // must still prove the same session ID and current rollout path.
    const nativeCwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : null;
    if (nativeCwd && (!path.isAbsolute(nativeCwd) || (cwd && nativeCwd !== cwd)))
      return { known: true, file: null };
    // A resumed thread may retain its archive in CODEX_SQLITE_HOME while the
    // new process uses a separate account configuration in CODEX_HOME.
    for (const root of new Set([archiveHome, home])) {
      const archive = validateArchive(
        root,
        row.rollout_path,
        sessionId,
        nativeCwd ? undefined : cwd,
      );
      if (archive) return { known: true, file: archive };
    }
    return { known: true, file: null };
  } catch {
    return { known: true, file: null };
  } finally {
    db?.close();
  }
}

module.exports = { stateFile, archiveName, validateArchive, currentArchive };

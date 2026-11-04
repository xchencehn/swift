'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { stripAnsi } = require('../public/ansi');
const { CodexLineage } = require('./codex-lineage');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
// `codex exec fork --thread-source user` retains its exec source even after
// the TUI resumes it. This is an interactive user fork, not a background exec.
const isUserFork = (payload) =>
  payload?.source === 'exec' &&
  payload.thread_source === 'user' &&
  UUID.test(payload.forked_from_id || '');
const canonical = (text) =>
  stripAnsi(String(text || ''))
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function screenAnchors(screen) {
  return [
    ...new Set(
      stripAnsi(screen)
        .split('\n')
        .map((line) =>
          canonical(line.replace(/^\s*[•└├│]\s*/, '').replace(/\s*(?:…|\.{3})\s*$/, '')),
        )
        .filter(
          (line) =>
            line.length >= 48 &&
            !/^(?:Ran |Working \(|Worked for |GPT-|gpt-|Ask Codex|Tip:|›|\+ \d+ lines)/i.test(line),
        ),
    ),
  ];
}

function recordTexts(lines) {
  const texts = [];
  const outputTexts = (value, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      texts.push(canonical(value));
      // Code-mode outputs may carry a JSON tool envelope with escaped lines.
      try {
        outputTexts(JSON.parse(value), depth + 1);
      } catch {}
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 512)) outputTexts(item, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 512)) {
        if (['text', 'output', 'content', 'value', 'result'].includes(key))
          outputTexts(item, depth + 1);
      }
    }
  };
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const item = entry.payload;
    if (entry.type === 'response_item' && ['user', 'assistant'].includes(item?.role)) {
      const text = (item.content || [])
        .filter((block) => ['input_text', 'output_text', 'text'].includes(block.type))
        .map((block) => block.text || '')
        .join('\n');
      if (
        !/^\s*(?:# AGENTS\.md|<(?:environment_context|permissions|INSTRUCTIONS|system-reminder))/.test(
          text,
        )
      )
        texts.push(canonical(text));
    } else if (
      entry.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output'].includes(item?.type)
    ) {
      outputTexts(item.output);
    } else if (
      entry.type === 'event_msg' &&
      ['agent_message', 'user_message'].includes(item?.type)
    ) {
      texts.push(canonical(item.message));
    }
  }
  return texts;
}

function matchEvidence(texts, screen) {
  const anchors = screenAnchors(screen).filter((anchor) =>
    texts.some((text) => text.includes(anchor)),
  );
  const characters = anchors.reduce((sum, anchor) => sum + anchor.length, 0);
  return anchors.length >= 2 && characters >= 160 ? { anchors: anchors.length, characters } : null;
}

class CodexSessionDiscovery {
  constructor({
    home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    archiveHome = home,
  } = {}) {
    this.home = home;
    this.archiveHome = archiveHome;
    this.lineage = new CodexLineage({ maxBytes: MAX_BYTES });
  }

  async candidates(pane) {
    const cwd = pane.baseCwd || pane.cwd;
    const title = pane.agentTitle || '';
    if (!path.isAbsolute(cwd || '') || !title.trim()) return [];
    const names = (await fs.readdir(this.home))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!names.length) return [];
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(this.home, names[0]), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=100');
      // Native thread names are only a candidate filter. They never establish identity alone.
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(threads)')
          .all()
          .map((column) => column.name),
      );
      if (!['id', 'name', 'cwd', 'rollout_path', 'originator'].every((name) => columns.has(name)))
        return [];
      const nativeTitle = title.endsWith(` | ${path.basename(cwd)}`)
        ? title.slice(0, -` | ${path.basename(cwd)}`.length)
        : title;
      const rows = db
        .prepare(
          'SELECT id, name, cwd, rollout_path FROM threads WHERE cwd = ? AND name = ? AND originator = ? LIMIT 65',
        )
        .all(cwd, nativeTitle, 'codex-tui');
      if (rows.length > 64) return [];
      return rows
        .filter((row) => UUID.test(row.id))
        .map((row) => ({ sessionId: row.id, cwd: row.cwd, file: row.rollout_path }));
    } finally {
      db.close();
    }
  }

  async read(candidate) {
    const real = await fs.realpath(candidate.file);
    const homes = (
      await Promise.all(
        [this.archiveHome, this.home].map((home) => fs.realpath(home).catch(() => null)),
      )
    ).filter(Boolean);
    if (
      !homes.some((home) =>
        /^(?:sessions|archived_sessions)[/\\]/.test(path.relative(home, real)),
      ) ||
      !require('./codex-archive').archiveName(real, candidate.sessionId)
    )
      return null;
    const handle = await fs.open(real, 'r');
    try {
      const stat = await handle.stat();
      // Flat archives are sampled with fixed head/tail windows regardless of total size.
      if (!stat.isFile()) return null;
      const head = Buffer.alloc(Math.min(WINDOW_BYTES, stat.size));
      await handle.read(head, 0, head.length, 0);
      const first = head.toString('utf8').split('\n')[0];
      let meta;
      try {
        meta = JSON.parse(first);
      } catch {
        return null;
      }
      if (
        meta.type !== 'session_meta' ||
        meta.payload?.id !== candidate.sessionId ||
        meta.payload.originator !== 'codex-tui' ||
        meta.payload.ephemeral === true ||
        (meta.payload.thread_source !== undefined && meta.payload.thread_source !== 'user') ||
        (meta.payload.source !== undefined &&
          !['cli', 'vscode'].includes(meta.payload.source) &&
          !isUserFork(meta.payload))
      )
        return null;
      // The native row owns the current directory and rollout selection. The
      // archive header may still name the directory used at launch.
      const current = require('./codex-archive').currentArchive(
        this.home,
        candidate.sessionId,
        candidate.cwd,
        { archiveHome: this.archiveHome },
      );
      if (!current.known || current.file !== real) return null;
      // Forks and rewinds keep their visible prefix in immutable ancestor
      // rollouts. Reading only the leaf makes that shared content appear to
      // identify the parent uniquely and can overwrite the child's binding.
      if (meta.payload.history_base) {
        const history = await this.lineage.read(real);
        return { ...candidate, texts: recordTexts(history.lines) };
      }
      let raw = head.toString('utf8');
      if (stat.size > head.length) {
        const tail = Buffer.alloc(Math.min(WINDOW_BYTES, stat.size));
        await handle.read(tail, 0, tail.length, stat.size - tail.length);
        const text = tail.toString('utf8');
        raw = raw.slice(0, raw.lastIndexOf('\n')) + '\n' + text.slice(text.indexOf('\n') + 1);
      }
      return { ...candidate, texts: recordTexts(raw.split('\n')) };
    } finally {
      await handle.close();
    }
  }

  async discover(pane, screen) {
    const anchors = screenAnchors(screen);
    if (anchors.length < 2 || anchors.reduce((sum, anchor) => sum + anchor.length, 0) < 160)
      return null;
    const matches = [];
    for (const candidate of await this.candidates(pane)) {
      let record;
      // An unreadable candidate does not prove the remaining match unique.
      try {
        record = await this.read(candidate);
      } catch {
        return null;
      }
      const evidence = record && matchEvidence(record.texts, screen);
      if (evidence) matches.push({ ...record, evidence });
    }
    return matches.length === 1 ? matches[0] : null;
  }
}

module.exports = { CodexSessionDiscovery, matchEvidence, screenAnchors, isUserFork };

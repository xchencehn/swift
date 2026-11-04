'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { parseOmpTranscript } = require('./upstream/transcript-records');
const Capabilities = require('../../public/provider-capabilities');
const JSONL = Capabilities.jsonlProviders.filter((provider) => !Capabilities.get(provider).send);
const DATABASE = Capabilities.databaseProviders;
const PROVIDERS = Capabilities.providers;
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function messagesFromTurns(provider, turns, sessionId = '') {
  const duplicates = new Map();
  return turns
    .map((turn) => {
      const head = turn.parts.find((p) => p.kind === 'text' || p.kind === 'tool');
      const key = digest(
        JSON.stringify([
          provider,
          sessionId,
          turn.role,
          turn.ts,
          head?.kind,
          head?.text?.slice(0, 120),
          head?.name,
          head?.input,
        ]),
      );
      const occurrence = duplicates.get(key) || 0;
      duplicates.set(key, occurrence + 1);
      return {
        id: `${provider}-${key}-${occurrence}`,
        role: turn.role,
        ts: turn.ts,
        harness: provider,
        blocks: turn.parts.flatMap((part, i) => {
          if (['text', 'thinking'].includes(part.kind))
            return [{ kind: part.kind, text: part.text }];
          if (part.kind === 'tool')
            return [
              {
                kind: 'tool',
                id: part.id || part.output_ref || `${key}:tool:${i}`,
                name: part.name,
                input: { text: part.input || '', truncated: false },
                result: part.output
                  ? {
                      text: part.output,
                      truncated: Boolean(part.output_size),
                      ...(part.output_size ? { fullLength: part.output_size } : {}),
                      isError: Boolean(part.error),
                    }
                  : null,
              },
            ];
          if (part.kind === 'skill')
            return [{ kind: 'text', text: `Skill: ${part.skill?.name || ''}` }];
          if (part.kind === 'task_result')
            return [
              { kind: 'text', text: part.tasks.map((task) => JSON.stringify(task)).join('\n') },
            ];
          if (['notice', 'compact'].includes(part.kind))
            return [{ kind: 'text', text: part.text || part.body || JSON.stringify(part) }];
          return [];
        }),
      };
    })
    .filter((message) => message.blocks.length);
}
function parseJsonl(provider, lines, options = {}) {
  return messagesFromTurns(
    provider,
    parseOmpTranscript(lines.join('\n'), Number.MAX_SAFE_INTEGER, options),
  );
}
function locateJsonl(provider, sessionId, home = os.homedir()) {
  if (!JSONL.includes(provider) || typeof sessionId !== 'string') return null;
  const root = path.join(home, `.${provider}`, 'agent', 'sessions');
  let canonical;
  try {
    canonical = fs.realpathSync(root);
  } catch {
    return null;
  }
  function valid(file) {
    try {
      const real = fs.realpathSync(file);
      return real.startsWith(canonical + path.sep) &&
        real.endsWith('.jsonl') &&
        fs.statSync(real).isFile()
        ? real
        : null;
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(sessionId)) return valid(sessionId);
  if (!/^[\w-]{1,128}$/.test(sessionId)) return null;
  let visited = 0;
  const found = [];
  function scan(dir, depth) {
    if (depth > 3 || visited > 10000) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 10000) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(16384);
        let bytes;
        try {
          bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        try {
          const header = JSON.parse(buffer.subarray(0, bytes).toString('utf8').split('\n')[0]);
          if (header.type === 'session' && header.id === sessionId) found.push(valid(file));
        } catch {}
      }
    }
  }
  try {
    scan(root, 0);
  } catch {
    return null;
  }
  return visited <= 10000 && found.length === 1 ? found[0] : null;
}
function databasePath(provider) {
  if (provider === 'opencode') return require('./upstream/opencode').opencodeDatabasePath();
  if (provider === 'devin') return require('./upstream/devin').defaultDevinDbPath();
  return null;
}
function readDatabase(pane, options = {}) {
  const provider = pane.agent?.label,
    sessionId = pane.agent?.session?.value;
  if (
    !DATABASE.includes(provider) ||
    typeof sessionId !== 'string' ||
    !/^[\w-]{1,200}$/.test(sessionId)
  )
    return null;
  let result;
  if (provider === 'opencode') {
    const { opencodeDatabasePath, opencodeConversation } = require('./upstream/opencode');
    const file = opencodeDatabasePath();
    if (!file || !fs.existsSync(file)) return null;
    result = opencodeConversation(file, sessionId, options);
    if (result?.kind === 'history_changed')
      throw Object.assign(new Error('原生历史分支已改变，请重新读取。'), {
        status: 409,
        code: 'HISTORY_CHANGED',
      });
    if (result?.kind !== 'page')
      throw Object.assign(new Error('当前 OpenCode 存档暂不可读取，请检查 CLI 存档结构。'), {
        status: 503,
        code: 'NATIVE_ARCHIVE_UNAVAILABLE',
      });
  } else {
    const {
      defaultDevinDbPath,
      devinConversation,
      DevinHistoryChanged,
    } = require('./upstream/devin');
    const file = defaultDevinDbPath();
    if (!fs.existsSync(file)) return null;
    try {
      result = devinConversation(
        sessionId,
        pane.baseCwd || pane.cwd || '',
        { ...options, limit: options.limit || 200 },
        file,
      );
    } catch (error) {
      throw Object.assign(
        new Error(
          error instanceof DevinHistoryChanged
            ? '原生历史分支已改变，请重新读取。'
            : '当前 Devin 存档暂不可读取，请检查会话身份及 CLI 存档结构。',
        ),
        {
          status: error instanceof DevinHistoryChanged ? 409 : 503,
          code:
            error instanceof DevinHistoryChanged ? 'HISTORY_CHANGED' : 'NATIVE_ARCHIVE_UNAVAILABLE',
        },
      );
    }
  }
  const messages = messagesFromTurns(provider, result.turns, sessionId);
  // Native cursor binds the first message to the database's effective branch.
  if (result.cursor && messages.length) messages[0].id = result.cursor;
  return {
    messages,
    hasMore: Boolean(result.cursor),
    revision: result.signature || result.version,
    metadata: result.metadata,
  };
}
module.exports = {
  PROVIDERS,
  JSONL,
  DATABASE,
  messagesFromTurns,
  parseJsonl,
  locateJsonl,
  databasePath,
  readDatabase,
};

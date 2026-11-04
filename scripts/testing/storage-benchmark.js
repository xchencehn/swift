#!/usr/bin/env node
'use strict';
// Reproducible synthetic workload; never opens application data or native journals.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Database } = require('../../lib/store/database');
const { EventLog } = require('../../lib/store/events');
const { MessageStore } = require('../../lib/store/message-store');
const { ConversationStore } = require('../../lib/conversation-store');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..'),
  baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.split('=')[1] || 'a5c400c';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-benchmark-'));
const oldModules = new Map();
function original(relative) {
  if (oldModules.has(relative)) return oldModules.get(relative).exports;
  const source = execFileSync('git', ['show', `${baseline}:${relative}`], {
    cwd: root,
    encoding: 'utf8',
  });
  const filename = path.join(root, relative),
    mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  const fallback = Module.createRequire(filename);
  mod.require = (name) =>
    [
      '../lib/conversation-store.js',
      '../lib/agent-transcript.js',
      '../lib/conversation-state.js',
    ].includes(name)
      ? fallback(name)
      : relative === 'lib/conversation-store.js' &&
          ['./agent-transcript', './conversation-state'].includes(name)
        ? original(`lib/${name.slice(2)}.js`)
        : fallback(name);
  oldModules.set(relative, mod);
  mod._compile(source, filename);
  return mod.exports;
}
function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}
function receipts(Store, label) {
  const database = new Database(path.join(directory, `${label}.sqlite`)),
    store = new Store(database, new EventLog(database));
  try {
    const items = Array.from({ length: 10000 }, (_, i) => ({
      id: `m${i}`,
      paneId: 'fixture',
      status: 'consumed',
      text: 'x'.repeat(256),
      updatedAt: 1,
    }));
    store.save(items);
    database.exec(
      "CREATE TABLE writes(kind TEXT); CREATE TRIGGER changed AFTER UPDATE ON messages BEGIN INSERT INTO writes VALUES('upsert'); END; CREATE TRIGGER added AFTER INSERT ON messages BEGIN INSERT INTO writes VALUES('upsert'); END; CREATE TRIGGER deleted AFTER DELETE ON messages BEGIN INSERT INTO writes VALUES('delete'); END;",
    );
    const elapsed = [];
    for (let i = 0; i < 20; i++) {
      items[9999].text = `changed-${i}`;
      items[9999].updatedAt = i + 2;
      const start = performance.now();
      store.save(items, { changedIds: ['m9999'] });
      elapsed.push(performance.now() - start);
    }
    const writes = database.prepare('SELECT kind, COUNT(*) count FROM writes GROUP BY kind').all();
    if (store.load().length !== items.length) throw Error('Receipt history was lost');
    return { receipts: items.length, changes: elapsed.length, ...quantiles(elapsed), writes };
  } finally {
    database.close();
  }
}
async function archive(Store, label) {
  const file = path.join(directory, `${label}.jsonl`),
    store = new Store();
  const line = (id) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id,
        role: 'user',
        content: [{ type: 'input_text', text: `${id}: ${'x'.repeat(1024)}` }],
      },
    }) + '\n';
  fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => line(`u${i}`)).join(''));
  await store.read(file, 'codex');
  const elapsed = [];
  let reused = 0;
  for (let i = 0; i < 20; i++) {
    const previous = await store.read(file, 'codex');
    fs.appendFileSync(file, line(`append-${i}`));
    const start = performance.now(),
      current = await store.read(file, 'codex');
    // Both paths include the history revision calculation used by SyncHub.
    const Conversation =
      label === 'before'
        ? original('lib/conversation-state.js')
        : require('../../lib/conversation-state');
    Conversation.historyVersion(current.conversation);
    elapsed.push(performance.now() - start);
    reused = current.conversation.filter(
      (message, j) => message === previous.conversation[j],
    ).length;
    if (current.conversation.length !== 5001 + i) throw Error('Archive projection was lost');
  }
  return {
    bytes: fs.statSync(file).size,
    messages: 5020,
    appends: 20,
    reusedMessages: reused,
    ...quantiles(elapsed),
  };
}
async function main() {
  try {
    const before = sourceFingerprint(root);
    const result = {
      at: new Date().toISOString(),
      baseline,
      source: before,
      node: process.version,
      queue: {
        before: receipts(original('lib/store/message-store.js').MessageStore, 'before'),
        after: receipts(MessageStore, 'after'),
      },
      archive: {
        before: await archive(original('lib/conversation-store.js').ConversationStore, 'before'),
        after: await archive(ConversationStore, 'after'),
      },
    };
    const output = path.join(root, 'artifacts/five-defects');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'performance.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

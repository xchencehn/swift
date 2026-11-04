'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TranscriptWatcher } = require('../lib/transcript-watcher');
const { parseCodexTranscript, textOnly } = require('../lib/agent-transcript');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1800;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('archive notification timeout');
    await delay(20);
  }
}
test('archive append exposes a running command before its result and updates the same id', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-watch-'));
  const file = path.join(folder, 'session.jsonl');
  const changed = [];
  const watcher = new TranscriptWatcher((file) => changed.push(file), { interval: 30 });
  try {
    await fs.writeFile(file, '');
    watcher.watch(file);
    await delay(80);
    const before = changed.length;
    await fs.appendFile(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'running',
          name: 'exec_command',
          arguments: '{"cmd":"sleep 12"}',
        },
      }) + '\n',
    );
    await until(() => changed.length > before);
    const read = async () =>
      textOnly(parseCodexTranscript((await fs.readFile(file, 'utf8')).split('\n')))
        .flatMap((m) => m.blocks)
        .flatMap((b) => b.items || []);
    const running = await read();
    assert.equal(running.length, 1);
    assert.equal(running[0].running, true);
    assert.equal(running[0].result, null);
    const middle = changed.length;
    await fs.appendFile(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'running',
          output: 'Process exited with code 0',
        },
      }) + '\n',
    );
    await until(() => changed.length > middle);
    const completed = await read();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, running[0].id);
    assert.equal(completed[0].running, false);
    watcher.close();
    const stopped = changed.length;
    await fs.appendFile(file, '\n');
    await delay(100);
    assert.equal(changed.length, stopped);
  } finally {
    watcher.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test('inactive archives expire and watcher count stays bounded', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-watch-'));
  const watcher = new TranscriptWatcher(() => {}, { interval: 30, ttl: 100, maxFiles: 2 });
  try {
    for (let i = 0; i < 3; i++) {
      const file = path.join(folder, `${i}.jsonl`);
      await fs.writeFile(file, '');
      watcher.watch(file);
    }
    assert.equal(watcher.files.size, 2);
    await until(() => watcher.files.size === 0);
  } finally {
    watcher.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('native notifications survive replacement and creation without waiting for the poll interval', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-native-'));
  const first = path.join(folder, 'first.jsonl'),
    second = path.join(folder, 'second.jsonl');
  const changed = [];
  const watcher = new TranscriptWatcher((file) => changed.push(file), { interval: 60000 });
  try {
    await fs.writeFile(first, 'old');
    watcher.watch(first);
    watcher.watch(second);
    await delay(80);
    assert.equal(watcher.directories.size, 1, 'archives share one directory watcher');
    const before = changed.length;
    const replacement = path.join(folder, 'replace.tmp');
    await fs.writeFile(replacement, 'new');
    await fs.rename(replacement, first);
    await until(() => changed.slice(before).includes(first));
    const afterReplace = changed.length;
    await fs.appendFile(first, ' appended');
    await until(() => changed.slice(afterReplace).includes(first));
    await fs.writeFile(second, 'created');
    await until(() => changed.includes(second));
    watcher.remove(first);
    assert.equal(watcher.directories.size, 1);
    watcher.remove(second);
    assert.equal(watcher.directories.size, 0);
    const stopped = changed.length;
    await fs.appendFile(first, ' ignored');
    await delay(60);
    assert.equal(changed.length, stopped);
  } finally {
    watcher.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

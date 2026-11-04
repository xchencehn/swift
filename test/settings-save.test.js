'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create } = require('../public/core/settings-save');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test('large read markers fit the server limit and an old pending journal resumes without blocking appearance settings', async (t) => {
  const { mergeSettings } = require('../lib/root-preferences');
  const seen = JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `completion:["terminal-${i}","codex","00000000-0000-0000-0000-${String(i).padStart(12, '0')}","scope"]:123`,
        1700000000000 + i,
      ]),
    ),
  );
  assert.throws(() => mergeSettings({}, { ui: { studioSeenDone: seen } }), {
    code: 'INVALID_SETTINGS',
  });
  const patch = { theme: 'black', ui: { studioSeenDone: seen, studioSidebarWidth: '280' } };
  let saved;
  const saver = create({
    load: () => [{ root: 'a', settings: patch }],
    debounceMs: 10000,
    write: async (root, settings) => ({
      rootDirectory: root,
      settings: mergeSettings({}, settings),
    }),
    onSaved: (_, settings) => {
      saved = settings;
    },
  });
  t.after(() => saver.close());
  saver.queue('a', { fontSize: 18 });
  await saver.flush('a');
  assert.equal(saved.theme, 'black');
  assert.equal(saved.fontSize, 18);
  assert.equal(saved.ui.studioSidebarWidth, '280');
  assert(saved.ui.studioSeenDone.length <= 16384);
  const values = Object.values(JSON.parse(saved.ui.studioSeenDone));
  assert.equal(Math.max(...values), 1700000000399);
  assert(values.length > 0 && values.length < 400);
  assert.equal(patch.ui.studioSeenDone, seen, 'local read markers are not changed');
  assert.equal(saver.busy('a'), false);
});
test('settings timeout retains a durable patch, coalesces newer values, retries and clears its error', async (t) => {
  let journal = [],
    calls = [],
    errors = [],
    fail = true;
  const saver = create({
    debounceMs: 10000,
    retryMs: 10,
    write: async (root, settings) => {
      calls.push(settings);
      if (fail) throw Object.assign(new Error('signal timed out'), { code: 'REQUEST_TIMEOUT' });
      return { rootDirectory: root, settings };
    },
    persist: (rows) => {
      journal = structuredClone(rows);
    },
    onError: (_, message) => errors.push(message),
  });
  t.after(() => saver.close());
  saver.queue('a', { theme: 'black', ui: { one: 'old' } });
  await assert.rejects(saver.flush('a'));
  assert.equal(journal[0].settings.theme, 'black');
  assert(errors.at(-1).includes('已保存在本机'));
  saver.queue('a', { theme: 'light', ui: { two: 'new' } });
  fail = false;
  await saver.flush('a');
  assert.deepEqual(calls.at(-1), { theme: 'light', ui: { one: 'old', two: 'new' } });
  assert.deepEqual(journal, []);
  assert.equal(errors.at(-1), '');
});
test('only one request runs while rapid updates merge into a single next patch', async (t) => {
  let release,
    calls = [],
    active = 0,
    max = 0;
  const gate = new Promise((r) => {
    release = r;
  });
  const saver = create({
    debounceMs: 10000,
    write: async (root, settings) => {
      active++;
      max = Math.max(max, active);
      calls.push(settings);
      if (calls.length === 1) await gate;
      active--;
      return { rootDirectory: root, settings };
    },
  });
  t.after(() => saver.close());
  saver.queue('a', { fontSize: 12 });
  const first = saver.flush('a');
  await wait(0);
  for (let i = 13; i < 30; i++) {
    saver.queue('a', { fontSize: i });
    assert.equal(saver.flush('a'), first);
  }
  release();
  await first;
  await saver.flush('a');
  assert.equal(max, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fontSize, 29);
});
test('reload restores unsaved changes and root switching cannot move them into another root', async (t) => {
  let journal = [];
  const first = create({
    debounceMs: 10000,
    persist: (rows) => {
      journal = structuredClone(rows);
    },
    write: async () => {
      throw Error('offline');
    },
  });
  first.queue('old', { theme: 'black' });
  first.close();
  const writes = [];
  const restored = create({
    load: () => journal,
    debounceMs: 10000,
    write: async (root, settings) => {
      writes.push(root);
      return { rootDirectory: root, settings };
    },
  });
  t.after(() => restored.close());
  restored.queue('new', { fontSize: 18 });
  await restored.flush('new');
  assert.equal(restored.pending('old').theme, 'black');
  await restored.flush('old');
  assert.deepEqual(writes, ['new', 'old']);
});
test('permission failures do not spin in a retry loop, while transient failures recover automatically', async (t) => {
  let calls = 0;
  const saver = create({
    debounceMs: 10000,
    retryMs: 5,
    write: async (root, settings) => {
      calls++;
      if (calls === 1) throw Object.assign(Error('bad'), { status: 401 });
      return { rootDirectory: root, settings };
    },
  });
  t.after(() => saver.close());
  saver.queue('a', { theme: 'dark' });
  await assert.rejects(saver.flush('a'));
  await wait(25);
  assert.equal(calls, 1);
  saver.queue('a', { theme: 'black' });
  await saver.flush('a');
  assert.equal(calls, 2);
  let attempts = 0;
  const retry = create({
    debounceMs: 1,
    retryMs: 5,
    write: async (root, settings) => {
      if (++attempts === 1) throw Error('offline');
      return { rootDirectory: root, settings };
    },
  });
  t.after(() => retry.close());
  retry.queue('a', { fontSize: 16 });
  await wait(60);
  assert.equal(attempts, 2);
  assert.equal(retry.busy('a'), false);
});

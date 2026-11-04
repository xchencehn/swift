'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/frontend-updates');

test('foreground update revalidates, waits for edits, and reloads once', async () => {
  let remote = 'a',
    safe = true,
    reloads = 0,
    fail = false;
  const updater = create({
    version: 'a',
    url: '/frontend-version.json',
    canReload: () => safe,
    reload: () => reloads++,
    fetch: async (url, options) => {
      assert.equal(options.cache, 'no-store');
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ version: remote }) };
    },
  });
  await updater.check();
  assert.equal(reloads, 0);
  safe = false;
  remote = 'b';
  await updater.check();
  assert.equal(reloads, 0);
  assert(updater.isPending());
  safe = true;
  fail = true;
  await updater.check();
  assert.equal(reloads, 0);
  fail = false;
  await updater.check();
  await updater.check();
  assert.equal(reloads, 1);
});

test('concurrent update checks share one request and invalid responses never reload', async () => {
  let finish,
    requests = 0;
  const updater = create({
    version: 'a',
    url: '/version',
    canReload: () => true,
    reload: () => assert.fail('unexpected reload'),
    fetch: () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = updater.check();
  await updater.check();
  assert.equal(requests, 1);
  finish({ ok: true, json: async () => ({}) });
  await first;
  const second = updater.check();
  finish({ ok: false });
  await second;
  assert(!updater.isPending());
});

test('已知有新版本时，切到后台直接重载，不再先请求一次', async () => {
  let reloads = 0,
    requests = 0,
    hidden = false;
  const updater = create({
    version: 'a',
    url: '/v',
    canReload: () => hidden,
    reload: () => reloads++,
    fetch: async () => {
      requests++;
      return { ok: true, json: async () => ({ version: 'b' }) };
    },
  });
  await updater.check();
  assert.equal(reloads, 0, '在前台时只记下来，不当着人的面重载');
  assert(updater.isPending());
  hidden = true;
  updater.applyPending();
  assert.equal(reloads, 1);
  assert.equal(requests, 1);
  updater.applyPending();
  assert.equal(reloads, 1, '只重载一次');
});

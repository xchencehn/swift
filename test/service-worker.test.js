'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function worker() {
  const listeners = {},
    saved = new Map(),
    fetched = [];
  const state = { offline: false, status: 200 };
  const scope = 'http://fixture/swift/';
  const cache = {
    put: async (req, res) => saved.set(req.url, res),
    match: async (req) => saved.get(req.url),
    keys: async () => [...saved.keys()].map((url) => new Request(url)),
    delete: async (req) => saved.delete(req.url),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), {
    URL,
    Request,
    self: {
      registration: { scope },
      addEventListener: (name, callback) => {
        listeners[name] = callback;
      },
    },
    caches: { open: async () => cache },
    fetch: async (request, options = {}) => {
      fetched.push([request.url, options.cache || null]);
      if (state.offline) throw new Error('offline');
      return new Response(`body of ${request.url}`, { status: state.status });
    },
  });
  const dispatch = async (url) => {
    let response;
    const pending = [];
    listeners.fetch({
      request: new Request(url),
      respondWith: (result) => {
        response = result;
      },
      waitUntil: (result) => pending.push(result),
    });
    const result = await response?.catch(() => undefined);
    await Promise.all(pending);
    return result;
  };
  return { scope, saved, fetched, state, dispatch };
}

test('带版本号的资源缓存优先：有就不回源，换版本才取新的，同一文件只留最新一版', async () => {
  const { scope, saved, fetched, dispatch } = worker();
  const v1 = scope + 'app.js?v=one',
    v2 = scope + 'app.js?v=two';
  assert.equal(await (await dispatch(v1)).text(), `body of ${v1}`);
  assert.equal(await (await dispatch(v1)).text(), `body of ${v1}`);
  assert.equal(fetched.filter(([url]) => url === v1).length, 1, '第二次直接用缓存，不再回源确认');
  await dispatch(v2);
  assert(saved.has(v2) && !saved.has(v1), '旧版本被清掉');
});

test('页面与不带版本号的先走网络，离线退回缓存；失败的响应不缓存；接口不经过缓存', async () => {
  const { scope, saved, fetched, state, dispatch } = worker();
  assert.equal(await (await dispatch(scope)).text(), `body of ${scope}`);
  assert.deepEqual(fetched.at(-1), [scope, 'no-cache']);
  state.offline = true;
  assert.equal(await (await dispatch(scope)).clone().text(), `body of ${scope}`);
  assert.equal(
    await dispatch(scope + 'app.js?v=never-cached'),
    undefined,
    '离线且没缓存就是失败，不拿别的版本顶替',
  );
  assert.equal(await dispatch(scope + 'frontend-version.json'), undefined);
  assert.equal(await dispatch(scope + 'api/messages?pane=test'), undefined);
  state.offline = false;
  state.status = 502;
  assert.equal((await dispatch(scope + 'app.js?v=failed')).status, 502);
  assert(!saved.has(scope + 'app.js?v=failed'));
});

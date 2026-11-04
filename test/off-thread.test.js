'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(options = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const context = {
    module: { exports: {} },
    setTimeout(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../public/core/off-thread'), 'utf8'),
    context,
  );
  const workers = [];
  const queue = context.module.exports.createOffThreadQueue(
    () => {
      const worker = {
        sent: [],
        terminated: false,
        postMessage(message) {
          this.sent.push(message);
        },
        terminate() {
          this.terminated = true;
        },
        ready() {
          this.onmessage({ data: { ready: true } });
        },
        reply(result) {
          this.onmessage({ data: { id: this.sent.at(-1).id, result } });
        },
      };
      workers.push(worker);
      return worker;
    },
    1000,
    options,
  );
  function tick(delta) {
    const end = now + delta;
    while (true) {
      const next = [...timers]
        .filter(([, value]) => value.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  }
  return { queue, workers, tick };
}

test('slow worker initialization does not consume parsing time; parsing remains limited to one second', async () => {
  const f = fixture({ waitForReady: true });
  const first = f.queue('code');
  f.tick(1500);
  assert.equal(f.workers[0].sent.length, 0);
  assert.equal(f.workers[0].terminated, false);
  f.workers[0].ready();
  f.tick(999);
  f.workers[0].reply('highlighted');
  assert.equal(await first.promise, 'highlighted');
  const stuck = f.queue('pathological source');
  f.tick(1000);
  assert.equal(await stuck.promise, null);
  assert.equal(f.workers[0].terminated, true);
  const next = f.queue('next code');
  assert.equal(f.workers.length, 2);
  f.workers[1].ready();
  f.workers[1].reply('next highlighted');
  assert.equal(await next.promise, 'next highlighted');
});

test('initialization failure releases every waiting job and allows a later worker', async () => {
  const f = fixture({ waitForReady: true });
  const jobs = [f.queue('first'), f.queue('second')];
  f.tick(5000);
  assert.deepEqual(await Promise.all(jobs.map((job) => job.promise)), [null, null]);
  assert.equal(f.workers[0].terminated, true);
  const next = f.queue('retry');
  f.workers[1].ready();
  f.workers[1].reply('ready');
  assert.equal(await next.promise, 'ready');
});

test('waiting for readiness retains the queue bound and cancellation', async () => {
  const f = fixture({ waitForReady: true });
  const jobs = Array.from({ length: 32 }, (_, i) => f.queue(i));
  assert.equal(await f.queue('overflow').promise, null);
  assert.equal(jobs[0].cancel(), true);
  assert.equal(await jobs[0].promise, null);
  f.workers[0].onerror();
  assert((await Promise.all(jobs.map((job) => job.promise))).every((value) => value === null));
});

test('existing workers continue to execute immediately without a readiness message', async () => {
  const f = fixture();
  const job = f.queue('legacy');
  assert.equal(f.workers[0].sent.length, 1);
  f.workers[0].reply('done');
  assert.equal(await job.promise, 'done');
});

'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { create } = require('../public/core/connection-feedback');
function fixture() {
  let now = 0,
    id = 0;
  const jobs = new Map(),
    renders = [];
  const feedback = create({
    render: (value) => renders.push(value),
    setTimer: (run, ms) => {
      jobs.set(++id, { at: now + ms, run });
      return id;
    },
    clearTimer: (key) => jobs.delete(key),
  });
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at).find(([, job]) => job.at <= end);
      if (!next) break;
      now = next[1].at;
      jobs.delete(next[0]);
      next[1].run();
    }
    now = end;
  }
  return { feedback, renders, advance, jobs };
}
test('brief network recovery stays silent and retry attempts do not postpone a sustained outage', () => {
  const { feedback: f, renders, advance } = fixture();
  f.update(false, '恢复中');
  advance(14000);
  f.update(true);
  advance(2000);
  assert.deepEqual(renders, []);
  f.update(false, '断开');
  advance(7000);
  f.update(false, '正在重试');
  advance(7999);
  assert.deepEqual(renders, []);
  advance(1);
  assert.deepEqual(renders, ['正在重试']);
  f.update(true);
  advance(500);
  f.update(false, '仍在恢复');
  advance(1000);
  assert.equal(renders.at(-1), '仍在恢复');
  f.update(true);
  advance(1000);
  assert.equal(renders.at(-1), '');
});
test('initial loading ends on readiness, actionable errors remain through passive retries, and reset cancels timers', () => {
  const { feedback: f, renders, advance, jobs } = fixture();
  f.update(false, '加载中', { initial: true });
  f.update(true);
  assert.deepEqual(renders, ['加载中', '']);
  f.update(false, '身份改变', { actionable: true });
  f.update(false, '重试中');
  advance(20000);
  assert.equal(renders.at(-1), '身份改变');
  f.update(true);
  f.reset();
  advance(20000);
  assert.equal(renders.at(-1), '');
  assert.equal(jobs.size, 0);
});

'use strict';
// Synthetic eight-hour journal, with the same scale as the observed 167
// archives. No real session is read and no terminal receives input.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const { AsyncConversationStore } = require('../../lib/async-conversation-store');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(
  process.env.SWIFT_LONG_SESSION_OUTPUT || 'artifacts/testing/long-session-performance/benchmark',
);
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
const json = (value) => JSON.stringify(value) + '\n';
const utterance = (id, text, role = 'assistant') => ({
  type: 'response_item',
  timestamp: '2026-10-28T08:00:00.000Z',
  payload: {
    type: 'message',
    id,
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  },
});
const ms = (value) => Math.round(value * 100) / 100;
async function measure(work) {
  let last = performance.now(),
    longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 5);
    last = now;
  }, 5);
  const start = performance.now();
  try {
    const value = await work(),
      elapsed = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { value, ms: ms(elapsed), longestTimerDelayMs: ms(Math.max(0, longest)) };
  } finally {
    clearInterval(timer);
  }
}
function sample(read) {
  return {
    ms: read.ms,
    longestTimerDelayMs: read.longestTimerDelayMs,
    transferredBytes: v8.serialize(read.value).byteLength,
  };
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const before = sourceFingerprint(root),
    file = path.join(output, 'eight-hour-session.jsonl');
  const fd = fs.openSync(file, 'w'),
    calls = 1600,
    large = 'test output\n'.repeat(5400);
  try {
    fs.writeSync(fd, json(utterance('user-initial', '持续研究八小时，保留全部历史。', 'user')));
    for (let i = 0; i < calls; i++) {
      const timestamp = new Date(Date.UTC(2026, 9, 28) + i * 18000).toISOString();
      fs.writeSync(
        fd,
        json({
          type: 'response_item',
          timestamp,
          payload: {
            type: 'function_call',
            call_id: `tool-${i}`,
            name: 'exec_command',
            arguments: '{"cmd":"npm test"}',
          },
        }),
      );
      fs.writeSync(
        fd,
        json({
          type: 'response_item',
          timestamp,
          payload: { type: 'function_call_output', call_id: `tool-${i}`, output: large },
        }),
      );
      if (i % 20 === 19)
        fs.writeSync(
          fd,
          json(
            utterance(`commentary-${i}`, `第 ${i + 1} 步的结果已核对。\n\n下一步继续验证边界。`),
          ),
        );
    }
  } finally {
    fs.closeSync(fd);
  }
  const result = {
    at: new Date().toISOString(),
    node: process.version,
    source: before,
    journalBytes: fs.statSync(file).size,
    toolCalls: calls,
  };
  if (baseline) {
    const Old = require(
        path.join(path.resolve(baseline), 'lib/async-conversation-store'),
      ).AsyncConversationStore,
      old = new Old();
    try {
      const cold = await measure(() => old.read(file, 'codex'));
      result.baseline = {
        cold: sample(cold),
        messages: cold.value.conversation.length,
        appends: [],
      };
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(file, json(utterance(`baseline-append-${i}`, '新增正文。')));
        result.baseline.appends.push(sample(await measure(() => old.read(file, 'codex'))));
      }
    } finally {
      await old.close();
    }
  }
  const cache = path.join(output, 'conversation-index.sqlite');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cache + suffix, { force: true });
  let store = new AsyncConversationStore({ indexFile: cache });
  try {
    const cold = await measure(() => store.page(file, 'codex'));
    result.indexed = {
      cold: sample(cold),
      messages: cold.value.messages.length,
      total: cold.value.total,
      warm: sample(await measure(() => store.page(file, 'codex'))),
      appends: [],
    };
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(file, json(utterance(`index-append-${i}`, '新增正文。')));
      result.indexed.appends.push(sample(await measure(() => store.page(file, 'codex'))));
    }
    const page = await store.page(file, 'codex');
    result.indexed.earlier = sample(
      await measure(() =>
        store.page(file, 'codex', {
          before: page.messages[0].id,
          limit: 40,
          revision: page.historyRevision,
        }),
      ),
    );
    await store.close();
    store = new AsyncConversationStore({ indexFile: cache });
    result.indexed.restart = sample(await measure(() => store.page(file, 'codex')));
    assert(
      result.indexed.warm.transferredBytes < 256 * 1024,
      'the worker must transfer a bounded page',
    );
  } finally {
    await store.close();
  }
  result.after = sourceFingerprint(root);
  assert.deepEqual(result.after, before);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

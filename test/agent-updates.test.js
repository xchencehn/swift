'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { updatePrompt, launchWithUpdates } = require('../lib/agent-updates');
const screen =
  'Update available! 0.155.0 → 0.155.1\nRelease notes: https://github.com/openai/codex/releases/latest\n  1. Update now (runs `npm install -g @openai/codex`)\n❯ 2. Skip\n  3. Skip until next version';
test('只确认已识别的原生更新菜单，不把权限或聊天内容当更新', () => {
  assert.deepEqual(updatePrompt(screen, 'codex').keys, ['up', 'enter']);
  assert.equal(updatePrompt(screen, 'claude'), null);
  assert.equal(updatePrompt('Do you trust this folder?\n❯ Yes\nNo', 'codex'), null);
  assert.equal(updatePrompt('Please update Codex now', 'codex'), null);
});
test('更新使初始进程退出后，仅用原参数恢复自建目标，避免重复更新', async () => {
  const pane = { paneId: 'new', terminalId: 'same' };
  let calls = 0,
    finish;
  const keys = [];
  const herdr = {
    json: async (args) => {
      calls++;
      assert.deepEqual(args, ['agent', 'start', 'probe']);
      if (calls === 2) return { ready: true };
      return new Promise((_, reject) => {
        finish = reject;
      });
    },
    resolveTarget: async () => pane,
    readPane: async () => screen,
  };
  const result = await launchWithUpdates(herdr, ['agent', 'start', 'probe'], pane, 'codex', {
    pollMs: 1,
    keys: async (target, value) => {
      keys.push([target, value]);
      finish(Error('old process exited after updating'));
    },
  });
  assert.equal(result.ready, true);
  assert.equal(calls, 2);
  assert.deepEqual(keys, [['new', ['up', 'enter']]]);
});

test('更新未完成时 Herdr 启动超时不能提前清理，也不能重复确认', async () => {
  const pane = { paneId: 'new', terminalId: 'same', agent: { label: 'codex', status: 'blocked' } };
  let rejectLaunch,
    submitted = 0,
    polls = 0;
  const herdr = {
    json: async () =>
      new Promise((_, reject) => {
        rejectLaunch = reject;
      }),
    resolveTarget: async () => {
      if (submitted && ++polls > 3) pane.agent.status = 'idle';
      return pane;
    },
    readPane: async () => screen,
  };
  const result = await launchWithUpdates(herdr, ['agent', 'start', 'probe'], pane, 'codex', {
    pollMs: 1,
    keys: async () => {
      submitted++;
      rejectLaunch(Error('agent_not_ready'));
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(submitted, 1);
  assert(polls > 3);
});

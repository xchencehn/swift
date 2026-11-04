'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyNativeReadiness } = require('../lib/agent-readiness');
const pane = {
  paneId: 'w1:p1',
  terminalId: 'term-1',
  runtimeId: '42:100',
  status: 'unknown',
  agent: { label: 'codex', status: 'unknown', session: { kind: 'id', value: 'native-session' } },
};
// 保留线上画面的 ANSI dim、输入框位置、状态栏分隔符和快捷键行。
const ready =
  'Worked for 14s • 17:08\n\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n' +
  '  GPT-6.1-Sol medium · ~/workdir/community · community · main · Ready · Context 74% used · weekly 79% left\n' +
  '  ← for agents · ? for shortcuts\n';

test('已绑定会话的 unknown Codex 只在明确的原生就绪画面下允许投递', () => {
  const result = applyNativeReadiness(pane, ready);
  assert.equal(result.agent.status, 'idle');
  assert.equal(result.agent.readinessSource, 'codex-native-screen');
  assert.equal(result.runtimeId, pane.runtimeId);
  assert.deepEqual(result.agent.session, pane.agent.session);
  assert.equal(pane.agent.status, 'unknown');
});

test('不把缺少身份、用户草稿、活动、审批和正文中的 Ready 当作就绪', () => {
  for (const patch of [
    { runtimeId: null },
    { agent: { ...pane.agent, session: null } },
    { agent: { ...pane.agent, label: 'claude' } },
    { agent: { ...pane.agent, status: 'working' } },
    { agent: { ...pane.agent, status: 'blocked' } },
    { agent: { ...pane.agent, interactiveReady: false } },
    { agent: { ...pane.agent, launchPending: true } },
  ]) {
    const target = { ...pane, ...patch };
    assert.equal(applyNativeReadiness(target, ready), target);
  }
  for (const screen of [
    ready.replace(/\x1b\[2m/g, ''),
    ready.replace('Ready', 'Working'),
    'Ready\n› \x1b[2mAsk Codex to do anything\x1b[0m\n',
    ready + 'Would you like to run this command?\n',
    ready + '审批问题\n',
    '• Working (12s · Esc to interrupt)\n' + ready,
    ready.replace('? for shortcuts', 'Press Enter to confirm'),
  ]) {
    assert.equal(applyNativeReadiness(pane, screen), pane);
  }
});

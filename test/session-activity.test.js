'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activityKind } = require('../public/ui-model');

test('状态点按「要不要我」着色：工作中、等我看、等我答、只是开着', () => {
  const pane = { agent: { label: 'codex', status: 'working' } };
  assert.equal(activityKind(pane), 'working', '推理和执行都算工作中，不再分成两种颜色');
  pane.agent.status = 'done';
  assert.equal(activityKind(pane), 'done', '本轮结束、消息还没被看过');
  pane.agent.status = 'idle';
  assert.equal(activityKind(pane), 'idle', '看过之后只是开着');
  pane.agent.status = 'blocked';
  assert.equal(activityKind(pane), 'blocked');
  // 断开连接时不能继续声称对方在忙或有话要说。
  for (const status of ['working', 'done', 'blocked']) {
    pane.agent.status = status;
    assert.equal(activityKind(pane, false), 'offline');
  }
  assert.equal(activityKind({ status: 'working', agent: null }), 'shell');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { archivedSettings, getAgentSettings, validateSettings } = require('../lib/agent-settings');
const catalog = { models: [{ id: 'test-model', efforts: [{ id: 'high' }, { id: 'low' }] }] };

test('最新 turn_context 提供模型和 effort，目录默认值不代替当前值', () => {
  const value = archivedSettings('codex', [
    JSON.stringify({ type: 'turn_context', payload: { model: 'old', effort: 'low' } }),
    'broken',
    JSON.stringify({
      type: 'turn_context',
      timestamp: 'today',
      payload: { model: 'test-model', effort: 'high' },
    }),
  ]);
  assert.deepEqual(value, {
    model: 'test-model',
    effort: 'high',
    source: 'turn_context',
    recordedAt: 'today',
  });
  assert.equal(archivedSettings('codex', []).model, null);
  assert.equal(
    archivedSettings('claude', [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-test' } }),
    ]).effort,
    null,
  );
});

test('Codex 会话在终端里切换，可编辑；没有会话 id 的新会话也一样', async () => {
  const readLines = async () => [];
  const codexSettings = { recorded: async () => null };
  const readCatalog = async () => catalog;
  const value = await getAgentSettings(
    { paneId: 'p', agent: { label: 'codex', session: { value: 's' } } },
    { readLines, codexSettings, readCatalog },
  );
  assert.equal(value.editable, true);
  assert.equal(value.selector, 'native');
  // 刚建、还没发过第一句话：终端里的 /model 照样能用。
  const fresh = await getAgentSettings(
    { paneId: 'p', agent: { label: 'codex', session: null } },
    { readLines, codexSettings, readCatalog },
  );
  assert.equal(fresh.editable, true);
  const shell = await getAgentSettings(
    { paneId: 'p', agent: null },
    { readLines, codexSettings, readCatalog },
  );
  assert.equal(shell.editable, false);
  assert.ok(shell.reason);
});

test('设置校验拒绝空值、不支持的模型和 effort，允许单独更新 effort', () => {
  const current = { model: 'test-model' };
  assert.deepEqual(validateSettings({ effort: 'low' }, current, catalog), { effort: 'low' });
  for (const body of [
    null,
    {},
    { model: null },
    { effort: [] },
    { model: 'missing' },
    { effort: 'extreme' },
  ]) {
    assert.throws(() => validateSettings(body, current, catalog), { status: 400 });
  }
  assert.throws(() => validateSettings({ model: 'test-model' }, current, { models: [] }), {
    status: 503,
  });
});

test('运行中进程的设置（状态行）优先于存档里上一轮的记录，读不到就用存档', async () => {
  const pane = { paneId: 'p', agent: { label: 'codex', session: { value: 's' } } };
  const readLines = async () => [
    JSON.stringify({
      type: 'turn_context',
      timestamp: 't',
      payload: { model: 'old', effort: 'low' },
    }),
  ];
  const readCatalog = async () => catalog;
  let live = {
    model: 'test-model',
    effort: 'high',
    serviceTier: 'priority',
    source: 'codex-native-screen',
  };
  const codexSettings = { recorded: async () => live };
  const value = await getAgentSettings(pane, { readLines, codexSettings, readCatalog });
  assert.deepEqual(
    [value.model, value.effort, value.serviceTier, value.source],
    ['test-model', 'high', 'priority', 'codex-native-screen'],
  );
  live = null;
  const archived = await getAgentSettings(pane, { readLines, codexSettings, readCatalog });
  assert.deepEqual(
    [archived.model, archived.effort, archived.source],
    ['old', 'low', 'turn_context'],
  );
  codexSettings.recorded = async () => {
    throw Error('画面读不到');
  };
  assert.equal(
    (await getAgentSettings(pane, { readLines, codexSettings, readCatalog })).source,
    'turn_context',
  );
});

test('Fast 只接受当前模型的服务档位，null 明确关闭，省略不改', () => {
  const models = {
    models: [{ id: 'm', efforts: [{ id: 'low' }], serviceTiers: [{ id: 'priority' }] }],
  };
  assert.deepEqual(validateSettings({ serviceTier: 'priority' }, { model: 'm' }, models), {
    serviceTier: 'priority',
  });
  assert.deepEqual(validateSettings({ serviceTier: null }, { model: 'm' }, models), {
    serviceTier: null,
  });
  assert.deepEqual(validateSettings({ effort: 'low' }, { model: 'm' }, models), { effort: 'low' });
  for (const serviceTier of ['fast', '', false, {}, []])
    assert.throws(() => validateSettings({ serviceTier }, { model: 'm' }, models), { status: 400 });
});

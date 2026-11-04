'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeControl, modelMenu, receipt } = require('../lib/claude-control');
const rule = '─'.repeat(90);
const catalog = {
  models: [
    {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      short: 'Sonnet',
      primary: true,
      efforts: ['low', 'medium', 'high'].map((id) => ({ id })),
    },
  ],
};
function fixture() {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    agent: { label: 'claude', status: 'working', session: { value: 's' } },
  };
  const state = { mode: 'composer', input: '', selected: 0, effort: 2, lines: [], keys: [] };
  const screen = () =>
    state.mode === 'menu'
      ? `Select model\n${state.selected === 0 ? '❯' : ' '} 1. Default (recommended) Opus 5\n${state.selected === 1 ? '❯' : ' '} 2. Sonnet Sonnet 5\n● ${['Low', 'Medium', 'High'][state.effort]} effort\nEnter to set as default · s to use this session only · Esc to cancel`
      : `${rule}\n❯ ${state.input}\n${rule}`;
  const control = new ClaudeControl({
    herdr: { readPane: async () => screen() },
    exactPane: async () => pane,
    readLines: async () => state.lines,
    catalog: async () => catalog,
    timeoutMs: 80,
    paste: async (_, text) => {
      state.input = text;
    },
    keys: async (_, keys) => {
      state.keys.push(...keys);
      for (const key of keys) {
        if (key === 'ctrl+u') state.input = '';
        if (key === 'enter') state.mode = 'menu';
        if (key === 'down') state.selected++;
        if (key === 'left') state.effort--;
        if (key === 's') {
          state.mode = 'composer';
          state.input = '';
          state.lines.push(
            JSON.stringify({
              type: 'user',
              timestamp: '2026-09-19T00:00:00Z',
              message: {
                content:
                  '<local-command-stdout>Set model to `Sonnet 5` for this session only with `low` effort</local-command-stdout>',
              },
            }),
          );
        }
        if (key === 'esc') state.mode = 'composer';
      }
    },
  });
  return { pane, state, control };
}
test('Claude 模型与 effort 使用同一原生选择器，仅会话提交并等待新确认', async () => {
  const { pane, state, control } = fixture();
  const actual = await control.apply(pane, { model: 'claude-sonnet-5', effort: 'low' }, catalog);
  assert.equal(actual.model, 'claude-sonnet-5');
  assert.equal(actual.effort, 'low');
  assert.equal(actual.scope, 'session');
  assert.deepEqual(state.keys, ['enter', 'down', 'left', 'left', 's']);
  assert.equal(control.busy.size, 0);
});
test('明确设置操作清空原生草稿，但仍拒绝阻塞问题', async () => {
  const { pane, state, control } = fixture();
  state.input = 'unfinished draft';
  await control.apply(pane, { model: 'claude-sonnet-5', effort: 'low' }, catalog);
  assert.equal(state.input, '');
  assert.deepEqual(state.keys.slice(0, 3), ['ctrl+e', 'ctrl+u', 'ctrl+k']);
  pane.agent.status = 'blocked';
  await assert.rejects(control.apply(pane, { model: 'claude-sonnet-5' }, catalog), {
    code: 'AGENT_NOT_READY',
  });
  assert.equal(modelMenu('Please trust this folder\n❯ 1. Yes\n2. No'), null);
});
test('身份在异步等待时变化，不向替换后的会话写入', async () => {
  const { pane, state, control } = fixture();
  control.beforeApply = async () => {
    pane.terminalId = 'replaced';
  };
  await assert.rejects(control.apply(pane, { model: 'claude-sonnet-5' }, catalog), {
    code: 'SESSION_CHANGED',
  });
  assert.deepEqual(state.keys, []);
});
test('旧回复的模型不能覆盖已确认的后续会话配置，显式原生命令可覆盖', async () => {
  const { pane, control } = fixture();
  const raw = JSON.stringify({
    type: 'user',
    message: {
      content:
        '<local-command-stdout>Set model to `Sonnet 5` for this session only with `low` effort</local-command-stdout>',
    },
  });
  const settings = await control.recorded(pane, [
    raw,
    JSON.stringify({ type: 'assistant', message: { model: 'old-turn-model' } }),
  ]);
  assert.equal(settings.model, 'claude-sonnet-5');
  assert.equal(settings.effort, 'low');
  assert.equal(receipt('broken', catalog.models), null);
});

test('菜单 effort 只取选择器区域，不受页首旧模型说明影响', () => {
  const value = modelMenu(
    'Sonnet 5 with low effort\nSelect model\n❯ 1. Default Opus 5\n2. Sonnet Sonnet 5\n● High effort\ns to use this session only',
  );
  assert.equal(value.effort, 'high');
});

test('只确认指定模型的缓存提示，不批准 hook、权限或其他模型', () => {
  const { cacheSwitchPrompt } = require('../lib/claude-control');
  const screen =
    'Switch model?\nYour next response will be slower and use more tokens\nThis conversation is cached for the current model.\n❯ 1. Yes, switch to Sonnet 5\n2. No, go back';
  assert.deepEqual(cacheSwitchPrompt(screen, catalog.models[0]), ['enter']);
  assert.equal(cacheSwitchPrompt(screen, { label: 'Opus 5' }), null);
  assert.equal(
    cacheSwitchPrompt(
      screen.replace(
        'This conversation is cached for the current model.',
        'PreModelSwitch hook requires approval',
      ),
      catalog.models[0],
    ),
    null,
  );
});

test('运行中的设置没有存档回执时，以原生应用后的页首确认，旧轮回复不覆盖', async () => {
  const { pane, control } = fixture();
  const read = control.herdr.readPane;
  let applied = false;
  const keys = control.keys;
  control.readLines = async () => [];
  control.keys = async (id, value) => {
    await keys(id, value);
    if (value.includes('s')) applied = true;
  };
  control.herdr.readPane = async () =>
    applied
      ? `▐▛██ ClaudeCodev2.1.258\n▝▜██ Sonnet5 with low effort · ClaudeMax\n${rule}\n❯\n${rule}`
      : read();
  const result = await control.apply(pane, { model: 'claude-sonnet-5', effort: 'low' }, catalog);
  assert.equal(result.source, 'claude-native-screen');
  control.herdr.readPane = async () => `${rule}\n❯\n${rule}`;
  const current = await control.recorded(pane, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2099-01-01T00:00:00Z',
      message: { model: 'old-turn-model' },
    }),
  ]);
  assert.equal(current.model, 'claude-sonnet-5');
  assert.equal(current.effort, 'low');
});

test('缓存确认兼容换行、1M 上下文标注和推理强度，只确认所选目标', () => {
  const { cacheSwitchPrompt, cacheSwitchConfirmation } = require('../lib/claude-control');
  const raw =
    '│ Switch model?\n│ Your next response will be slower and use more tokens\n│ This conversation is cached for the current model.\n│  1. Yes, switch to Sonnet 5\n│     (1M context)\n│ ❯ 2. No, go back │';
  assert.deepEqual(cacheSwitchPrompt(raw, catalog.models[0]), ['up', 'enter']);
  assert.equal(cacheSwitchConfirmation(raw).selected, 1);
  const effort = raw
    .replace('Switch model?', 'Change effort level?')
    .replace('current model.', 'current effort level.')
    .replace('Sonnet 5\n│     (1M context)', 'High');
  assert.deepEqual(cacheSwitchPrompt(effort, catalog.models[0], 'high'), ['up', 'enter']);
  assert.equal(cacheSwitchPrompt(effort, catalog.models[0], 'low'), null);
  assert.equal(cacheSwitchPrompt(effort, catalog.models[0]), null);
});

test('运行中切换模型与强度连续出现两个缓存确认时分别核对和处理', async () => {
  const { pane, state, control } = fixture();
  const originalRead = control.herdr.readPane,
    originalKeys = control.keys;
  let stage = '';
  const prompt = () =>
    `${stage === 'model' ? 'Switch model?' : 'Change effort level?'}\nYour next response will be slower and use more tokens\nThis conversation is cached for the current ${stage === 'model' ? 'model' : 'effort level'}.\n❯ 1. Yes, switch to ${stage === 'model' ? 'Sonnet 5 (1M context)' : 'Low'}\n2. No, go back`;
  control.herdr.readPane = async () => (stage ? prompt() : originalRead());
  control.keys = async (id, keys) => {
    if (stage && keys[0] === 'enter') {
      state.keys.push(...keys);
      if (stage === 'model') stage = 'effort';
      else {
        stage = '';
        state.lines.push(
          JSON.stringify({
            type: 'user',
            message: {
              content:
                '<local-command-stdout>Set model to `Sonnet 5` for this session only with `low` effort</local-command-stdout>',
            },
          }),
        );
      }
    } else {
      await originalKeys(id, keys);
      if (keys.includes('s')) {
        state.lines = [];
        stage = 'model';
      }
    }
  };
  control.timeoutMs = 1000;
  const result = await control.apply(pane, { model: 'claude-sonnet-5', effort: 'low' }, catalog);
  assert.equal(result.model, 'claude-sonnet-5');
  assert.deepEqual(state.keys.slice(-3), ['s', 'enter', 'enter']);
});

test('终端 /effort 的原生确认覆盖 APP 旧档位，模型沿用原生记录', async () => {
  const pane = {
    paneId: 'p',
    terminalId: 't',
    runtimeId: 'process',
    agent: { label: 'claude', session: { value: 's' } },
  };
  const { ClaudeControl } = require('../lib/claude-control');
  const control = new ClaudeControl({
    herdr: { readPane: async () => '' },
    catalog: async () => ({ models: [] }),
  });
  control.observed.set(require('../lib/conversation-state').binding(pane), {
    model: 'm',
    effort: 'high',
    recordedAt: '2026-09-20T00:00:00Z',
  });
  const value = await control.recorded(pane, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-20T00:00:00Z',
      message: { model: 'm' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-20T01:00:00Z',
      message: {
        content:
          '<local-command-stdout>Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation with minimal overhead</local-command-stdout>',
      },
    }),
  ]);
  assert.equal(value.effort, 'low');
  assert.equal(value.model, 'm');
});

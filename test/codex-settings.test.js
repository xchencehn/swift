'use strict';
// Codex 的模型与档位切换：用一个按实测规则响应按键的假终端来验按键序列。
// ⚠️ 最要紧的断言是「全局配置从未被改写」：档位菜单里按数字或回车都会以「设为默认」生效。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CodexSettings,
  codexMenu,
  statusSettings,
  restoreServiceTier,
} = require('../lib/codex-settings');

const MODELS = [
  {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((id) => ({ id })),
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6-Sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((id) => ({ id })),
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id })),
  },
];
const LABEL = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

test('Goal alignment preserves a complete model and reasoning setting without guessing truncation', () => {
  for (const footer of [
    'GPT-6-Astra ultra · wwh · ~/project           Pursuing goal (44s)',
    '~/project · wwh · GPT-6-Astra ultra           Pursuing goal (44s)',
    '~/project · wwh\n  GPT-6-Astra ultra fast           Pursuing goal (44s)',
  ]) {
    const current = statusSettings(`» \n\n  ${footer}\n  ? for shortcuts`, MODELS);
    assert.equal(current.model, 'gpt-6-astra');
    assert.equal(current.effort, 'ultra');
    assert.equal(current.serviceTier, footer.includes(' fast') ? 'priority' : null);
  }
  assert.equal(
    statusSettings('» \n\n  ~/project · GPT-6-Astra ult…           Pursuing goal (44s)', MODELS),
    null,
  );
  assert.equal(
    statusSettings(
      '» \n\n  ~ · GPT-6-Astr… Goal paused (/goal resume)    ⚠ 1 warning · f2 to view',
      MODELS,
    ),
    null,
  );
  assert.equal(statusSettings('» \n\n  ~… Goal paused (/goal resume)    ⚠ 1 · f2', MODELS), null);
});

/** 假 Codex：只模拟实测过的那几种菜单与按键语义。 */
function fakeCodex({
  model = 'gpt-6-astra',
  effort = 'high',
  tier = null,
  opensModelList = false,
} = {}) {
  const t = {
    model,
    effort,
    tier,
    composer: '',
    menu: null,
    cursor: 0,
    menuModel: null,
    log: [],
    globalWrites: 0,
    keys: [],
  };
  const byId = (id) => MODELS.find((m) => m.id === id);
  const effortRows = (m) => {
    const base = m.efforts.map((e) => e.id).filter((e) => !['max', 'ultra'].includes(e));
    return m.efforts.some((e) => ['max', 'ultra'].includes(e.id)) ? [...base, 'more'] : base;
  };
  const advancedRows = (m) =>
    m.efforts.map((e) => e.id).filter((e) => ['max', 'ultra'].includes(e));
  t.render = () => {
    const lines = ['│ >_ OpenAI Codex (v0.156.0) │', '', ...t.log.map((line) => `• ${line}`), ''];
    if (t.menu === 'effort' || t.menu === 'advanced') {
      const m = byId(t.menuModel),
        rows = t.menu === 'effort' ? effortRows(m) : advancedRows(m);
      lines.push(
        t.menu === 'effort' ? `  Select Reasoning Level for ${m.label}` : '  Advanced Reasoning',
        '',
      );
      rows.forEach((id, i) =>
        lines.push(
          `${i === t.cursor ? '›' : ' '} ${i + 1}. ${id === 'more' ? 'More reasoning…' : LABEL[id]}${m.id === t.model && id === t.effort ? ' (current)' : ''}   说明`,
        ),
      );
      lines.push(
        '',
        rows[t.cursor] === 'more'
          ? '  enter select · esc back'
          : '  enter default · s session · esc back',
      );
    } else if (t.menu === 'model') {
      lines.push('  Select Model and Effort', '');
      MODELS.forEach((m, i) =>
        lines.push(
          `${i === t.cursor ? '›' : ' '} ${i + 1}. ${m.label}${m.id === t.model ? ' (current)' : ''}   说明`,
        ),
      );
      lines.push('', '  enter select · esc back');
    } else {
      lines.push(
        `› ${t.composer}`,
        '',
        `  ${byId(t.model).label} ${t.effort}${t.tier ? ' fast' : ''} · ~/workdir · Ready · Context 0% used`,
      );
    }
    return lines.join('\n');
  };
  const rowsNow = () =>
    t.menu === 'effort'
      ? effortRows(byId(t.menuModel))
      : t.menu === 'advanced'
        ? advancedRows(byId(t.menuModel))
        : MODELS;
  const setDefault = (id) => {
    t.globalWrites += 1;
    t.model = t.menuModel;
    t.effort = id;
    t.menu = null;
    t.log.push(`Model changed to ${t.model} ${id}`);
  };
  t.press = (key) => {
    t.keys.push(key);
    if (!t.menu) {
      if (key === 'ctrl+u') {
        t.composer = '';
        return;
      }
      if (key === 'enter' && t.composer === '/model' && opensModelList) {
        t.composer = '';
        t.menu = 'model';
        t.cursor = MODELS.findIndex((m) => m.id === t.model);
      } else if (key === 'enter' && t.composer === '/model') {
        t.composer = '';
        t.menu = 'effort';
        t.menuModel = t.model;
        t.cursor = effortRows(byId(t.model)).indexOf(
          ['max', 'ultra'].includes(t.effort) ? 'more' : t.effort,
        );
      } else if (key === 'enter' && t.composer === '/fast') {
        t.composer = '';
        t.tier = t.tier ? null : 'priority';
        t.log.push(`Service tier set to ${t.tier || 'default'}`);
        // 真实 Codex 的 /fast 顺手改写全局配置里的 service_tier。
        if (t.configFile)
          fs.writeFileSync(
            t.configFile,
            fs
              .readFileSync(t.configFile, 'utf8')
              .replace(/^service_tier = .*$/m, `service_tier = "${t.tier ? 'fast' : 'default'}"`),
          );
      } else if (key.length === 1) t.composer += key;
      return;
    }
    const rows = rowsNow();
    if (key === 'down') t.cursor = Math.min(rows.length - 1, t.cursor + 1);
    else if (key === 'up') t.cursor = Math.max(0, t.cursor - 1);
    else if (key === 'esc') {
      if (t.menu === 'effort') {
        t.menu = 'model';
        t.cursor = MODELS.findIndex((m) => m.id === t.model);
      } else if (t.menu === 'advanced') {
        t.menu = 'effort';
        t.cursor = effortRows(byId(t.menuModel)).indexOf('more');
      } else t.menu = null;
    } else if (t.menu === 'model' && key === 'enter') {
      t.menuModel = MODELS[t.cursor].id;
      t.menu = 'effort';
      t.cursor = effortRows(byId(t.menuModel)).indexOf('medium');
    } else if (t.menu === 'model' && /^\d$/.test(key)) {
      t.menuModel = MODELS[Number(key) - 1].id;
      t.menu = 'effort';
      t.cursor = 1;
    } else if (t.menu === 'effort' && key === 'enter' && rows[t.cursor] === 'more') {
      t.menu = 'advanced';
      t.cursor = 0;
    } else if (
      (t.menu === 'effort' || t.menu === 'advanced') &&
      (key === 'enter' || /^\d$/.test(key))
    )
      setDefault(rows[/^\d$/.test(key) ? Number(key) - 1 : t.cursor]);
    else if (
      (t.menu === 'effort' || t.menu === 'advanced') &&
      key === 's' &&
      rows[t.cursor] !== 'more'
    ) {
      t.model = t.menuModel;
      t.effort = rows[t.cursor];
      t.menu = null;
      t.log.push(`Model changed to ${t.model} ${t.effort} for this session only`);
    }
  };
  return t;
}

function harness(state, options = {}) {
  const pane = {
    paneId: 'w1:p1',
    terminalId: 'term',
    agent: { label: 'codex', status: 'idle', session: { value: 's1' } },
  };
  const settings = new CodexSettings({
    configFile:
      state.configFile || path.join(os.tmpdir(), 'agent-studio-no-such-codex-config.toml'),
    ...options,
    herdr: { readPane: async () => state.render() },
    exactPane: async () => pane,
    keys: async (_, keys) => keys.forEach((key) => state.press(key)),
    paste: async (_, text) => {
      for (const ch of text) state.composer += ch;
    },
    timeoutMs: 500,
    stepMs: 1,
  });
  return { pane, settings };
}

test('只换档位：方向键移到目标再按 s，只对本会话生效', async () => {
  const state = fakeCodex({ effort: 'high' });
  const { pane, settings } = harness(state);
  const result = await settings.apply(pane, { effort: 'xhigh' }, { models: MODELS });
  assert.equal(state.effort, 'xhigh');
  assert.equal(state.globalWrites, 0, '不能改写全局配置');
  assert.equal(result.effort, 'xhigh');
  assert(!state.keys.some((key) => /^\d$/.test(key)), '档位菜单里不按数字');
});

test('换模型：Esc 回模型列表，选中后进它的档位菜单', async () => {
  const state = fakeCodex({ model: 'gpt-6-astra', effort: 'high' });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { model: 'gpt-5.5', effort: 'low' }, { models: MODELS });
  assert.deepEqual([state.model, state.effort, state.globalWrites], ['gpt-5.5', 'low', 0]);
});

test('/model 直接打开模型列表时，先选当前模型再进档位菜单', async () => {
  // 2026-09-23 真实 Codex v0.156.0 上就是这样：只等档位菜单的实现在这里超时。
  const state = fakeCodex({ effort: 'high', opensModelList: true });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { effort: 'low' }, { models: MODELS });
  assert.deepEqual([state.model, state.effort, state.globalWrites], ['gpt-6-astra', 'low', 0]);
  assert(!state.keys.includes('esc'), '模型列表里不必先退出');
});

test('只换模型不指定档位：用那个模型的默认档位', async () => {
  const state = fakeCodex({ model: 'gpt-6-astra', effort: 'xhigh' });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { model: 'gpt-6-sol' }, { models: MODELS });
  assert.deepEqual([state.model, state.effort, state.globalWrites], ['gpt-6-sol', 'medium', 0]);
});

test('max 与 ultra 在二级菜单里，进去也只按 s', async () => {
  const state = fakeCodex({ effort: 'high' });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { effort: 'ultra' }, { models: MODELS });
  assert.deepEqual([state.effort, state.globalWrites], ['ultra', 0]);
  // 回到普通档位：二级菜单之外的档位直接在第一层选。
  await settings.apply(pane, { effort: 'low' }, { models: MODELS });
  assert.deepEqual([state.effort, state.globalWrites], ['low', 0]);
});

test('速度档位用 /fast 开关，已是目标档位就不按', async () => {
  const state = fakeCodex({ tier: null });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { serviceTier: 'priority' }, { models: MODELS });
  assert.equal(state.tier, 'priority');
  const pressed = state.keys.length;
  await settings.apply(pane, { serviceTier: 'priority' }, { models: MODELS });
  assert.equal(state.keys.length, pressed, '已经是 fast 了，再按一次就关掉了');
  await settings.apply(pane, { serviceTier: null }, { models: MODELS });
  assert.equal(state.tier, null);
});

test('/fast 之后把全局配置里的 service_tier 恢复成原样，其他行保持', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = fakeCodex({ tier: null });
  state.configFile = path.join(dir, 'config.toml');
  const original =
    'model = "gpt-6-astra"\nservice_tier = "default"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(state.configFile, original);
  const { pane, settings } = harness(state);
  await settings.apply(pane, { serviceTier: 'priority' }, { models: MODELS });
  assert.equal(state.tier, 'priority', '运行中的会话切到了 fast');
  assert.equal(fs.readFileSync(state.configFile, 'utf8'), original, '全局默认不变');
});

test('恢复 service_tier 只动那一行；原来没有这一行就删掉', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "a"\nservice_tier = "fast"\nnotify = true\n');
  assert.equal(restoreServiceTier(file, 'model = "a"\nservice_tier = "default"\n'), true);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    'model = "a"\nservice_tier = "default"\nnotify = true\n',
    '同时写入的 notify 保留',
  );
  fs.writeFileSync(file, 'model = "a"\nservice_tier = "fast"\n');
  restoreServiceTier(file, 'model = "a"\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "a"\n');
});

test('刚确认的切换在短时间内优先于还没刷新的状态行', async () => {
  const state = fakeCodex({ model: 'gpt-6-astra', effort: 'high' });
  let clock = Date.now();
  const { pane, settings } = harness(state, { now: () => clock });
  await settings.apply(pane, { model: 'gpt-6-sol', effort: 'max' }, { models: MODELS });
  state.model = 'gpt-6-sol';
  state.effort = 'high'; // 状态行滞后：模型换了，档位还是旧的
  assert.equal((await settings.recorded(pane, { models: MODELS })).effort, 'max');
  clock += 60000;
  assert.equal(
    (await settings.recorded(pane, { models: MODELS })).effort,
    'high',
    '过了这段时间就以状态行为准',
  );
});

test('consecutive changes use the confirmed model while the native footer is being redrawn', async () => {
  const state = fakeCodex({ model: 'gpt-6-astra', effort: 'high' });
  const { pane, settings } = harness(state);
  await settings.apply(pane, { model: 'gpt-6-sol', effort: 'max' }, { models: MODELS });
  const render = state.render;
  state.render = () =>
    render().replace(/GPT-6-Sol max · .*$/, '                 GPT-6-Sol ma…  ⚠ 1 · f2');
  assert.equal(
    statusSettings(state.render(), MODELS),
    null,
    'The partial footer is deliberately unreadable',
  );
  const result = await settings.apply(pane, { effort: 'ultra' }, { models: MODELS });
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.effort, 'ultra');
  assert.equal(state.globalWrites, 0);
});

test('设置前清空输入框，菜单已开时拒绝，工作中的 Codex 仍可设置', async () => {
  const typed = fakeCodex();
  typed.composer = '写到一半';
  await harness(typed).settings.apply(harness(typed).pane, { effort: 'low' }, { models: MODELS });
  assert.equal(typed.effort, 'low');
  assert.equal(typed.composer, '');
  assert.deepEqual(typed.keys.slice(0, 3), ['ctrl+e', 'ctrl+u', 'ctrl+k']);

  const open = fakeCodex();
  open.menu = 'model';
  open.cursor = 0;
  await assert.rejects(
    harness(open).settings.apply(harness(open).pane, { effort: 'low' }, { models: MODELS }),
    { code: 'SELECTOR_OPEN' },
  );

  const busy = fakeCodex();
  const { pane, settings } = harness(busy);
  pane.agent.status = 'working';
  await settings.apply(pane, { effort: 'low' }, { models: MODELS });
  assert.equal(busy.effort, 'low');
});

test('失败时把自己打开的菜单关掉，最多退三层', async () => {
  const state = fakeCodex();
  const { pane, settings } = harness(state);
  await assert.rejects(
    settings.apply(
      pane,
      { model: 'gpt-6-sol', effort: 'ultra' },
      { models: [MODELS[0], { ...MODELS[1], label: '不在菜单里' }, MODELS[2]] },
    ),
    { code: 'MODEL_NOT_IN_SELECTOR' },
  );
  assert.equal(state.menu, null, '菜单要关掉');
  assert.equal(state.globalWrites, 0);
});

test('状态行读出模型、档位与速度档位', () => {
  const screen = '› \n\n  GPT-6-Sol xhigh fast · ~/w · Ready';
  assert.deepEqual(statusSettings(screen, MODELS), {
    model: 'gpt-6-sol',
    effort: 'xhigh',
    serviceTier: 'priority',
    source: 'codex-native-screen',
  });
  assert.equal(statusSettings('› \n\n  未知模型 high · ~/w', MODELS), null, '认不出的模型不猜');
});

test('编号不连续的列表不当成菜单', () => {
  assert.equal(
    codexMenu('  Select Model and Effort\n› 1. A\n  3. C\n  enter select · esc back'),
    null,
  );
  assert.equal(
    codexMenu('  Select Model and Effort\n  1. A\n  2. B\n  enter select · esc back'),
    null,
    '没有选中行',
  );
});

test('an unanswered native question and an unrecognized screen cannot receive model commands', async () => {
  const blocked = fakeCodex();
  const a = harness(blocked);
  a.pane.agent.status = 'blocked';
  await assert.rejects(a.settings.apply(a.pane, { effort: 'low' }, { models: MODELS }), {
    code: 'AGENT_BLOCKED',
  });
  assert.equal(blocked.keys.length, 0);
  const unknown = fakeCodex();
  unknown.render = () => 'A different foreground screen';
  const b = harness(unknown);
  await assert.rejects(b.settings.apply(b.pane, { effort: 'low' }, { models: MODELS }), {
    code: 'NATIVE_INPUT_UNAVAILABLE',
  });
  assert.equal(unknown.keys.length, 0);
  assert.equal(unknown.composer, '');
});

test('Fast does not wait two seconds when the canonical default already matches', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-fast-config-')),
    file = path.join(directory, 'config.toml');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, 'service_tier = "fast"\n');
  const state = fakeCodex();
  state.configFile = file;
  const { pane, settings } = harness(state);
  const started = Date.now();
  const actual = await settings.apply(pane, { serviceTier: 'priority' }, { models: MODELS });
  assert(
    Date.now() - started < 1500,
    'An unchanged canonical setting must not incur the fixed two-second wait',
  );
  assert.equal(actual.serviceTier, 'priority');
  assert.equal(state.tier, 'priority');
  assert.equal(fs.readFileSync(file, 'utf8'), 'service_tier = "fast"\n');
});
test('Fast still waits for a delayed changed config write before restoring the original default', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-fast-delayed-')),
    file = path.join(directory, 'config.toml');
  let timer,
    written = false;
  t.after(() => {
    clearTimeout(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(file, 'service_tier = "default"\n');
  const state = fakeCodex(),
    original = state.press;
  state.press = (key) => {
    const fast = state.composer === '/fast' && key === 'enter';
    original(key);
    if (fast)
      timer = setTimeout(() => {
        fs.writeFileSync(file, 'service_tier = "fast"\n');
        written = true;
      }, 40);
  };
  const { pane, settings } = harness(state, { configFile: file });
  const actual = await settings.apply(pane, { serviceTier: 'priority' }, { models: MODELS });
  assert(written);
  assert.equal(actual.serviceTier, 'priority');
  assert.equal(fs.readFileSync(file, 'utf8'), 'service_tier = "default"\n');
});

test('new Codex compact footer resolves default effort without relying on a completed turn', () => {
  const models = [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [{ id: 'medium', isDefault: true }] },
  ];
  assert.deepEqual(
    statusSettings('› Ask Codex to do anything\n\n  GPT-6-Astra default · ~', models),
    { model: 'gpt-6-astra', effort: 'medium', serviceTier: null, source: 'codex-native-screen' },
  );
  assert.equal(statusSettings('GPT-6-Astra default · ~\n› draft', models), null);
});

test('Codex settings find their catalog model in any custom status field position', () => {
  for (const account of ['wwh', 'work-account', '中文账号', 'arbitrary-label']) {
    for (const fields of [
      ['GPT-6-Astra max', account, '~/workdir/swift', 'Ready'],
      [account, 'GPT-6-Astra max', '~/workdir/swift', 'Ready'],
      ['~/workdir/swift', account, 'GPT-6-Astra max', 'Ready'],
      ['Ready', account, '~/workdir/swift', 'GPT-6-Astra max'],
      ['Context 72% used', account, 'GPT-6-Astra max'],
      ['~/workdir/swift', account, 'GPT-6-Astra max'],
    ]) {
      const footer = fields.join(' · ');
      assert.deepEqual(
        statusSettings(`› \n\n  ${footer}`, MODELS),
        { model: 'gpt-6-astra', effort: 'max', serviceTier: null, source: 'codex-native-screen' },
        footer,
      );
    }
  }
  assert.deepEqual(statusSettings('» \n\n  wwh · ~/w · GPT-6-Astra ultra fast · Ready', MODELS), {
    model: 'gpt-6-astra',
    effort: 'ultra',
    serviceTier: 'priority',
    source: 'codex-native-screen',
  });
});

test('custom status settings still reject unknown models, old footers and model text in the current draft', () => {
  for (const raw of [
    '› \n\n  wwh · ~/w · UnknownModel max · Ready',
    'wwh · GPT-6-Astra max · ~/w · Ready\n\n› current draft',
    '› wwh · GPT-6-Astra max · ~/w · Ready',
    '› \n\n  wwh · Ready · Context 72% used',
  ])
    assert.equal(statusSettings(raw, MODELS), null, raw);
});

test('Ultra native footer accepts session application without opening a Swift confirmation', () => {
  const menu = codexMenu(
    'Advanced Reasoning\n\n  1. Max\n› 2. Ultra\n\n  enter apply · s session · esc back',
  );
  assert.equal(menu.kind, 'advanced');
  assert.equal(menu.efforts[menu.selected], 'ultra');
});

test('Ultra composer wins over slash suggestions and keeps the status row anchored', () => {
  const { readStatusArea } = require('../lib/agent-composer');
  const area = readStatusArea(
    '› /model  choose a model\n\n» /model\n\n  GPT-6-Astra ultra · ~/w · Ready',
  );
  assert.equal(area.composer, '/model');
  assert.deepEqual(area.statusline, ['GPT-6-Astra ultra · ~/w · Ready']);
});

test('native settings confirmation accepts soft wrapping and bounded scrollback receipts', async () => {
  for (const clipped of [false, true]) {
    const state = fakeCodex({ effort: 'high' }),
      render = state.render;
    state.log = Array(30).fill('Model changed to gpt-6-astra high for this session only');
    state.render = () => {
      const screen = render();
      if (state.menu) return screen;
      return (clipped ? screen.split('\n').slice(-10).join('\n') : screen).replaceAll(
        'for this session only',
        'for\r\nthis session only',
      );
    };
    const { pane, settings } = harness(state);
    assert.equal(
      (await settings.apply(pane, { effort: 'medium' }, { models: MODELS })).effort,
      'medium',
    );
  }
});

test('settings distinguish complete effort before native truncation from a cut-off effort', () => {
  const footer = (effort) => `› \n\n  ~ · GPT-6-Astra ${effort}  ⚠ 1 · f2`;
  assert.equal(statusSettings(footer('max…'), MODELS).effort, 'max');
  assert.equal(statusSettings(footer('ma…'), MODELS), null);
});

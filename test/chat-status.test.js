'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { archivedStatus, chatStatus } = require('../lib/chat-status');
const { readStatusArea } = require('../lib/agent-composer');
test('历史工具参数及重复后台记录不生成 Agent 状态，原生状态仍保留', () => {
  const activity = '• Working (3s • esc to interrupt)';
  const terminal = { activity, statusline: [] };
  const pane = { agent: { label: 'codex', status: 'working' } };
  const messages = [
    {
      role: 'assistant',
      blocks: [
        {
          kind: 'tools',
          items: Array.from({ length: 10 }, (_, i) => ({
            id: `wait-${i}`,
            name: 'exec',
            running: true,
            detail: 'text(await tools.write_stdin({session_id:31450}))',
          })),
        },
      ],
    },
  ];
  const result = chatStatus(terminal, pane, { model: 'gpt-test' }, messages);
  assert.equal(result.activity, activity);
  assert.deepEqual(result.statusline, ['gpt-test · working']);
  assert.equal(JSON.stringify(result).includes('write_stdin'), false);
});
test('窄终端已经截断的状态改由会话数据提供，保留完整目录和模型，移除用量并按字段配色', () => {
  const data = archivedStatus(
    'codex',
    [
      {
        type: 'turn_context',
        timestamp: '2026-09-19T01:00:00Z',
        payload: { model: 'gpt-test', effort: 'xhigh', cwd: '/long/directory' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { model_context_window: 258400, last_token_usage: { total_tokens: 113907 } },
        },
      },
    ].map(JSON.stringify),
  );
  const pane = { agent: { label: 'codex', status: 'working' }, cwd: '/long/directory' };
  const out = chatStatus(
    { statusline: ['gpt-test default · Context 39…'], statusSpans: [[{ text: 'clipped' }]] },
    pane,
    data,
    [
      {
        role: 'assistant',
        blocks: [{ kind: 'tools', items: [{ running: true, name: 'exec_command' }] }],
      },
    ],
  );
  assert.deepEqual(out.statusline, ['gpt-test · xhigh · working', '/long/directory']);
  assert.ok(new Set(out.statusSpans.flat().map((span) => span.color)).size >= 4);
  assert.deepEqual(
    out.statusSpans.map((row) => row.map((span) => span.text).join('')),
    out.statusline,
  );
  assert.equal(chatStatus({}, pane, {}).statusline, undefined, '没有数据时不得猜模型或用量');
});
test('Claude 的整条状态切成事实，颜色照旧，换行留给前端按宽度排', () => {
  const screen = [
    '›',
    '\u001b[90m[Opus 5 (1M context)]\u001b[0m \u001b[33meff:high\u001b[0m \u001b[32m55%\u001b[0m' +
      '  5h \u001b[33m20%\u001b[0m·1h  weekly \u001b[32m73%\u001b[0m·5d21h' +
      '  \u001b[01;32mchenchen2@DESKTOP-LIIC751\u001b[00m:\u001b[01;34m/home/developer/workdir/mxops\u001b[00m',
    '\u001b[90m◯ general-purpose  Reading contracts' +
      ' '.repeat(40) +
      '41m 46s · ↓ 313.9k tokens\u001b[0m',
  ].join('\n');
  const terminal = readStatusArea(screen);
  const out = chatStatus(terminal, { agent: { label: 'claude', status: 'working' } }, null);
  // 服务端不再按坐标硬切成几行：那是给某一家某一行写死的切点，换个模型名就落错
  // 位置。现在只切成事实并标出边界，排到哪儿换行由前端按真实宽度决定
  //（docs/STATUS_WRAPPING.md）。
  assert.deepEqual(out.statusline, [
    '[Opus 5 (1M context)] eff:high 55%  5h 20%·1h  weekly 73%·5d21h  chenchen2@DESKTOP-LIIC751:/home/developer/workdir/mxops',
    '◯ general-purpose  Reading contracts  41m 46s · ↓ 313.9k tokens',
  ]);
  const facts = (row) =>
    row.reduce((out, span) => {
      if (span.startsFact || !out.length) out.push(span.text);
      else out[out.length - 1] += span.text;
      return out;
    }, []);
  assert.deepEqual(facts(out.statusSpans[0]), [
    '[Opus 5 (1M context)] eff:high 55%  ',
    '5h 20%·1h  ',
    'weekly 73%·5d21h  ',
    'chenchen2@DESKTOP-LIIC751:',
    '/home/developer/workdir/mxops',
  ]);
  assert.deepEqual(
    out.statusSpans.map((row) => row.map((span) => span.text).join('')),
    out.statusline,
  );
  // 颜色本身是信息（快满了还是还早），切成事实不能把它抹平。
  assert.equal(
    new Set(out.statusSpans[0].map((span) => span.color).filter(Boolean)).size,
    4,
    '模型、强度、额度、路径的颜色都留着',
  );
  assert.ok(
    out.statusSpans[0]
      .filter((span) => span.text.includes('/home/developer'))
      .every((span) => span.color),
    '工作目录保留终端给的路径色',
  );
});
test('认不出形状的状态行原样保留，不按猜测拆开', () => {
  const terminal = {
    statusline: ['Context left until auto-compact: 12%'],
    statusSpans: [[{ text: 'Context left until auto-compact: 12%' }]],
  };
  const out = chatStatus(terminal, { agent: { label: 'claude' } }, null);
  assert.deepEqual(out.statusline, ['Context left until auto-compact: 12%']);
});
test('状态区保留超过两行的有效状态及颜色', () => {
  const lines = ['›', '[model]', '⏵ permissions', 'Quota · 50%', 'Context · 25%'];
  const result = readStatusArea(lines.join('\n'));
  assert.deepEqual(result.statusline, lines.slice(1));
  assert.equal(result.statusSpans.length, 4);
});
test('活动行下面的 Tip 整条取回，右对齐的行和工具结果都不算它的续行', () => {
  const rule = '─'.repeat(40);
  const base = [
    '✽ Topsy-turvying… (17m 1s · ↓ 447.4k tokens)',
    '  ⎿ \u00a0Tip: Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
  ];
  const tail = [
    `${' '.repeat(60)}◎ /goal active (7h)`,
    rule,
    '❯',
    rule,
    '    [Opus 5] eff:high 12%',
  ];
  assert.equal(
    readStatusArea([...base, ...tail].join('\n')).tip,
    'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
  );
  // 终端按宽度折行时，续行只有缩进，要接回来。
  assert.equal(
    readStatusArea([...base, '    and MCP servers in one place', ...tail].join('\n')).tip,
    'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools and MCP servers in one place',
  );
  // `⎿` 也是工具结果的续行符号，只认写着 Tip: 的那一条。
  assert.equal(
    readStatusArea([base[0], '  ⎿ Read 320 lines from src/example.js', ...tail].join('\n')).tip,
    '',
  );
  // 没有活动行就没有提示可言。
  assert.equal(readStatusArea([base[1], ...tail].join('\n')).tip, '');
});
test('额度按实际窗口识别，一周额度不会误当五小时，缺失窗口不虚构', () => {
  const status = chatStatus(
    {},
    { agent: { label: 'codex' } },
    {
      model: 'gpt-test',
      rateLimits: {
        primary: { window_minutes: 10080, used_percent: 19, resets_at: 1790361116 },
        secondary: null,
      },
    },
  );
  assert.ok(status.statusline.some((line) => line.startsWith('weekly 81% left · resets ')));
  assert.ok(!status.statusline.some((line) => line.startsWith('5h')));
});
test('额度统一显示剩余比例，双窗口与单窗口使用相同名称和颜色判据', () => {
  const pane = { agent: { label: 'codex' } };
  const rateLimits = {
    primary: { window_minutes: 300, used_percent: 48 },
    secondary: { window_minutes: 10080, used_percent: 49 },
  };
  const status = chatStatus({}, pane, { model: 'gpt-test', rateLimits });
  assert.deepEqual(status.statusline.slice(1), ['5h 52% left', 'weekly 51% left']);
  assert.deepEqual(
    status.statusSpans.map((row) => row.map((span) => span.text).join('')),
    status.statusline,
  );
  assert.equal(rateLimits.primary.used_percent, 48, '格式化不能修改原始额度');
  for (const [used, expected, color] of [
    [0, 100, '#9bce78'],
    [70, 30, '#e8c47a'],
    [90, 10, '#ee929b'],
    [100, 0, '#ee929b'],
    [120, 0, '#ee929b'],
    [-2, 100, '#9bce78'],
    [49.6, 50, '#9bce78'],
  ]) {
    const result = chatStatus({}, pane, {
      model: 'gpt-test',
      rateLimits: { primary: { window_minutes: 10080, used_percent: used } },
    });
    assert.equal(result.statusline[1], `weekly ${expected}% left`);
    assert.equal(result.statusSpans[1][1].color, color);
  }
});
test('缺失或未知窗口不猜 weekly，缺失或无效额度不显示', () => {
  const render = (window) =>
    chatStatus(
      {},
      { agent: { label: 'codex' } },
      { model: 'gpt-test', rateLimits: { primary: window } },
    ).statusline.slice(1);
  assert.deepEqual(render({ window_minutes: 60, used_percent: 25 }), ['60min 75% left']);
  assert.deepEqual(render({ used_percent: 25 }), ['quota 75% left']);
  for (const used_percent of [null, undefined, NaN, Infinity, '25'])
    assert.deepEqual(render({ window_minutes: 10080, used_percent }), []);
});
test('Claude 权限模式单独成行显示在最后，只剥掉按不了的快捷键提示', () => {
  // 权限模式说明这个会话敢不敢直接动机器，是终端上一眼能看到的安全提示，
  // 网页漏掉它等于少一项信息。但 shift+tab 在网页上按不了，留着是假承诺。
  const terminal = {
    statusline: [
      '[Opus] high · used 40%',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents',
    ],
    statusSpans: [
      [{ text: '[Opus]', color: '#ffaa00' }, { text: ' high · used 40%' }],
      [
        { text: '⏵⏵ bypass permissions on (shift+tab to cycle)', color: '#d97757' },
        { text: ' · ← 7 agents' },
      ],
    ],
    activity: 'Working',
  };
  const result = chatStatus(terminal, { agent: { label: 'Claude Code' } });

  assert.equal(result.statusline.length, 2);
  assert.equal(result.statusline[0], '[Opus] high · used 40%');
  assert.equal(
    result.statusline.at(-1),
    '⏵⏵ bypass permissions on · ← 7 agents',
    '权限行排在最后，紧跟当前目录之后',
  );
  // 颜色分段要保留，界面上才能和终端长得一样。
  assert.equal(result.statusSpans.at(-1)[0].color, '#d97757');
  assert.equal(terminal.statusline.length, 2, '不能改动传入的对象');
  assert.equal(result.activity, 'Working');
});

test('权限行尾巴上的「后台还剩什么在跑」另起一行，颜色分段跟着走', () => {
  const line = '⏵⏵ bypass permissions on (shift+tab to cycle) · 11 shells, 2 monitors · ← 7 agents';
  const terminal = {
    statusline: ['[Opus] high · used 40%', line],
    statusSpans: [
      [{ text: '[Opus] high · used 40%' }],
      [
        { text: '⏵⏵ bypass permissions on (shift+tab to cycle)', color: '#d97757' },
        { text: ' · 11 shells, 2 monitors · ← 7 agents', color: '#b0b0bb' },
      ],
    ],
    activity: 'Working',
  };
  const result = chatStatus(terminal, { agent: { label: 'Claude Code' } });
  // 终端有一整行宽度，手机没有；断在计数那一段的开头，内容一个字不少。
  assert.deepEqual(result.statusline.slice(-2), [
    '⏵⏵ bypass permissions on',
    '11 shells, 2 monitors · ← 7 agents',
  ]);
  assert.equal(result.statusSpans.at(-2)[0].color, '#d97757');
  assert.equal(result.statusSpans.at(-1)[0].color, '#b0b0bb');
});

test('单独一行的循环快捷键提示仍然丢弃', () => {
  const terminal = {
    statusline: ['[Opus] high', 'shift+tab to cycle'],
    statusSpans: [[{ text: '[Opus] high' }], [{ text: 'shift+tab to cycle' }]],
  };
  const result = chatStatus(terminal, { agent: { label: 'Claude Code' } });
  assert.deepEqual(result.statusline, ['[Opus] high']);
});
test('重置额度显示短倒计时，并保留刷新时间用于客户端推进', () => {
  const { resetCountdown } = require('../public/ui-model');
  const now = 1800000000000;
  assert.equal(resetCountdown(now / 1000 + 26 * 3600, now), '1d2h');
  assert.equal(resetCountdown(now / 1000 + 3660, now), '1h1m');
  assert.equal(resetCountdown(now / 1000 - 30, now), '0m');
  const resets = Math.floor(Date.now() / 1000) + 26 * 3600;
  const status = chatStatus(
    {},
    { agent: { label: 'codex' } },
    { model: 'test', rateLimits: { primary: { used_percent: 10, resets_at: resets } } },
  );
  assert.ok(status.statusline.some((line) => /resets 1d2h$/.test(line)));
  assert.equal(status.statusSpans.flat().find((span) => span.resetsAt).resetsAt, resets);
});

test('Codex 状态行一比一复刻终端，不按存档重拼', () => {
  // 重拼会丢掉终端里有而我们没建的字段。这一行取自真实画面：
  // 工作区名、分支名和 Context 用量都只存在于终端，存档里没有。
  const line =
    'gpt-6-astra high · ~/workdir/mxops · mxops · proveforkernel · Working · Context 9% used · weekly 60% left';
  const terminal = {
    statusline: [line],
    statusSpans: [
      [
        { text: 'gpt-6-astra', color: '#8fc7ff' },
        {
          text: ' high · ~/workdir/mxops · mxops · proveforkernel · Working · Context 9% used · weekly 60% left',
        },
      ],
    ],
  };
  const result = chatStatus(
    terminal,
    { agent: { label: 'codex', status: 'working' }, cwd: '/home/developer/workdir/mxops' },
    { model: 'gpt-6-astra', effort: 'high', recordedAt: '2026-09-22T00:00:00Z' },
  );

  assert.equal(result.statusline[0], line, '终端给了完整一行就原样用，不重拼');
  assert.equal(result.statusSource, 'terminal');
  for (const piece of ['mxops', 'proveforkernel', 'Context 9% used']) {
    assert(result.statusline.join(' ').includes(piece), `重拼会丢掉「${piece}」`);
  }
  assert.equal(result.statusSpans[0][0].color, '#8fc7ff', '颜色分段要保留');
});

test('终端那行被截断时才回退到按存档重拼', () => {
  // 窄屏会把它截断，这时重拼比显示半截更有用。
  const terminal = {
    statusline: ['gpt-6-astra high · ~/workdir/mx…'],
    statusSpans: [[{ text: 'gpt-6-astra high · ~/workdir/mx…' }]],
  };
  const result = chatStatus(
    terminal,
    { agent: { label: 'codex', status: 'working' }, cwd: '/home/developer/workdir/mxops' },
    { model: 'gpt-6-astra', effort: 'high', recordedAt: '2026-09-22T00:00:00Z' },
  );
  assert.equal(result.statusSource, 'session');
  assert.equal(result.statusline[0], 'gpt-6-astra · high · working');
  assert(result.statusline.includes('/home/developer/workdir/mxops'));
});

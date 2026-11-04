'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HerdrClient, HerdrError, clampInt, parseCliEnvelope } = require('../lib/herdr-client');

test('parseCliEnvelope unwraps successful API responses', () => {
  assert.deepEqual(parseCliEnvelope('{"id":"x","result":{"type":"ok","value":3}}'), {
    type: 'ok',
    value: 3,
  });
});

test('agentPane resolves only the requested native occupant without a session snapshot', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' }),
    calls = [];
  client.query = async (method, params) => {
    calls.push({ method, params });
    return {
      agent: {
        pane_id: 'w1:pAZ',
        terminal_id: 'terminal',
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        agent: 'codex',
        name: 'reviewer',
        agent_status: 'working',
        agent_session: { kind: 'uuid', value: 'thread' },
        foreground_cwd: '/repo',
      },
    };
  };
  client.snapshot = () => assert.fail('input must not enumerate other panes');
  const pane = await client.agentPane('w1:pAZ');
  assert.equal(pane.paneId, 'w1:pAZ');
  assert.equal(pane.agent.label, 'codex');
  assert.equal(pane.agent.session.value, 'thread');
  assert.equal(pane.terminalId, 'terminal');
  assert.equal(pane.cwd, '/repo');
  assert.deepEqual(calls, [{ method: 'agent.get', params: { target: 'w1:pAZ' } }]);
  await assert.rejects(client.agentPane('wrong'), { code: 'TARGET_NOT_FOUND' });
});

test('parseCliEnvelope keeps Herdr error codes', () => {
  assert.throws(
    () => parseCliEnvelope('{"error":{"code":"NO_PANE","message":"gone"}}'),
    (error) => error instanceof HerdrError && error.code === 'NO_PANE' && error.message === 'gone',
  );
});

test('clampInt applies bounds and fallback', () => {
  assert.equal(clampInt('120', 20, 100, 80), 100);
  assert.equal(clampInt('3', 20, 100, 80), 20);
  assert.equal(clampInt('nope', 20, 100, 80), 80);
});

test('normalizeSnapshot binds agents to stable pane and terminal ids', () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const normalized = client.normalizeSnapshot({
    version: '0.7.4',
    protocol: 16,
    focused_pane_id: 'w1:p1',
    focused_workspace_id: 'w1',
    workspaces: [{ workspace_id: 'w1', label: 'project', number: 1 }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1 }],
    panes: [
      {
        pane_id: 'w1:p1',
        terminal_id: 'term_1',
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        foreground_cwd: '/repo',
        focused: true,
      },
    ],
    agents: [
      {
        pane_id: 'w1:p1',
        terminal_id: 'term_1',
        name: 'reviewer',
        agent_status: 'working',
        session_ref: 'abc',
      },
    ],
  });
  assert.equal(normalized.panes.length, 1);
  assert.equal(normalized.panes[0].terminalId, 'term_1');
  assert.equal(normalized.panes[0].agent.name, 'reviewer');
  assert.equal(normalized.panes[0].status, 'working');
  assert.equal(normalized.panes[0].workspace, 'project');
});

test('resolveTarget never accepts an arbitrary process or command', async () => {
  const client = new HerdrClient();
  client.dashboard = async () => ({
    panes: [{ paneId: 'w1:p1', terminalId: 'term_1', agent: null }],
  });
  assert.equal((await client.resolveTarget('term_1')).paneId, 'w1:p1');
  await assert.rejects(
    client.resolveTarget('bash -c anything'),
    (error) => error.code === 'TARGET_NOT_FOUND',
  );
});

function tabClient(focusedTabId) {
  const client = new HerdrClient({ bin: '/does/not/run' });
  // Deliberately unsorted so the test also covers ordering by tab number.
  const tabs = [
    {
      tab_id: 'w9:tC',
      workspace_id: 'w9',
      label: '第三个',
      number: 12,
      focused: focusedTabId === 'w9:tC',
    },
    {
      tab_id: 'w9:tA',
      workspace_id: 'w9',
      label: '第一个',
      number: 5,
      focused: focusedTabId === 'w9:tA',
    },
    {
      tab_id: 'w9:tB',
      workspace_id: 'w9',
      label: '第二个',
      number: 9,
      focused: focusedTabId === 'w9:tB',
    },
  ];
  client.focusCalls = [];
  client.json = async (args) => {
    if (args[0] === 'tab' && args[1] === 'list') return { tabs };
    client.focusCalls.push(args[2]);
    return { tab: tabs.find((tab) => tab.tab_id === args[2]) };
  };
  return client;
}

test('cycleTab orders tabs by number and moves in both directions', async () => {
  const forward = tabClient('w9:tA');
  assert.equal((await forward.cycleTab('next')).tabId, 'w9:tB');
  assert.deepEqual(forward.focusCalls, ['w9:tB']);

  const backward = tabClient('w9:tB');
  assert.equal((await backward.cycleTab('prev')).tabId, 'w9:tA');
});

test('cycleTab wraps around at both ends', async () => {
  assert.equal((await tabClient('w9:tC').cycleTab('next')).tabId, 'w9:tA');
  assert.equal((await tabClient('w9:tA').cycleTab('prev')).tabId, 'w9:tC');
});

test('cycleTab is a no-op with a single tab and rejects with none', async () => {
  const single = new HerdrClient({ bin: '/does/not/run' });
  single.focusCalls = [];
  single.json = async (args) => {
    if (args[1] === 'list')
      return { tabs: [{ tab_id: 'w9:tA', label: '唯一', number: 1, focused: true }] };
    single.focusCalls.push(args[2]);
    return {};
  };
  assert.equal((await single.cycleTab('next')).tabId, 'w9:tA');
  assert.deepEqual(single.focusCalls, [], '单个标签页不应该触发 focus 调用');

  const empty = new HerdrClient({ bin: '/does/not/run' });
  empty.json = async () => ({ tabs: [] });
  await assert.rejects(empty.cycleTab('next'), (error) => error.code === 'NO_TABS');
});

test('两家都在 pane 里独立启动：不预建线程、不带 --remote', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.resolveTarget = async () => ({
    paneId: 'w1:p2',
    terminalId: 'term-new',
    cwd: '/project with spaces',
  });
  let captured;
  client.json = async (args, options) => {
    captured = { args, options };
    return {};
  };
  for (const kind of ['codex', 'claude']) {
    await client.startAgentInPane('w1:p2', kind, `new-${kind}`);
    assert.deepEqual(captured.args, [
      'agent',
      'start',
      `new-${kind}`,
      '--kind',
      kind,
      '--pane',
      'w1:p2',
    ]);
    assert.equal(captured.options.timeoutMs, 120000);
  }
});

test('恢复在终端里原生进行：Codex 是规范的 resume <id>，Claude 是 --resume <id>', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.createTab = async () => ({ root_pane: { pane_id: 'w1:p3' } });
  client.resolveTarget = async () => ({ paneId: 'w1:p3', terminalId: 't', agent: null });
  const calls = [];
  client.json = async (args) => {
    calls.push(args);
    return {};
  };
  await client.resumeAgent({ provider: 'codex', sessionId: 'thread-1', cwd: '/w/p' }, 'w1');
  await client.resumeAgent({ provider: 'claude', sessionId: 'uuid-2', cwd: '/w/p' }, 'w1');
  const tail = (args) => args.slice(args.indexOf('--') + 1);
  // ⚠️ 恰好两项：多带参数 Herdr 就认不出这个 pane 是哪个会话。
  assert.deepEqual(tail(calls[0]), ['resume', 'thread-1']);
  assert.deepEqual(tail(calls[1]), ['--resume', 'uuid-2']);
  assert(!calls.some((args) => args.includes('--remote')));
});

test('快照里的会话身份只来自 Herdr，保留启动中的状态字段', () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const normalized = client.normalizeSnapshot({
    panes: [{ pane_id: 'w1:p2', terminal_id: 'term' }],
    agents: [
      {
        pane_id: 'w1:p2',
        name: 'new',
        agent: 'codex',
        agent_session: null,
        agent_status: 'idle',
        interactive_ready: true,
        launch_pending: false,
      },
    ],
  }).panes[0];
  assert.equal(normalized.agent.session, null);
  assert.equal(normalized.agent.name, 'new');
  assert.equal(normalized.agent.interactiveReady, true);
  assert.equal(normalized.agent.launchPending, false);
});

test('Claude directory trust is a pending startup, not a failed launch', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  let launched = false;
  client.resolveTarget = async () => ({
    paneId: 'w1:p2',
    terminalId: 'terminal',
    cwd: '/project',
    agent: launched ? { name: 'new-claude', label: 'claude', status: 'blocked' } : null,
  });
  client.json = async () => {
    launched = true;
    throw Object.assign(new Error('not ready'), { code: 'agent_not_ready' });
  };
  client.readPane = async () =>
    'Accessing workspace:\n\n /project\n\n ❯ No, exit\n   Yes, I trust this folder';
  const result = await client.startAgentInPane('w1:p2', 'claude', 'new-claude');
  assert.equal(result.status, 'awaiting_confirmation');
  assert.equal(result.startup.cwd, '/project');
  await assert.rejects(client.startAgentInPane('w1:p2', 'claude'), { code: 'PANE_NOT_AVAILABLE' });
  launched = false;
  client.readPane = async () => 'An unrelated error';
  await assert.rejects(client.startAgentInPane('w1:p2', 'claude'), { code: 'agent_not_ready' });
});

test('标签页标签与原生终端标题分开，不使用随机启动标识符作为标题', () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const dashboard = client.normalizeSnapshot({
    workspaces: [],
    tabs: [{ tab_id: 'tab', label: '我的标签页' }],
    panes: [{ pane_id: 'pane', tab_id: 'tab', terminal_title_stripped: '真正会话标题' }],
    agents: [{ pane_id: 'pane', name: 'codex-mu7sxlt6', agent: 'codex' }],
  });
  assert.equal(dashboard.panes[0].tabTitle, '我的标签页');
  assert.equal(dashboard.panes[0].agentTitle, '真正会话标题');
  assert.equal(dashboard.panes[0].title, '我的标签页');
});
test('中文显示名传给 Codex 会话，内部启动标识符仍独立；重命名只修改目标标签页', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.resolveTarget = async () => ({
    paneId: 'p',
    tabId: 't',
    terminalId: 'term',
    cwd: '/project',
  });
  client.remoteSessions = { bind() {} };
  client.codexControl = {
    startThread: async (cwd, name) => {
      assert.equal(name, '中文会话名称');
      return { id: 'thread' };
    },
  };
  const calls = [];
  client.json = async (args) => {
    calls.push(args);
    return {};
  };
  await client.startAgentInPane('p', 'codex', '中文会话名称');
  assert.match(calls[0][2], /^codex-/);
  await client.renameTab('p', '新的标签页');
  assert.deepEqual(calls[1], ['tab', 'rename', 't', '新的标签页']);
});

test('用户起的会话名直接写在标签页上，不填则留 Herdr 的默认编号', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const calls = [];
  client.json = async (args) => {
    calls.push(args);
    return { root_pane: { pane_id: 'w1:p2' } };
  };
  client.startAgentInPane = async (paneId, provider, name) => {
    assert.equal(paneId, 'w1:p2');
    assert.equal(provider, 'codex');
    return {};
  };
  // 会话只有一级名字，标签页就是它（docs/PRODUCT_SPEC.md 2.5）。
  await client.startAgent({ workspaceId: 'w1', provider: 'codex', name: '中文会话名称' });
  assert.deepEqual(calls, [
    ['tab', 'create', '--no-focus', '--workspace', 'w1', '--label', '中文会话名称'],
  ]);
  // 不填名字就不带 --label：留着默认编号，等内容够了由系统自动命名。
  calls.length = 0;
  await client.startAgent({ workspaceId: 'w1', provider: 'codex' });
  assert.deepEqual(calls, [['tab', 'create', '--no-focus', '--workspace', 'w1']]);
});

test('新建会话不等 Agent 就绪：标签页一建好就返回，起完再回调', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.json = async () => ({ root_pane: { pane_id: 'w1:p2' } });
  let release;
  const launched = new Promise((resolve) => {
    release = resolve;
  });
  client.startAgentInPane = () => launched;
  const done = [];
  client.onAgentStarted = (paneId, error) => done.push([paneId, error?.message || null]);
  // Agent 的 TUI 要几秒才能接收输入（实测 codex 约 4.4 秒），等它返回界面就僵住了。
  const result = await client.startAgent({ workspaceId: 'w1', provider: 'codex' });
  assert.deepEqual(result, { paneId: 'w1:p2', provider: 'codex', status: 'starting' });
  assert.deepEqual(done, [], '这时候还没起完');
  release({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(done, [['w1:p2', null]]);
});

test('后台启动失败要收拾干净：关掉标签页并把失败报上来', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.json = async () => ({ root_pane: { pane_id: 'w1:p2' } });
  client.startAgentInPane = async () => {
    throw new Error('launch failed');
  };
  const closed = [];
  client.closeSession = async (id) => {
    closed.push(id);
  };
  const done = [];
  client.onAgentStarted = (paneId, error) => done.push([paneId, error?.message || null]);
  await client.startAgent({ workspaceId: 'w1', provider: 'codex' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(closed, ['w1:p2'], '失败路径也要清理，否则留下建好却没人管的标签页');
  assert.deepEqual(done, [['w1:p2', 'launch failed']]);
});

test('wait:true 保留同步语义：等就绪，失败就地回滚', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.json = async () => ({ root_pane: { pane_id: 'w1:p2' } });
  client.startAgentInPane = async () => ({ status: 'ready' });
  assert.deepEqual(await client.startAgent({ workspaceId: 'w1', provider: 'codex', wait: true }), {
    status: 'ready',
    paneId: 'w1:p2',
  });
  client.startAgentInPane = async () => {
    throw new Error('launch failed');
  };
  let cleaned = false;
  client.closeSession = async () => {
    cleaned = true;
  };
  await assert.rejects(client.startAgent({ workspaceId: 'w1', provider: 'codex', wait: true }));
  assert(cleaned);
});

test('恢复原生会话在原目录新建标签页、沿用原 id；新标签页失败时清理', async () => {
  for (const provider of ['codex', 'claude']) {
    const client = new HerdrClient({ bin: '/does/not/run' }),
      calls = [];
    client.createTab = async (options) => {
      assert.deepEqual(options, { cwd: '/project with spaces', workspaceId: 'w1' });
      return { root_pane: { pane_id: 'w1:p2' } };
    };
    client.resolveTarget = async () => ({
      paneId: 'w1:p2',
      terminalId: 'term2',
      cwd: '/project with spaces',
    });
    client.json = async (args) => {
      calls.push(args);
      return {};
    };
    const result = await client.resumeAgent(
      { provider, sessionId: 'original-id', cwd: '/project with spaces', title: '旧会话' },
      'w1',
    );
    assert.equal(result.sessionId, 'original-id');
    const args = calls[0];
    assert(args.includes(provider === 'codex' ? 'resume' : '--resume'));
    assert(args.includes('original-id'));
    // 目录由新建标签页给出；Codex 的参数必须恰好是 resume <id>，Herdr 才认得出会话。
    if (provider === 'codex') assert.deepEqual(args.slice(-2), ['resume', 'original-id']);
    let cleaned = false;
    client.json = async () => {
      throw new Error('launch failed');
    };
    client.closeSession = async (id) => {
      assert.equal(id, 'w1:p2');
      cleaned = true;
    };
    await assert.rejects(
      client.resumeAgent(
        { provider: 'codex', sessionId: 'old', cwd: '/project with spaces' },
        'w1',
      ),
    );
    assert(cleaned);
  }
});
test('关闭独占会话回收 tab，分屏只关闭目标 pane，拒绝替换后的身份', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const pane = {
    paneId: 'w:p',
    tabId: 'w:t',
    terminalId: 'term',
    agent: { label: 'codex', session: { value: 's' } },
  };
  let panes = [pane],
    args;
  client.resolveTarget = async () => pane;
  client.dashboard = async () => ({ panes });
  client.sessionBindings = () => ({ remove: () => {} });
  client.json = async (a) => {
    args = a;
    return {};
  };
  await client.closeSession('w:p', { terminalId: 'term', sessionId: 's' });
  assert.deepEqual(args, ['tab', 'close', 'w:t']);
  panes = [pane, { paneId: 'other', tabId: 'w:t' }];
  await client.closeSession('w:p');
  assert.deepEqual(args, ['pane', 'close', 'w:p']);
  await assert.rejects(client.closeSession('w:p', { sessionId: 'replacement' }), {
    code: 'SESSION_CHANGED',
  });
});

test('移动会话必须带 --new-tab：只给 --workspace 会被 herdr 拒掉', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const args = [];
  client.json = async (value) => {
    args.push(value);
    return {};
  };
  client.resolveTarget = async (target) => ({ paneId: String(target) });
  await client.movePane('w0:p9', 'w11');
  // `pane move <id> --workspace <ws>` 单独用是 usage error —— 这个写操作曾经从没成功过。
  assert.deepEqual(args[0], [
    'pane',
    'move',
    'w0:p9',
    '--new-tab',
    '--workspace',
    'w11',
    '--no-focus',
  ]);
  // 名字要一起带过去：新标签页默认取 herdr 的编号，不给 --label 就等于把会话改了名。
  client.resolveTarget = async (target) => ({ paneId: String(target), tabTitle: '架构升级' });
  await client.movePane('w0:pA', 'w11');
  assert.deepEqual(args[1], [
    'pane',
    'move',
    'w0:pA',
    '--new-tab',
    '--workspace',
    'w11',
    '--no-focus',
    '--label',
    '架构升级',
  ]);
  client.resolveTarget = async (target) => ({ paneId: String(target) });
  await assert.rejects(
    () => client.movePane('w0:p9', ''),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('分屏显式定位使用 pane.focus 的准确 ID，不把聚焦 Tab 当成 Pane', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.resolveTarget = async () => ({ paneId: 'w1:p2', tabId: 'w1:t1', tab: 'two panes' });
  let request;
  client.request = async (method, params) => {
    request = { method, params };
    return {};
  };
  client.json = async () => {
    throw new Error('must not focus tab');
  };
  assert.equal((await client.focusPane('w1:p2')).paneId, 'w1:p2');
  assert.deepEqual(request, { method: 'pane.focus', params: { pane_id: 'w1:p2' } });
  client.request = async () => {
    throw new Error('not found');
  };
  await assert.rejects(client.focusPane('w1:p2'), /not found/);
});

test('原生完成序号保留可选和 null 语义，不伪造旧版服务字段', () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  const base = { panes: [{ pane_id: 'p' }] };
  const pane = (extra) =>
    client.normalizeSnapshot({ ...base, agents: [{ pane_id: 'p', agent: 'codex', ...extra }] })
      .panes[0];
  assert.equal(Object.hasOwn(pane({}).agent, 'completionSeq'), false);
  assert.equal(pane({ completion_seq: null }).agent.completionSeq, null);
  assert.equal(pane({ completion_seq: 42, state_change_seq: 42 }).agent.completionSeq, 42);
  assert.equal(pane({ completion_seq: 42, state_change_seq: 42 }).agent.stateChangeSeq, 42);
});

test('读画面默认取缓冲区末尾，不取视口：视口跟着 Herdr 里的滚动走', async () => {
  const client = new HerdrClient({ bin: '/does/not/run' });
  client.resolveTarget = async () => ({ paneId: 'w1:p1' });
  let args;
  client.run = async (value) => {
    args = value;
    return '';
  };
  await client.readPane('w1:p1', { lines: 100, ansi: true });
  assert.equal(args[args.indexOf('--source') + 1], 'recent');
});

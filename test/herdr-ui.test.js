'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { invoke } = require('../lib/herdr-ui');
const { HerdrClient } = require('../lib/herdr-client');
const { slimSnapshot, snapshotChange } = require('../lib/sync/hub');
const { applySnapshot } = require('../public/session-sync');
const original = {
  version: '0.9.3',
  protocol: 22,
  focused_tab_id: 't',
  workspaces: [
    {
      workspace_id: 'w',
      label: 'repo',
      agent_status: 'blocked',
      active_tab_id: 't',
      tokens: { branch: 'main', custom: '<b>' },
      worktree: { repo_key: 'r', is_linked_worktree: false },
    },
  ],
  tabs: [{ tab_id: 't', workspace_id: 'w', label: 'review' }],
  panes: [
    {
      pane_id: 'p',
      terminal_id: 'terminal',
      tab_id: 't',
      workspace_id: 'w',
      restore_error: 'resume failed',
      tokens: { load: '90' },
      state_labels: { blocked: 'approval' },
    },
  ],
  layouts: [{ tab_id: 't', area: { x: 0, y: 0, width: 80, height: 24 }, panes: [] }],
};
function fixture() {
  const calls = [];
  const view = new HerdrClient({ socketPath: '/nonexistent/swift-test' }).normalizeSnapshot(
    original,
  );
  return {
    calls,
    view,
    dashboard: async () => view,
    request: async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    },
  };
}
function startingFixture() {
  const f = fixture();
  f.view.runtimeId = 'runtime';
  f.reads = 0;
  f.readProcessInfo = async () => {
    f.reads++;
    return {
      pane_id: 'p',
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: [{ pid: 100, name: 'bash' }],
    };
  };
  f.start = (timeoutMs = 1000) =>
    invoke(
      f,
      'agent.start',
      { pane_id: 'p', name: 'new-codex', kind: 'codex' },
      { runtimeId: 'runtime', terminalId: 'terminal' },
      { shellWait: { timeoutMs, pollMs: 1 } },
    );
  return f;
}
test('Agent startup waits for a stable foreground Shell and submits its launch once', async () => {
  const f = startingFixture(),
    shell = f.readProcessInfo;
  f.readProcessInfo = async () => {
    const info = await shell();
    // The first sample can precede Bash startup. A later foreground command
    // must reset the two-sample check rather than accepting that initial gap.
    if ([2, 3].includes(f.reads)) info.foreground_processes.push({ pid: 101, name: 'sleep' });
    return info;
  };
  await f.start();
  assert.equal(f.reads, 5);
  assert.deepEqual(f.calls, [
    { method: 'agent.start', params: { pane_id: 'p', name: 'new-codex', kind: 'codex' } },
  ]);
  assert.equal(f.startingPanes.size, 0);
});
test('Agent startup rejects changed runtime, terminal, location, occupant and Shell before writing', async () => {
  const cases = [
    [
      (f) => {
        f.view.runtimeId = 'replacement';
      },
      'RUNTIME_CHANGED',
    ],
    [
      (f) => {
        f.view.panes[0].terminalId = 'replacement';
      },
      'TARGET_CHANGED',
    ],
    [
      (f) => {
        f.view.panes[0].tabId = 'replacement';
      },
      'TARGET_CHANGED',
    ],
    [
      (f) => {
        f.view.panes = [];
      },
      'TARGET_GONE',
    ],
    [
      (f) => {
        f.view.panes[0].agent = { label: 'codex' };
      },
      'PANE_NOT_AVAILABLE',
    ],
    [
      (f) => {
        f.view.panes.push({ paneId: 'other', agent: { name: 'new-codex' } });
      },
      'AGENT_NAME_TAKEN',
    ],
  ];
  for (const [change, code] of cases) {
    const f = startingFixture(),
      dashboard = f.dashboard;
    let reads = 0;
    f.dashboard = async () => {
      // Copy the original identity so mutations during the wait do not alter
      // the evidence captured by invoke's first dashboard read.
      if (++reads === 3) change(f);
      return structuredClone(await dashboard());
    };
    await assert.rejects(f.start(), { code });
    assert.equal(f.calls.length, 0);
    assert.equal(f.startingPanes.size, 0);
  }
  for (const [replacement, code] of [
    [null, 'SHELL_UNAVAILABLE'],
    [101, 'TARGET_CHANGED'],
  ]) {
    const f = startingFixture(),
      shell = f.readProcessInfo;
    f.readProcessInfo = async () => {
      const info = await shell();
      if (f.reads === 2) info.shell_pid = replacement;
      return info;
    };
    await assert.rejects(f.start(), { code });
    assert.equal(f.calls.length, 0);
  }
});
test('Agent startup has a bounded read-only wait and does not replay uncertain or rejected launch calls', async () => {
  for (const hanging of [false, true]) {
    const f = startingFixture(),
      shell = f.readProcessInfo;
    f.readProcessInfo = hanging
      ? () => new Promise(() => {})
      : async () => {
          const info = await shell();
          info.foreground_process_group_id = 101;
          return info;
        };
    const before = Date.now();
    await assert.rejects(f.start(100), { code: 'SHELL_NOT_READY' });
    assert(Date.now() - before < 1000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.startingPanes.size, 0);
  }
  for (const code of ['TIMEOUT', 'agent_pane_busy', 'agent_start_input_failed']) {
    const f = startingFixture();
    let writes = 0;
    f.request = async () => {
      writes++;
      throw Object.assign(new Error('native rejection'), { code });
    };
    await assert.rejects(f.start(), { code });
    assert.equal(writes, 1);
    assert.equal(f.startingPanes.size, 0);
  }
});
test('simultaneous Agent startup actions cannot both submit to the same Shell', async () => {
  const f = startingFixture();
  let release;
  const blocked = new Promise((resolve) => {
      release = resolve;
    }),
    shell = f.readProcessInfo;
  f.readProcessInfo = async () => {
    await blocked;
    return shell();
  };
  const first = f.start();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.start(), { code: 'PANE_NOT_AVAILABLE' });
  release();
  await first;
  assert.equal(f.calls.length, 1);
});
test('complete topology and restore errors survive normalization, delta sync, and full cache replacement', () => {
  const view = fixture().view;
  assert.equal(view.panes[0].restoreError, 'resume failed');
  assert.equal(view.workspaces[0].tokens.custom, '<b>');
  assert.equal(view.workspaces[0].activeTabId, 't');
  const first = slimSnapshot(view);
  const next = {
    ...first,
    runtimeId: 'fresh-runtime',
    layouts: [{ ...first.layouts[0], zoomed: true }],
  };
  const change = snapshotChange(first, next);
  assert.deepEqual(change.layouts, next.layouts);
  assert.equal(change.runtimeId, 'fresh-runtime');
  assert.equal(applySnapshot(first, { ...change, hash: 'b' }).runtimeId, 'fresh-runtime');
  assert.deepEqual(
    applySnapshot({ ...first, hash: 'a' }, { ...change, hash: 'b' }).layouts,
    next.layouts,
  );
  assert.deepEqual(
    applySnapshot({ ...next, hash: 'b' }, { full: true, hash: 'c', panes: [] }).layouts,
    [],
  );
});
test('worktree groups preserve native parent order, selected children and unrelated Spaces', () => {
  const { workspaceEntries } = require('../public/ui-model');
  const workspaces = [
    { workspaceId: 'child', worktree: { repo_key: 'r', is_linked_worktree: true } },
    { workspaceId: 'other' },
    { workspaceId: 'parent', worktree: { repo_key: 'r', is_linked_worktree: false } },
  ];
  assert.deepEqual(
    workspaceEntries(workspaces).map((e) => [e.workspace.workspaceId, e.indented]),
    [
      ['parent', false],
      ['child', true],
      ['other', false],
    ],
  );
  assert.deepEqual(
    workspaceEntries(workspaces, () => true).map((e) => e.workspace.workspaceId),
    ['parent', 'other'],
  );
  assert.deepEqual(
    workspaceEntries(workspaces, () => true, 'child').map((e) => e.workspace.workspaceId),
    ['parent', 'child', 'other'],
  );
});
test('Tab operations reject missing targets, replaced terminals and removed split actions', async () => {
  const f = fixture();
  await assert.rejects(invoke(f, 'pane.focus', {}, {}), { code: 'TARGET_REQUIRED' });
  await assert.rejects(invoke(f, 'tab.close', { tab_id: 't' }, { terminalId: 'old' }), {
    code: 'TARGET_CHANGED',
  });
  for (const action of [
    'pane.split',
    'pane.close',
    'pane.rename',
    'pane.zoom',
    'pane.resize',
    'pane.swap',
    'pane.move',
    'layout.set_split_ratio',
    'pane.send_text',
  ]) {
    await assert.rejects(invoke(f, action, {}, {}), { code: 'UNSUPPORTED_ACTION' });
  }
  await assert.rejects(invoke(f, 'pane.focus', { pane_id: 'gone' }, { terminalId: 'terminal' }), {
    code: 'TARGET_GONE',
  });
  assert.equal(f.calls.length, 0);
  await invoke(f, 'tab.close', { tab_id: 't' }, { terminalId: 'terminal' });
  assert.deepEqual(f.calls[0], { method: 'tab.close', params: { tab_id: 't' } });
});
test('structure mutations reject menus from an earlier native runtime, including Workspace operations', async () => {
  const f = fixture();
  f.view.runtimeId = 'new-generation';
  await assert.rejects(
    invoke(f, 'workspace.close', { workspace_id: 'w' }, { runtimeId: 'old-generation' }),
    { code: 'RUNTIME_CHANGED' },
  );
  assert.equal(f.calls.length, 0);
  await invoke(
    f,
    'workspace.rename',
    { workspace_id: 'w', label: 'renamed' },
    { runtimeId: 'new-generation' },
  );
});
test('named Session adapters isolate topology, stores and authenticated requests without changing the global client', async (t) => {
  const net = require('node:net'),
    { fork } = require('node:child_process');
  const { HerdrSessions } = require('../lib/herdr-sessions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-session-scope-'));
  const directory = path.join(dir, 'sessions');
  const sockets = [];
  for (const name of ['one', 'two']) {
    fs.mkdirSync(path.join(directory, name), { recursive: true });
    const server = net.createServer((socket) => {
      // One-shot readers close after their response; observation readers can also
      // cancel while the fixture is writing. Only peer-disconnect errors are expected.
      socket.on('error', (error) => {
        if (!['ECONNRESET', 'EPIPE'].includes(error.code)) throw error;
      });
      socket.once('data', (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === 'events.subscribe') {
          socket.end(JSON.stringify({ id: message.id, result: { type: 'subscribed' } }) + '\n');
          return;
        }
        const snapshot = {
          version: 'fixture',
          protocol: 22,
          workspaces: [{ workspace_id: 'w', label: name }],
          tabs: [{ tab_id: 't', workspace_id: 'w', label: name }],
          panes: [
            {
              pane_id: 'p',
              terminal_id: `term-${name}`,
              workspace_id: 'w',
              tab_id: 't',
              agent_status: 'unknown',
            },
          ],
          agents: [],
          layouts: [],
        };
        socket.end(JSON.stringify({ id: message.id, result: { snapshot } }) + '\n');
      });
    });
    await new Promise((resolve) =>
      server.listen(path.join(directory, name, 'herdr.sock'), resolve),
    );
    sockets.push(server);
  }
  const herdr = new HerdrClient({
    session: 'one',
    socketPath: path.join(directory, 'one/herdr.sock'),
  });
  const gateway = new (require('../lib/herdr-sessions').HerdrSessions)({
    herdr,
    root: () => dir,
    dataDirectory: () => path.join(dir, 'swift'),
    spawn: (file, args, options) =>
      fork(file, args, {
        ...options,
        env: { ...options.env, HOME: dir, SWIFT_MACHINES_FILE: path.join(dir, 'machines.json') },
      }),
  });
  t.after(async () => {
    gateway.close();
    await new Promise((r) => setTimeout(r, 500));
    for (const socket of sockets) socket.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(
    gateway.list().map((s) => s.name),
    ['one', 'two'],
  );
  await assert.rejects(gateway.connect('../escape'), { code: 'SESSION_OFFLINE' });
  const [one, two, repeated] = await Promise.all([
    gateway.connect('one'),
    gateway.connect('two'),
    gateway.connect('one'),
  ]);
  assert.equal(one, repeated);
  assert.equal(gateway.connections.size, 2);
  assert.notEqual(one.port, two.port);
  const fetchSnapshot = async (connection) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}/api/snapshot`, {
      headers: { 'x-agent-studio-token': connection.token },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const views = await Promise.all([fetchSnapshot(one), fetchSnapshot(two)]);
  assert.equal(views[0].workspaces[0].label, 'one');
  assert.equal(views[1].workspaces[0].label, 'two');
  assert.equal(herdr.session, 'one');
  assert.equal(views[0].panes[0].terminalId, 'term-one');
  assert.equal(views[1].panes[0].terminalId, 'term-two');
  const unauthorized = await fetch(`http://127.0.0.1:${two.port}/api/snapshot`, {
    headers: { 'x-agent-studio-token': one.token },
  });
  assert.equal(unauthorized.status, 401);
  const parentToken = require('node:crypto').randomBytes(32).toString('hex');
  const parent = fork(path.resolve(__dirname, '../server.js'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      HOME: dir,
      HOST: '127.0.0.1',
      PORT: '0',
      SWIFT_TOKEN: parentToken,
      SWIFT_DIRECT_AUTH: 'token',
      SWIFT_BASE_PATH: '/swift',
      SWIFT_HIDE_STARTUP_URLS: '1',
      SWIFT_SESSION_CHILD: '1',
      SWIFT_MANAGEMENT_CONFIG: '',
      SWIFT_ROOT_DIR: dir,
      SWIFT_DATA_DIR: path.join(dir, 'parent-roots'),
      SWIFT_SETTINGS_FILE: path.join(dir, 'parent-settings.json'),
      SWIFT_MACHINES_FILE: path.join(dir, 'machines.json'),
      HERDR_SESSION: 'one',
      HERDR_SOCKET_PATH: herdr.socketPath,
    },
  });
  t.after(() => parent.kill('SIGTERM'));
  const parentPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parent fixture startup timeout')), 15000);
    parent.once('error', reject);
    parent.on('message', (message) => {
      if (message.swiftSessionPort) {
        clearTimeout(timer);
        resolve(message.swiftSessionPort);
      }
    });
  });
  const base = `http://127.0.0.1:${parentPort}/swift/herdr-sessions/two`;
  const headers = { 'x-agent-studio-token': parentToken };
  const app = await fetch(base + '/', { headers });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert(
    (await app.text()).includes(
      'name="agent-studio-base-path" content="/swift/herdr-sessions/two"',
    ),
  );
  const proxied = await fetch(base + '/api/snapshot', { headers });
  assert.equal(proxied.status, 200);
  assert.equal((await proxied.json()).workspaces[0].label, 'two');
  const refused = await fetch(base + '/api/snapshot');
  assert.equal(refused.status, 401);
  const WebSocket = require('ws');
  const peer = new WebSocket(base.replace('http:', 'ws:') + '/api/terminal?observe=1', { headers });
  t.after(() => peer.terminate());
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Session observation relay timeout')), 10000);
    peer.once('error', reject);
    peer.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data));
    });
  });
  assert.equal(ready.transport, 'observe');
  peer.close();
});

'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const {
  CodexTerminalRefresh,
  RefreshHelper,
  snapshotGuard,
} = require('../lib/codex-terminal-refresh');
const { rowsToAnsi } = require('../lib/codex-rewind-watch');
const pane = {
  paneId: 'p',
  terminalId: 't',
  workspaceId: 'w',
  tabId: 'tab',
  runtimeId: '1:2',
  agent: { label: 'codex', session: { kind: 'id', value: 's' } },
};
function frame(mode, sequence = 1) {
  const rows =
    mode === 'unknown'
      ? [[{ text: '00% left' }]]
      : mode === 'modal'
        ? [[{ text: 'Approval required' }]]
        : [
            [
              { text: '› ', bold: true },
              { text: 'Ask Codex to do anything', dim: true },
            ],
            [],
            [
              {
                text:
                  'GPT-6.1-Sol default · ~' +
                  (mode === 'side' ? ' · Side from main thread · ^/ for side' : ''),
              },
            ],
          ];
  return {
    rows,
    raw: rowsToAnsi(rows),
    cursor: { x: 2, y: 0 },
    endColumns: rows.map((r) => r.map((s) => s.text).join('').length),
    frameSequence: sequence,
    watchId: 'watch',
  };
}
function setup(options = {}) {
  let phase = 0,
    starts = 0,
    closes = 0,
    now = 0,
    fail = false;
  const commands = [];
  let current = structuredClone(pane);
  const snapshot = {
    focused_pane_id: 'p',
    focused_workspace_id: 'w',
    focused_tab_id: 'tab',
    panes: [
      {
        pane_id: 'p',
        terminal_id: 't',
        workspace_id: 'w',
        tab_id: 'tab',
        agent_session: { value: 's' },
        agent: { label: 'codex', status: 'working' },
      },
    ],
    agents: [],
    layouts: [{ tab_id: 'tab', panes: [{ pane_id: 'p', rect: { width: 120, height: 53 } }] }],
  };
  const helper = {
    next: async (type) => {
      if (type === 'prepared') options.onPrepared?.(snapshot, current);
      if (options.helperFailure === type) throw Error('helper disconnected');
      return { type, original: [53, 120, 960, 848] };
    },
    command: (command) => {
      commands.push(command);
      if (command === 'narrow') phase = 1;
      if (command === 'restore') phase = 2;
    },
    close: async () => {
      closes++;
    },
  };
  const refresh = new CodexTerminalRefresh({
    herdr: {
      socketPath: '/fixture/socket',
      readProcessInfo: async () => ({
        foreground_processes: [{ pid: 1 }],
        foreground_process_group_id: options.badPgid ? 2 : 1,
      }),
      snapshot: async () => snapshot,
    },
    exactPane: async () => current,
    readIdentity: async () => ({ pid: 1, start: '2', tty: '/dev/pts/1', pgrp: 1, ttyNr: 1 }),
    readSocketIdentity: async () => ({ dev: '1', ino: '2', ctimeNs: '3' }),
    startHelper: () => {
      starts++;
      return helper;
    },
    readScreen: async () => {
      if (fail || (options.disconnect && phase === 1)) throw Error('observer disconnected');
      return frame(
        phase === 2
          ? options.finalMode || 'main'
          : phase === 1
            ? options.narrowMode || 'main'
            : options.initialMode || 'unknown',
        phase + 1,
      );
    },
    frameTimeoutMs: 12,
    stepMs: 1,
    now: options.fakeClock ? () => now : () => performance.now(),
    cooldownMs: 20,
  });
  return {
    refresh,
    snapshot,
    commands,
    get starts() {
      return starts;
    },
    get closes() {
      return closes;
    },
    options: () => ({ pane, requestId: 'one', reason: 'prewrite-unknown' }),
    retry: () => {
      phase = 0;
      now += 21;
    },
    fail: () => {
      fail = true;
    },
    current,
  };
}
test('explicit unknown refresh only restores through helper then confirms a fresh main frame', async () => {
  const f = setup(),
    r = await f.refresh.refresh(f.options());
  assert.equal(r.mainConfirmed, true);
  assert.equal(r.temporaryViewConfirmed, true);
  assert.deepEqual(f.commands, ['narrow', 'restore']);
  assert.equal(f.closes, 1);
});
test('read-only/background or invalid operation never starts helper', async () => {
  for (const change of [
    { reason: 'poll' },
    { requestId: '' },
    { pane: { ...pane, agent: { label: 'shell' } } },
  ]) {
    const f = setup();
    await assert.rejects(f.refresh.refresh({ ...f.options(), ...change }), {
      code: 'NATIVE_REFRESH_UNAVAILABLE',
    });
    assert.equal(f.starts, 0);
  }
});
test('a naturally restored complete main screen succeeds without starting a helper', async () => {
  const f = setup({ initialMode: 'main' });
  assert.deepEqual(await f.refresh.refresh(f.options()), {
    ok: true,
    refreshed: false,
    mainConfirmed: true,
    requestId: 'one',
  });
  assert.equal(f.starts, 0);
  assert.deepEqual(f.commands, []);
});
test('current native focus is required without focus writes', async () => {
  const f = setup();
  f.snapshot.focused_pane_id = 'other';
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_NOT_FOCUSED' });
  assert.equal(f.starts, 0);
});
test('foreground PID and PGID are independently required', async () => {
  const f = setup({ badPgid: true });
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_PROCESS_CHANGED' });
  assert.equal(f.starts, 0);
});
test('layout change after prepare aborts before narrow and closes owned helper', async () => {
  const f = setup({
    onPrepared: (s) => {
      s.layouts[0].panes[0].rect.width = 121;
    },
  });
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_OWNER_CHANGED' });
  assert.deepEqual(f.commands, []);
  assert.equal(f.closes, 1);
});
test('session change after prepare rejects before ioctl command', async () => {
  const f = setup({
    onPrepared: (_s, p) => {
      p.agent.session.value = 'other';
    },
  });
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_TARGET_CHANGED' });
  assert.deepEqual(f.commands, []);
});
test('nested agent identity is captured while changing dynamic status is ignored', async () => {
  const f = setup({
    onPrepared: (s) => {
      s.panes[0].agent.status = 'idle';
      s.agents[0].agent.status = 'idle';
    },
  });
  f.snapshot.agents = [
    {
      terminal: { pane_id: 'p' },
      id: 'agent',
      session_ref: { value: 's' },
      agent: { label: 'codex', status: 'working' },
    },
  ];
  assert.equal(snapshotGuard(f.snapshot, pane).paneAgent.id, 'agent');
  assert.equal((await f.refresh.refresh(f.options())).mainConfirmed, true);
});
test('observer loss after narrow cannot send another mutate command and reaches helper cleanup', async () => {
  const f = setup({ disconnect: true });
  await assert.rejects(f.refresh.refresh(f.options()), /observer disconnected/);
  assert.deepEqual(f.commands, ['narrow']);
  assert.equal(f.closes, 1);
});
test('restored side or modal never passes as complete main', async () => {
  for (const finalMode of ['side', 'modal']) {
    const f = setup({ finalMode });
    await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_UNCONFIRMED' });
    assert.deepEqual(f.commands, ['narrow', 'restore']);
    assert.equal(f.closes, 1);
  }
});
test('same binding inflight merges, then explicit retry is possible after bounded cooldown', async () => {
  const f = setup({ fakeClock: true });
  const a = f.refresh.refresh(f.options()),
    b = f.refresh.refresh(f.options());
  assert.equal(a, b);
  await a;
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_COOLDOWN' });
  f.retry();
  await f.refresh.refresh(f.options());
  assert.equal(f.starts, 2);
});

test('a temporary unknown frame reaches guarded restore before requiring a fresh complete main', async () => {
  const f = setup({ narrowMode: 'unknown' });
  const result = await f.refresh.refresh(f.options());
  assert.equal(result.temporaryViewConfirmed, false);
  assert.equal(result.mainConfirmed, true);
  assert.deepEqual(f.commands, ['narrow', 'restore']);
  assert.equal(f.closes, 1);
});

test('a temporary paint timeout never accepts an unknown, Side or modal final frame', async () => {
  for (const finalMode of ['unknown', 'side', 'modal']) {
    const f = setup({ narrowMode: 'unknown', finalMode });
    await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_UNCONFIRMED' });
    assert.deepEqual(f.commands, ['narrow', 'restore']);
    assert.equal(f.closes, 1);
  }
});

test('an initial main frame without the current composer cursor is rejected without repaint', async () => {
  const f = setup({ initialMode: 'main' });
  f.refresh.readScreen = async () => ({ ...frame('main'), cursor: { x: 0, y: 2 } });
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_NOT_UNKNOWN' });
  assert.equal(f.starts, 0);
});

function helperFixture() {
  const { EventEmitter } = require('node:events'),
    { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit('close', null, 'SIGTERM');
  };
  const helper = new RefreshHelper({}, { spawnProcess: () => child, timeoutMs: 1000 });
  return { child, helper, emit: (value) => child.stdout.write(value) };
}
test('helper protocol failure takes precedence over an older queued acknowledgement', async () => {
  const f = helperFixture();
  f.emit('{"type":"prepared"}\ninvalid\n');
  await assert.rejects(f.helper.next('prepared'), { code: 'NATIVE_REFRESH_PROTOCOL' });
  f.child.emit('close', 0, null);
  await f.helper.close();
});
test('helper timeout takes precedence over an older queued acknowledgement', async () => {
  const f = helperFixture();
  f.emit('{"type":"narrowed"}\n');
  f.helper.invalidate(Object.assign(Error('timeout'), { code: 'NATIVE_REFRESH_TIMEOUT' }));
  await assert.rejects(f.helper.next('narrowed'), { code: 'NATIVE_REFRESH_TIMEOUT' });
  f.child.emit('close', 0, null);
  await f.helper.close();
});
test('a clean helper exit preserves its already queued final restore acknowledgement', async () => {
  const f = helperFixture();
  f.emit('{"type":"restored"}\n');
  f.child.emit('close', 0, null);
  assert.equal((await f.helper.next('restored')).type, 'restored');
  await f.helper.close();
});
test('an abnormal helper exit cannot be accepted from a queued final acknowledgement', async () => {
  const f = helperFixture();
  f.emit('{"type":"restored"}\n');
  f.child.emit('close', 1, null);
  await assert.rejects(f.helper.next('restored'), { code: 'NATIVE_REFRESH_HELPER_FAILED' });
  await f.helper.close();
});

test('Python held-tty guards and cleanup retain ownership across EOF, signals and races', () => {
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(
    'python3',
    [
      '-I',
      path.join(__dirname, 'codex-terminal-refresh-helper.py'),
      path.join(__dirname, '../lib/codex-terminal-refresh.py'),
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.pure.count, 12);
  assert.equal(report.lifecycle.count, 7);
});

test('an unrelated observer error with the same public code does not trigger an explicit restore', async () => {
  const f = setup();
  f.refresh.readScreen = async () => {
    if (f.commands.includes('narrow'))
      throw Object.assign(Error('observer failed'), { code: 'NATIVE_REFRESH_UNCONFIRMED' });
    return frame('unknown', 1);
  };
  await assert.rejects(f.refresh.refresh(f.options()), /observer failed/);
  assert.deepEqual(f.commands, ['narrow']);
  assert.equal(f.closes, 1);
});
test('fallback restore requires a frame newer than the last temporary observation', async () => {
  const f = setup({ narrowMode: 'unknown' });
  f.refresh.readScreen = async () =>
    f.commands.includes('restore')
      ? frame('main', 2)
      : f.commands.includes('narrow')
        ? frame('unknown', 2)
        : frame('unknown', 1);
  await assert.rejects(f.refresh.refresh(f.options()), { code: 'NATIVE_REFRESH_UNCONFIRMED' });
  assert.deepEqual(f.commands, ['narrow', 'restore']);
});

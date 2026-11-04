'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { CodexFork } = require('../lib/codex-fork');
const parentId = '11111111-1111-4111-8111-111111111111',
  childId = '22222222-2222-4222-8222-222222222222';
const screen =
  '› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  fixture-model default · /fixture · Ready';
function fixture({
  status = 'active',
  deferred = true,
  sourceGoal = status
    ? { goal_id: 'goal', objective: 'Original goal', token_budget: 100, status }
    : null,
} = {}) {
  const parent = {
    paneId: 'parent',
    terminalId: 'parent-terminal',
    tabId: 'parent-tab',
    workspaceId: 'workspace',
    runtimeId: 'parent-process',
    agent: { label: 'codex', status: 'working', session: { value: parentId } },
  };
  const state = {
    parent,
    child: null,
    goal: null,
    deferred,
    calls: [],
    phases: [],
    parentWrites: [],
    clock: 0,
    forkCalls: 0,
    pauseCalls: 0,
    launch: {
      binary: '/fixture/bin/codex',
      cwd: '/fixture',
      args: ['--no-daemon', '-c', 'model="fixture-model"', 'resume', parentId],
      env: { HOME: '/fixture', CODEX_HOME: '/fixture/.codex' },
      goalHome: '/fixture/.codex',
    },
    view: {
      runtimeId: 'herdr-runtime',
      focusedPaneId: 'parent',
      tabs: [{ tab_id: 'parent-tab', workspace_id: 'workspace' }],
      panes: [parent],
    },
  };
  const herdr = {
    socketPath: '/fixture/isolated-herdr.sock',
    dashboard: async () => structuredClone(state.view),
    readProcessInfo: async () => ({
      shell_pid: process.pid,
      foreground_process_group_id: process.pid,
      foreground_processes: [{ pid: process.pid, name: 'sh' }],
    }),
    readPane: async () => screen,
    request: async (method, params) => {
      state.calls.push({ method, params: structuredClone(params) });
      if (params.pane_id === 'parent' || params.target === 'parent')
        state.parentWrites.push({ method, params });
      if (method === 'tab.create') {
        state.child = {
          paneId: 'child',
          terminalId: 'child-terminal',
          tabId: 'child-tab',
          workspaceId: 'workspace',
          agent: null,
        };
        state.view.panes.push(state.child);
        state.view.tabs.push({ tab_id: 'child-tab', workspace_id: 'workspace' });
        return {
          tab: { tab_id: 'child-tab' },
          root_pane: { pane_id: 'child', terminal_id: 'child-terminal' },
        };
      }
      if (method === 'pane.run') {
        Object.assign(state.child, {
          runtimeId: 'child-process',
          agent: { label: 'codex', session: { value: childId } },
        });
      }
      return {};
    },
  };
  herdr.run = async (args, options) => {
    state.runOptions = options;
    return herdr.request('pane.run', { pane_id: args[2], command: args[3] });
  };
  const native = new CodexFork({
    herdr,
    exactPane: async (id) => structuredClone(state.view.panes.find((pane) => pane.paneId === id)),
    capture: async (_pane, options) => {
      state.captureOptions = options;
      return { ...state.launch };
    },
    resolveBinary: async () => ({
      binary: '/fixture/bin/current-codex',
      version: 'codex-cli 0.164.0',
    }),
    runCodex: async (binary, args, options) => {
      state.forkCalls++;
      state.exec = { binary, args, options };
      state.goal = sourceGoal && { ...sourceGoal, thread_id: childId };
      return JSON.stringify({ type: 'thread.started', thread_id: childId });
    },
    readGoal: async (id) => structuredClone(id === parentId ? sourceGoal : state.goal),
    readDeferred: async () => state.deferred,
    pauseGoal: async (pane, { verify }) => {
      await verify();
      assert.equal(pane.paneId, 'child');
      state.pauseCalls++;
      state.goal.status = 'paused';
    },
    timeoutMs: 50,
    pollMs: 10,
    now: () => state.clock,
    wait: async (ms) => {
      state.clock += ms;
    },
  });
  const progress = async (value) => {
    state.phases.push(structuredClone(value));
  };
  return { state, herdr, native, parent, progress, sourceGoal };
}

test('busy native Fork writes only the child, preserves parent options and pauses its inherited Goal', async () => {
  const f = fixture(),
    result = await f.native.run(f.parent, { progress: f.progress });
  assert.deepEqual(result, {
    sessionId: childId,
    tabId: 'child-tab',
    paneId: 'child',
    terminalId: 'child-terminal',
    goalPaused: true,
    goalStatus: 'paused',
  });
  assert.equal(f.state.forkCalls, 1);
  assert.equal(f.state.pauseCalls, 1);
  assert.deepEqual(f.state.parentWrites, []);
  assert.equal(f.state.exec.binary, '/fixture/bin/current-codex');
  assert.deepEqual(f.state.captureOptions, { binaryOverride: '/fixture/bin/current-codex' });
  assert.deepEqual(
    f.state.exec.args.slice(-8),
    [
      'exec',
      '--cd',
      '/fixture',
      'fork',
      parentId,
      '--json',
      '--thread-source',
      'user',
      '--skip-git-repo-check',
    ].slice(-8),
  );
  assert(f.state.exec.args.includes('--enable'));
  assert(f.state.exec.args.includes('goals'));
  assert(!f.state.exec.args.includes('/goal pause'));
  assert(!f.state.exec.args.includes('resume'));
  assert.equal(f.state.exec.options.env.CODEX_HOME, '/fixture/.codex');
  assert(
    !Object.keys(f.state.exec.options.env).some(
      (key) => key.startsWith('HERDR_') || key === 'CODEX_THREAD_ID',
    ),
  );
  assert.deepEqual(
    f.state.calls.map((call) => call.method),
    ['tab.create', 'tab.move', 'pane.run'],
  );
  assert.equal(f.state.calls[0].params.focus, false);
  assert.deepEqual(f.state.runOptions, {
    env: { HERDR_SOCKET_PATH: '/fixture/isolated-herdr.sock' },
  });
  assert.deepEqual(f.state.calls[1].params, { tab_id: 'child-tab', insert_index: 1 });
  const command = f.state.calls[2].params.command;
  assert(command.endsWith("'resume' '" + childId + "'"));
  assert(!command.includes(parentId));
  assert(!command.includes('/goal pause'));
  assert.equal(f.state.phases[0].phase, 'forking');
  assert.equal(f.state.phases[1].sessionId, childId);
  assert.equal(
    f.state.phases.find((value) => value.phase === 'tab-created').terminalId,
    'child-terminal',
  );
  assert.equal(f.sourceGoal.status, 'active');
  assert.equal(f.state.view.focusedPaneId, 'parent');
});

test('natural parent turn completion does not invalidate the Fork binding', async () => {
  const f = fixture();
  await f.native.run(f.parent, {
    progress: f.progress,
    validate: async () => {
      f.state.parent.agent.status = 'idle';
    },
  });
  assert.equal(f.state.forkCalls, 1);
  assert.deepEqual(f.state.parentWrites, []);
});

test('no Goal and terminal Goals never create or revive a Goal', async () => {
  for (const status of [null, 'complete', 'budget_limited', 'paused']) {
    const f = fixture({ status });
    const result = await f.native.run(f.parent, { progress: f.progress });
    assert.equal(f.state.pauseCalls, 0);
    assert.equal(result.goalStatus, status);
    assert.equal(result.goalPaused, status === 'paused');
    assert(!f.state.exec.args.includes('resume'));
    assert.deepEqual(f.state.parentWrites, []);
  }
});

test('missing native deferral stops an active child before any Tab is created', async () => {
  const f = fixture({ deferred: false });
  await assert.rejects(f.native.run(f.parent, { progress: f.progress }), (error) => {
    assert.equal(error.code, 'FORK_GOAL_NOT_DEFERRED');
    assert.equal(error.partial.sessionId, childId);
    return true;
  });
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.state.pauseCalls, 0);
});

test('durable progress must succeed before Fork and before every later native mutation', async () => {
  for (const blocked of [
    'forking',
    'forked',
    'creating-tab',
    'tab-created',
    'positioning-tab',
    'tab-positioned',
    'starting-child',
    'child-started',
    'pausing-goal',
  ]) {
    const f = fixture();
    await assert.rejects(
      f.native.run(f.parent, {
        progress: async (value) => {
          await f.progress(value);
          if (value.phase === blocked) throw new Error('ledger unavailable');
        },
      }),
      /ledger unavailable/,
    );
    const last = f.state.phases.at(-1);
    assert.equal(last.phase, blocked);
    const expectedForks = blocked === 'forking' ? 0 : 1;
    assert.equal(f.state.forkCalls, expectedForks);
    const created = [
      'tab-created',
      'positioning-tab',
      'tab-positioned',
      'starting-child',
      'child-started',
      'pausing-goal',
    ].includes(blocked);
    assert.equal(
      f.state.calls.filter((call) => call.method === 'tab.create').length,
      Number(created),
    );
    const started = ['child-started', 'pausing-goal'].includes(blocked);
    assert.equal(
      f.state.calls.filter((call) => call.method === 'pane.run').length,
      Number(started),
    );
    assert.equal(f.state.pauseCalls, 0);
    assert(!f.state.calls.some((call) => /close|interrupt/.test(call.method)));
  }
});

test('uncertain Fork execution is not converted to a second Fork or an empty successful result', async () => {
  const f = fixture();
  f.native.runCodex = async () => {
    f.state.forkCalls++;
    throw new Error('reply lost');
  };
  await assert.rejects(f.native.run(f.parent, { progress: f.progress }), (error) => {
    assert.equal(error.deliveryUncertain, true);
    assert.equal(error.partial.phase, 'forking');
    assert(!error.partial.sessionId);
    return true;
  });
  assert.equal(f.state.forkCalls, 1);
  assert.deepEqual(f.state.calls, []);
});

test('lost pause reply keeps known child IDs and the original native deferral', async () => {
  const f = fixture();
  f.native.pauseGoal = async () => {
    throw new Error('pause reply lost');
  };
  await assert.rejects(f.native.run(f.parent, { progress: f.progress }), (error) => {
    assert.equal(error.partial.sessionId, childId);
    assert.equal(error.partial.paneId, 'child');
    assert.equal(error.partial.phase, 'pausing-goal');
    return true;
  });
  assert(f.state.deferred);
  assert.equal(f.state.goal.status, 'active');
  assert.equal(f.sourceGoal.status, 'active');
  assert(!f.state.calls.some((call) => /close|interrupt/.test(call.method)));
  assert.deepEqual(f.state.parentWrites, []);
});

test('source changes before the first mutation reject without executing native Fork', async () => {
  for (const field of ['terminalId', 'tabId', 'workspaceId', 'runtimeId']) {
    const f = fixture();
    const original = structuredClone(f.parent);
    f.state.parent[field] += '-changed';
    await assert.rejects(f.native.run(original, { progress: f.progress }), {
      code: 'FORK_SOURCE_CHANGED',
    });
    assert.equal(f.state.forkCalls, 0);
    assert.deepEqual(f.state.calls, []);
  }
});

test('a child replaced before pause is never given the native command', async () => {
  const f = fixture();
  await assert.rejects(
    f.native.run(f.parent, {
      progress: async (value) => {
        await f.progress(value);
        if (value.phase === 'child-started') f.state.child.agent.session.value = parentId;
      },
    }),
    { code: 'FORK_CHILD_CHANGED' },
  );
  assert.equal(f.state.pauseCalls, 0);
  assert.deepEqual(f.state.parentWrites, []);
});

test('native output cannot silently identify the parent or multiple child sessions as a successful Fork', async () => {
  for (const output of [
    JSON.stringify({ type: 'thread.started', thread_id: parentId }),
    '{bad json',
    [childId, childId]
      .map((thread_id) => JSON.stringify({ type: 'thread.started', thread_id }))
      .join('\n'),
  ]) {
    const f = fixture();
    f.native.runCodex = async () => output;
    await assert.rejects(f.native.run(f.parent, { progress: f.progress }), (error) => {
      assert.equal(error.deliveryUncertain, true);
      return true;
    });
    assert.deepEqual(f.state.calls, []);
  }
});

test('the child Goal operation uses its own shared input lock', async () => {
  const f = fixture(),
    locks = [];
  let locked = false;
  f.native.operate = async (id, work) => {
    locks.push(id);
    locked = true;
    try {
      return await work();
    } finally {
      locked = false;
    }
  };
  const pause = f.native.pauseGoal;
  f.native.pauseGoal = async (...args) => {
    assert(locked);
    return pause(...args);
  };
  await f.native.run(f.parent, { progress: f.progress });
  assert.deepEqual(locks, ['child']);
  assert.deepEqual(f.state.parentWrites, []);
});

test('a lost native Tab or launch reply retains partial IDs and reports uncertain delivery', async () => {
  for (const method of ['tab.create', 'tab.move', 'pane.run']) {
    const f = fixture(),
      request = f.herdr.request;
    f.herdr.request = async (...args) => {
      if (args[0] === method) throw new Error('native reply lost');
      return request(...args);
    };
    await assert.rejects(f.native.run(f.parent, { progress: f.progress }), (error) => {
      assert.equal(error.deliveryUncertain, true);
      assert.equal(error.partial.sessionId, childId);
      return true;
    });
    assert.equal(f.state.forkCalls, 1);
    assert(!f.state.calls.some((call) => /close|interrupt/.test(call.method)));
  }
});

test('a process that replaced the new Shell never receives a resume command', async () => {
  const f = fixture();
  await assert.rejects(
    f.native.run(f.parent, {
      progress: async (fields) => {
        await f.progress(fields);
        if (fields.phase === 'starting-child')
          f.herdr.readProcessInfo = async () => ({
            shell_pid: process.pid,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, name: 'python' }],
          });
      },
    }),
    { code: 'FORK_TAB_OCCUPIED' },
  );
  assert(!f.state.calls.some((call) => call.method === 'pane.run'));
  assert.deepEqual(f.state.parentWrites, []);
});

test('a paused inherited Goal chooses Leave paused before returning an editable composer', async () => {
  const f = fixture({ status: 'paused' });
  let selected = 0,
    open = true;
  const request = f.herdr.request;
  f.herdr.readPane = async () =>
    open
      ? `Resume paused goal?\nGoal: Original goal\n${selected === 0 ? '›' : ' '} 1. Resume goal  Mark it active and continue when idle\n${selected === 1 ? '›' : ' '} 2. Leave paused  Keep it paused; use /goal resume later\nenter select · esc back`
      : screen;
  f.herdr.request = async (method, params) => {
    if (method === 'agent.send_keys') {
      assert.equal(params.target, 'child');
      if (params.keys[0] === 'down') selected = 1;
      else {
        assert.equal(selected, 1);
        assert.equal(params.keys[0], 'enter');
        open = false;
      }
    }
    return request(method, params);
  };
  const result = await f.native.run(f.parent, { progress: f.progress });
  assert.equal(result.goalStatus, 'paused');
  assert.equal(f.state.pauseCalls, 0);
  assert(!open);
  assert.deepEqual(
    f.state.calls
      .filter((call) => call.method === 'agent.send_keys')
      .map((call) => call.params.keys),
    [['down'], ['enter']],
  );
});

test('an unverified installed Codex version is rejected before creating a Fork', async () => {
  const f = fixture();
  f.native.resolveBinary = async () => ({
    binary: '/fixture/bin/codex',
    version: 'codex-cli 0.163.0',
  });
  await assert.rejects(f.native.run(f.parent, { progress: f.progress }), {
    code: 'FORK_NATIVE_UNSUPPORTED',
  });
  assert.equal(f.state.forkCalls, 0);
  assert.deepEqual(f.state.calls, []);
});

test('Fork can capture an old deleted parent executable while using the verified current binary', async () => {
  const fs = require('node:fs/promises'),
    { captureLaunch, processStart } = require('../lib/codex-restart');
  const readlink = fs.readlink,
    readFile = fs.readFile,
    pid = process.pid;
  const pane = {
    paneId: 'old-parent',
    runtimeId: await processStart(pid),
    agent: { session: { value: parentId } },
  };
  const herdr = {
    readProcessInfo: async () => ({ shell_pid: pid, foreground_processes: [{ pid }] }),
  };
  fs.readlink = async (file) =>
    file === `/proc/${pid}/exe`
      ? '/removed/codex (deleted)'
      : file === `/proc/${pid}/cwd`
        ? '/fixture'
        : readlink(file);
  fs.readFile = async (file, ...args) =>
    file === `/proc/${pid}/cmdline`
      ? Buffer.from('/removed/codex\0--no-daemon\0')
      : file === `/proc/${pid}/environ`
        ? Buffer.from(
            'HOME=/fixture\0CODEX_HOME=/fixture/.codex\0PRIVATE_TOKEN=must-not-be-copied\0',
          )
        : readFile(file, ...args);
  try {
    const launch = await captureLaunch(herdr, pane, { binaryOverride: '/verified/current/codex' });
    assert.equal(launch.binary, '/verified/current/codex');
    assert.deepEqual(launch.args, ['--no-daemon', 'resume', parentId]);
    assert.deepEqual(launch.env, { HOME: '/fixture', CODEX_HOME: '/fixture/.codex' });
    await assert.rejects(captureLaunch(herdr, pane), { code: 'RESTART_UNCONFIRMED' });
  } finally {
    fs.readlink = readlink;
    fs.readFile = readFile;
  }
});

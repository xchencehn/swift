'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { GoalActions, revision, editorInputMatches } = require('../lib/goal-actions');
function fixture() {
  const state = {
    goal: {
      objective: 'Original goal',
      status: 'paused',
      token_budget: 8000,
      created_at_ms: 100,
      tokens_used: 10,
    },
    writes: [],
    pane: { paneId: 'pane', runtimeId: 'process' },
  };
  const commands = {
    leases: new Map(),
    beforeWrite: async () => {},
    target: async () => state.pane,
    operate: (_id, fn) => fn(),
    execute: async (body) => {
      state.writes.push(body.text);
      if (body.text === '/goal clear') state.goal = null;
      if (body.text === '/goal resume') state.goal.status = 'active';
      if (body.text === '/goal pause') state.goal.status = 'paused';
    },
    herdr: { readPane: async () => '' },
  };
  const actions = new GoalActions({
    commands,
    readGoal: async () => structuredClone(state.goal),
    stepMs: 1,
    timeoutMs: 5,
  });
  const body = {
    paneId: 'pane',
    runtimeId: 'runtime',
    terminalId: 'terminal',
    sessionId: 'session',
    clientId: 'client',
    processRuntimeId: 'process',
    revision: revision(state.goal),
    requestId: 'request',
    action: 'resume',
  };
  const run = async (patch = {}) => {
    const b = { ...body, ...patch };
    await actions.start(b);
    await actions.running.get(b.requestId);
    return actions.get(b.requestId);
  };
  return { state, commands, actions, body, run };
}
test('Goal revisions ignore live accounting but distinguish recreated goals and changed budgets', () => {
  const { state } = fixture(),
    g = state.goal;
  assert.equal(
    revision(g),
    revision({ ...g, tokens_used: 5000, updated_at_ms: 200, time_used_seconds: 10 }),
  );
  for (const patch of [
    { created_at_ms: 101 },
    { status: 'active' },
    { objective: 'Changed' },
    { token_budget: null },
  ])
    assert.notEqual(revision(g), revision({ ...g, ...patch }));
});
test('resume preserves objective and budget; concurrent duplicate requests write once', async () => {
  const { actions, body, state } = fixture();
  await Promise.all([actions.start(body), actions.start(body)]);
  await actions.running.get(body.requestId);
  assert.equal(actions.get(body.requestId).status, 'succeeded');
  assert.deepEqual(state.writes, ['/goal resume']);
  assert.equal(state.goal.token_budget, 8000);
  await actions.start(body);
  assert.equal(state.writes.length, 1);
  await assert.rejects(actions.start({ ...body, action: 'clear' }), {
    code: 'GOAL_REQUEST_CHANGED',
  });
});
test('clear verifies absent native Goal and never pauses it', async () => {
  const { state, run } = fixture();
  const job = await run({ action: 'clear' });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.goal, null);
  assert.deepEqual(state.writes, ['/goal clear']);
});
test('pausing a Goal preserves its objective and budget and verifies native paused state', async () => {
  const { state, run } = fixture();
  state.goal.status = 'active';
  const job = await run({ action: 'pause', revision: revision(state.goal) });
  assert.equal(job.status, 'succeeded');
  assert.equal(state.goal.objective, 'Original goal');
  assert.equal(state.goal.token_budget, 8000);
  assert.equal(state.goal.status, 'paused');
  assert.deepEqual(state.writes, ['/goal pause']);
});
test('stale process or Goal rejects before any terminal write', async () => {
  for (const patch of [{ processRuntimeId: 'other' }, { revision: 'stale' }]) {
    const { state, run } = fixture();
    assert.equal((await run(patch)).status, 'failed');
    assert.deepEqual(state.writes, []);
  }
});
test('completed or budget exhausted Goals cannot silently resume, and active is idempotent', async () => {
  for (const status of ['complete', 'budget_limited', 'active']) {
    const { state, run } = fixture();
    state.goal.status = status;
    const job = await run({ revision: revision(state.goal) });
    assert.equal(job.status, status === 'active' ? 'succeeded' : 'failed');
    assert.deepEqual(state.writes, []);
  }
});
test('uncertain delivery is retained and never retried', async () => {
  const { state, commands, body, actions, run } = fixture();
  commands.execute = async () => {
    state.writes.push('once');
    throw Object.assign(new Error('Lost acknowledgement'), { deliveryUncertain: true });
  };
  const job = await run();
  assert.equal(job.uncertain, true);
  await actions.start(body);
  assert.equal(state.writes.length, 1);
});
test('unconfirmed native state is not reported as success', async () => {
  const { commands, run } = fixture();
  commands.execute = async () => {};
  const job = await run();
  assert.equal(job.status, 'failed');
  assert.equal(job.code, 'GOAL_UNCONFIRMED');
  assert.equal(job.uncertain, true);
});
test('native Goal editor acknowledgement excludes history and checks visible multiline suffix', () => {
  const screen =
    'Old history\n  Edit goal\n\n› 优化 A3 softmax\n  保留所有测试。\n\n  enter submit · esc back';
  assert(editorInputMatches(screen, '优化 A3 softmax\n保留所有测试。'));
  assert(!editorInputMatches(screen, '另一项测试'));
  assert(!editorInputMatches('› Ordinary composer', 'Ordinary composer'));
});

test('setting a new Goal confirms the native record, not unrelated command output', async () => {
  const { state, actions, body, run, commands } = fixture();
  state.goal = null;
  commands.execute = async (b) => {
    state.writes.push(b.text);
    state.goal = {
      objective: b.text.slice(6),
      status: 'active',
      created_at_ms: 101,
      token_budget: null,
    };
    return { mode: 'result', failed: true, rows: [[{ text: '■ Unrelated earlier tool failure' }]] };
  };
  const job = await run({ action: 'set', objective: '真实目标', revision: revision(null) });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.goal.objective, '真实目标');
  assert.deepEqual(state.writes, ['/goal 真实目标']);
});
test('new Codex panes can preview and set a Goal before a Herdr session ID exists', async () => {
  const { state, actions, body, commands, run } = fixture();
  state.goal = null;
  const preview = await actions.preview({ ...body, sessionId: '' });
  assert.equal(preview.goal, null);
  commands.execute = async () => {
    state.goal = { objective: 'First Goal', status: 'active', created_at_ms: 101 };
  };
  const job = await run({
    action: 'set',
    objective: 'First Goal',
    sessionId: '',
    revision: preview.revision,
  });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.goal.objective, 'First Goal');
});
test('replacing an existing Goal needs explicit confirmation and the exact native menu', async () => {
  const { state, run, commands } = fixture();
  const denied = await run({ action: 'set', objective: '新的目标' });
  assert.equal(denied.code, 'GOAL_REPLACE_REQUIRED');
  assert.deepEqual(state.writes, []);
  commands.execute = async (b) => ({
    mode: 'menu',
    leaseId: 'lease',
    revision: 'menu',
    rows: [[{ text: 'Replace goal?' }]],
    options: [{ label: 'Replace current goal' }, { label: 'Cancel' }],
  });
  commands.handle = async (b, locked) => {
    assert(locked);
    assert.equal(b.action, 'pick');
    assert.equal(b.option, 'Replace current goal');
    state.writes.push(b.option);
    state.goal = {
      ...state.goal,
      objective: '新的目标',
      status: 'active',
      token_budget: null,
      created_at_ms: 101,
    };
  };
  const job = await run({
    action: 'set',
    objective: '新的目标',
    confirmReplace: true,
    requestId: 'replace',
  });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.goal.objective, '新的目标');
  assert.deepEqual(state.writes, ['Replace current goal']);
});
test('reserved native Goal controls cannot accidentally become a set request', async () => {
  const { actions, body, state } = fixture();
  for (const objective of ['clear', 'PAUSE', 'resume', 'edit'])
    await assert.rejects(
      actions.start({ ...body, action: 'set', objective, requestId: objective }),
      { code: 'INVALID_GOAL_OBJECTIVE' },
    );
  assert.deepEqual(state.writes, []);
});
test('completed Goals are replaced without waiting for a confirmation Codex does not show', async () => {
  const { state, commands, run } = fixture();
  state.goal.status = 'complete';
  commands.execute = async (body) => {
    state.writes.push(body.text);
    state.goal = {
      ...state.goal,
      objective: 'Next objective',
      status: 'active',
      created_at_ms: 101,
    };
  };
  const job = await run({
    action: 'set',
    objective: 'Next objective',
    confirmReplace: true,
    revision: revision(state.goal),
  });
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(state.writes, ['/goal Next objective']);
});
test('replacing a completed Goal with identical text still requires a new native record', async () => {
  const { state, commands, run } = fixture();
  state.goal.status = 'complete';
  commands.execute = async () => {};
  const job = await run({
    action: 'set',
    objective: state.goal.objective,
    confirmReplace: true,
    revision: revision(state.goal),
  });
  assert.equal(job.code, 'GOAL_UNCONFIRMED');
});

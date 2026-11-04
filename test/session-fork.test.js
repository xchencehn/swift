'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { createHash } = require('node:crypto');
const { SessionFork } = require('../lib/session-fork');
const child = {
  sessionId: 'child-session',
  tabId: 'child-tab',
  paneId: 'child-pane',
  terminalId: 'child-terminal',
  goalPaused: true,
  goalStatus: 'paused',
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-session-fork-'));
  const roots = { a: path.join(directory, 'project'), b: path.join(directory, 'project/nested') };
  const stores = {};
  for (const key of Object.keys(roots)) {
    fs.mkdirSync(roots[key], { recursive: true });
    const storage = path.join(directory, 'data-' + key);
    fs.mkdirSync(path.join(storage, 'state'), { recursive: true });
    stores[key] = { directory: roots[key], file: (relative) => path.join(storage, relative) };
  }
  const state = {
    root: 'a',
    runtimeId: 'herdr-runtime',
    calls: [],
    mutations: [],
    changes: 0,
    pane: {
      paneId: 'parent-pane',
      terminalId: 'parent-terminal',
      runtimeId: '123:456',
      tabId: 'parent-tab',
      workspaceId: 'workspace',
      cwd: roots.b,
      agent: { label: 'codex', status: 'working', session: { value: 'parent-session' } },
    },
    run: async () => child,
  };
  const controllers = [],
    gates = [];
  function controller() {
    const service = new SessionFork({
      herdr: {
        normalizeSnapshot: () => ({ runtimeId: state.runtimeId }),
        dashboard: async () => ({ runtimeId: state.runtimeId }),
      },
      exactPane: async (id) => (id === state.pane?.paneId ? structuredClone(state.pane) : null),
      native: {
        run: async (pane, options) => {
          state.calls.push(structuredClone(pane));
          return state.run(pane, options);
        },
      },
      data: () => stores[state.root],
      onChange: () => {
        state.changes++;
      },
    });
    controllers.push(service);
    return service;
  }
  const service = controller();
  const body = (requestId = 'fork-once', patch = {}) => ({
    requestId,
    runtimeId: state.runtimeId,
    paneId: state.pane.paneId,
    terminalId: state.pane.terminalId,
    sessionId: state.pane.agent.session.value,
    processRuntimeId: state.pane.runtimeId,
    ...patch,
  });
  const file = (key = state.root) => stores[key].file('state/session-forks.json');
  const ledger = (key = state.root) => JSON.parse(fs.readFileSync(file(key), 'utf8'));
  const settle = async (target = service) => {
    while (target.running.size) await Promise.all([...target.running.values()]);
  };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all(controllers.map(settle));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    service,
    state,
    roots,
    stores,
    controller,
    body,
    file,
    ledger,
    settle,
    gate: () => {
      const gate = deferred();
      gates.push(gate);
      return gate;
    },
    finish: async (request) => {
      service.start(request);
      await settle();
      return service.get(request.requestId);
    },
  };
}

test('Fork persists its receipt before native execution and duplicate replies never run twice', async (t) => {
  const f = fixture(t),
    entered = f.gate(),
    release = f.gate(),
    request = f.body();
  f.state.run = async (_pane, { progress }) => {
    assert.equal(f.ledger().jobs[request.requestId].job.status, 'running');
    await progress({ phase: 'forked', sessionId: child.sessionId });
    assert.equal(f.ledger().jobs[request.requestId].job.sessionId, child.sessionId);
    f.state.mutations.push('fork');
    entered.resolve();
    await release.promise;
    return child;
  };
  const initial = f.service.start(request);
  assert.equal(initial.status, 'running');
  assert.equal(f.ledger().jobs[request.requestId].job.status, 'running');
  initial.status = 'succeeded';
  assert.equal(
    f.service.get(request.requestId).status,
    'running',
    'A returned clone cannot change the receipt',
  );
  f.service.start({ ...request });
  await entered.promise;
  assert.equal(f.state.calls.length, 1);
  release.resolve();
  await f.settle();
  const completed = f.service.get(request.requestId);
  assert.equal(completed.status, 'succeeded');
  for (const key of Object.keys(child)) assert.equal(completed[key], child[key]);
  f.service.start(request);
  const restarted = f.controller();
  assert.equal(restarted.start(request).status, 'succeeded');
  assert.deepEqual(f.state.mutations, ['fork']);
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.changes, 1);
});

test('a lost native reply keeps durable partial identifiers and the same ID never replays it', async (t) => {
  const f = fixture(t),
    request = f.body();
  f.state.run = async (_pane, { progress }) => {
    await progress({ phase: 'tab-created', ...child });
    f.state.mutations.push('created');
    throw Object.assign(new Error('reply lost after creation'), {
      code: 'NATIVE_REPLY_LOST',
      deliveryUncertain: true,
    });
  };
  const job = await f.finish(request);
  assert.equal(job.status, 'uncertain');
  assert.equal(job.code, 'NATIVE_REPLY_LOST');
  for (const key of Object.keys(child)) assert.equal(job[key], child[key]);
  assert.equal(f.ledger().jobs[request.requestId].job.paneId, child.paneId);
  assert.equal(f.service.start(request).status, 'uncertain');
  const restarted = f.controller();
  assert.equal(restarted.start(request).status, 'uncertain');
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.mutations, ['created']);
});

test('error.partial retains only child progress fields and cannot replace receipt identity or success', async (t) => {
  const f = fixture(t),
    request = f.body();
  f.state.run = async () => {
    throw Object.assign(new Error('child created before reply was lost'), {
      deliveryUncertain: true,
      partial: {
        ...child,
        phase: 'child-started',
        status: 'succeeded',
        requestId: 'different-id',
        untrusted: 'not-progress',
      },
    });
  };
  const job = await f.finish(request);
  assert.equal(job.status, 'uncertain');
  assert.equal(job.requestId, request.requestId);
  assert.equal(job.phase, 'child-started');
  for (const key of Object.keys(child)) assert.equal(job[key], child[key]);
  assert.equal(Object.hasOwn(job, 'untrusted'), false);
  assert.equal(f.ledger().jobs[request.requestId].job.sessionId, child.sessionId);
  assert.equal(f.service.start(request).status, 'uncertain');
  assert.equal(f.state.calls.length, 1);
});

test('partial child identity survives an error even when its receipt can no longer be persisted', async (t) => {
  const f = fixture(t),
    request = f.body();
  let lastDurable;
  f.state.run = async (_pane, { progress }) => {
    await progress({ phase: 'forking' });
    lastDurable = f.ledger().jobs[request.requestId].job;
    f.state.mutations.push('fork-created');
    fs.rmSync(f.file());
    fs.mkdirSync(f.file());
    throw Object.assign(new Error('cannot persist discovered child'), {
      deliveryUncertain: true,
      partial: { phase: 'forked', sessionId: child.sessionId },
    });
  };
  const job = await f.finish(request);
  assert.equal(lastDurable.phase, 'forking');
  assert.equal(Object.hasOwn(lastDurable, 'sessionId'), false);
  assert.equal(job.sessionId, child.sessionId);
  assert.equal(job.status, 'uncertain');
  assert.equal(job.code, 'FORK_RECEIPT_WRITE_FAILED');
  assert.deepEqual(f.state.mutations, ['fork-created']);
  f.service.start(request);
  assert.equal(f.state.calls.length, 1);
});

test('native promise rejections without Error objects become failed receipts rather than replaying', async (t) => {
  for (const value of [undefined, null, false, 0, '']) {
    const f = fixture(t),
      request = f.body();
    f.state.run = async () => {
      throw value;
    };
    const job = await f.finish(request);
    assert.equal(job.status, 'failed');
    assert.equal(job.code, 'FORK_FAILED');
    assert.equal(f.service.start(request).status, 'failed');
    assert.equal(f.state.calls.length, 1);
  }
});

test('one parent cannot run a second Fork concurrently, including after a root switch', async (t) => {
  const f = fixture(t),
    entered = f.gate(),
    release = f.gate(),
    first = f.body('first');
  f.state.run = async () => {
    entered.resolve();
    await release.promise;
    return child;
  };
  f.service.start(first);
  await entered.promise;
  assert.throws(() => f.service.start(f.body('second')), { code: 'FORK_BUSY' });
  f.state.root = 'b';
  assert.throws(() => f.service.get(first.requestId), { code: 'FORK_RECEIPT_UNKNOWN' });
  assert.throws(() => f.service.start(f.body('other-root')), { code: 'FORK_BUSY' });
  assert.equal(f.state.calls.length, 1);
  release.resolve();
  await f.settle();
  assert.equal(f.ledger('a').jobs.first.job.status, 'succeeded');
  assert.equal(Object.keys(f.ledger('b').jobs).length, 0);
});

test('a persisted running receipt becomes uncertain after restart without invoking native', async (t) => {
  const f = fixture(t),
    request = f.body('interrupted-server');
  const binding = Object.fromEntries(
    ['runtimeId', 'paneId', 'terminalId', 'sessionId', 'processRuntimeId'].map((key) => [
      key,
      request[key] || '',
    ]),
  );
  const job = {
    requestId: request.requestId,
    status: 'running',
    phase: 'tab-created',
    tabId: child.tabId,
    sessionId: child.sessionId,
  };
  fs.writeFileSync(
    f.file(),
    JSON.stringify({
      version: 1,
      jobs: {
        [request.requestId]: {
          fingerprint: digest(binding),
          parentKey: digest([binding.runtimeId, binding.terminalId, binding.sessionId]),
          job,
        },
      },
    }),
  );
  const recovered = f.service.get(request.requestId);
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.code, 'FORK_SERVER_RESTARTED');
  assert.equal(recovered.tabId, child.tabId);
  assert.equal(f.ledger().jobs[request.requestId].job.status, 'uncertain');
  assert.equal(f.service.start(request).status, 'uncertain');
  assert.equal(f.state.calls.length, 0);
});

test('failed and uncertain receipts need a distinct request ID for an explicit new attempt', async (t) => {
  for (const uncertain of [false, true]) {
    const f = fixture(t),
      first = f.body('original');
    f.state.run = async () => {
      throw Object.assign(new Error('first attempt failed'), { uncertain });
    };
    assert.equal((await f.finish(first)).status, uncertain ? 'uncertain' : 'failed');
    f.state.run = async () => child;
    assert.equal(f.service.start(first).status, uncertain ? 'uncertain' : 'failed');
    assert.equal(f.state.calls.length, 1);
    assert.equal((await f.finish(f.body('explicit-new-attempt'))).status, 'succeeded');
    assert.equal(f.state.calls.length, 2);
  }
});

test('wrong root, Herdr runtime, native session, terminal, process and provider fail before native execution', async (t) => {
  const scenarios = [
    ['runtimeId', 'old-herdr', 'RUNTIME_CHANGED'],
    ['paneId', 'old-pane', 'SESSION_CHANGED'],
    ['terminalId', 'old-terminal', 'SESSION_CHANGED'],
    ['sessionId', 'old-session', 'SESSION_CHANGED'],
    ['processRuntimeId', 'old-process', 'SESSION_CHANGED'],
  ];
  for (const [key, value, code] of scenarios) {
    const f = fixture(t),
      job = await f.finish(f.body('stale-' + key, { [key]: value }));
    assert.equal(job.status, 'failed');
    assert.equal(job.code, code);
    assert.equal(f.state.calls.length, 0);
  }
  for (const [change, code] of [
    [
      (pane) => {
        pane.cwd = path.parse(pane.cwd).root;
      },
      'ROOT_CHANGED',
    ],
    [
      (pane) => {
        pane.agent.label = 'claude';
      },
      'SESSION_CHANGED',
    ],
    [
      (pane) => {
        pane.runtimeId = '';
      },
      'SESSION_CHANGED',
    ],
  ]) {
    const f = fixture(t),
      request = f.body();
    change(f.state.pane);
    const job = await f.finish(request);
    assert.equal(job.status, 'failed');
    assert.equal(job.code, code);
    assert.equal(f.state.calls.length, 0);
  }
});

test('validate rejects a moved parent Tab, workspace, directory or replacement process before the next mutation', async (t) => {
  for (const [field, value, code] of [
    ['tabId', 'moved-tab', 'FORK_TARGET_MOVED'],
    ['workspaceId', 'moved-space', 'FORK_TARGET_MOVED'],
    ['cwd', 'nested-move', 'FORK_TARGET_MOVED'],
    ['runtimeId', 'new-process', 'SESSION_CHANGED'],
    ['terminalId', 'new-terminal', 'SESSION_CHANGED'],
  ]) {
    const f = fixture(t);
    f.state.run = async (_pane, { validate }) => {
      f.state.pane[field] = field === 'cwd' ? path.join(f.roots.b, value) : value;
      await validate();
      f.state.mutations.push('must-not-run');
      return child;
    };
    const job = await f.finish(f.body());
    assert.equal(job.status, 'failed');
    assert.equal(job.code, code);
    assert.deepEqual(f.state.mutations, []);
  }
});

test('the same request ID cannot be rebound to another target or process', async (t) => {
  const f = fixture(t),
    request = f.body();
  await f.finish(request);
  for (const key of ['runtimeId', 'paneId', 'terminalId', 'sessionId', 'processRuntimeId'])
    assert.throws(() => f.service.start({ ...request, [key]: 'replacement' }), {
      code: 'FORK_REQUEST_CHANGED',
    });
  assert.equal(f.state.calls.length, 1);
});

test('receipts stay isolated by root even when both roots can see the same parent', async (t) => {
  const f = fixture(t),
    request = f.body('same-id');
  const first = await f.finish(request);
  assert.equal(first.paneId, child.paneId);
  f.state.root = 'b';
  assert.throws(() => f.service.get(request.requestId), { code: 'FORK_RECEIPT_UNKNOWN' });
  f.state.run = async () => ({ ...child, paneId: 'other-root-child' });
  assert.equal((await f.finish(request)).paneId, 'other-root-child');
  f.state.root = 'a';
  assert.equal(f.service.get(request.requestId).paneId, child.paneId);
  assert.equal(f.state.calls.length, 2);
});

test('a failed initial receipt write cannot reach native and can be retried only after persistence recovers', async (t) => {
  const f = fixture(t),
    request = f.body();
  f.service.store();
  fs.rmSync(f.file());
  fs.mkdirSync(f.file());
  assert.throws(() => f.service.start(request));
  assert.throws(() => f.service.get(request.requestId), { code: 'FORK_RECEIPT_UNKNOWN' });
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.service.running.size, 0);
  fs.rmdirSync(f.file());
  assert.equal((await f.finish(request)).status, 'succeeded');
  assert.equal(f.state.calls.length, 1);
});

test('a failed progress write stops subsequent native mutations and never advances the failed phase', async (t) => {
  const f = fixture(t),
    request = f.body();
  f.state.run = async (_pane, { progress }) => {
    await progress({ phase: 'forked', sessionId: child.sessionId });
    f.state.mutations.push('fork');
    fs.rmSync(f.file());
    fs.mkdirSync(f.file());
    await progress({ phase: 'creating-tab' });
    f.state.mutations.push('must-not-create-tab');
    return child;
  };
  const job = await f.finish(request);
  assert.deepEqual(f.state.mutations, ['fork']);
  assert.equal(job.status, 'uncertain');
  assert.equal(job.code, 'FORK_RECEIPT_WRITE_FAILED');
  assert.equal(job.phase, 'forked');
  assert.equal(job.sessionId, child.sessionId);
  assert.equal(f.service.start(request).status, 'uncertain');
  assert.equal(f.state.calls.length, 1);
});

test('corrupt or incomplete receipt ledgers are rejected without overwriting evidence or starting native', async (t) => {
  for (const contents of [
    '{broken json',
    'null',
    '{"version":2,"jobs":{}}',
    '{"version":1,"jobs":[]}',
    '{"version":1,"jobs":{"id":{"job":{"status":"running"}}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":"f"}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":"f","job":"corrupt"}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":"f","job":{}}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":"f","job":{"requestId":"id","phase":"validating","status":"unknown"}}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":{},"job":{"requestId":"id","phase":"validating","status":"failed"}}}}',
    '{"version":1,"jobs":{"id":{"fingerprint":"f","job":{"requestId":"another-id","phase":"complete","status":"succeeded"}}}}',
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.file(), contents);
    assert.throws(() => f.service.start(f.body()));
    assert.equal(fs.readFileSync(f.file(), 'utf8'), contents);
    assert.equal(f.state.calls.length, 0);
  }
});

test('receipt schema rejects each malformed identity, job and status before converting any running job', async (t) => {
  for (const corrupt of [
    (entry) => {
      entry.fingerprint = {};
    },
    (entry) => {
      entry.parentKey = 'not-a-parent-hash';
    },
    (entry) => {
      entry.job = 'not-a-job';
    },
    (entry) => {
      entry.job = [];
    },
    (entry) => {
      delete entry.job.requestId;
    },
    (entry) => {
      entry.job.requestId = 'other-request';
    },
    (entry) => {
      entry.job.status = 'unexpected';
    },
    (entry) => {
      entry.job.phase = [];
    },
  ]) {
    const f = fixture(t),
      request = f.body('valid');
    const binding = Object.fromEntries(
      ['runtimeId', 'paneId', 'terminalId', 'sessionId', 'processRuntimeId'].map((key) => [
        key,
        request[key] || '',
      ]),
    );
    const valid = {
      fingerprint: digest(binding),
      parentKey: digest([binding.runtimeId, binding.terminalId, binding.sessionId]),
      job: { requestId: 'valid', status: 'running', phase: 'forking' },
    };
    const invalid = structuredClone(valid);
    invalid.job.requestId = 'invalid';
    corrupt(invalid);
    const contents = JSON.stringify({ version: 1, jobs: { valid, invalid } });
    fs.writeFileSync(f.file(), contents);
    assert.throws(() => f.service.get('valid'), { code: 'FORK_RECEIPTS_INVALID' });
    assert.equal(fs.readFileSync(f.file(), 'utf8'), contents);
    assert.equal(f.state.calls.length, 0);
  }
});

function browserHelper({
  cryptoAvailable = true,
  uuidAvailable = true,
  performanceAvailable = true,
  wallNow = () => Date.now(),
} = {}) {
  let ids = 0;
  const pendingTimers = new Set();
  const context = {
    Date: { now: wallNow },
    performance: { now: () => performance.now() },
    crypto: { randomUUID: () => `request-${++ids}` },
    setTimeout: (callback, ms) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        callback();
      }, ms);
      pendingTimers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      pendingTimers.delete(timer);
      clearTimeout(timer);
    },
  };
  if (!cryptoAvailable) delete context.crypto;
  else if (!uuidAvailable) context.crypto = {};
  if (!performanceAvailable) delete context.performance;
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../public/nav/session-fork.js'), 'utf8'),
    context,
    { filename: 'public/nav/session-fork.js' },
  );
  return { run: context.StudioSessionFork.run, getIds: () => ids, pendingTimers };
}

function frozenTarget() {
  return Object.freeze({
    runtimeId: 'herdr-runtime',
    paneId: 'parent-pane',
    terminalId: 'parent-terminal',
    sessionId: 'parent-session',
    processRuntimeId: '123:456',
  });
}

test('browser Fork starts once, reads the same receipt, and leaves its frozen target unchanged', async () => {
  const helper = browserHelper(),
    target = frozenTarget(),
    before = { ...target },
    calls = [];
  const result = await helper.run({
    target,
    stepMs: 1,
    request: async (body) => {
      calls.push({ ...body });
      return {
        job: body.action === 'start' ? { status: 'running' } : { status: 'succeeded', ...child },
      };
    },
  });
  assert.equal(result.paneId, child.paneId);
  assert.equal(helper.getIds(), 1);
  assert.deepEqual(
    calls.map((body) => body.action),
    ['start', 'read'],
  );
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.deepEqual(calls[0], { ...target, action: 'start', requestId: 'request-1' });
  assert.deepEqual(calls[1], { action: 'read', requestId: 'request-1' });
  assert.deepEqual(target, before);
});

test('browser recovers a lost start reply and transient read failure by reading only the original ID', async () => {
  const helper = browserHelper(),
    calls = [];
  const result = await helper.run({
    target: frozenTarget(),
    stepMs: 1,
    request: async (body) => {
      calls.push({ ...body });
      if (calls.length < 3) throw new Error('transport disconnected');
      return { job: { status: 'succeeded', ...child } };
    },
  });
  assert.equal(result.sessionId, child.sessionId);
  assert.deepEqual(
    calls.map((body) => body.action),
    ['start', 'read', 'read'],
  );
  assert.equal(new Set(calls.map((body) => body.requestId)).size, 1);
  assert.equal(helper.getIds(), 1);
});

test('browser failed and uncertain receipts stop immediately and never create another Fork', async () => {
  for (const status of ['failed', 'uncertain'])
    for (const atStart of [true, false]) {
      const helper = browserHelper(),
        calls = [];
      await assert.rejects(
        helper.run({
          target: frozenTarget(),
          stepMs: 1,
          request: async (body) => {
            calls.push({ ...body });
            return {
              job:
                atStart || body.action === 'read'
                  ? { status, message: '保留现有子 Tab' }
                  : { status: 'running' },
            };
          },
        }),
        /保留现有子 Tab/,
      );
      assert.equal(calls.filter((body) => body.action === 'start').length, 1);
      assert.equal(calls.length, atStart ? 1 : 2);
    }
});

test('browser deadline only ends receipt polling and never repeats start after missing replies', async () => {
  for (const lostStart of [false, true]) {
    const helper = browserHelper(),
      calls = [];
    await assert.rejects(
      helper.run({
        target: frozenTarget(),
        timeoutMs: 20,
        stepMs: 1,
        request: async (body) => {
          calls.push({ ...body });
          if (lostStart && body.action === 'start') throw new Error('lost start reply');
          return { job: { status: 'running' } };
        },
      }),
      /Swift 不会自动重复创建/,
    );
    assert.equal(calls.filter((body) => body.action === 'start').length, 1);
    assert(calls.every((body) => body.action === 'start' || body.action === 'read'));
    assert.equal(new Set(calls.map((body) => body.requestId)).size, 1);
    assert.equal(helper.getIds(), 1);
    assert.equal(helper.pendingTimers.size, 0);
  }
});

test('browser start 4xx rejection is returned immediately without polling or target mutation', async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const helper = browserHelper(),
      target = frozenTarget(),
      before = { ...target },
      calls = [];
    const error = Object.assign(new Error('explicit request rejected'), { status });
    await assert.rejects(
      helper.run({
        target,
        request: async (body) => {
          calls.push(body);
          throw error;
        },
      }),
      (value) => value === error,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'start');
    assert.deepEqual(target, before);
  }
});

test('browser unauthorized receipt reads stop immediately instead of polling after access is lost', async () => {
  for (const fields of [{ status: 401 }, { status: 403 }, { code: 'UNAUTHORIZED' }]) {
    const helper = browserHelper(),
      calls = [],
      error = Object.assign(new Error('access denied'), fields);
    await assert.rejects(
      helper.run({
        target: frozenTarget(),
        stepMs: 1,
        request: async (body) => {
          calls.push({ ...body });
          if (body.action === 'read') throw error;
          return { job: { status: 'running' } };
        },
      }),
      (value) => value === error,
    );
    assert.deepEqual(
      calls.map((body) => body.action),
      ['start', 'read'],
    );
  }
});

test('browser receipt 404 and server failure recovery only reads the original operation', async () => {
  const helper = browserHelper(),
    calls = [];
  const result = await helper.run({
    target: frozenTarget(),
    stepMs: 1,
    request: async (body) => {
      calls.push({ ...body });
      if (body.action === 'start')
        throw Object.assign(new Error('start reply lost'), { status: 503 });
      if (calls.length === 2)
        throw Object.assign(new Error('receipt not visible yet'), { status: 404 });
      return { job: { status: 'succeeded', ...child } };
    },
  });
  assert.equal(result.sessionId, child.sessionId);
  assert.deepEqual(
    calls.map((body) => body.action),
    ['start', 'read', 'read'],
  );
  assert.equal(new Set(calls.map((body) => body.requestId)).size, 1);
});

test('browser Fork has a stable fallback receipt ID when randomUUID is unavailable', async () => {
  for (const options of [{ cryptoAvailable: false }, { uuidAvailable: false }]) {
    const helper = browserHelper(options),
      calls = [],
      target = frozenTarget(),
      before = { ...target };
    const result = await helper.run({
      target,
      stepMs: 1,
      request: async (body) => {
        calls.push({ ...body });
        if (body.action === 'start') throw new Error('lost reply in an insecure context');
        return { job: { status: 'succeeded', ...child } };
      },
    });
    assert.equal(result.paneId, child.paneId);
    assert.deepEqual(
      calls.map((body) => body.action),
      ['start', 'read'],
    );
    assert.match(calls[0].requestId, /^fork-[a-zA-Z0-9-]+$/);
    assert.match(calls[0].requestId, /^[a-zA-Z0-9][\w-]{0,99}$/);
    assert.equal(calls[1].requestId, calls[0].requestId);
    assert.equal(helper.getIds(), 0);
    assert.deepEqual(target, before);
  }
});

test(
  'browser pending POST ends at the deadline without cancelling the job or sending another POST',
  { timeout: 2000 },
  async () => {
    for (const performanceAvailable of [true, false]) {
      const helper = browserHelper({ performanceAvailable }),
        pending = deferred(),
        calls = [];
      await assert.rejects(
        helper.run({
          target: frozenTarget(),
          timeoutMs: 25,
          stepMs: 1,
          request: (body) => {
            calls.push({ ...body });
            return pending.promise;
          },
        }),
        /Fork 结果尚未确认/,
      );
      assert.deepEqual(
        calls.map((body) => body.action),
        ['start'],
      );
      assert.equal(helper.pendingTimers.size, 0);
      pending.resolve({ job: { status: 'succeeded', ...child } });
      await new Promise(setImmediate);
      assert.deepEqual(
        calls.map((body) => body.action),
        ['start'],
        'A late reply must not restart the completed wait',
      );
    }
  },
);

test(
  'browser pending GET ends at the deadline and keeps the same operation ID',
  { timeout: 2000 },
  async () => {
    const helper = browserHelper(),
      pending = deferred(),
      calls = [];
    await assert.rejects(
      helper.run({
        target: frozenTarget(),
        timeoutMs: 100,
        stepMs: 1,
        request: (body) => {
          calls.push({ ...body });
          return body.action === 'start'
            ? Promise.resolve({ job: { status: 'running' } })
            : pending.promise;
        },
      }),
      /Fork 结果尚未确认/,
    );
    assert.deepEqual(
      calls.map((body) => body.action),
      ['start', 'read'],
    );
    assert.equal(calls[0].requestId, calls[1].requestId);
    assert.equal(helper.pendingTimers.size, 0);
    pending.resolve({ job: { status: 'succeeded', ...child } });
    await new Promise(setImmediate);
    assert.equal(calls.length, 2);
  },
);

test(
  'browser POST and GET share one deadline rather than granting each request a new timeout',
  { timeout: 2000 },
  async () => {
    const helper = browserHelper(),
      pending = deferred(),
      calls = [];
    const operation = helper.run({
      target: frozenTarget(),
      timeoutMs: 120,
      stepMs: 1,
      request: async (body) => {
        calls.push({ ...body });
        if (body.action === 'start') {
          await new Promise((resolve) => setTimeout(resolve, 90));
          return { job: { status: 'running' } };
        }
        return pending.promise;
      },
    });
    let watchdog;
    try {
      await assert.rejects(
        Promise.race([
          operation,
          new Promise((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error('The request renewed the overall deadline')),
              180,
            );
          }),
        ]),
        /Fork 结果尚未确认/,
      );
      assert.equal(calls[0].action, 'start');
      assert(calls.length <= 2);
      assert(
        calls
          .slice(1)
          .every((body) => body.action === 'read' && body.requestId === calls[0].requestId),
      );
      assert.equal(helper.pendingTimers.size, 0);
    } finally {
      clearTimeout(watchdog);
      pending.resolve({ job: { status: 'succeeded', ...child } });
    }
  },
);

test('browser request timers are cleared after successful responses and immediate rejection', async () => {
  const success = browserHelper();
  await success.run({
    target: frozenTarget(),
    request: async () => ({ job: { status: 'succeeded', ...child } }),
  });
  assert.equal(success.pendingTimers.size, 0);
  const failure = browserHelper(),
    error = Object.assign(new Error('denied'), { status: 403 });
  await assert.rejects(
    failure.run({
      target: frozenTarget(),
      request: async () => {
        throw error;
      },
    }),
    (value) => value === error,
  );
  assert.equal(failure.pendingTimers.size, 0);
});

test('browser null or undefined request rejection recovers by reading the existing ID', async () => {
  for (const rejection of [null, undefined]) {
    const helper = browserHelper(),
      calls = [];
    const result = await helper.run({
      target: frozenTarget(),
      stepMs: 1,
      request: async (body) => {
        calls.push({ ...body });
        if (calls.length < 3) throw rejection;
        return { job: { status: 'succeeded', ...child } };
      },
    });
    assert.equal(result.sessionId, child.sessionId);
    assert.deepEqual(
      calls.map((body) => body.action),
      ['start', 'read', 'read'],
    );
    assert.equal(new Set(calls.map((body) => body.requestId)).size, 1);
    assert.equal(helper.pendingTimers.size, 0);
  }
});

test('browser deadline uses the monotonic clock when available', async () => {
  const helper = browserHelper({
    wallNow: () => {
      throw new Error('wall clock must not determine the deadline');
    },
  });
  const result = await helper.run({
    target: frozenTarget(),
    stepMs: 1,
    request: async (body) => ({
      job: body.action === 'start' ? { status: 'running' } : { status: 'succeeded', ...child },
    }),
  });
  assert.equal(result.sessionId, child.sessionId);
  assert.equal(helper.pendingTimers.size, 0);
});

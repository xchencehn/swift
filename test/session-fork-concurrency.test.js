'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SessionFork } = require('../lib/session-fork');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-fork-concurrency-'));
  const root = path.join(directory, 'project'),
    storage = path.join(directory, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(storage, 'state'), { recursive: true });
  const data = { directory: root, file: (relative) => path.join(storage, relative) };
  const gates = [],
    work = [],
    executions = [];
  const pane = {
    paneId: 'parent-pane',
    terminalId: 'parent-terminal',
    runtimeId: '123:456',
    tabId: 'parent-tab',
    workspaceId: 'parent-space',
    cwd: root,
    agent: { label: 'codex', status: 'working', session: { value: 'parent-session' } },
  };
  const child = (name) => ({
    sessionId: name + '-session',
    tabId: name + '-tab',
    paneId: name + '-pane',
    terminalId: name + '-terminal',
    goalPaused: true,
    goalStatus: 'paused',
  });
  const gate = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const result = { promise, resolve };
    gates.push(result);
    return result;
  };
  const controller = (socketPath, runtimeId, native) =>
    new SessionFork({
      herdr: { socketPath, normalizeSnapshot: () => ({ runtimeId }) },
      data: () => data,
      exactPane: async (id) => (id === pane.paneId ? structuredClone(pane) : null),
      native: {
        run: async (parent, options) => {
          executions.push({ socketPath, runtimeId, parent: structuredClone(parent) });
          return native(parent, options);
        },
      },
    });
  const request = (runtimeId, requestId) => ({
    requestId,
    runtimeId,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    sessionId: pane.agent.session.value,
    processRuntimeId: pane.runtimeId,
  });
  const begin = (service, body) => {
    const initial = service.start(body);
    const pending = service.running.get(`${service.store().file}:${body.requestId}`);
    assert(pending, 'A new request must have an observable running job');
    work.push(pending);
    return { initial, pending };
  };
  const entered = (signal, pending) =>
    Promise.race([
      signal.promise,
      pending.then(() => {
        throw new Error('Native mock completed before reaching its expected gate');
      }),
    ]);
  const ledger = (service) => JSON.parse(fs.readFileSync(service.store().file, 'utf8'));
  t.after(async () => {
    for (const signal of gates) signal.resolve();
    await Promise.allSettled(work);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    root,
    storage,
    child,
    gate,
    controller,
    request,
    begin,
    entered,
    ledger,
    executions,
  };
}

test(
  'interleaved Fork jobs on different sockets keep both receipts and a fresh process cannot replay either ID',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      aEntered = f.gate(),
      bEntered = f.gate(),
      finishA = f.gate(),
      finishB = f.gate();
    const socketA = path.join(f.directory, 'a.sock'),
      socketB = path.join(f.directory, 'b.sock');
    const runtimeA = f.directory + ':runtime-a',
      runtimeB = f.directory + ':runtime-b';
    const childA = f.child('child-a'),
      childB = f.child('child-b');
    const a = f.controller(socketA, runtimeA, async (_pane, { progress }) => {
      await progress({ phase: 'forked', sessionId: childA.sessionId });
      aEntered.resolve();
      await finishA.promise;
      await progress({ phase: 'tab-created', ...childA });
      return childA;
    });
    const b = f.controller(socketB, runtimeB, async (_pane, { progress }) => {
      await progress({ phase: 'forked', sessionId: childB.sessionId });
      bEntered.resolve();
      await finishB.promise;
      await progress({ phase: 'tab-created', ...childB });
      return childB;
    });
    const requestA = f.request(runtimeA, 'fork-a'),
      requestB = f.request(runtimeB, 'fork-b');
    const workA = f.begin(a, requestA);
    await f.entered(aEntered, workA.pending);
    const workB = f.begin(b, requestB);
    await f.entered(bEntered, workB.pending);

    assert.notEqual(
      a.store().file,
      b.store().file,
      'Different sockets sharing RootData must have separate durable ledgers',
    );
    assert.equal(
      a.get(requestA.requestId).status,
      'running',
      'Opening the other socket must not declare an active job interrupted',
    );
    assert.equal(f.ledger(a).jobs[requestA.requestId].job.sessionId, childA.sessionId);
    assert.equal(f.ledger(b).jobs[requestB.requestId].job.sessionId, childB.sessionId);
    assert.throws(() => a.get(requestB.requestId), { code: 'FORK_RECEIPT_UNKNOWN' });
    assert.throws(() => b.get(requestA.requestId), { code: 'FORK_RECEIPT_UNKNOWN' });

    // B completes first, then A writes again: the previous shared-file design
    // would erase B's completed receipt with A's older cached jobs object.
    finishB.resolve();
    await workB.pending;
    const completedB = fs.readFileSync(b.store().file, 'utf8');
    finishA.resolve();
    await workA.pending;
    assert.equal(fs.readFileSync(b.store().file, 'utf8'), completedB);
    const jobA = f.ledger(a).jobs[requestA.requestId].job,
      jobB = f.ledger(b).jobs[requestB.requestId].job;
    assert.deepEqual(jobA, {
      requestId: requestA.requestId,
      status: 'succeeded',
      phase: 'complete',
      ...childA,
    });
    assert.deepEqual(jobB, {
      requestId: requestB.requestId,
      status: 'succeeded',
      phase: 'complete',
      ...childB,
    });
    assert.deepEqual(
      f.executions.map((call) => call.socketPath),
      [socketA, socketB],
    );

    // A new Node process has no module-level store or parent locks. Its only
    // evidence is the persisted ledger, and its native adapter is still a mock.
    const restarted = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `
    const fs = require('node:fs'), path = require('node:path');
    const { SessionFork } = require(process.argv[1]);
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    let nativeCalls = 0, validations = 0;
    const jobs = input.targets.map(target => {
      const service = new SessionFork({
        herdr: { socketPath: target.socketPath, normalizeSnapshot: () => ({ runtimeId: target.body.runtimeId }) },
        data: () => ({ directory: input.root, file: relative => path.join(input.storage, relative) }),
        exactPane: async () => { validations++; throw new Error('Duplicate receipt must not validate a new target'); },
        native: { run: async () => { nativeCalls++; throw new Error('Duplicate receipt must never execute native'); } },
      });
      const before = service.get(target.body.requestId);
      const after = service.start(target.body);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Duplicate receipt changed after restart');
      return after;
    });
    process.stdout.write(JSON.stringify({ jobs, nativeCalls, validations }));
  `,
          require.resolve('../lib/session-fork'),
        ],
        {
          input: JSON.stringify({
            root: f.root,
            storage: f.storage,
            targets: [
              { socketPath: socketA, body: requestA },
              { socketPath: socketB, body: requestB },
            ],
          }),
          encoding: 'utf8',
          timeout: 5000,
        },
      ),
    );
    assert.deepEqual(restarted.jobs, [jobA, jobB]);
    assert.equal(restarted.nativeCalls, 0);
    assert.equal(restarted.validations, 0);
  },
);

test(
  'controllers for one socket share the active parent lock and the original running receipt',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      entered = f.gate(),
      finish = f.gate();
    const socket = path.join(f.directory, 'shared.sock'),
      runtime = f.directory + ':runtime';
    const child = f.child('shared-child');
    const a = f.controller(socket, runtime, async (_pane, { progress }) => {
      await progress({ phase: 'forked', sessionId: child.sessionId });
      entered.resolve();
      await finish.promise;
      return child;
    });
    const original = f.request(runtime, 'original'),
      first = f.begin(a, original);
    await f.entered(entered, first.pending);
    const before = fs.readFileSync(a.store().file, 'utf8');
    const b = f.controller(socket, runtime, async () => {
      throw new Error('The second controller must not execute native');
    });
    const shared = b.get(original.requestId);
    assert.equal(shared.status, 'running');
    assert.equal(shared.phase, 'forked');
    assert.equal(shared.sessionId, child.sessionId);
    assert.equal(shared.code, undefined);
    assert.deepEqual(b.start({ ...original }), shared);
    assert.equal(
      fs.readFileSync(a.store().file, 'utf8'),
      before,
      'A second controller must not reload an active receipt as uncertain',
    );
    assert.throws(() => b.start(f.request(runtime, 'second-request')), { code: 'FORK_BUSY' });
    assert.equal(Object.hasOwn(f.ledger(a).jobs, 'second-request'), false);
    assert.equal(f.executions.length, 1);

    finish.resolve();
    await first.pending;
    const completed = a.get(original.requestId);
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(b.get(original.requestId), completed);
    assert.deepEqual(b.start(original), completed);
    assert.equal(f.ledger(b).jobs[original.requestId].job.status, 'succeeded');
    assert.equal(f.executions.length, 1);
  },
);

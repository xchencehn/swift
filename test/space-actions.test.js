'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { SpaceActions } = require('../lib/space-actions');
const { resumeArgs } = require('../lib/codex-restart');
const { ConversationStore } = require('../lib/conversation-store');
function fixture(options = {}) {
  const pane = (id, workspaceId, provider = 'codex', status = 'idle') => ({
    paneId: id,
    workspaceId,
    tab: id,
    tabId: 'tab-' + id,
    terminalId: 'term-' + id,
    runtimeId: 'process-' + id,
    agent: { name: id, label: provider, status, session: { value: 'session-' + id } },
  });
  const view = {
    runtimeId: 'herdr-1',
    workspaces: [
      { workspaceId: 'space', label: 'Space' },
      { workspaceId: 'other', label: 'Other' },
    ],
    panes: [
      pane('idle', 'space'),
      pane('working', 'space', 'codex', 'working'),
      pane('claude', 'space', 'claude'),
      pane('excluded', 'other'),
    ],
  };
  const writes = [],
    lock = new ConversationStore();
  const queue = {
    submitNative: async (body) => {
      writes.push({ action: 'send', ...body });
      return { status: 'dispatched' };
    },
    interrupted: () => {},
  };
  const controller = new SpaceActions({
    herdr: { dashboard: async () => structuredClone(view) },
    exactPane: async (id) => structuredClone(view.panes.find((p) => p.paneId === id)),
    operate: (id, run) => lock.operate(id, run),
    interrupt: async (id) => writes.push({ action: 'stop', paneId: id }),
    restart: {
      restart: async (pane, { validate }) => {
        await validate();
        writes.push({ action: 'restart', paneId: pane.paneId });
        return { message: 'resumed' };
      },
    },
    ...options,
  });
  const body = async (action = 'send', requestId = 'fixture') => {
    const preview = await controller.preview('space');
    return {
      requestId,
      workspaceId: 'space',
      runtimeId: preview.runtimeId,
      action,
      targets: preview.targets.filter((t) => action === 'stop' || t.provider === 'codex'),
      ...(action === 'send' ? { text: '继续当前任务' } : {}),
    };
  };
  const finish = async (body) => {
    await controller.start(body, queue);
    await controller.running.get(body.requestId);
    return controller.get(body.requestId);
  };
  return { controller, view, queue, writes, body, finish };
}
test('Space broadcast includes idle and working Codex, excludes other Space and Claude', async () => {
  const f = fixture(),
    job = await f.finish(await f.body());
  assert(job.done);
  assert(job.items.every((i) => i.status === 'succeeded'));
  assert.deepEqual(
    f.writes.map((w) => w.paneId),
    ['idle', 'working'],
  );
  assert(
    f.writes.every(
      (w) =>
        w.spaceWorkspaceId === 'space' && w.binding && w.sessionId && w.text === '继续当前任务',
    ),
  );
});
test('Space stop uses Escape adapter for every Agent and keeps the panes', async () => {
  const f = fixture(),
    before = structuredClone(f.view);
  await f.finish(await f.body('stop'));
  assert.deepEqual(
    f.writes.map((w) => w.paneId),
    ['idle', 'working', 'claude'],
  );
  assert.deepEqual(f.view, before);
});
test('broadcast accepts an opened Codex waiting for its first input through the real queue', async () => {
  const f = fixture();
  f.view.panes[0].agent.session = null;
  const { MessageQueue } = require('../lib/message-queue');
  const queue = new MessageQueue({
    getPane: async (id) => structuredClone(f.view.panes.find((p) => p.paneId === id)),
    sendNative: async (item) => f.writes.push(item),
  });
  const body = await f.body();
  await f.controller.start(body, queue);
  await f.controller.running.get(body.requestId);
  assert(f.controller.get(body.requestId).items.every((i) => i.status === 'succeeded'));
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].sessionId, null);
});
test('restart dispatches each Codex independently and coalesces concurrent duplicate requests', async () => {
  const f = fixture(),
    body = await f.body('restart');
  await Promise.all([f.controller.start(body, f.queue), f.controller.start(body, f.queue)]);
  await f.controller.running.get(body.requestId);
  await f.controller.start(body, f.queue);
  assert.equal(f.writes.length, 2);
  await assert.rejects(() => f.controller.start({ ...body, action: 'stop' }, f.queue), /同一请求/);
});
test('single Agent preview and restart affect only its exact session', async () => {
  const f = fixture(),
    preview = await f.controller.preview('space', 'working');
  assert.deepEqual(
    preview.targets.map((t) => t.paneId),
    ['working'],
  );
  const job = await f.finish({
    requestId: 'single',
    action: 'restart',
    workspaceId: 'space',
    runtimeId: preview.runtimeId,
    targets: preview.targets,
  });
  assert.equal(job.items[0].status, 'succeeded');
  assert.deepEqual(f.writes, [{ action: 'restart', paneId: 'working' }]);
  assert.deepEqual((await f.controller.preview('space', 'excluded')).targets, []);
});
test('single Agent restart rejects a session replaced after preview without exiting it', async () => {
  const f = fixture(),
    preview = await f.controller.preview('space', 'idle');
  f.view.panes[0].agent.session.value = 'replacement-session';
  const job = await f.finish({
    requestId: 'single-stale',
    action: 'restart',
    workspaceId: 'space',
    runtimeId: preview.runtimeId,
    targets: preview.targets,
  });
  assert.equal(job.items[0].status, 'failed');
  assert.equal(f.writes.length, 0);
});
test('a moved or replaced Pane is not controlled; other targets still succeed', async () => {
  const f = fixture(),
    body = await f.body('stop');
  f.view.panes[0].workspaceId = 'other';
  f.view.panes[1].runtimeId = 'new-process';
  const job = await f.finish(body);
  assert.deepEqual(
    job.items.map((i) => i.status),
    ['failed', 'failed', 'succeeded'],
  );
  assert.deepEqual(
    f.writes.map((w) => w.paneId),
    ['claude'],
  );
});
test('restarted Herdr rejects an old preview before any input', async () => {
  const f = fixture(),
    body = await f.body('stop');
  f.view.runtimeId = 'herdr-2';
  await assert.rejects(() => f.finish(body), /Space 已变化/);
  assert.equal(f.writes.length, 0);
});
test('an uncertain delivery is retained and never automatically replayed', async () => {
  const f = fixture();
  f.queue.submitNative = async (body) => {
    f.writes.push(body);
    return { status: 'failed', deliveryUncertain: true, error: { message: 'reply lost' } };
  };
  const body = await f.body(),
    job = await f.finish(body);
  await f.controller.start(body, f.queue);
  assert(job.items.every((i) => i.status === 'uncertain'));
  assert.equal(f.writes.length, 2);
});
test('new panes are excluded from a previously previewed target set', async () => {
  const f = fixture(),
    body = await f.body('stop');
  f.view.panes.push({ ...f.view.panes[0], paneId: 'new' });
  await f.finish(body);
  assert(!f.writes.some((w) => w.paneId === 'new'));
});
test('persisted unfinished operations become uncertain on Swift restart without replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-space-')),
    file = path.join(dir, 'receipts.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        jobs: [
          { requestId: 'old', done: false, items: [{ status: 'running' }, { status: 'pending' }] },
        ],
      }),
    );
    const f = fixture({ file });
    const job = f.controller.get('old');
    assert(job.done);
    assert.deepEqual(
      job.items.map((i) => i.status),
      ['uncertain', 'failed'],
    );
    assert.equal(f.writes.length, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('malformed targets and terminal control characters fail before any write', async () => {
  const f = fixture(),
    body = await f.body();
  await assert.rejects(
    () => f.controller.start({ ...body, targets: [body.targets[0], body.targets[0]] }, f.queue),
    /请选择/,
  );
  await assert.rejects(
    () => f.controller.start({ ...body, text: 'hello\x1b[200~' }, f.queue),
    /控制字符/,
  );
  assert.equal(f.writes.length, 0);
});
test('resume arguments preserve settings while dropping original prompt and automatic selection', () => {
  assert.deepEqual(
    resumeArgs(
      [
        'codex',
        '--no-daemon',
        '-m',
        'gpt-6.1-sol',
        '-c',
        'model_reasoning_effort="high"',
        'resume',
        '--last',
        '--all',
        'old prompt',
      ],
      'exact-id',
    ),
    [
      '--no-daemon',
      '-m',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort="high"',
      'resume',
      'exact-id',
    ],
  );
  assert.throws(() => resumeArgs(['codex', '--remote', 'host'], 'id'), /启动参数/);
  assert.throws(() => resumeArgs(['codex', '-c', 'api_key="private"'], 'id'), /私有启动参数/);
  assert.throws(() => resumeArgs(['codex'], 'invalid\rcommand'), /会话 ID 无效/);
});

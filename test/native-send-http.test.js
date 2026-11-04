'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net'),
  { fork } = require('node:child_process');
test('native HTTP submission revalidates live identity immediately before input, rejects replacements and preserves idempotency', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-send-http-')),
    socketFile = path.join(directory, 'herdr.sock'),
    calls = [];
  let reads = 0,
    replace = false,
    replacementRead = 2,
    block = false,
    parallel = false,
    agentReads = 0;
  let screen = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol · ~/fixture';
  const agent = () => ({
    pane_id: 'w1:pAZ',
    terminal_id: replace && reads >= replacementRead ? 'replacement' : 'terminal',
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    agent: 'codex',
    name: 'fixture',
    agent_status: 'unknown',
    agent_session: { kind: 'uuid', value: 'fixture-thread' },
    cwd: directory,
  });
  const socket = net.createServer((connection) => {
    connection.on('error', () => {});
    let raw = '';
    connection.on('data', (chunk) => {
      raw += chunk;
      if (!raw.includes('\n')) return;
      const request = JSON.parse(raw.slice(0, raw.indexOf('\n')));
      calls.push(request.method);
      let result = {};
      if (request.method === 'agent.get') {
        reads++;
        agentReads++;
        result = { agent: agent() };
      }
      if (request.method === 'pane.process_info') {
        parallel ||= agentReads > 0;
        result = { process_info: { foreground_processes: [{ pid: process.pid, name: 'codex' }] } };
      }
      if (request.method === 'session.snapshot')
        result = { snapshot: { panes: [agent()], agents: [agent()], tabs: [], workspaces: [] } };
      if (request.method === 'agent.send_keys' && request.params.keys.includes('ctrl+u'))
        screen = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol high · ~/fixture';
      if (request.method === 'pane.read') result = { read: { text: screen } };
      if (request.method === 'agent.prompt' && block) {
        connection.end(
          JSON.stringify({
            id: request.id,
            error: { code: 'agent_blocked', message: 'native question' },
          }) + '\n',
        );
        return;
      }
      setTimeout(() => {
        if (request.method === 'agent.get') agentReads--;
        connection.end(JSON.stringify({ id: request.id, result }) + '\n');
      }, 10);
    });
  });
  await new Promise((resolve) => socket.listen(socketFile, resolve));
  const child = fork(path.join(__dirname, '../server.js'), [], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      HERDR_SOCKET_PATH: socketFile,
      HERDR_BIN: '/does/not/run',
      SWIFT_ROOT_DIR: directory,
      SWIFT_SETTINGS_FILE: path.join(directory, 'config/settings.json'),
      SWIFT_DATA_DIR: path.join(directory, 'data'),
      SWIFT_DIRECT_AUTH: 'trusted-network',
      SWIFT_HIDE_STARTUP_URLS: '1',
      SWIFT_SESSION_CHILD: '1',
      SWIFT_MANAGEMENT_CONFIG: '',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    await new Promise((r) => socket.close(r));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 10000);
    child.on('message', (m) => {
      if (m.swiftSessionPort) {
        clearTimeout(timer);
        resolve(m.swiftSessionPort);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('fixture stopped ' + code));
    });
  });
  const send = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paneId: 'w1:pAZ',
        sessionId: 'fixture-thread',
        text: 'test',
        ...body,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  let result = await send({ id: 'once' });
  assert.equal(result.body.message.status, 'dispatched');
  assert.equal(reads, 3, 'recheck identity after reading the current native composer');
  assert(parallel, 'process identity must be read alongside agent.get');
  assert.equal(
    calls.filter((m) => m === 'pane.read').length,
    2,
    'read composer preparation and current thread without polling Agent readiness',
  );
  const writes = () => calls.filter((m) => m === 'agent.prompt').length;
  assert.equal(writes(), 1);
  await send({ id: 'once' });
  assert.equal(writes(), 1);
  result = await send({ id: 'stale', binding: 'outdated' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SESSION_CHANGED');
  assert.equal(writes(), 1);
  reads = 0;
  replace = true;
  result = await send({ id: 'replaced' });
  assert.equal(result.body.message.status, 'failed');
  assert.equal(result.body.message.error.code, 'SESSION_CHANGED');
  assert.equal(result.body.message.deliveryUncertain, false);
  assert.equal(writes(), 1);
  reads = 0;
  replacementRead = 3;
  result = await send({ id: 'late-replaced' });
  assert.equal(result.body.message.status, 'failed');
  assert.equal(result.body.message.error.code, 'SESSION_CHANGED');
  assert.equal(result.body.message.deliveryUncertain, false);
  assert.equal(writes(), 1);
  replace = false;
  block = true;
  result = await send({ id: 'blocked' });
  assert.equal(result.body.message.status, 'failed');
  assert.equal(result.body.message.error.code, 'agent_blocked');
  assert.equal(result.body.message.retryable, true);
  assert.equal(result.body.message.deliveryUncertain, false);
  block = false;
  const count = writes();
  screen =
    '› \x1b[2mAsk a follow-up question\x1b[0m\n\nSide from main thread · ^/ to switch · ^c to close';
  result = await send({ id: 'side' });
  assert.equal(result.body.message.error.code, 'SIDE_ACTIVE');
  assert.equal(writes(), count);
  screen = 'unrecognized modal';
  result = await send({ id: 'unknown' });
  assert.equal(result.body.message.error.code, 'SIDE_UNKNOWN');
  assert.equal(writes(), count);
  screen = '» \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol ultra · ~/fixture · Ready';
  result = await send({ id: 'unknown', retry: true });
  assert.equal(result.body.message.status, 'dispatched');
  assert.equal(writes(), count + 1);
  await send({ id: 'unknown', retry: true });
  assert.equal(writes(), count + 1);
  screen =
    '■ Selected model is at capacity. Please try a different model.\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol max · wwh · ~/workdir/swift · swift · main · Ready\n? for shortcuts';
  result = await send({ id: 'account-ready' });
  assert.equal(result.body.message.status, 'dispatched');
  assert.equal(writes(), count + 2);
  await send({ id: 'account-ready' });
  assert.equal(writes(), count + 2);
  screen = '› native leftover\n\nGPT-6.1-Sol high · ~/fixture';
  result = await send({ id: 'clear-draft' });
  assert.equal(result.body.message.status, 'dispatched');
  assert.equal(writes(), count + 3);
  assert.equal(calls.filter((m) => m === 'agent.send_keys').length, 1);
  await send({ id: 'clear-draft' });
  assert.equal(writes(), count + 3);
  assert.equal(calls.filter((m) => m === 'agent.send_keys').length, 1);
});

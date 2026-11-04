'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { fork } = require('node:child_process');
const source = process.env.SWIFT_REWIND_SERVER_DIR || path.resolve(__dirname, '..');
test('rewind HTTP preparation is read-only and submission rejects invalid intents before native input', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-rewind-http-'));
  const socketPath = path.join(home, 'herdr.sock'),
    sessionId = '01a16900-1111-7111-8111-111111111111',
    calls = [];
  const archiveDir = path.join(home, '.codex/sessions/2026/10/24');
  fs.mkdirSync(archiveDir, { recursive: true });
  const records = [
    { type: 'session_meta', payload: { id: sessionId, cwd: home, history_mode: 'paginated' } },
  ];
  for (let n = 0; n < 3; n++) {
    const text = n === 1 ? '中文多行\n保持  空格。' : '重复正文',
      turn = 'turn-' + n;
    records.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'message-' + n,
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: turn,
          item: { type: 'UserMessage', id: 'native-' + n, content: [{ type: 'text', text }] },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
    );
  }
  fs.writeFileSync(
    path.join(archiveDir, 'rollout-2026-10-24-' + sessionId + '.jsonl'),
    records
      .map((r, ordinal) => JSON.stringify({ timestamp: '2026-10-24T00:00:00Z', ordinal, ...r }))
      .join('\n') + '\n',
  );
  const agent = {
    pane_id: 'w1:p1',
    terminal_id: 'terminal',
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    agent: 'codex',
    name: 'fixture',
    agent_status: 'idle',
    agent_session: { kind: 'uuid', value: sessionId },
    cwd: home,
  };
  const socket = net.createServer((connection) => {
    connection.on('error', () => {});
    let raw = '';
    connection.on('data', (chunk) => {
      raw += chunk;
      if (!raw.includes('\n')) return;
      const request = JSON.parse(raw.slice(0, raw.indexOf('\n')));
      calls.push(request.method);
      let result = {};
      if (request.method === 'agent.get') result = { agent };
      // The child has this fixture's HOME at process creation; the test runner
      // has another HOME in /proc even after process.env is reassigned.
      if (request.method === 'pane.process_info')
        result = { process_info: { foreground_processes: [{ pid: child.pid, name: 'codex' }] } };
      if (request.method === 'session.snapshot')
        result = { snapshot: { panes: [agent], agents: [agent], tabs: [], workspaces: [] } };
      connection.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise((resolve) => socket.listen(socketPath, resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(?:HERDR_|SWIFT_|AGENT_STUDIO_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(key))
      delete env[key];
  Object.assign(env, {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    HOST: '127.0.0.1',
    PORT: '0',
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN: '/does/not/run',
    SWIFT_ROOT_DIR: home,
    SWIFT_SETTINGS_FILE: path.join(home, 'config/settings.json'),
    SWIFT_DATA_DIR: path.join(home, 'data'),
    SWIFT_DIRECT_AUTH: 'token',
    AGENT_STUDIO_TOKEN: 'fixture-local-token',
    SWIFT_HIDE_STARTUP_URLS: '1',
    SWIFT_SESSION_CHILD: '1',
  });
  const child = fork(path.join(source, 'server.js'), [], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    await new Promise((r) => socket.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout: ' + stderr)), 10000);
    child.on('message', (m) => {
      if (m.swiftSessionPort) {
        clearTimeout(timer);
        resolve(m.swiftSessionPort);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('server exit ' + code + ': ' + stderr));
    });
  });
  const request = async (route, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { 'x-agent-studio-token': 'fixture-local-token' } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const stat = fs.statSync(socketPath),
    runtimeId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  const target = {
    action: 'prepare',
    requestId: 'prepare-one',
    clientId: 'browser',
    runtimeId,
    paneId: 'w1:p1',
    terminalId: 'terminal',
    sessionId,
    messageId: 'message-1',
  };
  assert.equal((await request('/api/agents/rewind', target, false)).status, 401);
  const prepared = await request('/api/agents/rewind', target);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.preparation.sourceText, '中文多行\n保持  空格。');
  assert.equal(
    (await request('/api/agents/rewind', target)).body.preparation.id,
    prepared.body.preparation.id,
  );
  assert.equal(
    (
      await request('/api/agents/rewind', {
        ...target,
        requestId: 'wrong-runtime',
        runtimeId: 'stale',
      })
    ).body.code,
    'RUNTIME_CHANGED',
  );
  assert.equal(
    (
      await request('/api/agents/rewind', {
        ...target,
        requestId: 'wrong-message',
        messageId: 'gone',
      })
    ).body.code,
    'REWIND_MESSAGE_CHANGED',
  );
  assert.equal(
    (await request('/api/agents/rewind', { ...target, action: 'send' })).body.code,
    'INVALID_REWIND_ACTION',
  );
  const invalid = await request('/api/messages', {
    id: 'invalid',
    paneId: target.paneId,
    sessionId,
    text: 'x'.repeat(102401),
    rewind: { preparationId: prepared.body.preparation.id },
  });
  assert.equal(invalid.body.code, 'INVALID_MESSAGE');
  assert.equal(invalid.body.deliveryUncertain, false);
  assert.equal(invalid.body.retryable, false);
  const command = await request('/api/messages', {
    id: 'command',
    paneId: target.paneId,
    sessionId,
    text: '\u0085/model',
    rewind: { preparationId: prepared.body.preparation.id },
  });
  assert.equal(command.status, 202);
  assert.equal(command.body.message.status, 'failed');
  assert.equal(command.body.message.deliveryUncertain, false);
  assert.equal(
    calls.filter((method) => ['agent.prompt', 'pane.send_keys', 'pane.send_input'].includes(method))
      .length,
    0,
  );
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { once } = require('events');
const { spawn } = require('node:child_process');

// All transport writes terminate at this test's Unix socket. No live Herdr is
// contacted, even when the developer is running inside a pane.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-api-test-'));
process.env.HOME = home;
process.env.SWIFT_ROOT_DIR = path.join(home, 'workdir');
process.env.SWIFT_SETTINGS_FILE = path.join(home, 'bootstrap.json');
process.env.SWIFT_DATA_DIR = path.join(home, 'swift-data');
process.env.CODEX_HOME = path.join(home, '.codex');
process.env.HERDR_SOCKET_PATH = path.join(home, 'test.sock');
process.env.AGENT_STUDIO_MESSAGES_FILE = path.join(home, 'messages.json');
process.env.AGENT_STUDIO_TOKEN = 'test-backend-token';
process.env.HERDR_BIN = path.join(__dirname, '..', 'scripts', 'testing', 'raw-terminal-fixture.js');
// /proc exposes the environment present at process creation. Use a separate
// fixture process so its native home matches these isolated archives.
const nativeProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: { ...process.env },
  stdio: 'ignore',
});
const nativeStarted = once(nativeProcess, 'spawn');
require('../lib/agent-catalog').readAgentCatalog = async () => ({
  models: [{ id: 'test-model', efforts: [{ id: 'high' }, { id: 'low' }] }],
});
require('../lib/agent-commands').readAgentCommands = async (provider, cwd) => ({
  provider,
  cwd,
  version: 'fixture',
  commands: [{ name: provider === 'codex' ? 'permissions' : 'effort' }],
});
const { server, herdr, codexSettings, getMessageQueue } = require('../server');
let pane = {
  paneId: 'w-test:p-test',
  terminalId: 'term-test',
  status: 'working',
  baseCwd: '/test',
  agent: { label: 'codex', session: { value: 'session-test' } },
};
herdr.dashboard = async () => ({ focusedPaneId: 'unrelated-pane', panes: [structuredClone(pane)] });
herdr.agentPane = async (paneId) =>
  (await herdr.dashboard()).panes.find((item) => item.paneId === paneId);
// Codex 的设置在终端里切换（lib/codex-settings.js，有自己的按键测试）。这里只替掉那一层，
// 验接口的校验与转交。
let liveSettings = { model: 'test-model', effort: 'high', source: 'codex-native-screen' };
codexSettings.recorded = async () => ({ ...liveSettings });
const updates = [];
codexSettings.apply = async (target, settings) => {
  updates.push([target.agent.session.value, settings]);
  liveSettings = { ...liveSettings, ...settings };
  return { ...liveSettings };
};
const archiveDir = path.join(home, '.codex', 'sessions', '2026', '09', '19');
fs.mkdirSync(archiveDir, { recursive: true });
const archive = path.join(archiveDir, 'rollout-test-session-test.jsonl');
const huge = 'a'.repeat(5000);
fs.writeFileSync(
  archive,
  [
    {
      type: 'turn_context',
      timestamp: '2026-09-19T00:00:00Z',
      payload: { model: 'test-model', effort: 'high' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'tool-test', name: 'exec', arguments: huge },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'tool-test', output: huge },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const inputs = [];
// The queue submits one agent.prompt; the fake socket never touches a live PTY.
const sends = () => inputs.filter((item) => item.method === 'agent.prompt').length;
const lastSend = () => inputs.filter((item) => item.method === 'agent.prompt').at(-1);
let stubComposer = '';
let stubProcesses = [];
let stubNativePromptError = null;
let stubKeyAction = null;
const fakeHerdr = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data;
    if (!buffer.includes('\n')) return;
    const request = JSON.parse(buffer.trim());
    // 只记会改动终端的请求；读画面、进程信息这类只读查询也走这条 socket，不算输入。
    if (request.method === 'pane.process_info') {
      return socket.end(
        JSON.stringify({
          id: request.id,
          result: {
            type: 'pane_process_info',
            process_info: { pane_id: request.params.pane_id, foreground_processes: stubProcesses },
          },
        }) + '\n',
      );
    }
    if (
      request.method === 'agent.prompt' &&
      (stubNativePromptError || (pane.agent?.status || pane.status) === 'blocked')
    )
      return socket.end(
        JSON.stringify({
          id: request.id,
          error: {
            code: stubNativePromptError || 'agent_blocked',
            message: 'Native Agent requires interaction',
          },
        }) + '\n',
      );
    if (request.method !== 'pane.read') inputs.push(request);
    let result = { type: 'input_sent' };
    if (['pane.send_keys', 'agent.send_keys'].includes(request.method))
      stubKeyAction?.(request.params.keys || []);
    if (request.method === 'pane.send_input') stubComposer = String(request.params.text || '');
    if (
      ['pane.send_keys', 'agent.send_keys'].includes(request.method) &&
      (request.params.keys || []).includes('enter')
    )
      stubComposer = '';
    if (request.method === 'pane.read') {
      // 空输入框里那行是 placeholder，终端把它画成暗色；有内容时是正文色。
      const line = stubComposer
        ? `\u001b[0m› ${stubComposer.split('\n')[0]}\u001b[0m`
        : '\u001b[2m› Ask Codex to do anything\u001b[0m';
      result = {
        type: 'pane_read',
        read: {
          pane_id: request.params.pane_id,
          source: request.params.source,
          format: 'ansi',
          text: `${line}\n\nGPT-6.1-Sol · /test\n`,
        },
      };
    }
    socket.end(JSON.stringify({ id: request.id, result }) + '\n');
  });
});
let base;
test.before(async () => {
  await nativeStarted;
  assert.equal(herdr.session, 'swift', 'the default runtime is swift');
  assert.equal(
    herdr.socketPath,
    process.env.HERDR_SOCKET_PATH,
    'an explicit socket must take precedence over the default Session',
  );
  fakeHerdr.listen(process.env.HERDR_SOCKET_PATH);
  await once(fakeHerdr, 'listening');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await getMessageQueue().tick();
  server.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => fakeHerdr.close(resolve)),
  ]);
  nativeProcess.kill('SIGTERM');
  await once(nativeProcess, 'exit');
  fs.rmSync(home, { recursive: true, force: true });
});
async function request(route, method = 'GET', body, auth = true, device = 'default') {
  const response = await fetch(base + route, {
    method,
    headers: {
      'x-agent-studio-device-id': device,
      ...(auth ? { 'x-agent-studio-token': 'test-backend-token' } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('原生端拒绝交互中的消息时保留失败收据，明确重试才再次投递', async () => {
  const originalPane = structuredClone(pane),
    originalRead = herdr.readPane,
    before = sends();
  const originalItems = structuredClone(getMessageQueue().items),
    originalInputCount = inputs.length;
  const ready =
    '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n' +
    'GPT-6.1-Sol medium · /test · Ready · Context 74% used\n? for shortcuts\n';
  try {
    pane.agent = {
      label: 'codex',
      name: 'codex',
      status: 'unknown',
      session: { value: 'codex-test-session' },
    };
    pane.status = 'unknown';
    stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
    herdr.readPane = async () => ready + 'Would you like to run this command?\n';
    stubNativePromptError = 'agent_blocked';
    const body = {
      id: 'unknown-ready-regression',
      paneId: pane.paneId,
      sessionId: pane.agent.session.value,
      text: 'unknown readiness test',
    };
    const held = await request('/api/messages', 'POST', body);
    assert.equal(held.status, 202);
    assert.equal(held.body.message.status, 'failed');
    assert.equal(sends(), before, '审批画面没有写入');
    herdr.readPane = async () => ready;
    stubNativePromptError = null;
    await getMessageQueue().tick();
    assert.equal(sends(), before, '原生拒绝不会变成等待空闲的自动队列');
    await request('/api/messages', 'POST', { ...body, retry: true });
    assert.equal(sends(), before + 1);
    assert.equal(lastSend().params.text, body.text);
    await getMessageQueue().tick();
    assert.equal(sends(), before + 1, '确认存档之前不重复发送');
  } finally {
    Object.assign(pane, originalPane);
    herdr.readPane = originalRead;
    stubProcesses = [];
    stubNativePromptError = null;
    getMessageQueue().items = originalItems;
    getMessageQueue().persist();
    inputs.splice(originalInputCount);
  }
});

test('新 Agent 的会话 ID 先于存档出现时保持可用，首次落盘后自动返回消息', async () => {
  const originalPane = structuredClone(pane),
    originalRead = herdr.readPane,
    inputCount = inputs.length;
  const dir = path.join(home, '.claude', 'projects', '-test');
  const file = path.join(dir, 'claude-new-session.jsonl');
  herdr.readPane = async () => '• Working (12s · Esc to interrupt)\n› Ask Codex to do anything';
  try {
    for (const provider of ['claude', 'codex']) {
      for (const session of [null, { value: `${provider}-new-session` }]) {
        pane.agent = { label: provider, session };
        const { status, body } = await request(`/api/transcript?pane=${pane.paneId}`);
        assert.equal(status, 200);
        assert.equal(body.supported, true);
        assert.equal(body.archivePending, true);
        assert.equal(body.sessionId, session?.value || '');
        assert.equal(body.reason, undefined);
        assert.deepEqual(body.messages, []);
        assert.equal(body.total, 0);
        assert.equal(body.hasMore, false);
        assert(Array.isArray(body.statusline));
        assert.equal(body.activity, '• Working (12s · Esc to interrupt)');
      }
    }
    pane.agent = { label: 'codex', session: null };
    pane.agentTitle = '已有原生会话 | test';
    assert.equal(
      (await request(`/api/transcript?pane=${pane.paneId}`)).body.associationPending,
      true,
    );
    pane.agentTitle = '新会话 | test';
    assert.equal(
      (await request(`/api/transcript?pane=${pane.paneId}`)).body.associationPending,
      false,
    );
    pane.agent = { label: 'claude', session: { value: 'claude-new-session' } };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: 'first-message',
        timestamp: '2026-09-20T00:00:00Z',
        message: { role: 'user', content: '第一条消息' },
      }) + '\n',
    );
    const ready = await request(`/api/transcript?pane=${pane.paneId}`);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.supported, true);
    assert(!ready.body.archivePending);
    assert.equal(ready.body.total, 1);
    assert.equal(ready.body.messages[0].blocks[0].text, '第一条消息');

    // A genuine read failure must not be disguised as a new, empty session.
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.equal((await request(`/api/transcript?pane=${pane.paneId}`)).status, 500);
    pane.agent = { label: 'shell', session: null };
    assert.equal((await request(`/api/transcript?pane=${pane.paneId}`)).body.supported, false);
    assert.equal((await request('/api/transcript?pane=missing-pane')).status, 404);
    assert.equal(inputs.length, inputCount, 'reading a pending archive must not send native input');
  } finally {
    pane = originalPane;
    herdr.readPane = originalRead;
    fs.rmSync(file, { recursive: true, force: true });
  }
});

test('运行中改变目录后聊天 API 读取原生当前存档并持续返回新增消息', async () => {
  const originalPane = structuredClone(pane),
    inputCount = inputs.length;
  const id = '01a16b68-2e81-7e13-a82c-0eda218fddf5';
  const root = process.env.CODEX_HOME,
    file = path.join(archiveDir, `rollout-2026-10-24T08-55-52-${id}.jsonl`);
  const database = path.join(root, 'state_5.sqlite');
  const { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(database);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, file, '/retired/project');
  const record = (role, text) =>
    JSON.stringify({
      type: 'response_item',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    }) + '\n';
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/original/project' } }) +
      '\n' +
      record('user', '目录变化前的用户消息'),
  );
  try {
    pane.baseCwd = '/retired/project';
    pane.agent = { label: 'codex', session: { value: id } };
    const route = `/api/transcript?pane=${pane.paneId}&sessionId=${id}`;
    const first = await request(route);
    assert.equal(first.status, 200);
    assert(!first.body.archivePending);
    assert.equal(first.body.total, 1);
    assert.equal(first.body.messages[0].blocks[0].text, '目录变化前的用户消息');
    fs.appendFileSync(file, record('assistant', '目录变化后的持续输出'));
    const state = await request(route + '&window=0');
    assert.equal(state.body.total, 2);
    assert.equal(state.body.windowless, true);
    assert.notEqual(state.body.historyRevision, first.body.historyRevision);
    const latest = await request(route);
    assert.equal(latest.body.messages.at(-1).blocks[0].text, '目录变化后的持续输出');
    pane.baseCwd = '/original/project';
    assert.equal(
      (await request(route)).body.archivePending,
      true,
      '旧启动目录不再匹配原生当前目录',
    );
    assert.equal(inputs.length, inputCount, '恢复读取不向原生终端发送输入');
  } finally {
    pane = originalPane;
    db.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(database, { force: true });
  }
});

test('前端压缩页面、版本探测与资源缓存使用同一个当前版本', async () => {
  const identity = await fetch(base + '/', { headers: { 'accept-encoding': 'identity' } });
  const plain = await identity.text();
  const zipped = await fetch(base + '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.equal(await zipped.text(), plain);
  assert.equal(zipped.headers.get('cache-control'), 'no-store');
  const versionResponse = await fetch(base + '/frontend-version.json');
  assert.equal(versionResponse.headers.get('cache-control'), 'no-store');
  const { version } = await versionResponse.json();
  assert(plain.includes(`content="${version}"`));
  // 每个资源带自己的版本号：改一个文件只有它换地址（lib/frontend-assets.js 的 fileVersion）。
  const iconVersion = /favicon\.svg\?v=([0-9a-f]+)"/.exec(plain)?.[1];
  const appVersion = /assets\/startup\.js\?v=([0-9a-f]+)"/.exec(plain)?.[1];
  assert(iconVersion && appVersion && iconVersion !== appVersion && iconVersion !== version);
  for (const file of ['sw.js', 'favicon.svg', 'assets/startup.js']) {
    const first = await fetch(base + '/' + file);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const conditional = await fetch(base + '/' + file, {
      headers: { 'if-none-match': first.headers.get('etag') },
    });
    assert.equal(conditional.status, 304);
  }
  const versioned = await fetch(base + `/assets/startup.js?v=${appVersion}`);
  assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const stale = await fetch(base + `/assets/startup.js?v=${iconVersion}`);
  assert.equal(stale.headers.get('cache-control'), 'no-cache', '版本号对不上的地址不能长期缓存');
});

test('消息 HTTP 契约、原生投递收据及幂等，不等待历史消费', async () => {
  const input = { id: 'message-1', paneId: pane.paneId, text: 'first\nsecond' };
  assert.equal((await request('/api/messages', 'POST', input, false)).status, 401);
  const created = await request('/api/messages', 'POST', input);
  assert.equal(created.status, 202);
  assert.equal(created.body.message.status, 'dispatched');
  assert.equal((await request('/api/messages', 'POST', input)).body.message.id, input.id);
  const queued = await request(`/api/messages?pane=${pane.paneId}`);
  assert.equal(queued.body.messages.length, 1);
  await getMessageQueue().tick();
  pane.status = 'idle';
  await getMessageQueue().tick();
  // Herdr 负责多行粘贴和延迟 Enter，Swift 只提交一次，历史消费由原生端负责。
  assert.deepEqual(inputs[0], {
    id: 'swift-message',
    method: 'agent.prompt',
    params: { target: pane.paneId, text: input.text },
  });
  assert.equal(
    inputs.filter((item) => item.method === 'pane.send_keys').length,
    0,
    'Herdr agent.prompt 负责 Enter，Swift 不补按',
  );
  await getMessageQueue().tick();
  assert.equal(sends(), 1);
  assert.equal(
    (await request(`/api/messages?pane=${pane.paneId}&id=${input.id}`, 'DELETE')).status,
    409,
  );
  fs.appendFileSync(
    archive,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.text }],
      },
    }) + '\n',
  );
  await getMessageQueue().tick();
  const consumed = (await request(`/api/messages?pane=${pane.paneId}`)).body.messages[0];
  assert.equal(consumed.status, 'dispatched');
  assert.equal(consumed.deliveryUncertain, false);
  pane.status = 'blocked';
  await request('/api/messages', 'POST', { ...input, id: 'message-2' });
  assert.equal(
    (await request(`/api/messages?pane=${pane.paneId}&id=message-2`, 'DELETE')).body.message.status,
    'cancelled',
  );
  assert.equal((await request('/api/messages?pane=missing')).body.messages.length, 0);
  assert.equal((await request('/api/messages')).status, 400);
});

test('uploaded PNG with a jpg name loads from existing attachment-root aliases through the real image endpoint', async () => {
  const original = fs.readFileSync(archive),
    config = (await request('/api/config')).body;
  const attachments = path.join(config.dataDirectory, 'attachments'),
    actual = attachments + '-test-real';
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hoAAAAASUVORK5CYII=',
    'base64',
  );
  fs.renameSync(attachments, actual);
  fs.symlinkSync(actual, attachments);
  try {
    const upload = await fetch(
      base +
        '/api/attachments?' +
        new URLSearchParams({ pane: pane.paneId, sessionId: 'session-test', name: 'mmexport.jpg' }),
      {
        method: 'POST',
        headers: {
          'x-agent-studio-token': 'test-backend-token',
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      },
    );
    assert.equal(upload.status, 201);
    const { attachment } = await upload.json();
    assert.equal(attachment.name, 'mmexport.jpg');
    assert.equal(attachment.path, fs.realpathSync(attachment.path));
    const legacy = path.join(attachments, attachment.id, attachment.name);
    fs.appendFileSync(
      archive,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: `附件：mmexport.jpg\n文件路径：${JSON.stringify(legacy)}` },
          ],
        },
      }) + '\n',
    );
    const transcript = (await request(`/api/transcript?pane=${pane.paneId}`)).body;
    const image = transcript.messages.flatMap((m) => m.blocks).find((b) => b.kind === 'image');
    assert(image);
    const response = await fetch(
      base +
        '/api/images?' +
        new URLSearchParams({ pane: pane.paneId, sessionId: 'session-test', id: image.id }),
      { headers: { 'x-agent-studio-token': 'test-backend-token' } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert(response.headers.get('x-content-type-options') === 'nosniff');
  } finally {
    fs.writeFileSync(archive, original);
    fs.unlinkSync(attachments);
    fs.renameSync(actual, attachments);
  }
});

test('图片经过认证与会话身份校验，原图单独读取并支持 ETag', async () => {
  const original = fs.readFileSync(archive);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hoAAAAASUVORK5CYII=';
  fs.appendFileSync(
    archive,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_image', image_url: `data:image/png;base64,${png}` }],
      },
    }) + '\n',
  );
  try {
    const transcript = (await request(`/api/transcript?pane=${pane.paneId}`)).body;
    assert.equal(transcript.sessionId, 'session-test');
    const image = transcript.messages.flatMap((m) => m.blocks).find((b) => b.kind === 'image');
    assert(image);
    assert(!JSON.stringify(transcript).includes(png));
    const route = `/api/images?pane=${pane.paneId}&sessionId=session-test&id=${image.id}`;
    assert.equal((await request(route, 'GET', undefined, false)).status, 401);
    assert.equal(
      (await request(route.replace('sessionId=session-test', 'sessionId=other'))).status,
      409,
    );
    assert.equal((await request(route.replace(image.id, 'unknown'))).status, 404);
    const headers = { 'x-agent-studio-token': 'test-backend-token' };
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
    assert.equal(
      (
        await fetch(base + route, {
          headers: { ...headers, 'if-none-match': response.headers.get('etag') },
        })
      ).status,
      304,
    );
  } finally {
    fs.writeFileSync(archive, original);
  }
});

test('goal HTTP 状态独立于存档缓存，清除不会误显示达成，Claude 读取原生事件', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, '.codex', 'goals_1.sqlite'));
  db.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT)');
  const originalPane = structuredClone(pane),
    stat = fs.statSync(archive),
    inputCount = inputs.length;
  try {
    const put = db.prepare('INSERT OR REPLACE INTO thread_goals VALUES (?,?,?)');
    for (const status of ['active', 'paused', 'active', 'complete']) {
      put.run('session-test', 'Objective ' + status, status);
      const response = await request(`/api/transcript?pane=${pane.paneId}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.goal.status, status);
      assert.equal(response.body.goal.objective, 'Objective ' + status);
    }
    assert.equal(fs.statSync(archive).mtimeMs, stat.mtimeMs);
    db.exec('DELETE FROM thread_goals');
    assert.equal((await request(`/api/transcript?pane=${pane.paneId}`)).body.goal, null);
    pane.agent = { label: 'claude', session: { value: 'claude-goal-test' } };
    const dir = path.join(home, '.claude/projects/-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'claude-goal-test.jsonl');
    for (const [value, expected] of [
      [{ met: false, sentinel: true }, 'active'],
      [{ met: true }, 'complete'],
      [{ met: true, sentinel: true }, null],
    ]) {
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'goal_status', condition: 'Claude objective', ...value },
        }) + '\n',
      );
      const response = await request(`/api/transcript?pane=${pane.paneId}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.goal?.status || null, expected);
    }
    // The only extra Herdr traffic is the existing readStatusArea path.
    assert(inputs.slice(inputCount).every((input) => input.method !== 'pane.send_input'));
  } finally {
    pane = originalPane;
    db.close();
  }
});

test('settings GET 读运行中进程的设置，POST 校验目标与候选后交给终端切换', async () => {
  const current = await request(`/api/agent-settings?pane=${pane.paneId}`);
  assert.equal(current.status, 200);
  assert.equal(current.body.model, 'test-model');
  assert.equal(current.body.effort, 'high');
  assert.equal(current.body.editable, true);
  assert.equal(current.body.selector, 'native');
  for (const body of [
    null,
    { paneId: pane.paneId },
    { paneId: pane.paneId, effort: 'invalid' },
    { paneId: pane.paneId, model: 12 },
  ]) {
    assert.equal((await request('/api/agent-settings', 'POST', body)).status, 400);
  }
  assert.equal((await request('/api/agent-settings', 'POST', {})).status, 400, '必须指明 pane');
  assert.equal(
    (
      await request('/api/agent-settings', 'POST', {
        paneId: pane.paneId,
        threadId: 'different',
        effort: 'low',
      })
    ).status,
    409,
  );
  const changed = await request('/api/agent-settings', 'POST', {
    paneId: pane.paneId,
    threadId: 'session-test',
    effort: 'low',
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(updates, [['session-test', { effort: 'low' }]]);
  const refreshed = (await request(`/api/agent-settings?pane=${pane.paneId}`)).body;
  assert.equal(refreshed.effort, 'low');
  assert.equal(refreshed.source, 'codex-native-screen');
  const apply = codexSettings.apply;
  codexSettings.apply = async () => {
    throw Object.assign(new Error('选择器已变化'), { status: 409, code: 'SELECTOR_CHANGED' });
  };
  assert.equal(
    (await request('/api/agent-settings', 'POST', { paneId: pane.paneId, effort: 'low' })).body
      .code,
    'SELECTOR_CHANGED',
  );
  codexSettings.apply = apply;
});

test('工具按 pane/session 查找并返回完整内容，错误有明确状态码', async () => {
  const result = await request(`/api/tool?pane=${pane.paneId}&id=tool-test`);
  assert.equal(result.status, 200);
  assert.equal(result.body.tool.input.text, huge);
  assert.equal(result.body.tool.result.text, huge);
  assert.equal(result.body.tool.truncated, false);
  assert.equal(
    (await request(`/api/tool?pane=${pane.paneId}&id=tool-test&sessionId=other`)).status,
    409,
  );
  assert.equal((await request(`/api/tool?pane=${pane.paneId}&id=missing`)).status, 404);
  assert.equal((await request('/api/tool?pane=missing&id=tool-test')).status, 404);
  assert.equal((await request('/api/tool?pane=missing')).status, 400);
});

test('大响应支持 gzip，禁用压缩仍返回相同正文，工具预览不代替完整详情', async () => {
  const original = fs.readFileSync(archive);
  fs.appendFileSync(
    archive,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compression-check '.repeat(400) }],
      },
    }) + '\n',
  );
  try {
    for (const encoding of ['gzip', 'gzip;q=0']) {
      const response = await fetch(base + `/api/transcript?pane=${pane.paneId}`, {
        headers: { 'x-agent-studio-token': 'test-backend-token', 'accept-encoding': encoding },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
      const body = await response.json();
      assert.ok(JSON.stringify(body.messages).includes('compression-check'));
      const tool = body.messages
        .flatMap((m) => m.blocks)
        .filter((b) => b.kind === 'tools')
        .flatMap((b) => b.items)
        .find((t) => t.id === 'tool-test');
      assert.ok(tool.input.text.length <= 512);
      assert.equal(tool.input.truncated, true);
    }
    const full = await request(`/api/tool?pane=${pane.paneId}&id=tool-test`);
    assert.equal(full.body.tool.input.text, huge);
  } finally {
    fs.writeFileSync(archive, original);
  }
});

test('POST 一步发送：空闲和忙碌都在返回前完成原生投递', async () => {
  const original = pane;
  pane = { ...pane, paneId: 'w-test:direct', status: 'idle' };
  try {
    const body = { id: 'http-direct', paneId: pane.paneId, text: 'direct HTTP delivery' };
    const sent = await request('/api/messages', 'POST', body);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.message.status, 'dispatched');
    assert.ok(sent.body.message.transportAcceptedAt != null);
    assert.equal(lastSend().params.target, pane.paneId);
    const count = sends();
    await request('/api/messages', 'POST', body);
    assert.equal(sends(), count);
    pane.status = 'working';
    const busy = await request('/api/messages', 'POST', { ...body, id: 'http-busy' });
    assert.equal(busy.body.message.status, 'dispatched');
    assert.equal(sends(), count + 1);
    assert.equal(lastSend().params.text, body.text);
  } finally {
    pane = original;
  }
});

test('interrupt 直接发送指定 pane 的 Esc，不读取或改变全局焦点', async (t) => {
  const original = pane,
    read = herdr.readPane,
    savedArchive = fs.readFileSync(archive);
  t.after(() => {
    pane = original;
    herdr.readPane = read;
    fs.writeFileSync(archive, savedArchive);
  });
  pane = { ...pane, runtimeId: 'interrupt-process' };
  herdr.readPane = async () =>
    '• Working (2s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  gpt-6 high · /test · Ready · Context 1%';
  assert.equal(
    (await request('/api/messages/interrupt', 'POST', { paneId: pane.paneId })).status,
    409,
  );
  fs.appendFileSync(
    archive,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'interrupt-turn' },
    }) + '\n',
  );
  const result = await request('/api/messages/interrupt', 'POST', {
    paneId: pane.paneId,
    binding: require('../lib/conversation-state').binding(pane),
    turnId: 'old-ui-turn',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.paneId, pane.paneId);
  assert.equal(result.body.interrupted, true);
  assert.deepEqual(inputs.at(-1), {
    id: 'swift-message',
    method: 'agent.send_keys',
    params: { target: pane.paneId, keys: ['esc'] },
  });
  assert.equal((await request('/api/messages/interrupt', 'POST', {})).status, 400);
  assert.equal(
    (await request('/api/messages/interrupt', 'POST', { paneId: 'missing' })).status,
    404,
  );
  assert.equal(
    (await request('/api/messages/interrupt', 'POST', { paneId: pane.paneId }, false)).status,
    401,
  );
});

test('队列变化经 WebSocket 立即广播 studio.changed', { timeout: 5000 }, async (t) => {
  const WebSocket = require('ws');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/terminal?token=test-backend-token');
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const changed = new Promise((resolve) =>
    ws.on('message', (data, binary) => {
      if (!binary && JSON.parse(String(data)).type === 'studio.changed') resolve();
    }),
  );
  pane.status = 'blocked';
  await request('/api/messages', 'POST', {
    id: 'notify',
    paneId: pane.paneId,
    text: 'notify test',
  });
  await changed;
  await request(`/api/messages?pane=${pane.paneId}&id=notify`, 'DELETE');
  ws.close();
  await once(ws, 'close');
});

test(
  '队列广播带事件序号与变化的 pane，游标接口可补齐且过期要求重新同步',
  { timeout: 5000 },
  async (t) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(
      base.replace('http:', 'ws:') + '/api/terminal?token=test-backend-token',
    );
    t.after(() => ws.terminate());
    await once(ws, 'open');
    const outbox = new Promise((resolve) =>
      ws.on('message', (data, binary) => {
        if (binary) return;
        const value = JSON.parse(String(data));
        if (value.type === 'studio.changed' && value.scope === 'outbox') resolve(value);
      }),
    );
    const before = (await request('/api/events?since=0')).body.cursor;
    pane.status = 'blocked';
    await request('/api/messages', 'POST', {
      id: 'seq-notify',
      paneId: pane.paneId,
      text: 'seq test',
    });
    const notice = await outbox;
    assert.equal(typeof notice.seq, 'number');
    assert(notice.seq > before, '事件序号必须随提交递增');
    assert.deepEqual(notice.paneIds, [pane.paneId], '只应报告实际变化的 pane');

    // 一次提交会产生多次持久化(入队、请求投递、投递结果),所以游标不小于这条通知。
    const caught = await request(`/api/events?since=${before}`);
    assert.equal(caught.status, 200);
    assert.equal(caught.body.reset, false);
    assert(caught.body.cursor >= notice.seq, '游标必须覆盖已广播的序号');
    assert(
      caught.body.events.some(
        (event) => event.seq === notice.seq && event.payload.paneIds.includes(pane.paneId),
      ),
    );
    assert.deepEqual(
      caught.body.events.map((event) => event.seq),
      caught.body.events.map((event) => event.seq).sort((a, b) => a - b),
      '事件必须按序号递增',
    );
    assert.equal(
      (await request(`/api/events?since=${caught.body.cursor}`)).body.events.length,
      0,
      '游标追平后没有新事件',
    );
    assert.equal(
      (await request(`/api/events?since=${caught.body.cursor + 1000}`)).body.reset,
      true,
      '超前游标必须要求重新同步',
    );
    assert.equal((await request('/api/events?since=-1')).status, 400);

    await request(`/api/messages?pane=${pane.paneId}&id=seq-notify`, 'DELETE');
    ws.close();
    await once(ws, 'close');
  },
);

test('HTTP 首次消息允许 session=null，下一条无需等待首条归档出现', async () => {
  pane = {
    paneId: 'w-test:p-new',
    terminalId: 'term-new',
    runtimeId: 'fixture-process',
    status: 'idle',
    baseCwd: '/new-project',
    agent: {
      label: 'codex',
      name: 'new-remote',
      session: null,
      interactiveReady: true,
      launchPending: false,
    },
  };
  const before = sends();
  const created = await request('/api/messages', 'POST', {
    id: 'first-new',
    paneId: pane.paneId,
    text: 'first user message',
    sessionId: null,
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.message.sessionId, null);
  await getMessageQueue().tick();
  assert.equal(sends(), before + 1);
  assert.equal(lastSend().params.target, pane.paneId);
  await request('/api/messages', 'POST', {
    id: 'second-new',
    paneId: pane.paneId,
    text: 'second user message',
  });
  await getMessageQueue().tick();
  assert.equal(sends(), before + 2);
  pane.agent.session = { kind: 'id', value: 'new-session' };
  fs.writeFileSync(
    path.join(archiveDir, 'rollout-test-new-session.jsonl'),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first user message' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
      },
    }) + '\n',
  );
  await getMessageQueue().tick();
  const messages = (await request(`/api/messages?pane=${pane.paneId}`)).body.messages;
  assert.equal(messages[0].status, 'dispatched');
  assert.equal(messages[0].nativeDelivery, true);
  assert.equal(messages[1].nativeDelivery, true);
  await getMessageQueue().tick();
  assert.equal(sends(), before + 2);
});

test('Claude startup confirmation binds to the current directory prompt and explicit pane', async () => {
  const original = structuredClone(pane);
  const readPane = herdr.readPane;
  const screen =
    'Accessing workspace:\n\n /test/project\n\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm';
  try {
    pane = {
      paneId: original.paneId,
      terminalId: 'claude-terminal',
      cwd: '/test/project',
      agent: { label: 'Claude Code', status: 'blocked' },
    };
    herdr.readPane = async () => screen;
    const prompt = await request(`/api/agents/startup?pane=${pane.paneId}`);
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.startup.cwd, '/test/project');
    const challenge = prompt.body.startup.challenge;
    const before = inputs.length;
    assert.equal(
      (
        await request('/api/agents/startup', 'POST', {
          paneId: pane.paneId,
          challenge,
          choice: 'anything',
        })
      ).status,
      400,
    );
    pane.terminalId = 'replacement';
    assert.equal(
      (
        await request('/api/agents/startup', 'POST', {
          paneId: pane.paneId,
          challenge,
          choice: 'trust',
        })
      ).status,
      409,
    );
    pane.terminalId = 'claude-terminal';
    herdr.readPane = async () => 'Approve executing rm?';
    assert.equal(
      (
        await request('/api/agents/startup', 'POST', {
          paneId: pane.paneId,
          challenge,
          choice: 'trust',
        })
      ).status,
      409,
    );
    assert.equal(inputs.length, before);
    herdr.readPane = async () => screen;
    assert.equal(
      (
        await request('/api/agents/startup', 'POST', {
          paneId: pane.paneId,
          challenge,
          choice: 'trust',
        })
      ).status,
      200,
    );
    assert.deepEqual(inputs.at(-1).params, { pane_id: pane.paneId, keys: ['down', 'enter'] });
    assert.equal(
      (
        await request('/api/agents/startup', 'POST', {
          paneId: pane.paneId,
          challenge,
          choice: 'reject',
        })
      ).status,
      200,
    );
    assert.deepEqual(inputs.at(-1).params.keys, ['enter']);
  } finally {
    pane = original;
    herdr.readPane = readPane;
  }
});

test('命令目录鉴权并按指定 pane 选择提供方，不采信调用方指定的 provider', async () => {
  const original = pane;
  try {
    pane = { paneId: 'commands-pane', cwd: '/commands', agent: { label: 'Claude Code' } };
    assert.equal(
      (await request('/api/commands?pane=commands-pane', 'GET', undefined, false)).status,
      401,
    );
    const response = await request('/api/commands?pane=commands-pane&provider=codex');
    assert.equal(response.body.provider, 'claude');
    assert.equal(response.body.cwd, '/commands');
    assert.deepEqual(response.body.commands, [{ name: 'effort' }]);
    assert.equal((await request('/api/commands?pane=missing')).status, 404);
  } finally {
    pane = original;
  }
});

test('附件 HTTP 上传需要鉴权和精确会话，二进制文件能从返回路径完整读取', async (t) => {
  const original = pane;
  pane = {
    paneId: 'attachment-test',
    agent: { label: 'codex', session: { value: 'session-test' } },
  };
  t.after(() => {
    pane = original;
  });
  const bytes = Buffer.from([0, 255, 128, 65]);
  const route = `/api/attachments?pane=${pane.paneId}&sessionId=session-test&name=${encodeURIComponent('测试图片.png')}`;
  const upload = (url, auth = true) =>
    fetch(base + url, {
      method: 'POST',
      body: bytes,
      headers: auth
        ? {
            'x-agent-studio-token': 'test-backend-token',
            'content-type': 'application/octet-stream',
          }
        : {},
    });
  assert.equal((await upload(route, false)).status, 401);
  assert.equal((await upload(route.replace('session-test', 'wrong-session'))).status, 409);
  const response = await upload(route);
  assert.equal(response.status, 201);
  const { attachment } = await response.json();
  assert.equal(attachment.name, '测试图片.png');
  assert.deepEqual(fs.readFileSync(attachment.path), bytes);
  assert.equal(attachment.size, bytes.length);
});

test('兼容工作区接口仅创建原生分组，不从标签推导或新建目录', async () => {
  const originalCreate = herdr.createWorkspace,
    originalStart = herdr.startAgent,
    originalDashboard = herdr.dashboard;
  const root = path.join(os.homedir(), 'workdir'),
    child = path.join(root, 'existing-directory');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'keep.md'), 'keep');
  const calls = [];
  herdr.createWorkspace = async (body) => {
    calls.push(body);
    return { workspace: { workspace_id: 'w-made' }, root_pane: { pane_id: 'p-made' } };
  };
  herdr.startAgent = async (body) => {
    calls.push(body);
    return { paneId: 'started' };
  };
  herdr.dashboard = async () => ({
    panes: [],
    workspaces: [
      { workspaceId: 'w-no-directory', label: 'existing-directory' },
      { workspaceId: 'w-explicit', label: 'arbitrary group', cwd: child },
    ],
  });
  try {
    const initial = fs.readdirSync(root);
    assert.equal(
      (await request('/api/workspaces/create', 'POST', { label: '任意 / 分组' })).status,
      200,
    );
    assert.deepEqual(calls.pop(), { label: '任意 / 分组', cwd: root });
    assert.deepEqual(fs.readdirSync(root), initial);
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (await request('/api/workspaces/create', 'POST', { label: 'same cwd', cwd: child })).status,
        200,
      );
      assert.deepEqual(calls.pop(), { label: 'same cwd', cwd: child });
    }
    const required = await request('/api/agents/start', 'POST', {
      provider: 'codex',
      workspaceId: 'w-no-directory',
    });
    assert.equal(required.status, 400);
    assert.equal(required.body.code, 'WORKSPACE_DIRECTORY_REQUIRED');
    assert.equal(
      (
        await request('/api/agents/start', 'POST', {
          provider: 'codex',
          workspaceId: 'w-no-directory',
          cwd: child,
        })
      ).status,
      201,
    );
    assert.equal(calls.pop().cwd, child);
    assert.equal(
      (await request('/api/agents/start', 'POST', { provider: 'codex', workspaceId: 'w-explicit' }))
        .status,
      201,
    );
    assert.equal(calls.pop().cwd, child);
    assert.equal(
      (
        await request('/api/agents/start', 'POST', {
          provider: 'codex',
          newWorkspace: 'another group',
          cwd: child,
        })
      ).status,
      201,
    );
    assert.equal(calls.pop().cwd, child);
    assert.deepEqual(calls.pop(), { label: 'another group', cwd: child });
    assert.equal(fs.readFileSync(path.join(child, 'keep.md'), 'utf8'), 'keep');
    assert.equal(
      (await request('/api/agents/start', 'POST', { provider: 'codex', workspaceId: 'missing' }))
        .status,
      404,
    );
    for (const kind of ['chat', 'quick']) {
      assert.equal(
        (
          await request('/api/agents/start', 'POST', {
            provider: 'codex',
            kind,
            workspaceId: 'w-explicit',
          })
        ).status,
        201,
      );
      assert.deepEqual(calls.pop(), {
        provider: 'codex',
        kind,
        cwd: root,
        workspaceId: 'w-explicit',
        rootPaneId: null,
      });
    }
    assert.equal(
      (await request('/api/agents/start', 'POST', { provider: 'codex', kind: 'quick' })).status,
      201,
    );
    assert.equal(calls.pop().rootPaneId, 'p-made');
    assert.deepEqual(calls.pop(), { label: 'workdir', cwd: root });
    assert.equal(
      (await request('/api/agents/start', 'POST', { kind: 'chat', paneId: 'p' })).status,
      400,
    );
    assert.equal(calls.length, 0);
  } finally {
    herdr.createWorkspace = originalCreate;
    herdr.startAgent = originalStart;
    herdr.dashboard = originalDashboard;
  }
});

test('session file API isolates the session, previews only recorded writes and rejects stale session ids', async (t) => {
  const original = pane;
  pane = {
    paneId: 'w-test:p-test',
    terminalId: 'term-files',
    baseCwd: home,
    agent: { label: 'codex', session: { value: 'session-test' } },
  };
  t.after(() => {
    pane = original;
  });
  const file = path.join(home, 'session-output.txt');
  fs.writeFileSync(file, '只读正文');
  fs.appendFileSync(
    archive,
    '\n' +
      [
        {
          type: 'response_item',
          timestamp: '2026-09-19T03:00:00Z',
          payload: {
            type: 'function_call',
            call_id: 'file-write',
            name: 'apply_patch',
            arguments: `*** Add File: ${file}`,
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-09-19T03:00:01Z',
          payload: { type: 'function_call_output', call_id: 'file-write', output: 'Success' },
        },
      ]
        .map(JSON.stringify)
        .join('\n') +
      '\n',
  );
  const route = '/api/session-files?pane=w-test:p-test&sessionId=session-test';
  assert.equal((await request(route, 'GET', undefined, false)).status, 401);
  const list = await request(route);
  assert.equal(list.status, 200);
  const entry = list.body.files.find((f) => f.path === file);
  assert.ok(entry);
  const contentRoute = '/api/session-files/content?pane=w-test:p-test&sessionId=session-test';
  assert.equal((await request(contentRoute + '&id=' + entry.id)).body.file.content, '只读正文');
  assert.equal((await request(contentRoute + '&id=unlisted')).status, 404);
  assert.equal(
    (await request('/api/session-files?pane=w-test:p-test&sessionId=other-session')).status,
    409,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '只读正文');
});
test('提问 API 鉴权、匹配当前会话，无法确认归属的同步模态拒绝写入', async (t) => {
  const savedProcesses = stubProcesses;
  stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
  t.after(() => {
    stubProcesses = savedProcesses;
  });
  const savedPane = pane,
    savedRead = herdr.readPane,
    savedArchive = fs.readFileSync(archive);
  t.after(() => {
    pane = savedPane;
    herdr.readPane = savedRead;
    fs.writeFileSync(archive, savedArchive);
  });
  pane = {
    paneId: 'question-pane',
    terminalId: 'question-terminal',
    status: 'blocked',
    baseCwd: '/test',
    agent: { name: 'codex-question', label: 'codex', session: { value: 'session-test' } },
  };
  const questions = [
    {
      id: 'color',
      header: 'Color',
      question: 'Choose a color?',
      options: [
        { label: 'Red', description: 'Red color' },
        { label: 'Blue', description: 'Blue color' },
      ],
    },
  ];
  fs.writeFileSync(
    archive,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'q-api',
        arguments: JSON.stringify({ questions }),
      },
    }) + '\n',
  );
  herdr.readPane = async () =>
    '\n  Question 1/1 (1 unanswered)\n  Choose a color?\n  › 1. Red    Red color\n    2. Blue   Blue color\n    3. None of the above  Optionally, add details in notes (tab).\n  tab to add notes | enter to submit answer | esc to interrupt';
  assert.equal(
    (await request('/api/agents/questions?pane=question-pane', 'GET', undefined, false)).status,
    401,
  );
  const q = (await request('/api/agents/questions?pane=question-pane')).body.question;
  assert.equal(q.question, 'Choose a color?');
  const count = inputs.length;
  assert.equal(
    (await request('/api/agents/questions', 'POST', { ...q, sessionId: 'wrong', choices: [0] }))
      .status,
    409,
  );
  assert.equal(inputs.length, count);
  const unknown = await request('/api/agents/questions', 'POST', { ...q, choices: [1] });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.code, 'SIDE_UNKNOWN');
  assert.match(unknown.body.message, /当前原生输入位置/);
  assert.match(unknown.body.diagnosticId, /^[\w-]{36}$/);
  assert.equal(
    (await request('/api/agents/questions', 'POST', { ...q, choices: [1] })).status,
    409,
  );
  assert.equal(inputs.length, count);
});
test('真实 ANSI 前景确认通过 HTTP 归属检查，普通消息拒绝且诊断不含目标内容', async (t) => {
  const savedPane = pane,
    savedRead = herdr.readPane,
    savedProcesses = stubProcesses;
  t.after(() => {
    pane = savedPane;
    herdr.readPane = savedRead;
    stubProcesses = savedProcesses;
    stubKeyAction = null;
  });
  pane = {
    paneId: 'native-panel-http',
    terminalId: 'native-terminal-http',
    status: 'blocked',
    baseCwd: '/test',
    agent: { name: 'codex-panel-http', label: 'codex', session: { value: 'session-test' } },
  };
  stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
  const captures = require('./fixtures/codex-native-panels-0164.json').captures;
  const first = captures.find((c) => c.state === '03-resume-goal').ansi;
  const second = first
    .replace('› 1. Resume goal', '  1. Resume goal')
    .replace('  2. Leave paused', '› 2. Leave paused');
  let screen = first;
  const writes = [];
  herdr.readPane = async () => screen;
  stubKeyAction = (keys) => {
    writes.push(keys);
    if (keys[0] === 'down') screen = second;
    if (keys[0] === 'enter') screen = captures.find((c) => c.state === '01-main').ansi;
  };
  const sendCount = sends();
  const refused = await request('/api/messages', 'POST', {
    id: 'modal-refusal-http',
    paneId: pane.paneId,
    sessionId: 'session-test',
    text: 'PRIVATE MESSAGE',
  });
  assert.equal(refused.body.message.error.code, 'QUESTION_PENDING');
  assert.equal(refused.body.message.deliveryUncertain, false);
  assert.equal(sends(), sendCount);
  assert.match(refused.body.message.error.diagnosticId, /^[\w-]{36}$/);
  const q = (await request('/api/agents/questions?pane=' + pane.paneId)).body.question;
  assert.equal(q.nativeModal.kind, 'goal-resume');
  const body = { ...q, choices: [1], requestId: 'native-panel-answer-http' };
  assert.equal((await request('/api/agents/questions', 'POST', body)).body.delivery, 'sent');
  assert.equal((await request('/api/agents/questions', 'POST', body)).body.repeated, true);
  assert.deepEqual(writes, [['down'], ['enter']]);
  assert.equal((await request('/api/diagnostics/native', 'GET', undefined, false)).status, 401);
  const diagnostics = (await request('/api/diagnostics/native')).body;
  assert(
    diagnostics.events.some(
      (event) => event.code === 'QUESTION_PENDING' && event.kind === 'goal-resume',
    ),
  );
  assert(!JSON.stringify(diagnostics).includes('PRIVATE MESSAGE'));
  assert(!JSON.stringify(diagnostics).includes('Verify fixture popup lifecycle'));
});
test('尚未报告会话 ID 的启动菜单使用进程和终端验证，经原生确认后创建会话', async (t) => {
  const savedPane = pane,
    savedRead = herdr.readPane,
    savedProcesses = stubProcesses;
  t.after(() => {
    pane = savedPane;
    herdr.readPane = savedRead;
    stubProcesses = savedProcesses;
    stubKeyAction = null;
  });
  pane = {
    paneId: 'startup-menu-http',
    terminalId: 'startup-terminal-http',
    status: 'blocked',
    baseCwd: '/test',
    agent: { name: 'codex-startup-http', label: 'codex', session: null },
  };
  stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
  let screen =
    '\x1b[1mSelect startup option\x1b[0m\n\n› 1. Continue\n  2. Go back\n\nenter select · esc back';
  const writes = [];
  herdr.readPane = async () => screen;
  stubKeyAction = (keys) => {
    writes.push(keys);
    if (keys[0] === 'enter') {
      pane = { ...pane, agent: { ...pane.agent, session: { value: 'session-test' } } };
      screen = '› Ask Codex to do anything\n\nGPT-6.1-Sol max · /test';
    }
  };
  const q = (await request('/api/agents/questions?pane=' + pane.paneId)).body.question;
  assert.equal(q.preSession, true);
  assert.equal(q.sessionId, '');
  assert.equal(q.canWrite, true);
  const body = { ...q, choices: [0], requestId: 'startup-answer-http' };
  const result = await request('/api/agents/questions', 'POST', body);
  assert.equal(result.status, 200);
  assert.equal(result.body.delivery, 'sent');
  assert.equal((await request('/api/agents/questions', 'POST', body)).body.repeated, true);
  assert.deepEqual(writes, [['enter']]);
});
test('状态栏警告经完整 HTTP 门禁进入，只允许所属租约操作并保留警告返回', async (t) => {
  const savedPane = pane,
    savedRead = herdr.readPane,
    savedProcesses = stubProcesses,
    savedComposer = stubComposer;
  t.after(() => {
    pane = savedPane;
    herdr.readPane = savedRead;
    stubProcesses = savedProcesses;
    stubComposer = savedComposer;
    stubKeyAction = null;
  });
  pane = {
    paneId: 'warnings-http',
    terminalId: 'warnings-terminal-http',
    status: 'working',
    baseCwd: '/test',
    agent: {
      name: 'codex-warnings-http',
      label: 'codex',
      status: 'working',
      session: { value: 'session-test' },
    },
  };
  stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
  stubComposer = '';
  let open = false,
    index = 1;
  const kept = new Set(),
    writes = [];
  herdr.readPane = async () =>
    open
      ? `History\n\n\x1b[1mWarnings · ${index} of 2 · MCP · fixture\x1b[0m\n\nFixture warning ${index}\n\nk keep & next · esc dismiss & close`
      : `History\n\n› ${stubComposer || '\x1b[2mAsk Codex to do anything\x1b[0m'}\n\nGPT-6.1-Sol max · /test · Ready\n? for shortcuts`;
  stubKeyAction = (keys) => {
    writes.push(keys);
    for (const key of keys) {
      if (key === 'enter' && stubComposer === '/warnings') {
        open = true;
        index = 1;
      } else if (open && key === 'right') index = Math.min(2, index + 1);
      else if (open && key === 'left') index = Math.max(1, index - 1);
      else if (open && key === 'k') {
        kept.add(index);
        if (index === 2) open = false;
        else index++;
      }
    }
  };
  const target = {
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    sessionId: 'session-test',
    runtimeId: herdr.normalizeSnapshot({}).runtimeId,
    clientId: 'statusbar-warning-client',
  };
  let reply = await request('/api/command-interaction', 'POST', {
    ...target,
    action: 'execute',
    text: '/warnings',
    requestId: 'http-warning-open',
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.surface, 'warnings');
  const before = sends();
  const refused = await request('/api/messages', 'POST', {
    id: 'warning-http-no-message',
    paneId: pane.paneId,
    sessionId: 'session-test',
    text: 'must remain a local draft',
  });
  assert.equal(refused.body.message.error.code, 'QUESTION_PENDING');
  assert.equal(sends(), before);
  reply = await request('/api/command-interaction', 'POST', {
    ...target,
    action: 'key',
    key: 'right',
    requestId: 'http-warning-next',
    leaseId: reply.body.leaseId,
    revision: reply.body.revision,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.warningIndex, 2);
  for (let i = 0; reply.body.mode === 'menu' && i < 6; i++)
    reply = await request('/api/command-interaction', 'POST', {
      ...target,
      action: 'close',
      requestId: 'http-warning-close-' + i,
      leaseId: reply.body.leaseId,
      revision: reply.body.revision,
    });
  assert.equal(reply.status, 200);
  assert(!['menu', 'query'].includes(reply.body.mode));
  assert.deepEqual([...kept].sort(), [1, 2]);
  assert(!writes.some((keys) => keys.includes('esc')));
  assert.equal(sends(), before);
});
test('投递 API 只恢复停止后选中的那条暂停消息，认证与会话校验不变', async (t) => {
  const savedPane = pane;
  t.after(() => {
    pane = savedPane;
  });
  pane = {
    paneId: 'delivery-pane',
    terminalId: 'delivery-terminal',
    status: 'blocked',
    baseCwd: '/test',
    agent: { name: 'codex-delivery', label: 'codex', session: { value: 'session-test' } },
  };
  for (const id of ['stay-paused', 'resume-selected'])
    await getMessageQueue().enqueue({
      id,
      paneId: pane.paneId,
      sessionId: 'session-test',
      text: id,
    });
  await getMessageQueue().tick();
  const count = sends();
  getMessageQueue().interrupted(pane);
  pane.status = 'working';
  assert.equal(
    (
      await request(
        '/api/messages/deliver',
        'POST',
        { id: 'resume-selected', paneId: pane.paneId },
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/api/messages/deliver', 'POST', {
        id: 'resume-selected',
        paneId: pane.paneId,
        sessionId: 'wrong',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('/api/messages/deliver', 'POST', {
        id: 'resume-selected',
        paneId: pane.paneId,
        sessionId: 'session-test',
      })
    ).status,
    202,
  );
  await getMessageQueue().tick();
  assert.equal(sends(), count + 1);
  assert.deepEqual(lastSend().params, { target: 'delivery-pane', text: 'resume-selected' });
  const messages = (await request('/api/messages?pane=delivery-pane')).body.messages;
  assert.equal(messages.find((x) => x.id === 'stay-paused').paused, true);
  assert.equal(
    (await request('/api/messages?pane=delivery-pane&id=stay-paused', 'DELETE')).body.message
      .status,
    'cancelled',
  );
});

test('工作中的独立 Codex 修改 Goal，无法确认模态归属时要求在终端完成确认', async (t) => {
  const savedProcesses = stubProcesses;
  stubProcesses = [{ pid: nativeProcess.pid, name: 'codex' }];
  t.after(() => {
    stubProcesses = savedProcesses;
  });
  const savedPane = pane,
    read = herdr.readPane;
  t.after(() => {
    pane = savedPane;
    herdr.readPane = read;
  });
  pane = {
    paneId: 'goal-pane',
    terminalId: 'goal-terminal',
    status: 'working',
    baseCwd: '/test',
    agent: { label: 'codex', session: { value: 'session-test' } },
  };
  const objective = '根据公开信息重新审查精度问题\n补充验收说明';
  const body = {
    id: 'goal-http',
    paneId: pane.paneId,
    sessionId: 'session-test',
    text: '/goal ' + objective,
  };
  const count = sends();
  assert.equal((await request('/api/messages', 'POST', body, false)).status, 401);
  assert.equal(
    (await request('/api/messages', 'POST', { ...body, sessionId: 'wrong' })).status,
    409,
  );
  const sent = await request('/api/messages', 'POST', body);
  assert.equal(sent.status, 202);
  assert.equal(sent.body.message.status, 'dispatched');
  assert.deepEqual(lastSend().params, { target: pane.paneId, text: body.text });
  await request('/api/messages', 'POST', body);
  assert.equal(sends(), count + 1);
  herdr.readPane = async () =>
    'Replace goal?\nNew objective: ' +
    objective +
    '\n› 1. Replace current goal  Set the new objective and start it now\n  2. Cancel                Keep the current goal\nPress enter to confirm or esc to go back';
  const question = (await request('/api/agents/questions?pane=goal-pane')).body.question;
  assert.equal(question.toolId, 'goal-confirmation');
  const inputCount = inputs.length;
  assert.equal(
    (await request('/api/agents/questions', 'POST', { ...question, choices: [0] })).body.code,
    'SIDE_UNKNOWN',
  );
  assert.equal(inputs.length, inputCount, '无法确认会话归属时不发送 Enter');
  assert.equal(sends(), count + 1);
  herdr.readPane = async () =>
    'Working (15s)\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol · /test';
  assert.equal((await request('/api/agents/questions?pane=goal-pane')).body.question, null);
  // Queued before the update: the same delivery button now accepts Goal.
  await getMessageQueue().enqueue({ ...body, id: 'old-goal-http', text: '/goal 补充目标' });
  const delivered = await request('/api/messages/deliver', 'POST', {
    id: 'old-goal-http',
    paneId: pane.paneId,
    sessionId: 'session-test',
  });
  assert.equal(delivered.status, 202);
  assert.equal(delivered.body.message.status, 'dispatched');
});

test('历史 HTTP 恢复只接受原生标识，重复请求合并，关闭后重新入列', async () => {
  const cwd = path.join(home, 'workdir');
  const id = 'history-claude-session';
  const dir = path.join(home, '.claude/projects/history');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, id + '.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd,
      message: { role: 'user', content: '历史验收' },
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  const originalDashboard = herdr.dashboard,
    originalResume = herdr.resumeAgent,
    originalClose = herdr.closeSession;
  let restored = null,
    resumes = 0,
    closes = 0;
  herdr.dashboard = async () => ({
    panes: [
      { ...pane, cwd, baseCwd: cwd, workspaceId: 'w-history' },
      ...(restored ? [restored] : []),
    ],
    workspaces: [{ workspaceId: 'w-history', label: '历史测试' }],
  });
  herdr.resumeAgent = async (entry, workspaceId) => {
    resumes++;
    assert.equal(entry.cwd, cwd);
    assert.equal(workspaceId, 'w-history');
    await new Promise((resolve) => setTimeout(resolve, 30));
    restored = {
      paneId: 'w-history:restored',
      terminalId: 'history-terminal',
      cwd,
      workspaceId,
      agent: { label: 'claude', session: { value: id } },
    };
    return { paneId: restored.paneId, sessionId: id };
  };
  // 会话身份由路由按 exactPane 的视图核对；closeSession 只拿终端 id。它若再拿 sessionId
  // 按 Herdr 原始表比，Codex 附属会话通道补充的身份就对不上，关闭一律 SESSION_CHANGED。
  herdr.closeSession = async (target, expected) => {
    assert.equal(target, restored.paneId);
    assert.equal(expected.sessionId, undefined);
    assert.equal(expected.terminalId, restored.terminalId);
    closes++;
    restored = null;
  };
  try {
    const list = await request('/api/history');
    assert(list.body.sessions.some((s) => s.sessionId === id));
    const body = { provider: 'claude', sessionId: id, cwd: '/attacker/directory' };
    const responses = await Promise.all([
      request('/api/history/resume', 'POST', body),
      request('/api/history/resume', 'POST', body),
    ]);
    assert(responses.every((r) => r.status === 201));
    assert.equal(resumes, 1);
    assert(!(await request('/api/history')).body.sessions.some((s) => s.sessionId === id));
    await request('/api/history/resume', 'POST', body);
    assert.equal(resumes, 1);
    assert.equal(
      (
        await request('/api/sessions/close', 'POST', {
          target: restored.paneId,
          sessionId: 'wrong',
        })
      ).status,
      409,
    );
    assert.equal(closes, 0);
    assert.equal(
      (
        await request('/api/sessions/close', 'POST', {
          target: restored.paneId,
          terminalId: restored.terminalId,
          sessionId: id,
        })
      ).status,
      200,
    );
    assert.equal(closes, 1);
    assert((await request('/api/history')).body.sessions.some((s) => s.sessionId === id));
  } finally {
    herdr.dashboard = originalDashboard;
    herdr.resumeAgent = originalResume;
    herdr.closeSession = originalClose;
  }
});

test('根目录 HTTP 设置验证目录并同步工作区、会话和临时会话落点', async () => {
  const original = (await request('/api/config')).body.rootDirectory;
  const next = path.join(home, 'another-root');
  fs.mkdirSync(next);
  const previousDashboard = herdr.dashboard,
    previousStart = herdr.startAgent,
    previousCreate = herdr.createWorkspace;
  const starts = [],
    creates = [];
  herdr.dashboard = async () => ({
    focusedPaneId: 'outside',
    workspaces: [{ workspaceId: 'old' }, { workspaceId: 'new' }],
    panes: [
      { paneId: 'outside', workspaceId: 'old', cwd: original },
      { paneId: 'inside', workspaceId: 'new', cwd: path.join(next, 'project') },
    ],
  });
  herdr.startAgent = async (payload) => {
    starts.push(payload);
    return { paneId: 'inside' };
  };
  herdr.createWorkspace = async (payload) => {
    creates.push(payload);
    return {
      workspace: { workspace_id: `w-${creates.length}` },
      root_pane: { pane_id: `p-${creates.length}` },
    };
  };
  try {
    assert.equal(
      (await request('/api/config', 'POST', { rootDirectory: next }, false)).status,
      401,
    );
    assert.equal((await request('/api/config', 'POST', { rootDirectory: 'relative' })).status, 400);
    assert.equal((await request('/api/config')).body.rootDirectory, original);
    assert.equal((await request('/api/config', 'POST', { rootDirectory: next })).status, 200);
    const config = (await request('/api/config')).body;
    assert.equal(config.rootDirectory, next);
    assert.equal(config.temporaryCwd, next);
    assert.equal(config.defaultCwd, next);
    const snapshot = (await request('/api/snapshot')).body;
    assert.deepEqual(
      snapshot.panes.map((p) => p.paneId),
      ['outside', 'inside'],
    );
    assert.equal(snapshot.focusedPaneId, 'outside');
    assert.deepEqual(
      snapshot.workspaces.map((w) => w.workspaceId),
      ['old', 'new'],
    );
    assert.equal((await request('/api/history')).body.total, 0);
    assert.equal((await request('/api/workspaces/create', 'POST', { label: '项目' })).status, 200);
    assert.equal(creates[0].cwd, next);
    assert.equal(
      (await request('/api/agents/start', 'POST', { provider: 'codex', kind: 'chat' })).status,
      201,
    );
    assert.equal(starts[0].cwd, next);
    // 换根之后，直接属于根的会话要落进**新根**同名的那个工作区，不能还挂在旧的上。
    assert.deepEqual(creates[1], { label: path.basename(next), cwd: next });
    assert.equal(starts[0].workspaceId, 'w-2');
  } finally {
    await request('/api/config', 'POST', { rootDirectory: original });
    herdr.dashboard = previousDashboard;
    herdr.startAgent = previousStart;
    herdr.createWorkspace = previousCreate;
  }
});

test('根目录和设备共同选择配置，切换后的消息队列相互独立', async () => {
  const original = (await request('/api/config')).body.rootDirectory,
    next = path.join(home, 'device-root');
  fs.mkdirSync(next);
  const previousPane = pane,
    previousDashboard = herdr.dashboard;
  pane = {
    paneId: 'device-pane',
    terminalId: 'device-terminal',
    cwd: original,
    agent: {
      label: 'codex',
      name: 'device-agent',
      status: 'working',
      session: { value: 'device-session' },
    },
  };
  herdr.dashboard = async () => ({ panes: [pane], workspaces: [] });
  try {
    const save = (rootDirectory, device, settings) =>
      request('/api/settings', 'POST', { rootDirectory, settings }, true, device);
    assert.equal((await save(original, 'phone', { theme: 'light', fontSize: 18 })).status, 200);
    assert.equal((await save(original, 'desktop', { theme: 'black', fontSize: 13 })).status, 200);
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'phone')).body.settings.fontSize,
      18,
    );
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'desktop')).body.settings.fontSize,
      13,
    );
    assert.equal(
      (
        await request('/api/messages', 'POST', {
          id: 'root-owned',
          paneId: pane.paneId,
          sessionId: 'device-session',
          text: '留在原目录',
        })
      ).status,
      202,
    );
    const queueFile = getMessageQueue().file;
    assert(
      queueFile.startsWith(path.join((await request('/api/config')).body.dataDirectory, 'state')),
    );
    await request('/api/config', 'POST', { rootDirectory: next });
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'phone')).body.settings.fontSize,
      14,
    );
    assert.equal((await request('/api/messages?pane=device-pane')).body.messages.length, 0);
    assert.equal((await save('/not-loaded', 'phone', { theme: 'soft' })).status, 409);
    assert.equal((await save(original, 'phone', { theme: 'soft' })).status, 200);
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'phone')).body.rootDirectory,
      next,
    );
    await save(next, 'phone', { fontSize: 16 });
    await request('/api/config', 'POST', { rootDirectory: original });
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'phone')).body.settings.fontSize,
      18,
    );
    assert.equal((await request('/api/messages?pane=device-pane')).body.messages.length, 1);
    assert.equal(getMessageQueue().file, queueFile);
  } finally {
    await request('/api/config', 'POST', { rootDirectory: original });
    pane = previousPane;
    herdr.dashboard = previousDashboard;
  }
});

test('切换根目录时尚未完成的消息写入仍属于原目录', async () => {
  const original = (await request('/api/config')).body.rootDirectory,
    next = path.join(home, 'concurrent-root');
  fs.mkdirSync(next);
  const previousDashboard = herdr.dashboard;
  let release, entered;
  const held = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  let first = true;
  const target = {
    paneId: 'held-pane',
    terminalId: 'held-terminal',
    cwd: original,
    agent: {
      label: 'codex',
      name: 'held-agent',
      status: 'working',
      session: { value: 'held-session' },
    },
  };
  herdr.dashboard = async () => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return { panes: [target], workspaces: [] };
  };
  try {
    const pending = request('/api/messages', 'POST', {
      id: 'held-write',
      paneId: target.paneId,
      sessionId: 'held-session',
      text: '异步写入',
    });
    await started;
    const oldQueue = getMessageQueue();
    await request('/api/config', 'POST', { rootDirectory: next });
    release();
    assert.equal((await pending).status, 202);
    assert.equal((await request('/api/messages?pane=held-pane')).body.messages.length, 0);
    assert(oldQueue.persisted().some((item) => item.id === 'held-write'));
  } finally {
    release();
    await request('/api/config', 'POST', { rootDirectory: original });
    herdr.dashboard = previousDashboard;
  }
});

test('正文接口带的提问是完整对象，不是提问正文那一串字', async () => {
  const savedPane = structuredClone(pane),
    savedArchive = fs.readFileSync(archive, 'utf8');
  const savedReadPane = herdr.readPane;
  // 终端画面：面板已经收起，屏幕上只剩「N unanswered question」那一行和输入框。
  herdr.readPane = async () =>
    '• Queued follow-up inputs\n     ? 1 question\n       alt+↑ to answer\n\n   › Ask Codex to do anything\n     gpt-6-astra high · ~/workdir · Working';
  try {
    // ⚠️ 存档按会话 id 定位，而前面的测试会把全局 pane 换掉 —— 这里要显式写死
    // session-test，不能拿当时的 pane 去克隆。
    pane = {
      paneId: 'w-test:p-question',
      terminalId: 'term-test',
      status: 'working',
      baseCwd: '/test',
      agent: { label: 'codex', session: { value: 'session-test' } },
    };
    // Codex 的异步提问：存档里挂着，终端面板已经收起。
    fs.writeFileSync(
      archive,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'request_user_input_async',
            call_id: 'call-q',
            arguments: JSON.stringify({
              questions: [{ title: '要不要继续推送？', options: ['继续', '先停一下'] }],
            }),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-q',
            output: JSON.stringify({ accepted: true }),
          },
        }),
      ].join('\n') + '\n',
    );
    const body = (await request(`/api/transcript?pane=${pane.paneId}&state=1`)).body;
    // ⚠️ `agentQuestions.read()` 返回的就是提问对象，别再往里取一层 —— 它自己有一个
    // `question` 字段（提问正文）。取成字符串的话 paneId、options、challenge 全丢，
    // 页面渲染出一个没有选项的空壳，提交时报「缺少 pane」。主路径正是走这条。
    assert.equal(typeof body.question, 'object', '提问要是对象，不是那一串字');
    assert.equal(body.question.paneId, pane.paneId, '没有 paneId 就提交不了');
    assert.equal(body.question.sessionId, 'session-test');
    assert.equal(body.question.question, '要不要继续推送？');
    assert.deepEqual(
      body.question.options.map((option) => option.label),
      ['继续', '先停一下'],
    );
    assert(body.question.challenge, '没有 challenge 就核对不了是不是同一个问题');
    // 与单独那个接口给的是同一个东西。
    const alone = (await request(`/api/agents/questions?pane=${pane.paneId}`)).body.question;
    assert.equal(alone.challenge, body.question.challenge);
  } finally {
    pane = savedPane;
    herdr.readPane = savedReadPane;
    fs.writeFileSync(archive, savedArchive);
  }
});

test('统一响应带会话身份与历史版本，60→200 补齐，空回滚清除，旧停止拒绝', async () => {
  const saved = fs.readFileSync(archive, 'utf8'),
    savedPane = structuredClone(pane),
    before = inputs.length;
  try {
    pane = {
      paneId: 'w-test:p-test',
      terminalId: 'term-test',
      status: 'working',
      baseCwd: '/test',
      agent: { label: 'codex', session: { value: 'session-test' } },
    };
    const records = (n) =>
      Array.from({ length: n }, (_, i) =>
        JSON.stringify({
          type: 'response_item',
          timestamp: new Date(1700000000000 + i * 1000).toISOString(),
          payload: {
            type: 'message',
            id: `sync-${i}`,
            role: 'user',
            content: [{ type: 'input_text', text: `m${i}` }],
          },
        }),
      ).join('\n') + '\n';
    fs.writeFileSync(archive, records(60));
    const first = await request(`/api/transcript?pane=${pane.paneId}&state=1`);
    assert.equal(first.status, 200);
    assert(first.body.binding);
    assert(first.body.historyRevision);
    assert(Array.isArray(first.body.outbox));
    fs.writeFileSync(archive, records(200));
    const expanded = await request(`/api/transcript?pane=${pane.paneId}&from=sync-0&state=1`);
    assert.equal(expanded.body.messages.length, 200);
    const stale = await request(
      `/api/transcript?pane=${pane.paneId}&before=sync-30&revision=${first.body.historyRevision}`,
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'HISTORY_CHANGED');
    fs.appendFileSync(
      archive,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 200 },
      }) + '\n',
    );
    const empty = await request(`/api/transcript?pane=${pane.paneId}&from=sync-0&state=1`);
    assert.deepEqual(empty.body.messages, []);
    assert.equal(empty.body.replace, true);
    assert.equal(
      (
        await request('/api/messages/interrupt', 'POST', {
          paneId: pane.paneId,
          binding: first.body.binding,
          turnId: 'old-turn',
        })
      ).status,
      409,
    );
    pane.terminalId = 'replaced';
    assert.equal(
      (
        await request('/api/messages/interrupt', 'POST', {
          paneId: pane.paneId,
          binding: first.body.binding,
          turnId: 'old-turn',
        })
      ).status,
      409,
    );
    assert.equal(inputs.length, before, '旧操作没有任何终端写入');
  } finally {
    fs.writeFileSync(archive, saved);
    pane = savedPane;
  }
});

test('swift serves only the new API path', async () => {
  const response = await fetch(base + '/herdr/health');
  assert.equal(response.status, 404);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.service, 'swift');
});

test('读取分页历史即同步弃用队列，不需要另发消息触发，且保留窗口之外的有效回执', async () => {
  const saved = fs.readFileSync(archive, 'utf8'),
    savedPane = structuredClone(pane);
  const queue = getMessageQueue(),
    savedItems = structuredClone(queue.items),
    before = sends();
  try {
    pane = {
      paneId: 'w-test:p-test',
      terminalId: 'term-test',
      status: 'working',
      baseCwd: '/test',
      agent: { label: 'codex', session: { value: 'session-test' } },
    };
    const user = (id) => ({
      type: 'response_item',
      payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text: id }] },
    });
    fs.writeFileSync(
      archive,
      [
        user('retained'),
        user('removed'),
        { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
        user('new-branch'),
      ]
        .map(JSON.stringify)
        .join('\n') + '\n',
    );
    queue.items = ['retained', 'removed'].map((id) => ({
      id: `outbox-${id}`,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      agent: 'codex',
      sessionId: 'session-test',
      text: id,
      status: 'consumed',
      consumedMessageId: id,
      consumedRechecked: true,
    }));
    const result = await request(`/api/transcript?pane=${pane.paneId}&state=1&limit=1`);
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.messages.map((message) => message.id),
      ['new-branch'],
    );
    assert.deepEqual(
      result.body.outbox.map((item) => item.status),
      ['consumed', 'discarded'],
    );
    assert.equal(result.body.outbox[1].consumedMessageId, 'removed');
    assert.equal(sends(), before, '只读历史不能触发消息投递');
    assert.equal(queue.persisted()[1].status, 'discarded');
  } finally {
    fs.writeFileSync(archive, saved);
    pane = savedPane;
    queue.items = savedItems;
    queue.persist();
  }
});

test(
  '个人资料按根目录共享，图片需要认证，上传跨越目录切换仍写入原目录',
  { timeout: 10000 },
  async (t) => {
    const WebSocket = require('ws');
    const original = (await request('/api/config')).body.rootDirectory;
    const first = fs.mkdtempSync(path.join(home, 'profile-first-'));
    const second = fs.mkdtempSync(path.join(home, 'profile-second-'));
    t.after(async () => {
      await request('/api/config', 'POST', { rootDirectory: original });
    });
    await request('/api/config', 'POST', { rootDirectory: first });
    const ws = new WebSocket(
      base.replace('http:', 'ws:') + '/api/terminal?token=test-backend-token',
      { headers: { 'x-agent-studio-device-id': 'other-device' } },
    );
    t.after(() => ws.terminate());
    await once(ws, 'open');
    const notified = new Promise((resolve) =>
      ws.on('message', (data, binary) => {
        if (!binary) {
          const value = JSON.parse(String(data));
          if (value.type === 'studio.profile.changed') resolve(value);
        }
      }),
    );
    assert.equal(
      (
        await request(
          '/api/profile',
          'POST',
          { rootDirectory: first, profile: { name: '测试用户' } },
          false,
        )
      ).status,
      401,
    );
    const saved = await request('/api/profile', 'POST', {
      rootDirectory: first,
      profile: { name: '测试用户' },
    });
    assert.equal(saved.status, 200);
    assert.equal((await notified).profile.name, '测试用户');
    assert.equal(
      (await request('/api/config', 'GET', undefined, true, 'other-device')).body.profile.name,
      '测试用户',
    );
    assert.equal(
      (
        await request('/api/profile', 'POST', {
          rootDirectory: first,
          profile: { avatar: { id: '../private' } },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request('/api/profile', 'POST', { rootDirectory: first, profile: { name: ' ' } }))
        .status,
      400,
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=',
      'base64',
    );
    const upload =
      '/api/profile/image?' + new URLSearchParams({ rootDirectory: first, slot: 'avatar' });
    const bad = await fetch(base + upload, {
      method: 'POST',
      headers: { 'x-agent-studio-token': 'test-backend-token', 'content-type': 'image/png' },
      body: '<svg></svg>',
    });
    assert.equal(bad.status, 415);
    const http = require('node:http');
    let finishUpload;
    const pending = new Promise((resolve, reject) => {
      const uploadRequest = http.request(
        base + upload,
        {
          method: 'POST',
          headers: {
            'x-agent-studio-token': 'test-backend-token',
            'content-type': 'image/png',
            'content-length': png.length,
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      uploadRequest.on('error', reject);
      uploadRequest.write(png.subarray(0, 8));
      finishUpload = () => uploadRequest.end(png.subarray(8));
    });
    await request('/api/config', 'POST', { rootDirectory: second });
    finishUpload();
    const uploaded = await pending;
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.rootDirectory, first);
    assert.equal((await request('/api/config')).body.profile.name, '用户');
    const stored = new (require('../lib/root-data').RootData)(first, {
      storageDirectory: process.env.SWIFT_DATA_DIR,
    });
    assert.equal(stored.config.profile.name, '测试用户');
    assert(stored.config.profile.avatar.id);
    const imageUrl =
      '/api/profile/image?' +
      new URLSearchParams({
        rootDirectory: first,
        slot: 'avatar',
        id: stored.config.profile.avatar.id,
      });
    assert.equal((await fetch(base + imageUrl)).status, 401);
    const image = await fetch(base + imageUrl, {
      headers: { 'x-agent-studio-token': 'test-backend-token' },
    });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    await request('/api/config', 'POST', { rootDirectory: first });
    assert.equal((await request('/api/config')).body.profile.name, '测试用户');
    await request('/api/profile', 'POST', { rootDirectory: first, profile: { avatar: null } });
    assert.equal(
      (await fetch(base + imageUrl, { headers: { 'x-agent-studio-token': 'test-backend-token' } }))
        .status,
      404,
    );
  },
);

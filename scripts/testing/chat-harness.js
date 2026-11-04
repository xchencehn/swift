#!/usr/bin/env node
'use strict';

// 独立本地 fixture：不启动 server.js、不调用 Herdr、不读取真实会话。
// --run 执行三档行为验收；--self-test 检查 mock 契约；--capture 仅生成截图。
// 消息 POST 与真实后端一致，返回 202 {ok:true,message}。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const root = path.resolve(__dirname, '../..');
const timestamp = '2026-09-19T08:00:00.000Z';
const clone = (value) => JSON.parse(JSON.stringify(value));
const viewports = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
];
const scenarios = [
  '工具默认折叠，手动展开查看，完成后收起',
  '同 id 的工具结果更新，包括文本长度不变、错误和截断标记变化',
  '切换 Codex/Claude 会话时草稿、模型、队列互不串用',
  'POST 挂起时立即回显用户气泡；成功排队；失败保留可见消息',
  '同 id 重试不重复入队，发送经 HTTP，不写入 terminal.input',
  '模型/会话菜单键盘导航、Escape 返回焦点，斜杠命令经消息 API 提交',
  '模型只读原因可见，可编辑模型仅更新目标会话',
  '阅读历史时同 id 更新和新消息不拉回底部，贴底时跟随',
  '三档有内容截图、弹层界内、页面无横向溢出',
];

function makeState() {
  const sessions = {};
  for (const provider of ['codex', 'claude']) {
    const paneId = `pane-${provider}`;
    const oldTool = {
      id: `${provider}-tool-old`,
      name: 'read_file',
      detail: 'src/example.js',
      running: false,
      failed: false,
      input: { text: '{"path":"src/example.js"}', truncated: false },
      result: { text: 'OLD_TOOL_RESULT\nconst example = 1;', truncated: false, isError: false },
    };
    const latestTool = {
      id: `${provider}-tool-latest`,
      name: 'run_tests',
      detail: 'npm test',
      running: true,
      failed: false,
      input: { text: 'npm test', truncated: false },
      result: { text: 'RESULT_PHASE_A', truncated: false, isError: false },
    };
    const messages = Array.from({ length: 24 }, (_, i) => ({
      id: `${provider}-history-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      ts: timestamp,
      blocks: [
        {
          kind: 'text',
          text:
            i % 2
              ? `第 ${i + 1} 条回复：这里是 ${provider} 的独立会话记录。\n\n我们会检查工具执行结果，并保留用户正在阅读的位置。`
              : `请检查第 ${i + 1} 组输入，并说明验证结果。`,
        },
      ],
    }));
    messages.push({
      id: `${provider}-tools`,
      role: 'assistant',
      ts: timestamp,
      blocks: [
        {
          kind: 'text',
          text: `**${provider} 浏览器验收样例**\n\n下面包含已完成和正在执行的工具。`,
        },
        { kind: 'tools', summary: '2 tools', items: [oldTool, latestTool] },
      ],
    });
    sessions[paneId] = {
      pane: {
        paneId,
        terminalId: `term-${provider}`,
        runtimeId: `fixture-process-${paneId}`,
        workspaceId: 'workspace-fixture',
        workspace: '浏览器验收',
        tabId: `tab-${provider}`,
        title: `${provider === 'codex' ? 'Codex' : 'Claude'} 验收会话`,
        cwd: '/fixture/project',
        agent: {
          id: provider,
          label: provider,
          status: 'working',
          session: { value: `thread-${provider}` },
        },
      },
      settings: {
        model: `${provider}-fixture-model`,
        effort: provider === 'codex' ? 'high' : 'medium',
        editable: provider === 'codex',
        reason: provider === 'codex' ? '' : '此 Claude 会话不支持外部修改模型',
      },
      messages,
      queue: [],
    };
  }
  return {
    workspaces: [
      { workspaceId: 'workspace-fixture', label: '浏览器验收', cwd: '/fixture/project' },
    ],
    sessions,
    focusedPaneId: 'pane-codex',
    requests: [],
    frames: [],
    syncFrames: [],
    unexpected: [],
  };
}

/** 会话文件列表的样例，与 GET /api/doc-files 给的相同（同步中心推的也是这一份）。 */
function docFixtures() {
  const base = '/fixture/workdir/mxops';
  const doc = (rel, title, summary, ago) => ({
    path: `${base}/${rel}`,
    name: rel.split('/').pop(),
    kind: 'markdown',
    title,
    summary,
    mtime: Date.parse(timestamp) - ago,
    size: 100,
  });
  return [
    doc('tasks/176-open-mr/results.md', '当前结果', '反向已跑通，性能是下一步。', 0),
    doc('tasks/176-open-mr/notes/推导.md', '推导过程', '先按块划分，再合并归约。', 3600000),
  ];
}

async function createFixture({
  publicDirectory = path.join(root, 'public'),
  terminalRuntime,
  sideSession = false,
} = {}) {
  const state = makeState();
  state.terminalChannelVersion = Number(process.env.SWIFT_FIXTURE_TERMINAL_CHANNEL) || 0;
  terminalRuntime?.bind(state);
  const deviceSettings = new Map();
  const profiles = new Map(),
    profileImages = new Map();
  const profileFor = (root = state.rootDirectory || '/fixture/workdir') =>
    profiles.get(root) || { name: '用户', avatar: null, welcome: null, revision: 0 };
  const publishProfile = (rootDirectory, patch) => {
    const previous = profileFor(rootDirectory),
      profile = { ...previous, ...patch, revision: previous.revision + 1 };
    profiles.set(rootDirectory, profile);
    for (const socket of sockets.clients)
      if (
        socket.readyState === WebSocket.OPEN &&
        rootDirectory === (state.rootDirectory || '/fixture/workdir')
      )
        socket.send(JSON.stringify({ type: 'studio.profile.changed', rootDirectory, profile }));
    return profile;
  };
  const settingsFor = (id) =>
    deviceSettings.get(`${state.rootDirectory || '/fixture/workdir'}:${id}`) || {
      theme: 'default',
      fontSize: 14,
      ui: {},
    };
  const holds = new Map();
  const behavior = new Map();
  const json = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/__fixture/disconnect' && req.method === 'POST') {
        disconnected = true;
        for (const socket of sockets.clients) socket.close(1000, 'isolated restart');
        const timer = setTimeout(() => {
          disconnected = false;
        }, 2000);
        timer.unref?.();
        return json(res, 200, { ok: true });
      }
      if (sideSession && url.pathname === '/api/agents/side') {
        state.sideThread ||= {
          supported: true,
          structured: true,
          mode: 'main',
          hasSide: false,
          canClose: false,
          sideId: null,
          paneId: 'pane-codex',
          binding: 'fixture-side-binding',
          revision: '0',
        };
        state.sideMessages ||= [
          {
            id: 'windows-side-answer',
            role: 'assistant',
            blocks: [{ kind: 'text', text: 'Windows 临时会话结构化回答' }],
          },
        ];
        if (url.searchParams.get('transcript') === '1')
          return json(res, 200, {
            sideId: state.sideThread.sideId,
            messages: state.sideMessages,
            hasMore: false,
          });
        let submitted = false;
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          if (body.action === 'send') {
            (state.sideSends ||= []).push(body);
            submitted = true;
            state.sideMessages.push({
              id: 'windows-side-sent',
              role: 'user',
              blocks: [{ kind: 'text', text: body.text }],
            });
          } else {
            state.sideThread.mode =
              body.action === 'main' || body.action === 'close' ? 'main' : 'side';
            state.sideThread.hasSide = body.action !== 'close';
            state.sideThread.sideId = state.sideThread.hasSide
              ? '01900000-0000-7000-8000-000000000182'
              : null;
            state.sideThread.canClose = state.sideThread.mode === 'side';
          }
          state.sideThread.revision = String(Number(state.sideThread.revision) + 1);
        }
        return json(res, 200, { ...state.sideThread, submitted });
      }
      if (sideSession && url.pathname === '/api/agents/fork') {
        let body = {};
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          body = JSON.parse(raw);
          (state.sideForks ||= []).push(body);
        }
        return json(res, 200, {
          ok: true,
          job: {
            requestId: body.requestId,
            status: 'succeeded',
            phase: 'complete',
            sessionId: 'windows-independent-side',
          },
        });
      }
      if (url.pathname === '/api/agents/side' && req.method === 'GET')
        return json(res, 200, {
          supported: true,
          mode: 'main',
          hasSide: false,
          canClose: false,
          paneId: url.searchParams.get('pane'),
          binding: 'fixture-side-binding',
          revision: 'fixture-main',
        });
      if (url.pathname === '/api/machines' && req.method === 'GET')
        return json(res, 200, { ok: true, machines: state.machines || [] });
      if (url.pathname === '/api/notifications' && req.method === 'GET')
        return json(res, 200, { ok: true, publicKey: '', subscribed: false });
      if (url.pathname === '/api/profile/image') {
        const rootDirectory = url.searchParams.get('rootDirectory'),
          slot = url.searchParams.get('slot');
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const bytes = Buffer.concat(chunks),
            id = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
          const mime = req.headers['content-type'];
          profileImages.set(`${rootDirectory}:${id}`, { bytes, mime });
          return json(res, 200, {
            rootDirectory,
            profile: publishProfile(rootDirectory, { [slot]: { id, mime } }),
          });
        }
        const image = profileImages.get(`${rootDirectory}:${url.searchParams.get('id')}`);
        if (!image) return json(res, 404, { message: '图片不存在' });
        res.writeHead(200, { 'content-type': image.mime });
        return res.end(image.bytes);
      }
      if (req.method === 'POST' && url.pathname === '/api/attachments') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const name = url.searchParams.get('name'),
          paneId = url.searchParams.get('pane');
        state.requests.push({
          route: 'POST /api/attachments',
          paneId,
          terminalId: url.searchParams.get('terminalId'),
          runtimeId: url.searchParams.get('runtimeId'),
          sessionId: url.searchParams.get('sessionId'),
          name,
          size: Buffer.concat(chunks).length,
          sha256: require('node:crypto')
            .createHash('sha256')
            .update(Buffer.concat(chunks))
            .digest('hex'),
        });
        return json(res, 201, {
          attachment: {
            id: String(state.requests.length),
            name,
            path: `/fixture/uploads/${state.requests.length}/${name}`,
            size: Buffer.concat(chunks).length,
          },
        });
      }
      let body = {};
      if (req.method === 'POST') {
        let data = '';
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 1024 * 1024) return json(res, 413, { error: 'fixture body too large' });
        }
        try {
          body = JSON.parse(data || '{}');
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
      const device = require('../../lib/root-preferences').deviceId(req);
      const route = `${req.method} ${url.pathname}`;
      state.requests.push({
        route,
        query: Object.fromEntries(url.searchParams),
        body: clone(body),
      });
      if (route === 'GET /frontend-version.json')
        return json(res, 200, { version: state.frontendVersion || 'fixture' });
      if (route === 'GET /api/workspace-files/list')
        return json(res, 200, {
          ok: true,
          root: url.searchParams.get('root'),
          path: url.searchParams.get('path') || url.searchParams.get('root'),
          entries: [],
          revision: 'fixture-workspace-files',
          truncated: false,
        });
      const paneId = url.searchParams.get('pane') || body.paneId || body.target;
      const session = state.sessions[paneId];
      if (route === 'POST /api/profile')
        return json(res, 200, {
          rootDirectory: body.rootDirectory,
          profile: publishProfile(body.rootDirectory, body.profile),
        });
      if (route === 'GET /api/profile')
        return json(res, 200, {
          rootDirectory: state.rootDirectory || '/fixture/workdir',
          profile: profileFor(),
        });
      if (route === 'GET /api/server-update')
        return json(
          res,
          200,
          state.serverUpdate || {
            currentVersion: state.serverVersion || require('../../package.json').version,
            version: state.serverVersion || require('../../package.json').version,
            available: false,
          },
        );
      if (route === 'GET /api/config')
        return json(res, 200, {
          ok: true,
          version: state.serverVersion || require('../../package.json').version,
          role: 'execution',
          basePath: '',
          profile: profileFor(),
          settings: settingsFor(device),
          websocketPath: '/api/terminal',
          terminalTransport: 'raw-pty',
          terminalChannelVersion: state.terminalChannelVersion ? 1 : 0,
          terminalMultiplexVersion: state.terminalChannelVersion === 2 ? 1 : 0,
          rootDirectory: state.rootDirectory || '/fixture/workdir',
          temporaryCwd: state.rootDirectory || '/fixture/workdir',
          defaultCwd: state.rootDirectory || '/fixture/workdir',
        });
      if (route === 'POST /api/config') {
        if (!body.rootDirectory?.startsWith('/fixture/') || body.rootDirectory.includes('missing'))
          return json(res, 400, { message: '目录不存在或不可读写，请选择其他目录。' });
        state.rootDirectory = body.rootDirectory;
        for (const socket of sockets.clients)
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'studio.config.changed',
                rootDirectory: state.rootDirectory,
                settings: settingsFor(socket.deviceId),
                profile: profileFor(),
              }),
            );
        return json(res, 200, {
          ok: true,
          rootDirectory: state.rootDirectory,
          settings: settingsFor(device),
          profile: profileFor(),
          temporaryCwd: state.rootDirectory,
          defaultCwd: state.rootDirectory,
        });
      }
      if (route === 'POST /api/settings') {
        const rootDirectory = state.rootDirectory || '/fixture/workdir';
        if (body.rootDirectory !== rootDirectory)
          return json(res, 409, { message: '根目录已改变' });
        const settings = require('../../lib/root-preferences').mergeSettings(
          settingsFor(device),
          body.settings,
        );
        deviceSettings.set(`${rootDirectory}:${device}`, settings);
        for (const socket of sockets.clients)
          if (socket.readyState === WebSocket.OPEN && socket.deviceId === device)
            socket.send(JSON.stringify({ type: 'studio.config.changed', rootDirectory, settings }));
        return json(res, 200, { ok: true, rootDirectory, settings });
      }
      if (route === 'GET /api/snapshot') {
        const dashboard = {
          runtimeId: state.runtimeId || 'fixture-runtime',
          version: '0.9.3',
          protocol: 22,
          tabs: state.tabs || [],
          layouts: state.layouts || [],
          focusedPaneId: state.focusedPaneId,
          workspaces: state.workspaces,
          panes: Object.values(state.sessions).map((s) => s.pane),
        };
        return json(res, 200, {
          ok: true,
          settings: settingsFor(device),
          profile: profileFor(),
          ...(state.rootDirectory
            ? require('../../lib/root-scope').scopeDashboard(dashboard, state.rootDirectory)
            : dashboard),
        });
      }
      if (route === 'GET /api/agents/goal') {
        const target = state.sessions[url.searchParams.get('paneId')];
        return json(res, 200, {
          ok: true,
          goal: target?.webStatus?.goal || null,
          revision: 'fixture-goal',
          processRuntimeId: 'fixture-process',
        });
      }
      if (route === 'POST /api/command-interaction') {
        state.nativeCommands ||= require('./command-interaction-fixture').create(state);
        try {
          return json(
            res,
            200,
            await (body.action === 'execute'
              ? state.nativeCommands.execute(body)
              : state.nativeCommands.handle(body)),
          );
        } catch (error) {
          return json(res, error.status || 409, { code: error.code, message: error.message });
        }
      }
      if (url.pathname === '/api/agents/interrupt') {
        state.sessionInterrupt ||= require('./session-interrupt-fixture').create(state, () =>
          hub?.poke(),
        );
        try {
          return json(
            res,
            200,
            await (req.method === 'POST'
              ? state.sessionInterrupt.run(body)
              : state.sessionInterrupt.preview(Object.fromEntries(url.searchParams))),
          );
        } catch (error) {
          return json(res, error.status || 409, {
            code: error.code,
            message: error.message,
            ...(typeof error.deliveryUncertain === 'boolean'
              ? { deliveryUncertain: error.deliveryUncertain }
              : {}),
          });
        }
      }
      if (route === 'GET /api/herdr/sessions')
        return json(res, 200, {
          ok: true,
          current: 'default',
          sessions: [{ name: 'default', running: true }],
        });
      if (route === 'GET /api/herdr/runtime')
        return json(res, 200, {
          ok: true,
          version: '0.9.3',
          protocol: 22,
          session: 'default',
          capabilityNotice: '测试运行时',
        });
      if (route === 'GET /api/herdr/read' || route === 'POST /api/herdr/action') {
        const herdr = {
          dashboard: async () => ({
            runtimeId: state.runtimeId || 'fixture-runtime',
            workspaces: state.workspaces,
            tabs: state.tabs || [],
            layouts: state.layouts || [],
            panes: Object.values(state.sessions).map((s) => s.pane),
          }),
          readProcessInfo: async (paneId) => ({
            pane_id: paneId,
            shell_pid: 42,
            foreground_process_group_id: 42,
            foreground_processes: [{ pid: 42, name: 'sh' }],
          }),
          request: async (method, params) => {
            (state.herdrCalls ||= []).push({ method, params });
            return state.herdrHandler
              ? await state.herdrHandler(method, params)
              : state.herdrResponses?.[method] ||
                  state.herdrResult || {
                    type: 'fixture_result',
                    actions: [],
                    read: { text: 'SHELL_OUTPUT' },
                  };
          },
        };
        try {
          const result = route.startsWith('GET')
            ? await require('../../lib/herdr-ui').invoke(
                herdr,
                url.searchParams.get('method'),
                JSON.parse(url.searchParams.get('params') || '{}'),
                null,
                { read: true },
              )
            : await require('../../lib/herdr-ui').invoke(
                herdr,
                body.action,
                body.params || {},
                body.expected,
              );
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, error.status || 400, { code: error.code, message: error.message });
        }
      }
      if (route === 'GET /api/history') {
        const active = new Set(
          Object.values(state.sessions).map((s) => s.pane.agent?.session?.value),
        );
        const sessions = (state.history || []).filter(
          (s) =>
            (!state.rootDirectory ||
              require('../../lib/root-scope').withinRoot(state.rootDirectory, s.cwd)) &&
            !active.has(s.sessionId) &&
            (!url.searchParams.get('q') || s.title.includes(url.searchParams.get('q'))),
        );
        return json(res, 200, { ok: true, sessions, total: sessions.length, nextOffset: null });
      }
      // 归档会话的只读正文：它已经停机，没有 pane、没有状态行、没有发送队列。
      if (route === 'GET /api/history/transcript') {
        const entry = (state.history || []).find(
          (s) =>
            s.sessionId === url.searchParams.get('sessionId') &&
            s.provider === url.searchParams.get('provider'),
        );
        if (!entry) return json(res, 404, { error: '归档不存在' });
        const messages = entry.messages || [
          {
            id: 'archived-1',
            role: 'user',
            ts: '2026-09-20T10:00:00.000Z',
            blocks: [{ kind: 'text', text: '归档里的第一条' }],
          },
          {
            id: 'archived-2',
            role: 'assistant',
            ts: '2026-09-20T10:00:05.000Z',
            blocks: [{ kind: 'text', text: '归档里的回答' }],
          },
        ];
        return json(res, 200, {
          ok: true,
          archived: true,
          agent: entry.provider,
          provider: entry.provider,
          sessionId: entry.sessionId,
          title: entry.title,
          cwd: entry.cwd,
          total: messages.length,
          hasMore: false,
          messages,
        });
      }
      if (route === 'POST /api/history/resume') {
        const entry = state.history.find(
          (s) => s.sessionId === body.sessionId && s.provider === body.provider,
        );
        if (!entry) return json(res, 404, { error: '历史不存在' });
        const resumed = clone(state.sessions['pane-' + entry.provider]);
        resumed.pane.paneId = 'pane-restored';
        resumed.pane.title = entry.title;
        resumed.pane.sessionTitle = entry.title;
        resumed.pane.cwd = entry.cwd;
        resumed.pane.agent.session.value = entry.sessionId;
        state.sessions['pane-restored'] = resumed;
        return json(res, 201, {
          ok: true,
          started: { paneId: 'pane-restored' },
          dashboard: {
            panes: Object.values(state.sessions).map((s) => s.pane),
            workspaces: state.workspaces,
          },
        });
      }
      if (route === 'POST /api/sessions/close') {
        const closed = state.sessions[body.target];
        if (!closed) return json(res, 404, { error: '会话不存在' });
        delete state.sessions[body.target];
        return json(res, 200, {
          ok: true,
          dashboard: {
            panes: Object.values(state.sessions).map((s) => s.pane),
            workspaces: state.workspaces,
          },
        });
      }
      if (route === 'POST /api/workspaces/create') {
        state.workspaces.push({
          workspaceId: 'workspace-new',
          label: body.label,
          cwd: '/fixture/workdir/' + body.label,
        });
        state.sessions['pane-new-shell'] = {
          pane: {
            paneId: 'pane-new-shell',
            workspaceId: 'workspace-new',
            cwd: '/fixture/workdir/' + body.label,
            baseCwd: '/fixture/workdir/' + body.label,
            agent: null,
          },
          messages: [],
          queue: [],
        };
        return json(res, 200, {
          ok: true,
          created: { workspace: { workspace_id: 'workspace-new' } },
          dashboard: {
            workspaces: state.workspaces,
            panes: Object.values(state.sessions).map((s) => s.pane),
          },
        });
      }
      if (route === 'POST /api/agents/start') {
        const created = clone(state.sessions[`pane-${body.provider}`]);
        Object.assign(created.pane, {
          paneId: 'pane-temporary',
          tabId: 'tab-temporary',
          title: '新会话',
          tabTitle: '新会话',
          sessionTitle: '新会话',
          cwd: '/fixture/workdir',
        });
        created.pane.agent.session.value = 'thread-temporary';
        created.pane.agent.status = 'idle';
        // Agent 还在启动：标签页建好了，但 pane 上还没有 agent（真实服务就是这样先返回）。
        if (state.startAgentPending) created.pane.agent = null;
        created.messages = [];
        created.queue = [];
        created.archivePending = true;
        state.sessions['pane-temporary'] = created;
        return json(res, 201, {
          ok: true,
          started: { paneId: 'pane-temporary' },
          dashboard: {
            workspaces: state.workspaces,
            panes: Object.values(state.sessions).map((s) => s.pane),
          },
        });
      }
      if (route === 'GET /api/images') {
        const image = state.images?.[url.searchParams.get('id')];
        Object.assign(state.requests.at(-1), {
          paneId,
          id: url.searchParams.get('id'),
          sessionId: url.searchParams.get('sessionId'),
          authenticated: req.headers['x-agent-studio-token'] === 'fixture',
        });
        if (
          !image ||
          image.fail ||
          url.searchParams.get('sessionId') !== session?.pane.agent?.session?.value
        )
          return json(res, 404, { message: '图片不存在' });
        if (image.delay) await new Promise((resolve) => setTimeout(resolve, image.delay));
        const content = image.sources
          ? await require('../../lib/chat-images').readImage(
              image.sources,
              url.searchParams.get('id'),
              { attachmentsDirectory: image.attachmentsDirectory },
            )
          : image;
        res.writeHead(200, { 'content-type': content.mime });
        return res.end(content.bytes);
      }
      if (route === 'GET /api/session-files')
        return json(res, 200, {
          ok: true,
          paneId,
          sessionId: session?.pane.agent?.session?.value,
          files: [
            {
              id: 'new-file',
              name: '修改后的文件.md',
              path: '/fixture/workdir/project/修改后的文件.md',
              updatedAt: Date.parse(timestamp),
            },
            {
              id: 'old-file',
              name: 'earlier.js',
              path: '/fixture/workdir/project/earlier.js',
              updatedAt: Date.parse(timestamp) - 60000,
            },
          ],
        });
      if (route === 'GET /api/session-files/content')
        return json(res, 200, {
          ok: true,
          file: {
            id: 'new-file',
            kind: 'text',
            content: `只读文件内容\n<script>window.filePreviewExecuted=true</script>\n${paneId}`,
            nextOffset: null,
          },
        });
      // 会话文件三栏（docs/PRODUCT_SPEC.md 2.4）：标题、摘要都由服务端读好。
      {
        const base = '/fixture/workdir/mxops';
        const doc = (rel, title, summary, ago, kind = 'markdown') => ({
          path: `${base}/${rel}`,
          name: rel.split('/').pop(),
          kind,
          title,
          summary,
          mtime: Date.parse(timestamp) - ago,
          size: 100,
        });
        const results = doc(
          'tasks/176-open-mr/results.md',
          '当前结果',
          '反向已跑通，性能是下一步。',
          0,
        );
        const derivation = doc(
          'tasks/176-open-mr/notes/推导.md',
          '推导过程',
          '先按块划分，再合并归约。',
          3600000,
        );
        const figure = doc('docs/架构图.png', '架构图.png', '图片 · docs', 7200000, 'image');
        if (route === 'GET /api/doc-files') {
          // 列表里只有文档：图片在文档里渲染，代码从文档里的链接点开（与服务端同一条规则）。
          if (url.searchParams.get('tab') === 'session')
            return json(res, 200, { ok: true, tab: 'session', files: [results, derivation] });
          return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '没有这一栏。' });
        }
        if (route === 'GET /api/doc-files/search') {
          const q = String(url.searchParams.get('q') || '').toLowerCase();
          const files = [results, derivation].filter((file) => file.path.toLowerCase().includes(q));
          return json(res, 200, { ok: true, query: q, total: files.length, files });
        }
        if (
          route === 'GET /api/doc-files/content' ||
          route === 'GET /api/workspace-files/content'
        ) {
          const wanted = url.searchParams.get('path');
          if (state.htmlPreview && wanted === '/fixture/workdir/native-report.html')
            return json(res, 200, {
              ok: true,
              path: wanted,
              kind: 'html',
              title: 'HTML 报告',
              truncated: false,
              text: '<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif;padding:24px;background:#f5f5f5;color:#222}button{padding:16px}</style><h1>HTML 原生渲染通过</h1><button onclick="document.querySelector(\'p\').textContent=\'HTML 页面交互通过\'">验证 HTML 交互</button><p>等待交互</p>',
            });
          if (wanted === results.path)
            return json(res, 200, {
              ok: true,
              path: wanted,
              kind: 'markdown',
              title: '当前结果',
              mtime: results.mtime,
              size: 100,
              truncated: false,
              // 带一段够长的代码：文档里常有命令行和日志，宽内容必须在自己的容器里滚，
              // 而不是把面板撑破（AGENTS.md 的既有约束）。正文里的 HTML 不能被执行。
              text:
                '# 当前结果\n\n反向已跑通，性能是下一步。\n\n推导见 [推导过程](notes/推导.md)，图见 [架构图](../../docs/架构图.png)，实现在 [kernel.cpp](../../src/kernel.cpp)。\n\n外部资料在 [上游](https://example.com/spec)。\n\n' +
                '![内嵌架构图](../../docs/架构图.png)\n\n![外链图](https://example.com/x.png)\n\n<script>window.filePreviewExecuted=true</script>\n\n```\n' +
                'npx some-very-long-command --with=many --flags=here --and=more --until=it --definitely=overflows --the=panel --width=for-sure\n' +
                '```\n\n| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |\n|---|---|---|---|---|---|---|---|\n| 值 | 值 | 值 | 值 | 值 | 值 | 值 | 值 |\n',
            });
          if (wanted === derivation.path)
            return json(res, 200, {
              ok: true,
              path: wanted,
              kind: 'markdown',
              title: '推导过程',
              mtime: derivation.mtime,
              size: 40,
              truncated: false,
              text: '# 推导过程\n\n先按块划分，再合并归约。',
            });
          // 文档里链接的代码：列表里不列，点进来照样能看。
          if (wanted === `${base}/src/kernel.cpp`)
            return json(res, 200, {
              ok: true,
              path: wanted,
              kind: 'code',
              title: 'kernel.cpp',
              mtime: results.mtime,
              size: 60,
              truncated: false,
              text: '// kernel\nint add(int a, int b) { return a + b; }\n',
            });
          return json(res, 404, { ok: false, code: 'NOT_FOUND', message: '没有这份材料。' });
        }
        if (
          route === 'GET /api/doc-files/raw' ||
          route === 'GET /api/workspace-files/raw' ||
          route === 'GET /api/workspace-files/download'
        ) {
          if (url.searchParams.get('path') !== figure.path)
            return json(res, 404, { ok: false, message: '没有这份材料。' });
          const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64',
          );
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end(png);
        }
      }
      if (route === 'GET /api/agent-catalog') {
        const provider = url.searchParams.get('provider');
        if (!['codex', 'claude'].includes(provider))
          return json(res, 400, { error: 'unknown provider' });
        return json(res, 200, {
          ok: true,
          provider,
          source: 'fixture',
          models: [0, 1].map((i) => ({
            id: `${provider}-fixture-model${i ? '-alternate' : ''}`,
            label: `${provider} 测试模型${i ? '二' : '一'}`,
            primary: !i,
            serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Increased usage' }],
            efforts: ['low', 'medium', 'high'].map((id) => ({
              id,
              label: id,
              isDefault: id === 'medium',
            })),
          })),
        });
      }
      if (route === 'GET /api/agent-skills')
        return json(res, 200, {
          skills: [
            {
              name: 'test-skill',
              path: '/project/.agents/skills/test/SKILL.md',
              description: 'Review code',
              enabled: true,
            },
          ],
          errors: [],
        });
      if (route === 'GET /api/commands') {
        const provider = paneId === 'pane-claude' ? 'claude' : 'codex';
        return json(res, 200, {
          provider,
          version: provider === 'codex' ? '0.155.1' : '2.1.258',
          commands: [
            { name: 'model', description: 'Choose model' },
            { name: 'compact', description: 'Compact context' },
            ...(provider === 'codex'
              ? [{ name: 'fast' }, { name: 'skills' }, { name: 'effort' }, { name: 'status' }]
              : []),
            {
              name: provider === 'codex' ? 'permissions' : 'effort',
              description: 'Provider-specific command',
            },
            ...Array.from({ length: 25 }, (_, i) => ({
              name: `sample-${i}`,
              description: 'Long command list for scrolling',
            })),
          ],
        });
      }
      if (route === 'GET /api/transcript') {
        if (!session) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        if (state.unified) {
          const C = require('../../lib/conversation-state');
          try {
            const appendSafe = state.syncIndexed && url.searchParams.get('historyEpoch') === '1';
            const history = C.historyWindow(session.messages, {
              limit: Number(url.searchParams.get('limit')) || 60,
              from: url.searchParams.get('from'),
              before: url.searchParams.get('before'),
              revision: appendSafe ? undefined : url.searchParams.get('revision'),
            });
            const { messages, ...range } = history;
            return json(res, 200, {
              ok: true,
              paneId,
              sessionId: session.pane.agent.session.value,
              supported: true,
              ...(url.searchParams.get('window') === '0'
                ? { ...range, windowless: true }
                : history),
              ...(state.syncIndexed ? { historyEpoch: 1 } : {}),
              binding: C.binding(session.pane),
              identity: C.identity(session.pane),
              outbox: session.queue,
              settings: session.settings,
              question: session.question || null,
              startup: session.startup || null,
              turnId: 'test-turn',
              turnIds: ['test-turn'],
            });
          } catch (error) {
            return json(res, error.status || 500, {
              ok: false,
              code: error.code,
              message: error.message,
            });
          }
        }
        if (session.archivePending || !session.pane.agent.session?.value)
          return json(res, 200, {
            ok: true,
            paneId,
            sessionId: session.pane.agent.session?.value || '',
            agent: session.pane.agent.label,
            supported: true,
            archivePending: true,
            associationPending: Boolean(session.associationPending),
            messages: [],
            total: 0,
            hasMore: false,
            ...(session.webStatus || {}),
            activity: session.activity || '',
          });
        let messages = session.messages;
        const before = url.searchParams.get('before');
        if (before) {
          const index = messages.findIndex((m) => m.id === before);
          messages = messages.slice(0, Math.max(index, 0));
        }
        const limit = Math.max(1, Number(url.searchParams.get('limit')) || 60);
        const historyRevision = require('../../lib/conversation-state').historyVersion(
          session.messages,
        );
        // 本地优先同步（docs/LOCAL_FIRST.md）：`window=0` 只要状态部分与版本号，正文由推送给。
        if (url.searchParams.get('window') === '0')
          return json(res, 200, {
            ok: true,
            paneId,
            supported: true,
            agent: session.pane.agent.label,
            ...(session.webStatus || {}),
            activity: session.activity || '',
            historyRevision,
            windowless: true,
            total: session.messages.length,
          });
        return json(res, 200, {
          ok: true,
          paneId,
          supported: true,
          agent: session.pane.agent.label,
          ...(session.webStatus || {}),
          historyRevision,
          activity: session.activity || '',
          messages: messages.slice(-limit),
          total: session.messages.length,
          hasMore: messages.length > limit,
        });
      }
      if (route === 'POST /api/messages/deliver') {
        const item = session?.queue.find((message) => message.id === body.id);
        if (!item || item.status !== 'queued') return json(res, 409, { message: '消息已开始投递' });
        item.status = 'sending';
        item.deliveryRequestedAt = Date.now();
        return json(res, 202, { ok: true, message: item });
      }
      if (route === 'GET /api/messages') {
        if (!session) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        return json(res, 200, { messages: session.queue });
      }
      if (route === 'DELETE /api/messages') {
        const message = session?.queue.find((m) => m.id === url.searchParams.get('id'));
        if (!message) return json(res, 404, { error: 'MESSAGE_NOT_FOUND' });
        if (!['queued', 'failed'].includes(message.status))
          return json(res, 409, { error: 'MESSAGE_NOT_CANCELLABLE' });
        message.status = 'cancelled';
        return json(res, 200, { ok: true, message });
      }
      if (route === 'GET /api/tool') {
        const tool = session?.messages
          .flatMap((m) => m.blocks)
          .flatMap((b) => b.items || [])
          .find((t) => t.id === url.searchParams.get('id'));
        if (!tool) return json(res, 404, { error: 'TOOL_NOT_FOUND' });
        return json(res, 200, {
          tool: { ...tool, result: { text: 'FULL_TOOL_RESULT', truncated: false, isError: false } },
        });
      }
      if (route === 'POST /api/messages') {
        if (
          !session ||
          typeof body.id !== 'string' ||
          !body.id ||
          typeof body.text !== 'string' ||
          !body.text.trim()
        ) {
          return json(res, 400, { error: 'id, paneId and text are required' });
        }
        if (url.searchParams.has('pane') && url.searchParams.get('pane') !== body.paneId) {
          return json(res, 400, { error: 'pane mismatch' });
        }
        const existing = session.queue.find((m) => m.id === body.id);
        if (existing) {
          if (
            body.retry === true &&
            existing.status === 'failed' &&
            !existing.deliveryUncertain &&
            existing.retryable === true
          ) {
            // Match MessageQueue.submit(): an accepted retry also attempts delivery.
            // Returning queued here made the assertion pass only during the transient submitting state.
            existing.status = ['idle', 'done', 'working'].includes(session.pane.agent?.status)
              ? 'sending'
              : 'queued';
            existing.retryable = false;
            existing.updatedAt = Date.now();
            if (existing.status === 'sending') existing.transportAcceptedAt = Date.now();
          }
          return json(res, 202, { ok: true, message: existing });
        }
        if (body.retry === true)
          return json(res, 404, { code: 'MESSAGE_NOT_FOUND', error: '要重试的消息不存在' });
        const mode = behavior.get(body.text) || 'queued';
        if (mode === 'hold')
          await new Promise((resolve) => {
            const waiting = holds.get(body.id) || [];
            waiting.push(resolve);
            holds.set(body.id, waiting);
          });
        if (res.destroyed) return;
        const accepted = session.queue.find((m) => m.id === body.id);
        if (accepted) return json(res, 202, { ok: true, message: accepted });
        if (mode === 'fail')
          return json(res, 503, {
            ok: false,
            code: 'FIXTURE_SEND_FAILED',
            error: '模拟发送失败',
            deliveryUncertain: false,
            retryable: true,
          });
        // 提交就是发送:目标能收就立刻发,只有收不了(blocked、unknown)才留在队列里。
        const message = {
          id: body.id,
          paneId: body.paneId,
          text: body.text,
          nativeDelivery: true,
          status: session.pane.agent?.status === 'blocked' ? 'failed' : 'dispatched',
          createdAt: new Date().toISOString(),
        };
        if (message.status === 'dispatched') message.transportAcceptedAt = Date.now();
        else
          Object.assign(message, {
            retryable: true,
            deliveryUncertain: false,
            error: { code: 'agent_blocked', message: '原生端正在等待交互' },
          });
        session.queue.push(message);
        return json(res, 202, { ok: true, message });
      }
      if (route === 'GET /api/agent-settings') {
        if (!session) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        return json(res, 200, session.settings);
      }
      if (route === 'POST /api/agent-settings') {
        // 现有后端通过 threadId 定位；兼容将来的 paneId 请求，保留请求记录用于断言。
        const target =
          session ||
          Object.values(state.sessions).find((s) => s.pane.agent.session.value === body.threadId);
        if (!target) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        if (!target.settings.editable)
          return json(res, 409, { code: 'NOT_REMOTE_SESSION', error: target.settings.reason });
        Object.assign(
          target.settings,
          Object.fromEntries(
            Object.entries(body).filter(([key]) =>
              ['model', 'effort', 'serviceTier'].includes(key),
            ),
          ),
        );
        return json(res, 200, { ok: true, settings: target.settings });
      }
      if (route === 'POST /api/panes/view') {
        if (state.holdNativeView) await state.holdNativeView(body);
        if (body.expected?.runtimeId !== (state.runtimeId || 'fixture-runtime'))
          return json(res, 409, {
            code: 'RUNTIME_CHANGED',
            message: 'Herdr 运行实例已经改变，请重新选择会话。',
          });
        if (
          !session ||
          body.expected?.terminalId !== session.pane.terminalId ||
          body.expected?.sessionId !== (session.pane.agent?.session?.value || '')
        )
          return json(res, 409, {
            code: 'TARGET_CHANGED',
            message: '终端或 Agent 会话已经改变，请重新选择会话。',
          });
        state.focusedPaneId = paneId;
        session.pane.scroll = { ...session.pane.scroll, offset_from_bottom: 0 };
        state.viewedPanes ||= [];
        state.viewedPanes.push(paneId);
        return json(res, 200, { ok: true, paneId });
      }
      if (route === 'POST /api/panes/focus') {
        if (!session) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        state.focusedPaneId = paneId;
        return json(res, 200, { ok: true });
      }
      if (route === 'GET /api/agents/questions')
        return json(res, 200, { ok: true, question: session?.question || null });
      if (route === 'POST /api/agents/questions') {
        if (state.questionAction) return json(res, 200, await state.questionAction(body, session));
        if (
          !session?.question ||
          body.challenge !== session.question.challenge ||
          body.sessionId !== session.pane.agent.session.value
        )
          return json(res, 409, { message: '问题已变化' });
        session.question = session.nextQuestion || null;
        delete session.nextQuestion;
        return json(res, 200, { ok: true });
      }
      if (route === 'GET /api/agents/startup')
        return json(res, 200, { ok: true, startup: session?.startup || null });
      if (route === 'POST /api/agents/startup') {
        if (!session?.startup || body.challenge !== session.startup.challenge)
          return json(res, 409, { message: '启动画面已变化' });
        session.startup = null;
        session.pane.agent.status = 'idle';
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/messages/interrupt') {
        if (!session) return json(res, 404, { error: 'PANE_NOT_FOUND' });
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        state.unexpected.push(route);
        return json(res, 501, { error: `unmocked API: ${route}` });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const relative =
        url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const publicRoot = publicDirectory;
      const file = path.resolve(publicRoot, relative);
      if (!file.startsWith(publicRoot + path.sep)) return json(res, 403, { error: 'forbidden' });
      let data;
      const assets = require('../../lib/frontend-assets').createFrontendAssets(publicDirectory);
      try {
        data = relative === 'assets/startup.js' ? assets.startup().data : await fs.readFile(file);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      // Explicit legacy surface for existing structured-chat regression fixtures.
      if (relative === 'index.html' && !state.productionPresentation)
        data = Buffer.from(
          data
            .toString()
            .replace(
              '<html',
              `<html data-chat-presentation="${state.terminalPreview ? 'terminal' : 'structured'}"`,
            ),
        );
      if (relative === 'index.html')
        data = Buffer.from(
          assets
            .bundleHtml(data.toString())
            .replaceAll('__AGENT_STUDIO_BASE_PATH__', req.headers['x-swift-public-base'] || '')
            .replaceAll('__ASSET_VERSION__', state.frontendVersion || 'fixture')
            .replaceAll(
              '__ROOT_SETTINGS__',
              JSON.stringify(settingsFor(device))
                .replaceAll('&', '&amp;')
                .replaceAll('\"', '&quot;')
                .replaceAll('<', '&lt;'),
            ),
        );
      const types = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
      };
      res.writeHead(200, {
        'x-frame-options': path.extname(file) === '.html' ? 'SAMEORIGIN' : 'DENY',
        'content-type': types[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        ...(relative === 'files/html-preview.html'
          ? {
              'content-security-policy': (
                await fs.readFile(path.join(publicDirectory, 'files/html-preview.csp'), 'utf8')
              ).trim(),
            }
          : {}),
        ...(relative === 'index.html' && state.contentSecurityPolicy
          ? { 'content-security-policy': state.contentSecurityPolicy }
          : {}),
      });
      res.end(data);
    } catch (error) {
      state.unexpected.push(error.stack);
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy();
    }
  });
  let disconnected = false;
  const sockets = new WebSocketServer({ server, path: '/api/terminal' });
  const shellStreams = new Set();
  const shellBuffers = new Map(),
    shellGeometry = new Map();
  function attachFixtureShell({ ws: socket, url }) {
    const params = url.searchParams;
    const pane = state.sessions[params.get('pane')]?.pane;
    if (!pane || pane.terminalId !== params.get('terminalId')) {
      socket.close(1000);
      return;
    }
    (state.shellBindings ||= []).push(Object.fromEntries(params));
    socket.shellPaneId = pane.paneId;
    shellStreams.add(socket);
    socket.once('close', () => shellStreams.delete(socket));
    const geometry = shellGeometry.get(pane.paneId) || state.nativeTerminalGeometry;
    if (geometry) socket.send(JSON.stringify({ type: 'terminal.geometry', ...geometry }));
    socket.send(JSON.stringify({ type: 'terminal.full' }));
    socket.send(
      JSON.stringify({
        type: 'terminal.ready',
        transport: 'shell',
        terminalId: pane.terminalId,
        paneId: pane.paneId,
      }),
    );
    if (!shellBuffers.has(pane.paneId))
      shellBuffers.set(pane.paneId, [
        Buffer.from(
          '\x1b[2J\x1b[H' +
            (state.nativeTerminalText ||
              (pane.agent
                ? (pane.agent.label === 'claude' ? 'Claude Code' : 'OpenAI Codex') +
                  ' · native terminal\r\n/model · /status · Shift+Left\r\n中文字体 · 工作会话 · https://example.com\r\n› '
                : 'SHELL_FIXTURE_READY\r\n$ ')),
        ),
      ]);
    socket.send(Buffer.concat(shellBuffers.get(pane.paneId)));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'terminal.ack') return;
      (state.shellFrames ||= []).push({ ...message, paneId: pane.paneId });
      if (message.type === 'terminal.history.request') {
        void Promise.resolve(
          state.nativeHistoryRead ? state.nativeHistoryRead(message) : state.nativeTerminalHistory,
        ).then((text) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'terminal.history',
                requestId: message.requestId,
                available: typeof text === 'string',
                ...(typeof text === 'string' ? { text } : {}),
              }),
            );
        });
      }
      if (message.type === 'terminal.input') {
        const bytes = Buffer.from(message.data);
        shellBuffers.get(pane.paneId).push(bytes);
        socket.send(bytes);
      }
    });
  }
  const nativeScreens = new Map();
  let nativeObservation = 0;
  function sendNativeScreen(socket, screen, { renew = false, observerId, revision } = {}) {
    if (!socket.nativeObserverId || renew) {
      socket.nativeObserverId = `observer-${socket.observing}-${++nativeObservation}`;
      socket.nativeRevision = 0;
      socket.send(
        JSON.stringify({
          type: 'terminal.observe.full',
          terminalId: socket.observing,
          binding: socket.nativeBinding,
          observerId: socket.nativeObserverId,
          screen: true,
        }),
      );
    }
    socket.send(
      JSON.stringify({
        type: 'terminal.screen',
        terminalId: socket.observing,
        binding: socket.nativeBinding,
        observerId: observerId || socket.nativeObserverId,
        requestId: socket.nativeRequestId,
        flow: socket.structuredStatus ? 'snapshot' : undefined,
        revision: revision || ++socket.nativeRevision,
        rows: clone(screen.rows),
        projection: clone(screen.projection),
        cols: screen.cols,
        capturedAt: Date.now(),
      }),
    );
  }
  sockets.on('connection', (socket, req) => {
    socket.structuredStatus =
      new URL(req.url, 'http://fixture').searchParams.get('screen') === 'structured';
    socket.deviceId = require('../../lib/root-preferences').deviceId(req);
    socket.shellPaneId =
      new URL(req.url, 'http://fixture').searchParams.get('shell') === '1'
        ? new URL(req.url, 'http://fixture').searchParams.get('pane')
        : null;
    if (disconnected) {
      socket.close(1012);
      return;
    }
    const params = new URL(req.url, 'http://fixture').searchParams;
    if (params.get('shell') === '1') {
      state.shellConnections = (state.shellConnections || 0) + 1;
      const url = new URL(req.url, 'http://fixture');
      if (params.get('channel') === '2')
        require('../../lib/terminal-multiplexer').attachTerminalMultiplexer({
          ws: socket,
          url,
          herdr: terminalRuntime?.herdr || {},
          maxInputBytes: 64 * 1024,
          attach: terminalRuntime?.attach || attachFixtureShell,
        });
      else if (params.get('channel') === '1')
        require('../../lib/terminal-channel').attachTerminalChannel({
          ws: socket,
          url,
          herdr: terminalRuntime?.herdr || {},
          maxInputBytes: 64 * 1024,
          attach: terminalRuntime?.attach || attachFixtureShell,
        });
      else if (terminalRuntime) void terminalRuntime.attach({ ws: socket, url });
      else attachFixtureShell({ ws: socket, url });
      return;
    }
    const rawClient = params.get('observe') !== '1';
    socket.send(
      JSON.stringify({ type: 'terminal.ready', transport: rawClient ? 'raw-pty' : 'observe' }),
    );
    if (rawClient) socket.send(Buffer.from('\x1b[2J\x1b[HHERDR_FIXTURE_READY\r\n'));
    socket.on('message', (bytes) => {
      // 同步控制消息不是终端输入，分开记：用例里 frames 为空表示「没有往终端写任何东西」。
      let message = null;
      try {
        message = JSON.parse(String(bytes));
      } catch {
        /* 二进制或非 JSON 就是终端输入 */
      }
      // 会话页只读观察选中会话的终端（lib/terminal-transport.js）：记下观察的是哪个，先回一帧完整画面的标记。
      if (message?.type === 'terminal.screen.ack') {
        state.screenAcks ||= [];
        state.screenAcks.push(clone(message));
        return;
      }
      if (message?.type === 'terminal.observe') {
        socket.observing = message.terminalId || '';
        socket.nativeBinding = message.binding || '';
        socket.nativeRequestId = message.requestId || '';
        socket.nativeObserverId = '';
        socket.nativeRevision = 0;
        state.observeFrames = (state.observeFrames || []).concat(socket.observing);
        if (socket.observing) {
          const latest = nativeScreens.get(socket.observing);
          if (latest) sendNativeScreen(socket, latest);
          else
            socket.send(
              JSON.stringify({ type: 'terminal.observe.full', terminalId: socket.observing }),
            );
        }
        return;
      }
      if (typeof message?.type === 'string' && message.type.startsWith('sync.')) {
        state.syncFrames.push(message);
        if (message.type === 'sync.hello' && state.sync) syncHub().hello(socket, message);
        return;
      }
      state.frames.push(String(bytes));
    });
  });
  // 用例打开 state.sync 后，夹具用真实的同步中心（lib/sync/hub.js）推送变化；默认关着，覆盖退回路径。
  let hub = null;
  const { SyncHub } = require('../../lib/sync/hub');
  const sessionOf = (key) =>
    Object.values(state.sessions).find(
      (item) => `${providerOf(item)}:${item.pane.agent?.session?.value}` === key,
    );
  const providerOf = (item) =>
    ['pi', 'omp', 'omo', 'gjc', 'opencode', 'devin'].includes(item.pane.agent?.label)
      ? item.pane.agent.label
      : /claude/i.test(item.pane.agent?.id || item.pane.agent?.label || '')
        ? 'claude'
        : 'codex';
  function syncHub() {
    if (hub) return hub;
    hub = new SyncHub({
      progressive: Boolean(state.syncIndexed),
      dashboard: async () => ({
        runtimeId: state.runtimeId || 'fixture-runtime',
        rootDirectory: state.rootDirectory || '/fixture/workdir',
        focusedPaneId: state.focusedPaneId,
        workspaces: state.workspaces,
        panes: Object.values(state.sessions).map((item) => ({
          ...clone(item.pane),
          agent: item.pane.agent && { ...clone(item.pane.agent), label: providerOf(item) },
        })),
      }),
      locate: (provider, sessionId) => `${provider}:${sessionId}`,
      databasePath: (provider) => `${provider}:database`,
      read: async (key, provider, pane) => {
        const messages = clone(
          (pane ? state.sessions[pane.paneId] : sessionOf(key))?.messages || [],
        );
        return {
          conversation: state.syncIndexed ? messages.slice(-60) : messages,
          revision: require('../../lib/conversation-state').historyVersion(messages),
          ...(state.syncIndexed
            ? {
                hasMore: messages.length > 60,
                bounded: true,
                historyEpoch: 1,
                total: messages.length,
              }
            : { hasMore: false }),
        };
      },
      stat: async (key) => {
        if (key.endsWith('-wal'))
          throw Object.assign(new Error('No fixture WAL'), { code: 'ENOENT' });
        const value = key.endsWith(':database')
          ? Object.values(state.sessions)
              .filter((item) => providerOf(item) === key.split(':')[0])
              .map((item) => item.messages)
          : sessionOf(key)?.messages || [];
        const text = JSON.stringify(value);
        return {
          ino: 1,
          size: text.length,
          mtimeMs: require('node:crypto').createHash('sha1').update(text).digest('hex'),
        };
      },
      clients: () => sockets.clients,
      send: (socket, message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      // 与 GET /api/doc-files、/api/history 同样的内容。
      files: async () => clone(state.syncFiles || docFixtures()),
      history: async () => ({ sessions: clone(state.history || []), nextOffset: null }),
      now: () => Date.now() + (state.clockAdvance || 0),
    });
    return hub;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = false;
  return {
    shellFrame(
      bytes,
      paneId = state.focusedPaneId,
      { full = false, markerOnly = false, geometry } = {},
    ) {
      if (geometry) shellGeometry.set(paneId, geometry);
      if (!markerOnly) {
        if (full || !shellBuffers.has(paneId)) shellBuffers.set(paneId, []);
        shellBuffers.get(paneId).push(Buffer.from(bytes));
      }
      for (const socket of shellStreams)
        if (socket.readyState === 1 && socket.shellPaneId === paneId) {
          if (geometry) socket.send(JSON.stringify({ type: 'terminal.geometry', ...geometry }));
          if (full) socket.send(JSON.stringify({ type: 'terminal.full' }));
          if (!markerOnly) socket.send(Buffer.from(bytes));
        }
    },
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    observationFailure() {
      for (const socket of sockets.clients)
        if (socket.readyState === 1 && socket.observing)
          socket.send(JSON.stringify({ type: 'terminal.error', recoverable: true }));
    },
    disconnect(value, code = 1012) {
      disconnected = value;
      if (value) for (const socket of sockets.clients) socket.close(code);
    },
    setSendBehavior(text, mode) {
      assert(['queued', 'hold', 'fail'].includes(mode));
      behavior.set(text, mode);
    },
    isHeld(id) {
      return holds.has(id);
    },
    release(id) {
      const waiting = holds.get(id);
      assert(waiting, `no held request ${id}`);
      holds.delete(id);
      for (const resolve of waiting) resolve();
    },
    updateTool(paneId, patch) {
      Object.assign(state.sessions[paneId].messages.at(-1).blocks[1].items.at(-1), clone(patch));
    },
    // 终端画面的一行即时状态。默认是焦点终端的画面（原来的语义），只发给正在观察那个终端的连接；
    // 页面观察的是选中的会话，选中的不是它就收不到——防串台的用例靠的正是这一点。
    activity(text, paneId = state.focusedPaneId) {
      const terminalId = state.sessions[paneId]?.pane.terminalId;
      for (const socket of sockets.clients)
        if (socket.readyState === WebSocket.OPEN && socket.observing === terminalId)
          socket.send(Buffer.from(`\x1b[2J\x1b[15;1H${text}`));
    },
    nativeScreen(screen, paneId = state.focusedPaneId, options = {}) {
      const terminalId = state.sessions[paneId]?.pane.terminalId;
      // A terminal exists independently of observers. A later subscription
      // receives its latest full screen, just like the real Herdr endpoint.
      if (!options.observerId && !options.revision) nativeScreens.set(terminalId, clone(screen));
      for (const socket of sockets.clients)
        if (socket.readyState === WebSocket.OPEN && socket.observing === terminalId)
          sendNativeScreen(socket, screen, options);
    },
    nativeFull() {
      for (const socket of sockets.clients)
        if (socket.readyState === WebSocket.OPEN && socket.nativeObserverId)
          socket.send(
            JSON.stringify({
              type: 'terminal.observe.full',
              terminalId: socket.observing,
              binding: socket.nativeBinding,
              observerId: socket.nativeObserverId,
              screen: true,
            }),
          );
    },
    nativeEnded(observerId) {
      for (const socket of sockets.clients)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({
              type: 'terminal.observe.ended',
              terminalId: socket.observing,
              binding: socket.nativeBinding,
              observerId,
            }),
          );
    },
    changed() {
      hub?.poke();
      for (const socket of sockets.clients)
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'studio.changed' }));
    },
    /** 同步推送：等同步中心算完并推出去。 */
    async synced() {
      if (hub) await hub.refresh();
    },
    async close() {
      if (closed) return;
      closed = true;
      hub?.close();
      for (const socket of sockets.clients) socket.terminate();
      for (const waiting of holds.values()) for (const resolve of waiting) resolve();
      holds.clear();
      await new Promise((resolve) => sockets.close(resolve));
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    },
  };
}

async function selfTest() {
  const fixture = await createFixture();
  const get = async (route) => (await fetch(fixture.url + route)).json();
  const post = (route, body) =>
    fetch(fixture.url + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await get('/api/snapshot')).panes.length, 2);
    assert.equal((await get('/api/agent-settings?pane=pane-claude')).editable, false);
    assert.equal((await get('/api/agent-catalog?provider=codex')).models.length, 2);
    const message = { id: 'test-message', paneId: 'pane-codex', text: '/compact' };
    assert.equal((await post('/api/messages', message)).status, 202);
    await post('/api/messages', message);
    assert.equal((await get('/api/messages?pane=pane-codex')).messages.length, 1);
    assert.equal((await get('/api/messages?pane=pane-claude')).messages.length, 0);
    fixture.setSendBehavior('HOLD', 'hold');
    let responded = false;
    const pending = post('/api/messages', { ...message, id: 'held-message', text: 'HOLD' }).then(
      (response) => {
        responded = true;
        return response;
      },
    );
    const deadline = Date.now() + 2000;
    while (!fixture.isHeld('held-message') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(fixture.isHeld('held-message'), 'POST must reach the explicit response gate');
    assert.equal(responded, false);
    assert.equal((await get('/api/messages?pane=pane-codex')).messages.length, 1);
    fixture.release('held-message');
    assert.equal((await pending).status, 202);
    assert.equal((await get('/api/messages?pane=pane-codex')).messages.length, 2);
    fixture.setSendBehavior('FAIL', 'fail');
    assert.equal(
      (await post('/api/messages', { ...message, id: 'failure', text: 'FAIL' })).status,
      503,
    );
    fixture.updateTool('pane-codex', {
      result: { text: 'RESULT_PHASE_B', truncated: true, isError: true },
    });
    const transcript = await get('/api/transcript?pane=pane-codex');
    assert.equal(transcript.messages.at(-1).blocks[1].items.at(-1).result.text, 'RESULT_PHASE_B');
    assert.equal(
      (await get('/api/transcript?pane=pane-claude')).messages.at(-1).blocks[1].items.at(-1).result
        .text,
      'RESULT_PHASE_A',
    );
    assert.equal(
      (
        await post('/api/agent-settings', {
          threadId: 'thread-claude',
          model: 'bad',
          effort: 'low',
        })
      ).status,
      409,
    );
    const retry = {
      id: 'retry-contract',
      paneId: 'pane-codex',
      text: 'retry fixture',
      status: 'failed',
      retryable: true,
    };
    fixture.state.sessions['pane-codex'].queue.push(retry);
    const retried = await (await post('/api/messages', { ...retry, retry: true })).json();
    assert.equal(
      retried.message.status,
      'sending',
      'successful retry must match the production submit contract',
    );
    assert(retried.message.transportAcceptedAt);
    await post('/api/messages', { ...retry, retry: true });
    assert.equal(
      fixture.state.sessions['pane-codex'].queue.filter((item) => item.id === retry.id).length,
      1,
    );
    assert.deepEqual(fixture.state.unexpected, []);
    console.log('mock contract self-test passed; browser acceptance has not run');
  } finally {
    await fixture.close();
  }
}

// 只采集有内容的三档截图；完整行为验收请使用 --run。
async function capture() {
  const { firefox, expect } = require('@playwright/test');
  const fixture = await createFixture();
  let browser;
  const output = path.join(root, 'artifacts', 'chat-harness');
  try {
    await fs.mkdir(output, { recursive: true });
    browser = await firefox.launch({ headless: true });
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        // 减少动效：三页之间的平移会让「打开后立刻量位置」量到半路；平移本身由 pageSlide 单独验。
        isMobile: viewport.touch,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
      );
      await page.goto(`${fixture.url}/?token=fixture&view=chat`);
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(page.locator('#chatLog .chat-msg')).toHaveCount(26);
      await page.evaluate(() => document.fonts.ready);
      const measurements = await page.evaluate(() => {
        const log = document.querySelector('#chatLog');
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          log: rect(log),
          scrollTop: log.scrollTop,
          scrollHeight: log.scrollHeight,
          input: rect(document.querySelector('.chat-input')),
          messages: log.querySelectorAll('.chat-msg').length,
        };
      });
      await page.screenshot({ path: path.join(output, `${viewport.name}.png`), fullPage: true });
      await fs.writeFile(
        path.join(output, `${viewport.name}.json`),
        JSON.stringify(measurements, null, 2),
      );
      assert.equal(measurements.overflow, 0, `${viewport.name}: horizontal overflow`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.deepEqual(fixture.state.unexpected, []);
    console.log(
      JSON.stringify({ captureOnly: true, output, pendingScenarios: scenarios }, null, 2),
    );
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

async function runBrowserSuite() {
  await selfTest();
  const { firefox, expect } = require('@playwright/test');
  const browserType = firefox;
  const selectedCase = process.argv
    .find((arg) => arg.startsWith('--case='))
    ?.slice('--case='.length);
  const output =
    selectedCase === 'nativeGoalStatus'
      ? path.join(root, 'artifacts', 'tasks', '083-goal-status-footer', 'browser')
      : process.env.SWIFT_CHAT_HARNESS_OUTPUT
        ? path.resolve(root, process.env.SWIFT_CHAT_HARNESS_OUTPUT, selectedCase || 'all')
        : path.join(root, 'artifacts', 'chat-harness');
  await fs.mkdir(output, { recursive: true });
  const browser = await browserType.launch({
    headless: true,
    ...(browserType === firefox ? { firefoxUserPrefs: { 'dom.w3c_touch_events.enabled': 1 } } : {}),
  });
  const results = [];
  const fingerprint = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'public/app.js',
          'public/index.html',
          'public/style.css',
          'public/device-theme.js',
          'public/device-font.js',
          'public/files/shell.js',
          'public/nav/sidebar.js',
          'public/chat/container.js',
          'public/chat/command-interaction.js',
          'lib/command-interaction.js',
          'public/nav/herdr-shell.js',
          'public/popovers.js',
          'public/native-status.js',
          'public/ansi.js',
          'public/chat/status.js',
          'lib/terminal-screen.js',
        ].map(async (file) => [
          file,
          require('node:crypto')
            .createHash('sha256')
            .update(await fs.readFile(path.join(root, file)))
            .digest('hex'),
        ]),
      ),
    );
  const sourceBefore = await fingerprint();
  const startedAt = new Date().toISOString();
  const tool = (page, id) =>
    page.locator(`details.chat-tool-row[data-tool-key="pane-codex:codex-tool-${id}"]`);
  const openModel = async (page) => {
    await page.locator('#commandInput').fill('/model ');
    await page.locator('#sendButton').click();
  };
  const send = async (page, text) => {
    await page.locator('#commandInput').fill(text);
    await page.locator('#sendButton').click();
  };
  const switchTo = async (page, provider, expected = `${provider} 浏览器验收样例`) => {
    if (page.viewportSize().width <= 760) await page.locator('#chatDrawerToggle').click();
    await page.locator(`#chatPickerList [data-pane-id="pane-${provider}"]`).click();
    await expect(page.locator('#chatLog')).toContainText(expected);
  };
  const refresh = async (page, fixture) => {
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          (fixture.state.unified ? '/api/transcript' : '/api/messages') &&
        r.request().method() === 'GET',
    );
    fixture.changed();
    await response;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const withinViewport = async (locator) => {
    await expect(locator).toBeVisible();
    const geometry = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert(
      geometry.x >= -1 &&
        geometry.y >= -1 &&
        geometry.right <= geometry.width + 1 &&
        geometry.bottom <= geometry.height + 1,
      `element escapes viewport: ${JSON.stringify(geometry)}`,
    );
    return geometry;
  };
  const swipePage = async (page, selector, right) => {
    await page.locator(selector).evaluate((el, right) => {
      const box = el.getBoundingClientRect(),
        x = box.left + 150,
        y = box.top + 80;
      const touch = (at) => new Touch({ identifier: 9, target: el, clientX: at, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)] }));
      el.dispatchEvent(
        new TouchEvent('touchmove', { bubbles: true, touches: [touch(x + (right ? 100 : -100))] }),
      );
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    }, right);
  };
  /** 桌面从右上角那个按钮进，手机与平板从聊天正文左滑进 —— 两档的入口本来就不同。 */
  const openFilesPanel = async (page, viewport) => {
    if (viewport.touch) await swipePage(page, '#chatLog', false);
    else await page.locator('#chatFilesToggle').click();
    await expect(page.locator('#sessionFilesPage')).toBeVisible();
  };
  const cases = {
    async chatHighlighting(page, fixture, viewport) {
      await require('./chat-highlighting-cases')(page, fixture, viewport, {
        output,
        refresh,
        switchTo,
        timestamp,
      });
    },
    async fileListRecovery(page, fixture, viewport) {
      await page.locator('#commandInput').fill('文件阅读期间保留的草稿');
      let fail = true,
        release,
        held = true;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const queries = [];
      await page.route('**/api/doc-files/search?*', async (route) => {
        const query = new URL(route.request().url()).searchParams.get('q');
        queries.push(query);
        if (held) await gate;
        const files =
          query === '没有匹配'
            ? []
            : [
                {
                  path: '/fixture/workdir/results.md',
                  kind: 'markdown',
                  title: '缓存文档',
                  summary: '已读结果继续可用',
                },
              ];
        await route.fulfill({
          status: fail ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(fail ? { error: '测试读取失败' } : { files, total: files.length }),
        });
      });
      try {
        await openFilesPanel(page, viewport);
        await page.locator('#docSearch').fill('恢复验证');
        await expect.poll(() => queries.length).toBe(1);
        await expect(page.locator('#sessionFilesList')).toContainText('正在读取文件…');
        await expect(page.locator('#sessionFilesList')).toHaveAttribute('aria-busy', 'true');
        await page.screenshot({ path: path.join(output, `${viewport.name}-files-reading.png`) });
        held = false;
        release();
        const feedback = page.locator('#sessionFilesList .list-feedback');
        await expect(feedback).toContainText('文件读取失败');
        await withinViewport(feedback.getByRole('button', { name: '重试', exact: true }));
        assert((await feedback.getByRole('button').boundingBox()).height >= 44);
        await expect(page.locator('#sessionFilesList')).not.toHaveAttribute('aria-busy', 'true');
        fail = false;
        await feedback.getByRole('button', { name: '重试', exact: true }).click();
        await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(1);
        await expect(feedback).toHaveCount(0);
        assert.deepEqual(queries, ['恢复验证', '恢复验证']);

        // 同一查询已有缓存时，失败不能把它伪装成更新成功。
        fail = true;
        await page
          .locator('#docSearch')
          .evaluate((el) => el.dispatchEvent(new Event('input', { bubbles: true })));
        await expect(feedback).toContainText('文件更新失败，仍显示上次结果');
        await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(1);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-files-cached-failure.png`),
        });
        fail = false;
        await feedback.getByRole('button', { name: '重试', exact: true }).click();
        await expect(feedback).toHaveCount(0);
        await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(1);
        assert.deepEqual(queries, Array(4).fill('恢复验证'));

        await page.locator('#docSearch').fill('没有匹配');
        await expect(feedback).toContainText('没有匹配的文件');
        await feedback.getByRole('button', { name: '清空搜索', exact: true }).click();
        await expect(page.locator('#docSearch')).toHaveValue('');
        await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(2);

        // 新查询已经输入、尚在防抖期间时，旧响应也必须失效。
        let releaseOld,
          sawOld = false;
        const oldGate = new Promise((resolve) => {
          releaseOld = resolve;
        });
        await page.route('**/api/doc-files/search?*', async (route) => {
          const query = new URL(route.request().url()).searchParams.get('q');
          if (query !== '旧查询') return route.fallback();
          sawOld = true;
          await oldGate;
          await route
            .fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                files: [{ path: '/fixture/old.md', title: '过时结果', kind: 'markdown' }],
              }),
            })
            .catch(() => {});
        });
        try {
          await page.locator('#docSearch').fill('旧查询');
          await expect.poll(() => sawOld).toBe(true);
          await page.locator('#sessionFilesList').evaluate((el) => {
            window.staleFileResultPainted = false;
            window.fileResultObserver = new MutationObserver(() => {
              if (el.textContent.includes('过时结果')) window.staleFileResultPainted = true;
            });
            window.fileResultObserver.observe(el, { childList: true, subtree: true });
          });
          await page.locator('#docSearch').fill('新查询');
          releaseOld();
          await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(1);
          await expect(page.locator('#sessionFilesList')).toContainText('缓存文档');
          await expect(page.locator('#sessionFilesList')).not.toContainText('过时结果');
          assert.equal(
            await page.evaluate(() => window.staleFileResultPainted),
            false,
            '旧响应不能短暂闪入新查询',
          );
        } finally {
          releaseOld();
          await page.evaluate(() => window.fileResultObserver?.disconnect());
        }
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留的草稿');
        assert(
          !fixture.state.requests.some(
            (r) => r.route.startsWith('POST ') && r.route !== 'POST /api/panes/view',
          ),
          '读取与重试不得写入会话',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
      } finally {
        release();
      }
    },
    async archiveListRecovery(page, fixture, viewport) {
      let fail = true,
        holdNext = false,
        release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const calls = [];
      const session = (id, title) => ({
        provider: 'codex',
        sessionId: id,
        title,
        cwd: '/fixture/workdir',
        lastMessageAt: timestamp,
      });
      await page.route('**/api/history?*', async (route) => {
        const params = new URL(route.request().url()).searchParams;
        const query = params.get('q'),
          offset = Number(params.get('offset'));
        calls.push({ query, offset });
        if (holdNext && offset === 1) await gate;
        const sessions =
          query === '没有匹配'
            ? []
            : [
                session(
                  offset ? 'archive-second' : 'archive-first',
                  offset ? '更多归档' : '已有归档',
                ),
              ];
        await route.fulfill({
          status: fail ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            fail
              ? { error: '测试读取失败' }
              : { sessions, nextOffset: query !== '没有匹配' && !offset ? 1 : null },
          ),
        });
      });
      try {
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarHistory').click();
        await page.locator('#chatSearchToggle').click();
        await page.locator('#chatPickerSearch').fill('归档验证');
        const feedback = page.locator('#chatPickerList .list-feedback');
        await expect(feedback).toContainText('归档读取失败');
        fail = false;
        await feedback.getByRole('button', { name: '重试', exact: true }).click();
        await expect(page.locator('#chatPickerList .history-item')).toHaveCount(1);
        await expect(feedback).toHaveCount(0);
        fail = true;
        await page.getByRole('button', { name: '加载更多', exact: true }).click();
        await expect(feedback).toContainText('更多归档读取失败');
        await expect(page.locator('#chatPickerList .history-item')).toHaveCount(1);
        await withinViewport(feedback.getByRole('button', { name: '重试', exact: true }));
        assert((await feedback.getByRole('button').boundingBox()).height >= 44);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-archive-page-failure.png`),
        });
        // 后台刷新不得偷偷重发失败分页，也不能把“重试”换回“加载更多”。
        const failedCount = calls.length;
        fixture.changed();
        await page.waitForTimeout(250);
        assert.equal(calls.length, failedCount);
        fail = false;
        holdNext = true;
        await feedback.getByRole('button', { name: '重试', exact: true }).click();
        await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
        release();
        await expect(page.locator('#chatPickerList .history-item')).toHaveCount(2);
        await expect(feedback).toHaveCount(0);
        assert.deepEqual(
          calls.filter((c) => c.query === '归档验证').map((c) => c.offset),
          [0, 0, 1, 1],
        );
        await page.locator('#chatPickerSearch').fill('没有匹配');
        await expect(feedback).toContainText('没有匹配的归档会话');
        await page.screenshot({ path: path.join(output, `${viewport.name}-archive-no-match.png`) });
        await feedback.getByRole('button', { name: '清空搜索', exact: true }).click();
        await expect(page.locator('#chatPickerSearch')).toHaveValue('');
        await expect(page.locator('#chatPickerList .history-item')).toHaveCount(1);
        await expect(feedback).toHaveCount(0);
        // 无搜索条件时，后台刷新也须保留失败状态，等待明确重试。
        fail = true;
        holdNext = false;
        await page.getByRole('button', { name: '加载更多', exact: true }).click();
        await expect(feedback).toContainText('更多归档读取失败');
        const unfilteredFailures = calls.length;
        fixture.changed();
        await page.waitForTimeout(250);
        assert.equal(calls.length, unfilteredFailures);
        await expect(feedback).toContainText('更多归档读取失败');
        fail = false;
        await feedback.getByRole('button', { name: '重试', exact: true }).click();
        await expect(page.locator('#chatPickerList .history-item')).toHaveCount(2);
        assert(
          !fixture.state.requests.some((r) => r.route === 'POST /api/history/resume'),
          '重试读取不应恢复 Agent',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
      } finally {
        release();
      }
    },
    async nativeScrollIntent(page, fixture, viewport) {
      const log = page.locator('#chatLog');
      const screen = {
        rows: [],
        projection: {
          recognized: true,
          rows: [[{ text: 'Working for 10s' }]],
          statusRows: [[{ text: 'GPT · Working · Context 23%' }]],
        },
      };
      fixture.nativeScreen(screen, 'pane-codex');
      await expect(page.locator('#chatExecutionElapsed')).toHaveText('10s');
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(220);
      await log.hover();
      await page.mouse.wheel(0, -24);
      await page.waitForTimeout(230);
      // Firefox scales wheel deltas differently with touch enabled. Keep the
      // real wheel gesture, then place its resting position inside the former
      // 64px snap threshold; the following assertions test near-bottom readers.
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight - el.clientHeight - 24;
      });
      const before = await log.evaluate((el) => ({
        top: el.scrollTop,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      }));
      assert(before.gap > 1 && before.gap < 64, 'wheel must leave the old snapping threshold');
      await page.evaluate(() => {
        const log = document.querySelector('#chatLog');
        window.scrollIntentSamples = [];
        window.sampleScrollIntent = true;
        function sample() {
          if (!window.sampleScrollIntent) return;
          scrollIntentSamples.push(log.scrollTop);
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      for (let i = 0; i < 12; i++) {
        screen.projection.rows[0][0].text = `Working for ${11 + i}s`;
        fixture.nativeFull();
        fixture.nativeScreen(screen, 'pane-codex');
        await page.waitForTimeout(35);
      }
      const samples = await page.evaluate(() => {
        window.sampleScrollIntent = false;
        return scrollIntentSamples;
      });
      assert(samples.length > 12);
      assert(
        samples.every((top) => Math.abs(top - before.top) <= 1),
        'native updates snapped a near-bottom reader',
      );
      // Hold a touch gesture over multiple frames, then leave the finger still.
      // These listeners consume the event type, not Touch coordinates. Desktop
      // Firefox does not expose the Touch constructor used by dispatchEvent.
      await log.evaluate((el) => {
        const event = new Event('touchstart', { bubbles: true });
        Object.defineProperty(event, 'touches', {
          value: [{ identifier: 1, clientX: 200, clientY: 300 }],
        });
        el.dispatchEvent(event);
      });
      await log.evaluate((el) => {
        el.scrollTop -= 12;
      });
      const touchTop = await log.evaluate((el) => el.scrollTop);
      screen.projection.rows.push([{ text: 'A status line that increases native layout height' }]);
      fixture.nativeScreen(screen, 'pane-codex');
      await page.waitForTimeout(260);
      assert.equal(
        await log.evaluate((el) => el.scrollTop),
        touchTop,
        'held touch was overridden by status growth',
      );
      await log.evaluate((el) => {
        const event = new Event('touchend', { bubbles: true });
        Object.defineProperties(event, {
          touches: { value: [] },
          changedTouches: { value: [{ identifier: 1, clientX: 200, clientY: 300 }] },
        });
        el.dispatchEvent(event);
      });
      await page.waitForTimeout(220);
      fixture.changed();
      await page.waitForTimeout(300);
      assert.equal(
        await log.evaluate((el) => el.scrollTop),
        touchTop,
        'stationary history moved after touch',
      );
      await log.hover();
      await page.mouse.wheel(0, 16);
      await page.waitForTimeout(220);
      const downTop = await log.evaluate((el) => el.scrollTop);
      assert(downTop > touchTop, 'downward wheel must follow user intent');
      fixture.nativeScreen(screen, 'pane-codex');
      await page.waitForTimeout(100);
      assert.equal(await log.evaluate((el) => el.scrollTop), downTop);
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      screen.projection.rows.push([{ text: 'New activity while following latest' }]);
      fixture.nativeScreen(screen, 'pane-codex');
      await expect
        .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(output, `${viewport.name}-scroll-intent.png`) });
    },
    async nativeFocusSynchronization(page, fixture, viewport) {
      await expect.poll(() => fixture.state.viewedPanes?.at(-1)).toBe('pane-codex');
      await page.locator('#commandInput').fill('CODEX_FOCUS_DRAFT');
      const count = fixture.state.viewedPanes.length;
      fixture.changed();
      await page.waitForTimeout(250);
      assert.equal(fixture.state.viewedPanes.length, count, 'polling must not write native focus');
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
      await expect.poll(() => fixture.state.viewedPanes.at(-1)).toBe('pane-claude');
      assert.equal(fixture.state.focusedPaneId, 'pane-claude');
      await page.locator('#commandInput').fill('CLAUDE_FOCUS_DRAFT');
      fixture.state.focusedPaneId = 'pane-codex';
      fixture.changed();
      await page.waitForTimeout(250);
      await expect(page.locator('#commandInput')).toHaveValue('CLAUDE_FOCUS_DRAFT');
      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
      await expect(page.locator('#commandInput')).toHaveValue('CODEX_FOCUS_DRAFT');
      assert.equal(
        fixture.state.viewedPanes.at(-1),
        'pane-claude',
        'Returning adopts native focus without writing it back',
      );
      const start = fixture.state.viewedPanes.length;
      await page.locator('#chatLog').hover();
      await page.mouse.wheel(0, -24);
      fixture.changed();
      await page.waitForTimeout(250);
      assert.equal(
        fixture.state.viewedPanes.length,
        start,
        'chat scrolling must not reposition native terminal',
      );
      // Delay an old selection while the user picks another pane. Only one
      // native view request may be in flight and the final choice must win.
      let release, reached;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        reached = resolve;
      });
      fixture.state.holdNativeView = async (body) => {
        if (body.target === 'pane-claude') {
          reached();
          await held;
        }
      };
      const choose = async (id) => {
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator(`#chatPickerList [data-pane-id="${id}"]`).click();
      };
      try {
        await choose('pane-claude');
        await started;
        fixture.nativeScreen(
          {
            rows: [],
            projection: {
              recognized: true,
              rows: [[{ text: 'Working for 1s' }], [{ text: '↓ Back to bottom · esc' }]],
              statusRows: [],
            },
          },
          'pane-claude',
        );
        await page.waitForTimeout(80);
        await expect(page.locator('#chatLog')).not.toContainText('Back to bottom');
        await choose('pane-codex');
        assert.equal(
          fixture.state.viewedPanes.length,
          start,
          'new selection must wait for the in-flight native operation',
        );
      } finally {
        release();
        fixture.state.holdNativeView = null;
      }
      await expect
        .poll(() => fixture.state.viewedPanes.slice(-2).join(','))
        .toBe('pane-claude,pane-codex');
      await expect(page.locator('#commandInput')).toHaveValue('CODEX_FOCUS_DRAFT');
      assert(!fixture.state.frames.some((frame) => /terminal\.(input|resize)/.test(frame)));
    },
    async nativeRenderingStability(page, fixture, viewport) {
      await require('./session-statusbar-cases').progress(page, fixture, viewport, output);
    },
    async nativeContextCompaction(page, fixture, viewport) {
      await require('./session-statusbar-cases').progress(page, fixture, viewport, output);
    },
    async nativeGoalStatus(page, fixture, viewport) {
      await require('./session-statusbar-cases').goal(page, fixture, viewport, output);
    },
    async nativeScreenCompatibility(page, fixture, viewport) {
      await require('./session-statusbar-cases').unknown(page, fixture, viewport, output);
    },
    async automaticSessionAssociation(page, fixture, viewport) {
      fixture.state.sync = true;
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      const session = fixture.state.sessions['pane-codex'];
      const history = session.messages,
        identity = session.pane.agent.session;
      session.pane.agent.session = null;
      session.messages = [];
      session.associationPending = true;
      await page.reload();
      await expect(page.locator('.chat-welcome-caption')).toHaveText(
        '正在关联原生会话，消息会自动同步',
      );
      await page.screenshot({
        path: path.join(output, `${viewport.name}-association-pending.png`),
      });
      session.pane.agent.session = identity;
      session.messages = history;
      session.associationPending = false;
      fixture.changed();
      await fixture.synced();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(page.locator('.chat-welcome')).toHaveCount(0);
      assert.equal(
        fixture.state.requests.filter((r) => r.route.startsWith('POST /api/messages')).length,
        0,
      );
      assert.equal(
        fixture.state.frames.filter((frame) => frame.includes('terminal.input')).length,
        0,
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-association-synced.png`) });
    },
    /**
     * 本地优先同步（docs/LOCAL_FIRST.md）：正文靠推送保持最新，切换会话不发正文请求，
     * 重新加载时从 IndexedDB 副本直接画，不等网络。
     */
    async localFirstSync(page, fixture, viewport) {
      fixture.state.sync = true;
      await page.reload();
      const windowed = (pane) =>
        fixture.state.requests.filter(
          (r) =>
            r.route === 'GET /api/transcript' && r.query.pane === pane && r.query.window !== '0',
        ).length;
      await expect
        .poll(
          () =>
            fixture.state.requests.some(
              (r) =>
                r.route === 'GET /api/transcript' &&
                r.query.window === '0' &&
                r.query.state === '0',
            ),
          { message: '同步生效后当前会话只取状态部分', timeout: 8000 },
        )
        .toBe(true);
      // 当前会话的新消息：推送原地接上，不重拉正文。
      const before = windowed('pane-codex');
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'pushed-1',
        role: 'assistant',
        ts: new Date().toISOString(),
        blocks: [{ kind: 'text', text: '这一条是推送来的' }],
      });
      fixture.changed();
      await fixture.synced();
      await expect(page.locator('#chatLog')).toContainText('这一条是推送来的');
      assert.equal(windowed('pane-codex'), before, '新消息不重拉正文');
      // 另一个会话在后台变了：切过去直接是最新的，不发正文请求。
      fixture.state.sessions['pane-claude'].messages.push({
        id: 'pushed-2',
        role: 'assistant',
        ts: new Date().toISOString(),
        blocks: [{ kind: 'text', text: 'Claude 后台的新回复' }],
      });
      fixture.changed();
      await fixture.synced();
      await page.waitForTimeout(200);
      const claudeBefore = windowed('pane-claude');
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
      await expect(page.locator('#chatLog')).toContainText('Claude 后台的新回复', {
        timeout: 1000,
      });
      await page.waitForTimeout(600);
      assert.equal(windowed('pane-claude'), claudeBefore, '切换会话不拉正文');
      // 文件页与归档栏：列表由推送给，打开时不请求。
      const listCalls = () =>
        fixture.state.requests.filter(
          (r) => r.route === 'GET /api/doc-files' || r.route === 'GET /api/history',
        ).length;
      const listsBefore = listCalls();
      await openFilesPanel(page, viewport);
      await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(2, { timeout: 500 });
      if (viewport.touch) await swipePage(page, '#sessionFilesPage', true);
      else await page.locator('#chatFilesToggle').click();
      fixture.state.history = [
        {
          provider: 'codex',
          sessionId: 'old-codex',
          title: '推送来的归档',
          cwd: '/fixture/project',
          lastMessageAt: Date.now() - 3600000,
          updatedAt: Date.now(),
        },
      ];
      // Archive lists have a one-minute safety refresh even with no runtime change.
      fixture.state.clockAdvance = 61000;
      fixture.changed();
      await fixture.synced();
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarHistory').click();
      await expect(page.locator('.history-item')).toContainText('推送来的归档', { timeout: 1000 });
      assert.equal(listCalls(), listsBefore, '文件页与归档栏都不请求');
      await page.locator('#sidebarRecent').click();
      if (viewport.width <= 760) await page.keyboard.press('Escape');
      // 重新加载：快照与正文请求全部挡住、启动缓存清掉，内容只能来自 IndexedDB 副本。
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            document.dispatchEvent(new Event('visibilitychange'));
            setTimeout(resolve, 1200);
          }),
      );
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(/\/api\/(transcript|snapshot)/, async (route) => {
        await gate;
        await route.continue();
      });
      try {
        await page.reload();
        await expect(page.locator('#chatPickerList [data-pane-id="pane-codex"]')).toHaveCount(1, {
          timeout: 3000,
        });
        await expect(page.locator('#chatLog')).toContainText(
          /这一条是推送来的|Claude 后台的新回复/,
          { timeout: 3000 },
        );
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    },
    /** 选中会话时文件列表就与正文一起取好，之后跟着新消息在后台更新；滑过去直接画，不再「刷出来」。 */
    async sessionFilesPreloaded(page, fixture, viewport) {
      const listCalls = () =>
        fixture.state.requests.filter((r) => r.route === 'GET /api/doc-files').length;
      await expect.poll(listCalls, { message: '没打开文件页也要先取列表' }).toBeGreaterThan(0);
      // 左栏里没点过的会话也在后台跟上：正文和它的文件列表都已取好。
      await expect
        .poll(
          () =>
            fixture.state.requests.some(
              (r) => r.route === 'GET /api/doc-files' && r.query.pane === 'pane-claude',
            ),
          { message: '没点过的会话的文件列表也要预取', timeout: 8000 },
        )
        .toBe(true);
      const before = listCalls();
      await page.waitForTimeout(3100); // 越过 3 秒的节流
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'files-live',
        role: 'assistant',
        ts: new Date().toISOString(),
        blocks: [{ kind: 'text', text: '写好了 results.md' }],
      });
      fixture.changed();
      await expect
        .poll(listCalls, { message: '有新消息时文件列表在后台重取', timeout: 8000 })
        .toBeGreaterThan(before);
      const settled = listCalls();
      await openFilesPanel(page, viewport);
      await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(2, { timeout: 300 });
      await page.waitForTimeout(600);
      assert.equal(listCalls(), settled, '刚取过的列表打开时直接画，不再发一遍');
    },
    async activityDoesNotExposeToolArguments(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.activity = '';
      const detail =
        'text(await tools.write_stdin({session_id:31450,chars:"",yield_time_ms:1000}));';
      session.messages
        .at(-1)
        .blocks.find((block) => block.kind === 'tools')
        .items.push({
          id: 'orchestration',
          name: 'exec',
          detail,
          running: true,
          input: { text: detail },
          result: null,
        });
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).toHaveText('Working');
      await expect(page.locator('#chatControls')).not.toContainText('write_stdin');
      await expect(
        page.locator('#chatLog .chat-tool-row').filter({ hasText: 'write_stdin' }),
      ).toHaveCount(1);
      for (const item of session.messages.at(-1).blocks.find((block) => block.kind === 'tools')
        .items)
        item.running = false;
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).toHaveText('Working');
      session.pane.agent.status = 'idle';
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).not.toHaveText('Working');
    },
    // 投递结果不确定（ACK_TIMEOUT）的消息，存档里出现之后要确认成送达、不重发。
    async codexArchiveReceipt(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      await send(page, 'SIDE_RECEIPT_PROMPT');
      await expect(page.locator('#commandInput')).toHaveValue('');
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog .chat-msg')).not.toContainText(['SIDE_RECEIPT_PROMPT']);
      session.messages.push({
        id: 'native-receipt',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'SIDE_RECEIPT_PROMPT' }],
      });
      await refresh(page, fixture);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^SIDE_RECEIPT_PROMPT$/ }),
      ).toHaveCount(1);
      Object.assign(session.queue[0], {
        status: 'failed',
        deliveryUncertain: true,
        error: { code: 'ACK_TIMEOUT' },
      });
      await refresh(page, fixture);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^SIDE_RECEIPT_PROMPT$/ }),
      ).toHaveCount(1);
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        1,
      );
    },
    async discardedBranchOutbox(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.queue.push(
        ...['queued', 'sending', 'failed', 'consumed', 'discarded'].map((status, i) => ({
          id: `old-${i}`,
          paneId: 'pane-codex',
          text: `OLD_BRANCH_${i}`,
          status,
          createdAt: timestamp,
        })),
      );
      await refresh(page, fixture);
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog')).not.toContainText('OLD_BRANCH_');
      session.messages.push({
        id: 'active-native-branch',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'ACTIVE_NATIVE_BRANCH' }],
      });
      await refresh(page, fixture);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^ACTIVE_NATIVE_BRANCH$/ }),
      ).toHaveCount(1);
      session.messages.pop();
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(page.locator('#chatLog')).not.toContainText('ACTIVE_NATIVE_BRANCH');
      assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
    },
    async authoritativeHistory(page, fixture) {
      fixture.state.unified = true;
      const session = fixture.state.sessions['pane-codex'];
      const messages = (n) =>
        Array.from({ length: n }, (_, i) => ({
          id: `sync-${i}`,
          role: i % 2 ? 'assistant' : 'user',
          ts: timestamp,
          blocks: [{ kind: 'text', text: `SYNC_MESSAGE_${i}` }],
        }));
      session.messages = messages(60);
      await refresh(page, fixture);
      await expect(page.locator('#chatLog [data-message-id="sync-0"]')).toHaveCount(1);
      session.messages = messages(200);
      await refresh(page, fixture);
      await expect(page.locator('#chatLog .chat-msg')).toHaveCount(200);
      await expect(page.locator('#chatLog [data-message-id="sync-80"]')).toHaveCount(1);
      session.messages = messages(2);
      await refresh(page, fixture);
      await expect(page.locator('#chatLog .chat-msg')).toHaveCount(2);
      session.messages = [];
      await refresh(page, fixture);
      await expect(page.locator('#chatLog .chat-msg')).toHaveCount(0);
    },
    /** 归档：列表靠前的会话正文与文件列表在后台先取好，点开直接画；归档会话左滑也能看它涉及的文件。 */
    async archivedPrefetchedWithFiles(page, fixture, viewport) {
      fixture.state.history = [
        {
          provider: 'codex',
          sessionId: 'old-codex',
          title: '已关闭的会话',
          cwd: '/fixture/workdir/mxops',
          lastMessageAt: Date.now() - 3600000,
          updatedAt: Date.now(),
        },
      ];
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarHistory').click();
      await expect(page.locator('.history-item')).toHaveCount(1);
      fixture.changed();
      const archivedCalls = () =>
        fixture.state.requests.filter(
          (r) => r.route === 'GET /api/history/transcript' && r.query.sessionId === 'old-codex',
        ).length;
      await expect
        .poll(archivedCalls, { message: '归档正文要在点开之前取好', timeout: 8000 })
        .toBe(1);
      await expect
        .poll(
          () =>
            fixture.state.requests.some(
              (r) => r.route === 'GET /api/doc-files' && r.query.archived === 'codex:old-codex',
            ),
          { message: '归档会话的文件列表也要预取', timeout: 8000 },
        )
        .toBe(true);
      await page.locator('.history-item').click();
      await expect(page.locator('#chatLog')).toContainText('归档里的回答', { timeout: 300 });
      assert.equal(archivedCalls(), 1, '点开时直接用取好的正文');
      await openFilesPanel(page, viewport);
      await expect(page.locator('#sessionFilesList .doc-row')).toHaveCount(2, { timeout: 300 });
    },
    async archivedReadingUsesHerdr(page, fixture, viewport) {
      fixture.state.history = [
        {
          provider: 'codex',
          sessionId: 'old-codex',
          title: '已关闭的会话',
          cwd: '/fixture/original directory',
          lastMessageAt: Date.now() - 27 * 3600000,
          updatedAt: Date.now(),
        },
        {
          provider: 'claude',
          sessionId: 'thread-claude',
          title: '仍在运行',
          cwd: '/fixture/project',
          updatedAt: Date.now(),
        },
      ];
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarHistory').click();
      await expect(page.locator('.history-item')).toHaveCount(1);
      await expect(page.locator('.history-item')).toHaveAttribute('title', /original directory/);
      await expect(page.locator('.history-item')).toContainText('1d 3h');
      assert((await page.locator('.history-item').boundingBox()).height <= 34);
      await page.screenshot({ path: path.join(output, `${viewport.name}-history.png`) });
      // 点一下只是翻看：归档里的会话已经停机，正文能读，消息发不出去。
      await page.locator('.history-item').click();
      await expect(page.locator('#chatCurrentName')).toHaveText('已关闭的会话');
      await expect(page.locator('#chatArchivedNotice')).toContainText('已归档');
      await expect(page.locator('#chatLog')).toContainText('归档里的回答');
      await expect(page.locator('#commandInput')).toBeDisabled();
      assert(
        !fixture.state.requests.some((r) => r.route === 'POST /api/history/resume'),
        '点一下不该直接恢复',
      );
      await expect(page.locator('#chatArchivedNotice')).toContainText('Herdr');
      if (viewport.width <= 760) {
        await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarHistory').click();
      }
      await page.locator('.history-item').click({ button: 'right' });
      if (viewport.touch) await expect(page.locator('.popover.context-menu')).toHaveCount(0);
      else {
        await expect(page.locator('.popover.context-menu')).toBeVisible();
        await expect(
          page
            .locator('.popover.context-menu')
            .getByRole('menuitem', { name: '设置', exact: true }),
        ).toBeEnabled();
        await expect(
          page
            .locator('.popover.context-menu')
            .getByRole('menuitem', { name: /分屏|重命名 Pane|关闭 Pane|恢复/ }),
        ).toHaveCount(0);
        await page.keyboard.press('Escape');
      }
      if (viewport.width <= 760)
        await page
          .locator('#chatPickerScrim')
          .click({ position: { x: viewport.width - 8, y: 100 } });
      await expect(page.locator('#chatTerminalView')).toHaveCount(0);
      await expect(page.locator('#commandInput')).toBeDisabled();
      assert(!fixture.state.requests.some((r) => r.route === 'POST /api/history/resume'));
    },
    async imageMenu(page, fixture, viewport) {
      // 文件页里长按（手机）或右键（电脑）图片：保存到本地、分享（2026-09-24 用户要求）。
      // 会话 APP 里走原生 StudioApp；这里用一个替身记下网页交过去的东西。
      await page.evaluate(() => {
        window.__imageCalls = [];
        window.StudioApp = {
          ...(window.StudioApp || {}),
          saveImage: (data, name, mime) =>
            window.__imageCalls.push(['save', name, mime, data.length]),
          shareImage: (data, name, mime) =>
            window.__imageCalls.push(['share', name, mime, data.length]),
        };
      });
      try {
        await openFilesPanel(page, viewport);
        await page.locator('.doc-row').first().click();
        const image = page.locator('.workspace-file-view:not([hidden]) img.doc-image');
        await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
        await image.click({ button: 'right' });
        const menu = page.locator('.popover');
        await expect(menu.getByRole('menuitem', { name: '保存到本地' })).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: '分享…' })).toBeVisible();
        await withinViewport(menu);
        await menu.getByRole('menuitem', { name: '保存到本地' }).click();
        await expect.poll(() => page.evaluate(() => window.__imageCalls.length)).toBe(1);
        const [action, name, mime, size] = await page.evaluate(() => window.__imageCalls[0]);
        assert.deepEqual([action, name, mime], ['save', '架构图.png', 'image/png']);
        assert(size > 0, '图片内容要交过去');
      } finally {
        await page.evaluate(() => {
          delete window.StudioApp.saveImage;
          delete window.StudioApp.shareImage;
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        if (await page.locator('#sessionFilesPage').isVisible())
          await page.keyboard.press('Escape');
      }
    },
    async filesPanelMaximize(page, fixture, viewport) {
      // 会话文件面板最大化（2026-09-24 用户要求）：电脑上标题栏右端一个按钮，面板占满原来聊天页
      // 的位置；再收起左栏，整个窗口就是它。按设备记住。手机与平板上文件页本来就是整页。
      const button = page.locator('#chatFilesMaximize');
      await openFilesPanel(page, viewport);
      if (viewport.touch) {
        await expect(button).toBeHidden();
        await page.keyboard.press('Escape');
        return;
      }
      const width = (selector) =>
        page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
      const main = await width('.chat-main');
      assert((await width('#sessionFilesPage')) < main * 0.7, '分栏时面板不占满');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(button).toHaveAttribute('title', '还原');
      await expect(page.locator('.chat-conversation')).toBeHidden();
      assert(
        Math.abs((await width('#sessionFilesPage')) - main) < 1,
        '最大化后占满原来聊天页的位置',
      );
      // 左栏展开时收起按钮在左栏自己的头部，面板标题栏里的那个让开；收起之后它出现，用来把左栏放回来。
      await expect(page.locator('#chatFilesSidebarToggle')).toBeHidden();
      await page.locator('#chatSidebarCollapse').click();
      await expect(page.locator('#chatSidebar')).toBeHidden();
      await expect(page.locator('#chatFilesSidebarToggle')).toBeVisible();
      assert(
        Math.abs((await width('#sessionFilesPage')) - viewport.width) < 1,
        '收起左栏后整个窗口就是它',
      );
      // 按设备记住：刷新后打开面板仍是最大化。
      await page.waitForTimeout(400);
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await page.locator('#chatFilesToggle').click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.chat-conversation')).toBeHidden();
      // 还原，并把左栏放回来，不影响后面的用例。
      await button.click();
      await expect(page.locator('.chat-conversation')).toBeVisible();
      if (await page.locator('#chatSidebar').isHidden())
        await page.locator('#chatDrawerToggle').click();
      await expect(page.locator('#chatSidebar')).toBeVisible();
      await page.locator('#chatFilesToggle').click();
      await expect(page.locator('#sessionFilesPage')).toBeHidden();
    },
    async inputHistoryPerSession(page, fixture, viewport) {
      // 输入框里 ↑ / ↓ 翻这个会话自己发过的消息，每个会话各一份（2026-09-24 用户要求）。触摸设备没有方向键。
      if (viewport.touch) return;
      const input = page.locator('#commandInput');
      const userTexts = () =>
        page
          .locator('#chatLog .chat-msg[data-role="user"]')
          .evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()));
      const open = async (provider) => {
        await page.locator(`#chatPickerList [data-pane-id="pane-${provider}"]`).click();
        await expect.poll(async () => (await userTexts()).length).toBeGreaterThan(0);
        return userTexts();
      };
      const codex = await open('codex');
      await input.click();
      await input.fill('还没写完的草稿');
      await input.press('ArrowUp');
      await expect(input).toHaveValue(codex.at(-1));
      await input.press('ArrowUp');
      await expect(input).toHaveValue(codex.at(-2));
      await input.press('ArrowDown');
      await input.press('End');
      await expect(input).toHaveValue(codex.at(-1));
      await input.press('ArrowDown');
      await expect(input).toHaveValue('还没写完的草稿');
      await input.fill('');
      // 换一个会话，翻的是那个会话自己的：给它一条只在它里面说过的话。
      fixture.state.sessions['pane-claude'].messages.push({
        id: 'claude-own',
        role: 'user',
        ts: new Date().toISOString(),
        blocks: [{ kind: 'text', text: '只在 Claude 会话里说过的话' }],
      });
      fixture.changed();
      await open('claude');
      await expect.poll(async () => (await userTexts()).at(-1)).toBe('只在 Claude 会话里说过的话');
      await input.click();
      await input.press('ArrowUp');
      await expect(input).toHaveValue('只在 Claude 会话里说过的话');
      await input.fill('');
    },
    async sidebarToggleLivesOnSidebar(page, fixture, viewport) {
      // 宽屏上左栏展开时，收起按钮在左栏头部最右端，会话顶栏里的让开；收起后没地方放了才落回顶栏左边，
      // 与右边文件页的开关对称（2026-09-24 用户要求）。手机上左栏是抽屉，仍由顶栏按钮开合。
      const inSidebar = page.locator('#chatSidebarCollapse'),
        inHead = page.locator('#chatDrawerToggle');
      if (viewport.width <= 760) {
        await expect(inSidebar).toBeHidden();
        await expect(inHead).toBeVisible();
        return;
      }
      await expect(page.locator('#chatSidebar')).toBeVisible();
      await expect(inSidebar).toBeVisible();
      await expect(inHead).toBeHidden();
      const place = await page.evaluate(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const button = box('#chatSidebarCollapse'),
          sidebar = box('#chatSidebar'),
          brand = box('.chat-sidebar-top');
        return {
          right: sidebar.right - button.right,
          brandHeight: brand.height,
          inBrand: button.top >= brand.top - 5 && button.bottom <= brand.bottom + 5,
        };
      });
      assert(
        place.inBrand && place.right >= 0 && place.right < 24,
        `收起按钮在左栏头部最右端：${JSON.stringify(place)}`,
      );
      assert.equal(
        place.brandHeight,
        viewport.touch ? 44 : 32,
        '收起按钮与导航同行，触屏保留 44px 点击区域',
      );
      await inSidebar.click();
      await expect(page.locator('#chatSidebar')).toBeHidden();
      await expect(inHead).toBeVisible();
      await expect(inSidebar).toBeHidden();
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        'chatDrawerToggle',
        '焦点跟着按钮到顶栏',
      );
      await inHead.click();
      await expect(page.locator('#chatSidebar')).toBeVisible();
      await expect(inHead).toBeHidden();
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        'chatSidebarCollapse',
        '焦点跟着按钮回到左栏',
      );
    },
    async sidebarResizerOnlyAtTop(page, fixture, viewport) {
      // 触摸设备上左栏宽度只能从右边缘最上面那一段拖（2026-09-24 用户要求，防误触）；
      // 电脑上整条边缘照旧。
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      const handle = page.locator('#chatResizer');
      await expect(handle).toBeVisible();
      const box = await handle.boundingBox();
      const sidebar = await page.locator('#chatSidebar').boundingBox();
      if (viewport.touch)
        assert(
          box.height <= 121 && Math.abs(box.y - sidebar.y) < 1,
          JSON.stringify({ box, sidebar }),
        );
      else assert(box.height >= sidebar.height - 1, JSON.stringify({ box, sidebar }));
      if (viewport.width <= 760)
        await page
          .locator('#chatPickerScrim')
          .click({ position: { x: viewport.width - 8, y: 100 } });
    },
    async tabDragFollowsFinger(page, fixture, viewport) {
      // 标签跟手（2026-09-24）：同一平面里左右平移，选中底色跟着手指滑；松手规则与换页一致。
      if (!viewport.touch) return;
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const steps = (from, to, count = 10) =>
        Array.from({ length: count + 1 }, (_, i) => Math.round(from + ((to - from) * i) / count));
      // 与真实触摸一样：目标是按下那一点下面的元素（列表里的某一行），之后的移动与松手都发给它 ——
      // 哪怕它已被挪动。原来直接发给列表容器，漏掉了「按住的那一行被重新渲染掉、后续事件冒泡不上来、
      // 页面只晃一下不跟手」的缺陷（2026-09-24 用户指出）。
      const touchAll = (selector, xs, pause, finish) =>
        page.locator(selector).evaluate(
          async (el, { xs, pause, finish }) => {
            const box = el.getBoundingClientRect(),
              y = box.top + Math.min(60, box.height / 2);
            const target = document.elementFromPoint(xs[0], y);
            window.__touchTarget = target && el.contains(target) ? target : el;
            const touch = (x) =>
              new Touch({ identifier: 5, target: window.__touchTarget, clientX: x, clientY: y });
            window.__touchTarget.dispatchEvent(
              new TouchEvent('touchstart', { bubbles: true, touches: [touch(xs[0])] }),
            );
            for (const x of xs.slice(1)) {
              window.__touchTarget.dispatchEvent(
                new TouchEvent('touchmove', { bubbles: true, touches: [touch(x)] }),
              );
              if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
            }
            if (finish)
              window.__touchTarget.dispatchEvent(
                new TouchEvent('touchend', { bubbles: true, touches: [] }),
              );
          },
          { xs, pause, finish },
        );
      const release = (selector) =>
        page
          .locator(selector)
          .evaluate((el) =>
            (window.__touchTarget || el).dispatchEvent(
              new TouchEvent('touchend', { bubbles: true, touches: [] }),
            ),
          );
      const verify = async ({ list, tabs, from, to, open }) => {
        await open();
        const box = await page.locator(list).boundingBox();
        const x0 = Math.round(box.x + box.width * 0.8),
          half = Math.round(box.width / 2);
        // 1. 拖到一半不松手：底色停在两个标签中间，快照与新内容各占一半。
        await touchAll(list, steps(x0, x0 - half), 30, false);
        const middle = await page.evaluate(
          ({ tabs, from, to }) => {
            const glider = document.querySelector('.tab-glider')?.getBoundingClientRect();
            const a = document.querySelector(tabs[from]).getBoundingClientRect(),
              b = document.querySelector(tabs[to]).getBoundingClientRect();
            return glider && { glider: glider.left, a: a.left, b: b.left };
          },
          { tabs, from, to },
        );
        assert(
          middle &&
            middle.glider > Math.min(middle.a, middle.b) + 2 &&
            middle.glider < Math.max(middle.a, middle.b) - 2,
          `底色应停在两个标签之间：${JSON.stringify(middle)}`,
        );
        // 停住再松手，过了四成：切过去，快照与底色都撤掉。
        await page.waitForTimeout(150);
        await release(list);
        await expect(page.locator(tabs[to])).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.tab-glider')).toHaveCount(0);
        await expect
          .poll(() =>
            page
              .locator(list)
              .evaluate(
                (el) =>
                  el.parentElement.querySelectorAll(':scope > [aria-hidden="true"][inert]').length,
              ),
          )
          .toBe(0);
        // 2. 往回慢拖不到四成：弹回，仍在新标签。
        await touchAll(
          list,
          steps(box.x + 30, box.x + 30 + Math.round(box.width * 0.25)),
          30,
          false,
        );
        await page.waitForTimeout(150);
        await release(list);
        await expect(page.locator(tabs[to])).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.tab-glider')).toHaveCount(0);
        // 3. 快速一甩：切回原来那一栏。
        await touchAll(list, [box.x + 30, box.x + 50, box.x + 110], 0, true);
        await expect(page.locator(tabs[from])).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.tab-glider')).toHaveCount(0);
      };
      try {
        await verify({
          list: '#chatPickerList',
          tabs: ['#sidebarWorkspaces', '#sidebarRecent', '#sidebarHistory'],
          from: 1,
          to: 2,
          open: async () => {
            if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
            await page.locator('#sidebarRecent').click();
          },
        });
        if (viewport.width <= 760) {
          await page
            .locator('#chatPickerScrim')
            .click({ position: { x: viewport.width - 8, y: 100 } });
          await expect(page.locator('#chatSidebar')).toBeHidden();
        }
      } finally {
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
    },
    async pageDragFollowsFinger(page, fixture, viewport) {
      // 换页跟手（2026-09-24 用户要求）：手指到哪页面到哪，松手按位置与速度决定完成还是弹回。
      if (!viewport.touch) return;
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // 逐点拖动：每一步之间停一会儿，速度就慢；不停就是一甩。
      const steps = (from, to, count = 10) =>
        Array.from({ length: count + 1 }, (_, i) => Math.round(from + ((to - from) * i) / count));
      const drag = (selector, xs, pause, finish = true) =>
        page.locator(selector).evaluate(
          async (el, { xs, pause, finish }) => {
            const y = el.getBoundingClientRect().top + 200;
            const touch = (x) => new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
            el.dispatchEvent(
              new TouchEvent('touchstart', { bubbles: true, touches: [touch(xs[0])] }),
            );
            for (const x of xs.slice(1)) {
              el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(x)] }));
              if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
            }
            if (finish)
              el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
          },
          { xs, pause, finish },
        );
      const release = (selector) =>
        page
          .locator(selector)
          .evaluate((el) =>
            el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })),
          );
      const left = (selector) =>
        page
          .locator(selector)
          .evaluate(
            (el) => el.getBoundingClientRect().left - el.parentElement.getBoundingClientRect().left,
          );
      try {
        const files = page.locator('#sessionFilesPage');
        const width = await page
          .locator('.chat-main')
          .evaluate((el) => el.getBoundingClientRect().width);
        const start = Math.round(width * 0.8);
        // 1. 拖到一半不松手：文件页停在手指的位置（跟手，没有动画）。
        await drag('#chatLog', steps(start, start - Math.round(width / 2)), 40, false);
        const midway = await left('#sessionFilesPage');
        assert(
          Math.abs(midway - width / 2) < width * 0.06,
          `拖到一半时应停在一半：${midway} / ${width}`,
        );
        // 停住再松手，过了四成：完成打开。
        await page.waitForTimeout(150);
        await release('#chatLog');
        await expect.poll(() => left('#sessionFilesPage')).toBe(0);
        await expect(files).toBeVisible();
        // 2. 往回慢拖不到四成就松手：弹回，仍开着。
        await drag('#sessionFilesList', steps(40, 40 + Math.round(width * 0.25)), 40, false);
        await page.waitForTimeout(150);
        await release('#sessionFilesList');
        await expect.poll(() => left('#sessionFilesPage')).toBe(0);
        await expect(files).toBeVisible();
        // 3. 快速一甩，距离很短也算：关掉。
        await drag('#sessionFilesList', [40, 60, 110], 0);
        await expect(files).toBeHidden();
        await expect(page.locator('#chatLog')).toBeVisible();
        if (viewport.width <= 760) {
          // 左栏同样跟手：慢拖不到四成弹回，慢拖过半打开。
          const sidebar = page.locator('#chatSidebar');
          const sidebarWidth = Math.min(viewport.width * 0.84, 320);
          await drag('#chatLog', steps(20, 20 + Math.round(sidebarWidth * 0.2)), 40, false);
          await page.waitForTimeout(150);
          await release('#chatLog');
          await expect(sidebar).toBeHidden();
          await drag('#chatLog', steps(20, 20 + Math.round(sidebarWidth * 0.7)), 40, false);
          await page.waitForTimeout(150);
          await release('#chatLog');
          await expect(sidebar).toBeVisible();
          await expect
            .poll(() => sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().left)))
            .toBe(0);
          await page
            .locator('#chatPickerScrim')
            .click({ position: { x: viewport.width - 8, y: 100 } });
          await expect(sidebar).toBeHidden();
        }
      } finally {
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
    },
    async pageSlide(page, fixture, viewport) {
      // 三页之间左右平移（2026-09-24 用户要求）：聊天页 ⇄ 左栏页、聊天页 ⇄ 文件页。
      // 电脑上两者都是并排的，不参与。页内换标签不平移。
      if (!viewport.touch) return;
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      try {
        const files = page.locator('#sessionFilesPage');
        const transform = (locator) => locator.evaluate((el) => getComputedStyle(el).transform);
        const offset = (locator) =>
          locator.evaluate(
            (el) => el.getBoundingClientRect().left - el.parentElement.getBoundingClientRect().left,
          );
        // 文件页：从右边平移进来。触发之后下一帧还在右侧，过渡结束后归位。
        await swipePage(page, '#chatLog', false);
        const early = await offset(files);
        assert(early > 20, `刚打开时应当还在右边：${early}`);
        await expect.poll(() => transform(files)).toBe('none');
        await expect(files).toBeVisible();
        // 返回：平移出去之后才算藏起来。
        await swipePage(page, '#sessionFilesList', true);
        await expect(files).toBeHidden();
        await expect(page.locator('#chatLog')).toBeVisible();
        if (viewport.width <= 760) {
          // 左栏：从左边平移进来。
          const sidebar = page.locator('#chatSidebar');
          await page.locator('#chatDrawerToggle').click();
          const start = await sidebar.evaluate((el) => el.getBoundingClientRect().left);
          assert(start < -20, `刚打开时应当还在左边：${start}`);
          await expect.poll(() => transform(sidebar)).toBe('none');
          await expect(page.locator('#chatPickerScrim')).toBeVisible();
          await page
            .locator('#chatPickerScrim')
            .click({ position: { x: viewport.width - 8, y: 100 } });
          await expect(sidebar).toBeHidden();
        }
      } finally {
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
    },
    async bootFromCache(page, fixture, viewport) {
      // 启动先画上次的样子：会话列表与当前会话存在本机，页面一打开就画出来，再在后台更新。
      // 原来要等配置、实时通道、快照、正文一路回来，先白屏再「啪」地出现（2026-09-24 用户指出）。
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      // 两个会话都「不忙、有过消息」：Codex 正看着（算看过），Claude 也切过去看一眼，都应是灰点。
      for (const id of ['pane-codex', 'pane-claude'])
        Object.assign(fixture.state.sessions[id].pane, { lastMessageAt: Date.parse(timestamp) });
      for (const id of ['pane-codex', 'pane-claude'])
        fixture.state.sessions[id].pane.agent.status = 'idle';
      await refresh(page, fixture);
      await switchTo(page, 'claude');
      await switchTo(page, 'codex');
      await expect(
        page.locator('#chatPickerList [data-pane-id="pane-claude"] .status-dot'),
      ).toHaveAttribute('data-status', 'idle');
      // 只在转入后台（pagehide / visibilitychange）时写，平时渲染不碰 localStorage。
      await page.waitForTimeout(1500);
      assert.equal(
        await page.evaluate(() => localStorage.getItem('agentStudioBoot')),
        null,
        '平时不写启动缓存',
      );
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem('agentStudioBoot'))), {
          timeout: 5000,
        })
        .toBe(true);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(/\/api\/(snapshot|transcript|config)/, async (route) => {
        await gate;
        await route.continue();
      });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#chatView')).toBeVisible({ timeout: 1500 });
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例', {
          timeout: 1500,
        });
        if (viewport.width > 760)
          await expect(page.locator('#chatPickerList [data-pane-id="pane-codex"]')).toBeVisible();
        // 设备配置还没回来：已看过的会话第一次画出来就是灰点，不先亮成蓝点（2026-09-25 用户指出）。
        const dot = page.locator('#chatPickerList [data-pane-id="pane-claude"] .status-dot');
        if (await dot.count())
          assert.equal(
            await dot.getAttribute('data-status'),
            'offline',
            '未联网的启动副本应明确标为离线',
          );
        else
          assert.equal(
            await page.evaluate(() => {
              const seen = JSON.parse(localStorage.getItem('studioSeenDoneLocal') || '{}');
              return Boolean(seen['thread-claude']);
            }),
            true,
            '已看过的记录没有存在本机',
          );
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
      // 数据回来之后原地更新，内容还在。
      await refresh(page, fixture);
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    },
    async prefetchRecentSessions(page, fixture, viewport) {
      // 空闲时预取最近的会话：切过去直接从缓存画出来，不等那一个来回（2026-09-24 用户指出
      // 手机上切会话要等一两秒）。页面重新载入后只打开过当前这一个，另一个靠预取。
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      const prefetched = () =>
        fixture.state.requests.filter(
          (r) => r.route === 'GET /api/transcript' && r.query.pane === 'pane-claude',
        ).length;
      await expect.poll(prefetched, { timeout: 8000 }).toBeGreaterThan(0);
      // 把正文请求整个卡住再切过去：内容只能来自预取的缓存。
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/api/transcript?*', async (route) => {
        await gate;
        await route.continue();
      });
      try {
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例', {
          timeout: 1500,
        });
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
      await switchTo(page, 'codex');
    },
    async shellPaneStaysSelected(page, fixture, viewport) {
      const shell = clone(fixture.state.sessions['pane-codex']);
      shell.pane = {
        ...shell.pane,
        paneId: 'pane-shell',
        terminalId: 'terminal-shell',
        title: '空 Shell',
        agent: null,
      };
      shell.messages = [];
      fixture.state.sessions['pane-shell'] = shell;
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarWorkspaces').click();
      await page.locator('[data-pane-id="pane-shell"]').click();
      await expect(page.locator('#chatCurrentName')).toContainText('空 Shell');
      await expect(page.locator('#shellTerminal')).toContainText('SHELL_FIXTURE_READY');
      await expect(page.locator('#chatLog')).toBeHidden();
      for (let i = 0; i < 3; i++) {
        const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/snapshot');
        fixture.changed();
        await response;
      }
      await expect(page.locator('#chatCurrentName')).toContainText('空 Shell');
      await expect(page.locator('#chatTerminalView')).toHaveCount(0);
      await expect(page.locator('#commandInput')).toBeDisabled();
      assert(!fixture.state.requests.some((r) => r.route === 'POST /api/agents/start'));
      shell.pane.agent = {
        id: 'codex',
        label: 'Codex',
        status: 'idle',
        session: { value: 'thread-shell' },
      };
      shell.messages = clone(fixture.state.sessions['pane-codex'].messages);
      await refresh(page, fixture);
      await expect(page.locator('#chatCurrentName')).toContainText('空 Shell');
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    },
    async projectMaterials(page, fixture, viewport) {
      await page.locator('#commandInput').fill('会话文件共用预览期间保留的草稿');
      await openFilesPanel(page, viewport);
      const rows = page.locator('#sessionFilesList .doc-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.first().locator('strong')).toHaveText('当前结果');
      await expect(rows.first().locator('time')).not.toHaveText('');
      await rows.first().click();
      const view = page.locator('.workspace-file-view:not([hidden])');
      await expect(page.locator('#workspaceFilesPage')).toBeVisible();
      await expect(view.locator('h1')).toHaveText('当前结果');
      await expect(page.locator('#projectView')).toBeEmpty();
      assert.equal(await page.evaluate(() => window.filePreviewExecuted), undefined);
      await view.locator('.md-local-link').filter({ hasText: 'kernel.cpp' }).click();
      await expect(view.locator('.cm-editor')).toHaveAttribute('data-language', 'C++');
      await expect(view.locator('.cm-content')).toContainText('int add(int a, int b)');
      const look = await view.locator('.cm-scroller').evaluate((node) => ({
        font: getComputedStyle(node).fontFamily,
        overflow: document.documentElement.scrollWidth - innerWidth,
      }));
      assert.match(look.font, /^["']?Cascadia Mono/);
      assert.equal(look.overflow, 0);
      assert(!fixture.state.requests.some((r) => r.route === 'GET /api/doc-files/content'));
      await page.screenshot({ path: path.join(output, `${viewport.name}-doc-files.png`) });
      await page.getByRole('button', { name: '返回会话', exact: true }).click();
      await expect(page.locator('#sessionFilesPage')).toBeVisible();
      await rows.first().click();
      await expect(view.locator('h1')).toHaveText('当前结果');
      await page.keyboard.press('Escape');
      await expect(page.locator('#sessionFilesList')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#commandInput')).toHaveValue('会话文件共用预览期间保留的草稿');
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
    },
    async projectPanelWidth(page, fixture, viewport) {
      // 面板要装的是整个工作区的材料，不是几个文件名 —— 固定 420px 不够，
      // 所以它可以拖，并且按设备记住。手机上面板是整页，没有这条手柄。
      const panel = page.locator('#sessionFilesPage');
      const handle = page.locator('#sessionFilesResizer');
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
      await openFilesPanel(page, viewport);
      // 手柄只属于「宽屏且有鼠标」那一档：平板同样宽，却没有悬停也没有实体键盘，
      // 面板在那里是整页的，没有可拖的边。
      if (viewport.touch) {
        await expect(handle).toBeHidden();
        return;
      }

      await expect(panel).toBeVisible();
      const before = (await panel.boundingBox()).width;
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // 面板在右边，所以往左拖是变宽。
      await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      const after = (await panel.boundingBox()).width;
      assert(after > before + 100, `拖动后应当明显变宽: ${before} → ${after}`);
      // 存下来的值要能撑过一次真正的重新加载。⚠️ 这里不能用 refresh()：它只是让
      // 前端重拉一次数据，页面不重载、面板仍开着，再点一次 toggle 反而是关掉它。
      //
      // ⚠️ 宽度存的是**根目录设备设置**（走 POST /api/settings），不是 localStorage，
      // 而那条写入有 150ms 节流。拖完立刻 reload 会把它连同请求一起丢掉 ——
      // 先等服务端真的收到这个值，再重载。
      await expect
        .poll(
          () =>
            fixture.state.requests.filter((r) => r.route === 'POST /api/settings').at(-1)?.body
              .settings?.ui?.studioFilesWidth,
        )
        .toBeTruthy();
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await openFilesPanel(page, viewport);
      // boundingBox 不像 locator 那样自动等待，先确认面板真的展开了再量。
      await expect(panel).toBeVisible();
      const restored = (await panel.boundingBox()).width;
      assert(Math.abs(restored - after) <= 2, `宽度应当按设备记住: ${after} → ${restored}`);
      // 服务端确实把它收下了。⚠️ `ui` 是白名单（lib/root-preferences.js 的 uiKeys），
      // 没登记的键会让整条 POST 被拒成 400，而前端只是 catch 掉 ——
      // 表现是「拖了有效、刷新就回去」，不报错。
      const stored = await page.evaluate(async () =>
        (await fetch('/api/config?token=fixture')).json().then((d) => d.settings?.ui),
      );
      assert.equal(
        stored.studioFilesWidth,
        String(Math.round(after)),
        '宽度要进设备配置，不是只活在这一次会话里',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    },
    async providerErrorNotice(page, fixture, viewport) {
      // 供应商返回的错误在存档里是一条 assistant 记录，但它不是 Agent 说的话。
      // 混在普通回答里，用户会以为模型真的这么回答了。
      const session = fixture.state.sessions['pane-claude'];
      session.messages = [
        { id: 'm1', role: 'user', blocks: [{ kind: 'text', text: '继续' }] },
        {
          id: 'm2',
          role: 'assistant',
          kind: 'error',
          status: 529,
          blocks: [
            { kind: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue.' },
          ],
        },
        { id: 'm3', role: 'assistant', blocks: [{ kind: 'text', text: '重试之后的正常回答。' }] },
      ];
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();

      const error = page.locator('#chatLog .chat-msg[data-kind="error"]');
      await expect(error).toHaveCount(1);
      await expect(error).toContainText('接口错误 529');
      await expect(error).toContainText('Overloaded');
      // 正常回答不能被误标成错误。
      await expect(page.locator('#chatLog .chat-msg[data-kind="error"]')).not.toContainText(
        '重试之后的正常回答',
      );

      const look = await error.evaluate((el) => {
        const parse = (value) =>
          value
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        const luminance = (rgb) => {
          const c = rgb.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const mark = el.querySelector('.chat-error-mark');
        let node = el,
          background = 'rgba(0, 0, 0, 0)';
        while (node && background.startsWith('rgba(0, 0, 0, 0')) {
          background = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        const a = luminance(parse(getComputedStyle(mark).color)),
          b = luminance(parse(background));
        return {
          border: getComputedStyle(el).borderLeftWidth,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert(parseFloat(look.border) >= 2, '错误消息要有左侧色条把它和回答分开');
      assert(look.ratio >= 4.5, `错误标签对比度只有 ${look.ratio.toFixed(2)}，低于 AA 的 4.5`);
      assert.equal(look.overflow, 0);
      await page.screenshot({ path: path.join(output, `${viewport.name}-provider-error.png`) });
    },
    async rendererDegradedNotice(page, fixture, viewport) {
      // 来源未知或数据版本过新时，内容照常显示但必须标明不是完整适配。
      // 静默降级会让人把「显示得朴素」当成「内容就这么简单」。
      const session = fixture.state.sessions['pane-claude'];
      session.messages = [
        {
          id: 'm1',
          role: 'assistant',
          harness: 'kimi-k3',
          blocks: [{ kind: 'text', text: '来自还没有渲染器的 Harness。' }],
        },
        {
          id: 'm2',
          role: 'assistant',
          harness: 'claude',
          schemaVersion: 9,
          blocks: [{ kind: 'text', text: '数据版本比渲染器新。' }],
        },
        {
          id: 'm3',
          role: 'assistant',
          harness: 'claude',
          blocks: [{ kind: 'text', text: '正常适配的消息。' }],
        },
      ];
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();

      const degraded = page.locator('#chatLog .chat-msg[data-degraded="true"]');
      await expect(degraded).toHaveCount(2, '未知来源与过新版本都要标记');
      await expect(degraded.nth(0)).toContainText('kimi-k3 还没有专用渲染器');
      await expect(degraded.nth(0)).toContainText(
        '来自还没有渲染器的 Harness',
        '内容仍要显示，不能空白',
      );
      await expect(degraded.nth(1)).toContainText('数据版本高于当前渲染器');

      // 正常适配的消息不该被标记，否则提示就没有意义了。
      const normal = page.locator('#chatLog .chat-msg', { hasText: '正常适配的消息' });
      await expect(normal).not.toHaveAttribute('data-degraded', 'true');

      const look = await degraded.nth(0).evaluate((el) => {
        const parse = (value) =>
          value
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        const luminance = (rgb) => {
          const c = rgb.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const mark = el.querySelector('.chat-degraded-mark');
        let node = el,
          background = 'rgba(0, 0, 0, 0)';
        while (node && background.startsWith('rgba(0, 0, 0, 0')) {
          background = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        const a = luminance(parse(getComputedStyle(mark).color)),
          b = luminance(parse(background));
        return {
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          harness: el.dataset.harness,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert(look.ratio >= 4.5, `兼容提示对比度只有 ${look.ratio.toFixed(2)}，低于 AA 的 4.5`);
      assert.equal(look.harness, 'unknown', '未知来源应落到兜底渲染器');
      assert.equal(look.overflow, 0);
      await page.screenshot({ path: path.join(output, `${viewport.name}-renderer-degraded.png`) });
    },
    async structuredChatPreservesDraft(page, fixture) {
      await page.locator('#commandInput').fill('结构化聊天草稿');
      await page.locator('#chatLog').evaluate((el) => {
        el.scrollTop = 300;
      });
      const top = await page.locator('#chatLog').evaluate((el) => el.scrollTop);
      await expect(page.locator('#chatTerminalView,.xterm')).toHaveCount(0);
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/snapshot');
      fixture.changed();
      await response;
      await expect(page.locator('#commandInput')).toHaveValue('结构化聊天草稿');
      assert.equal(await page.locator('#chatLog').evaluate((el) => el.scrollTop), top);
      assert(!fixture.state.frames.some((frame) => frame.includes('terminal.input')));
      assert(
        !fixture.state.requests.some((r) =>
          /POST \/api\/(agents\/start|workspaces\/create)/.test(r.route),
        ),
      );
    },
    async goalStatus(page, fixture, viewport) {
      const { codexGoal, claudeGoal } = require('../../lib/agent-goal');
      const session = fixture.state.sessions['pane-codex'];
      const objective =
        '完整目标\n' +
        '验证模型、消息队列和文件预览。'.repeat(100) +
        '<img src=x onerror=alert(1)>';
      const row = page.locator('#chatGoal'),
        summary = page.locator('#chatGoalSummary'),
        label = page.locator('#chatGoalState');
      await expect(row).toBeHidden();
      session.webStatus = { goal: codexGoal({ objective, status: 'active' }) };
      await refresh(page, fixture);
      await expect(label).toHaveText('Pursuing goal');
      const geometry = await row.evaluate((el) => {
        const summary = el.querySelector('button'),
          input = document.querySelector('#chatInput');
        return {
          row: el.getBoundingClientRect().toJSON(),
          summary: summary.getBoundingClientRect().toJSON(),
          input: input.getBoundingClientRect().toJSON(),
          text: el.querySelector('.chat-goal-text').clientWidth,
          background: getComputedStyle(summary).backgroundColor,
          border: getComputedStyle(summary).borderWidth,
          textScroll: el.querySelector('.chat-goal-text').scrollWidth,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.equal(geometry.overflow, 0);
      assert(geometry.row.bottom <= geometry.input.top);
      assert.equal(geometry.row.x, geometry.input.x);
      assert.equal(geometry.row.width, geometry.input.width);
      assert(geometry.textScroll > geometry.text);
      assert(geometry.summary.height <= 36);
      assert(
        geometry.summary.right <= (viewport.width * 5) / 8 + 0.5,
        'goal text must end before the viewport 5/8 line',
      );
      assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
      assert.equal(geometry.border, '0px');
      // Being idle between turns is not a paused goal.
      session.pane.agent.status = 'idle';
      await refresh(page, fixture);
      await expect(label).toHaveText('Pursuing goal');
      await summary.click();
      const dialog = page.locator('#chatDialog');
      await expect(dialog.locator('.chat-goal-detail')).toHaveText(objective);
      await expect(dialog.locator('img')).toHaveCount(0);
      for (const status of [
        'paused',
        'active',
        'blocked',
        'usageLimited',
        'budgetLimited',
        'complete',
      ]) {
        session.webStatus.goal = codexGoal({ objective: 'Changed goal: ' + status, status });
        await refresh(page, fixture);
        await expect(label).toHaveText(session.webStatus.goal.label);
        await expect(dialog.locator('.goal-dialog-status')).toHaveText(
          {
            paused: '已暂停',
            active: '进行中',
            blocked: '受阻',
            usageLimited: '额度受限',
            budgetLimited: '预算耗尽',
            complete: '已完成',
          }[status],
        );
        await expect(dialog.locator('.chat-goal-detail')).toHaveText('Changed goal: ' + status);
      }
      assert.equal(await page.evaluate(() => window.StudioNavigation.back()), true);
      await expect(dialog).not.toBeVisible();
      session.webStatus.goal = codexGoal({ objective: '持续完成开发任务', status: 'blocked' });
      await refresh(page, fixture);
      const goalSpacing = await row.evaluate((el) => {
        const summary = el.querySelector('button').getBoundingClientRect(),
          state = el.querySelector('.chat-goal-state').getBoundingClientRect();
        return { gap: state.left - summary.right, expected: parseFloat(getComputedStyle(el).gap) };
      });
      assert(
        Math.abs(goalSpacing.gap - goalSpacing.expected) < 1,
        'Goal status follows the objective',
      );
      await page.screenshot({ path: path.join(output, viewport.name + '-goal-inline.png') });
      await summary.click();
      session.webStatus.goal = null;
      await refresh(page, fixture);
      await expect(row).toBeHidden();
      await expect(dialog.locator('.goal-dialog-status')).toHaveText('未设置');
      await page.locator('#chatDialogCancel').click();
      session.webStatus.goal = codexGoal({ objective: 'Codex only', status: 'paused' });
      await refresh(page, fixture);
      await switchTo(page, 'claude');
      await expect(row).toBeHidden();
      const claude = fixture.state.sessions['pane-claude'];
      for (const value of [
        { met: false, sentinel: true },
        { met: false },
        { met: true },
        { met: false, failed: true },
        { met: true, sentinel: true },
      ]) {
        claude.webStatus = {
          goal: claudeGoal([
            {
              type: 'attachment',
              attachment: { type: 'goal_status', condition: 'Claude goal', ...value },
            },
          ]),
        };
        await refresh(page, fixture);
        if (claude.webStatus.goal) await expect(label).toHaveText(claude.webStatus.goal.label);
        else await expect(row).toBeHidden();
      }
      await switchTo(page, 'codex');
      await expect(label).toHaveText('Goal paused');
      // A new native session reusing the pane must not inherit its old goal.
      session.pane.agent.session.value = 'replacement-thread';
      delete session.webStatus.goal;
      await refresh(page, fixture);
      await expect(row).toBeHidden();
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
    },
    async claudeMidturnReceipt(page, fixture, viewport) {
      await switchTo(page, 'claude');
      const session = fixture.state.sessions['pane-claude'];
      session.queue.push({
        id: 'native-pending',
        paneId: 'pane-claude',
        text: 'CLAUDE_NATIVE_ONLY',
        status: 'sending',
        createdAt: timestamp,
      });
      session.messages.push({
        id: 'claude-native',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'CLAUDE_NATIVE_ONLY' }],
      });
      await refresh(page, fixture);
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^CLAUDE_NATIVE_ONLY$/ }),
      ).toHaveCount(1);
      session.queue[0].status = 'failed';
      await refresh(page, fixture);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^CLAUDE_NATIVE_ONLY$/ }),
      ).toHaveCount(1);
    },
    async deviceColors(page, fixture, viewport) {
      const postsBefore = fixture.state.requests.filter(
        (r) =>
          r.route.startsWith('POST') &&
          !['POST /api/settings', 'POST /api/panes/view'].includes(r.route),
      ).length;
      await page.evaluate(() => {
        window.themeCalls = [];
        window.StudioApp = { setTheme: (...args) => window.themeCalls.push(args) };
      });
      const footer = page.locator('#chatDeviceSettings');
      if (!(await footer.isVisible())) await page.locator('#chatDrawerToggle').click();
      await expect(footer).toBeVisible();
      const geometry = await footer.evaluate((el) => {
        const box = el.getBoundingClientRect(),
          sidebar = el.closest('aside').getBoundingClientRect();
        return {
          bottom: box.bottom,
          sidebarBottom: sidebar.bottom,
          height: box.height,
          width: innerWidth,
          left: box.left,
        };
      });
      assert(
        geometry.height >= 44 && geometry.sidebarBottom - geometry.bottom <= 36,
        JSON.stringify(geometry),
      );
      // Even a long history scrolls above the fixed settings entry.
      const afterScroll = await page.evaluate(() => {
        const list = document.querySelector('#chatPickerList');
        const probes = Array.from({ length: 100 }, () => {
          const row = document.createElement('div');
          row.style.height = '32px';
          row.style.flexShrink = '0';
          row.textContent = '会话';
          list.append(row);
          return row;
        });
        list.scrollTop = list.scrollHeight;
        const bottom = document.querySelector('#chatDeviceSettings').getBoundingClientRect().bottom;
        probes.forEach((row) => row.remove());
        return bottom;
      });
      assert.equal(afterScroll, geometry.bottom);
      await footer.click();
      await page.locator('#settingsAppearanceTab').click();
      await expect(page.locator('#settingsPage')).toBeVisible();
      const results = [];
      for (const id of ['light', 'default']) {
        await page.locator(`.device-theme-option:has(input[value="${id}"])`).click();
        await expect(page.locator(`input[name="deviceTheme"][value="${id}"]`)).toBeChecked();
        const result = await page.evaluate(() => {
          const palette = StudioDeviceTheme.current();
          function rgb(color) {
            return color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number);
          }
          function luminance(color) {
            return rgb(color).reduce((sum, v, i) => {
              const c = v / 255;
              return (
                sum +
                (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][i]
              );
            }, 0);
          }
          function contrast(fg, bg) {
            const a = luminance(fg),
              b = luminance(bg);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }
          const bg = getComputedStyle(document.body).backgroundColor;
          const dialog = document.querySelector('#settingsPage'),
            rect = dialog.getBoundingClientRect();
          const pairs = [
            ['.chat-msg[data-role="assistant"]', 'body'],
            ['.chat-input-field', '.chat-input'],
            ['#chatDeviceSettings', '.chat-sidebar'],
            ['.device-color-settings h3', '#settingsPage'],
            ['.chat-tool-detail', 'body'],
            ['#chatCurrentKind', 'body'],
          ];
          const ratios = pairs.map(([fg, background]) => ({
            fg,
            ratio: contrast(
              getComputedStyle(document.querySelector(fg)).color,
              getComputedStyle(document.querySelector(background)).backgroundColor,
            ),
          }));
          const folderColor = getComputedStyle(
            document.querySelector('.chat-tree-icon:not(.empty)'),
          ).color;
          const folderContrast = contrast(
            folderColor,
            getComputedStyle(document.querySelector('.chat-sidebar')).backgroundColor,
          );
          return {
            id: palette.id,
            bg,
            ratios,
            folderColor,
            folderContrast,
            top: rect.top,
            bottom: rect.bottom,
            right: rect.right,
            left: rect.left,
            width: innerWidth,
            height: innerHeight,
            native: window.themeCalls.at(-1),
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        assert.equal(result.id, id);
        assert.equal(
          result.folderColor,
          { default: 'rgb(158, 203, 255)', light: 'rgb(102, 120, 138)' }[id],
        );
        assert(result.folderContrast >= 3, JSON.stringify(result));
        await expect
          .poll(
            () =>
              fixture.state.requests.filter((r) => r.route === 'POST /api/settings').at(-1)?.body
                .settings.theme,
          )
          .toBe(id);
        assert(
          result.ratios.every((row) => row.ratio >= 4.5),
          JSON.stringify(result),
        );
        assert(
          result.left >= 0 &&
            result.right <= result.width &&
            result.top >= 0 &&
            result.bottom <= result.height &&
            !result.overflow,
          JSON.stringify(result),
        );
        assert.equal(result.native[1], id === 'light');
        results.push(result);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-theme-${id}-settings.png`),
        });
      }
      // Page back returns to categories before closing settings.
      assert(await page.evaluate(() => StudioNavigation.back()));
      await expect(page.locator('.settings-nav')).toBeVisible();
      assert(await page.evaluate(() => StudioNavigation.back()));
      await expect(page.locator('#settingsPage')).not.toBeVisible();
      if (viewport.touch) await page.evaluate(() => StudioNavigation.back());
      for (const id of ['light', 'default']) {
        await page.evaluate((id) => StudioDeviceTheme.apply(id), id);
        await page.screenshot({ path: path.join(output, `${viewport.name}-theme-${id}-chat.png`) });
      }
      // A remembered light theme must also keep the reconnect button readable on hover.
      await page.evaluate(() => {
        StudioDeviceTheme.apply('light');
        document.querySelector('#authDialog').showModal();
      });
      await page.locator('#authDialog .primary').hover();
      await expect
        .poll(() =>
          page
            .locator('#authDialog .primary')
            .evaluate((el) => getComputedStyle(el).backgroundColor),
        )
        .toBe('rgb(61, 90, 70)');
      await page.evaluate(() => document.querySelector('#authDialog').close());
      // Storage is applied in the head even when the main application cannot start.
      await page.evaluate(() => StudioDeviceTheme.apply('light'));
      await page.waitForTimeout(300);
      await page.route('**/app.js*', (route) => route.abort());
      await page.reload();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.deviceTheme),
        'light',
      );
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
        'rgb(242, 241, 237)',
      );
      await page.unroute('**/app.js*');
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      assert.equal(await page.evaluate(() => StudioDeviceTheme.current().id), 'light');
      // A different browser/WebView profile has its own choice on the same server.
      const isolated = await page.context().browser().newContext({ serviceWorkers: 'block' });
      try {
        await isolated.route('**/*', (route) =>
          new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
        );
        const other = await isolated.newPage();
        await other.goto(`${fixture.url}/?token=fixture&view=chat`);
        assert.equal(await other.evaluate(() => StudioDeviceTheme.current().id), 'default');
      } finally {
        await isolated.close();
      }
      assert.equal(
        fixture.state.requests.filter(
          (r) =>
            r.route.startsWith('POST') &&
            !['POST /api/settings', 'POST /api/panes/view'].includes(r.route),
        ).length,
        postsBefore,
      );
      await fs.writeFile(
        path.join(output, `${viewport.name}-device-colors.json`),
        JSON.stringify({ geometry, results }, null, 2),
      );
    },
    async formulaRendering(page, fixture, viewport) {
      const tex = String.raw`\operatorname{PReLU}(x,\alpha)=
\begin{cases}
x,&x\geq 0\\
\alpha x,&x<0
\end{cases}`;
      const source =
        '\\[\n' +
        tex +
        '\n\\]\n\n行内 \\(x_1 + x_2\\)。\n\n$$y^2$$\n\n```tex\n\\[x\\]\n```\n\n金额 $5 到 $10';
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'formula',
        role: 'assistant',
        ts: timestamp,
        blocks: [{ kind: 'text', text: source }],
      });
      await refresh(page, fixture);
      const message = page.locator('.chat-msg[data-message-id="formula"]');
      await expect(message.locator('.katex')).toHaveCount(3);
      await expect(message.locator('.katex-error')).toHaveCount(0);
      await expect(message.locator('annotation').first()).toHaveText(tex);
      await expect(message.locator('pre code')).toHaveText('\\[x\\]');
      await expect(message).toContainText('金额 $5 到 $10');
      await page.evaluate(() => document.fonts.ready);
      const geometry = await message.evaluate((el) => {
        const display = el.querySelector('.chat-math.display'),
          box = display.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: innerWidth,
          formulaHeight: box.height,
          cases: el.querySelectorAll('.mtable').length,
          fontReady: document.fonts.check('16px KaTeX_Main'),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert(
        geometry.cases > 0 && geometry.formulaHeight > 35 && geometry.fontReady,
        JSON.stringify(geometry),
      );
      assert(
        geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.overflow === 0,
        JSON.stringify(geometry),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-prelu-formula.png`) });
      await page.evaluate(() => {
        const fragment = StudioMarkdown.renderMarkdown(
          String.raw`\[\href{javascript:alert(1)}{bad}\]`,
        );
        if (fragment.querySelector('a,script,img,iframe'))
          throw new Error('untrusted math produced active content');
      });
      const bad = await page.evaluate(() => {
        const fragment = StudioMarkdown.renderMarkdown(
          String.raw`\[\newcommand{\loop}{\loop}\loop\]`,
        );
        return fragment.textContent;
      });
      assert(bad.includes('\\loop'), 'expansion limit must preserve source rather than hang');
    },
    async readingWidthAndSecondaryText(page, fixture, viewport) {
      const row = tool(page, 'old');
      await row.locator('summary').click();
      const colors = await page.evaluate(() => {
        const color = (s) => getComputedStyle(document.querySelector(s)).color;
        return {
          background: getComputedStyle(document.body).backgroundColor,
          main: color('.chat-msg[data-role="assistant"]'),
          small: ['.chat-tool-name', '.chat-tool-detail', '.tool-body pre', '#chatCurrentKind'].map(
            color,
          ),
        };
      });
      assert.equal(colors.background, 'rgb(23, 23, 26)');
      const channel = (c) => Number(c.match(/\d+/)[0]);
      assert(
        colors.small.every((c) => channel(c) < channel(colors.main) && channel(c) >= 140),
        JSON.stringify(colors),
      );
      const handle = page.locator('#chatContentResizer');
      if (viewport.touch) {
        await expect(handle).toBeHidden();
        return;
      }
      await expect(handle).toBeVisible();
      const measure = () =>
        page.evaluate(() => {
          const log = document.querySelector('#chatLog').getBoundingClientRect(),
            handle = document.querySelector('#chatContentResizer');
          const box = handle.getBoundingClientRect(),
            style = getComputedStyle(handle);
          const text = document
            .querySelector('.chat-msg[data-role="assistant"]')
            .getBoundingClientRect();
          return {
            x: box.left,
            y: box.top,
            width: box.width,
            height: box.height,
            logTop: log.top,
            logHeight: log.height,
            textX: text.left,
            textWidth: text.width,
            background: style.backgroundColor,
            border: style.borderWidth,
            shadow: style.boxShadow,
            outline: style.outlineWidth,
            aboveHandle: document.elementFromPoint(box.left + 6, log.top + log.height / 6)?.id,
            belowHandle: document.elementFromPoint(box.left + 6, log.top + (log.height * 5) / 6)
              ?.id,
            sidebarWidth: document.querySelector('.chat-sidebar').getBoundingClientRect().width,
          };
        });
      const before = await measure();
      assert(Math.abs(before.y - before.logTop) < 1);
      assert(Math.abs(before.height - before.logHeight / 4) < 1);
      assert(Math.abs(before.x + before.width - before.textX) < 1);
      assert.equal(before.aboveHandle, 'chatContentResizer');
      assert.notEqual(before.belowHandle, 'chatContentResizer');
      await page.mouse.move(before.x + 6, before.y + before.height / 2);
      const hover = await measure();
      for (const value of [before, hover]) {
        assert.equal(value.background, 'rgba(0, 0, 0, 0)');
        assert.equal(value.border, '0px');
        assert.equal(value.shadow, 'none');
        assert.equal(value.outline, '0px');
      }
      await page.mouse.down();
      await page.mouse.move(before.x + 96, before.y + before.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => (await measure()).textWidth)
        .toBeLessThan(before.textWidth - 150);
      const after = await measure();
      assert.equal(after.sidebarWidth, before.sidebarWidth);
      await page.reload();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      assert(
        Math.abs((await measure()).textWidth - after.textWidth) < 1,
        'width must survive reopening',
      );
      await handle.focus();
      await page.keyboard.press('Home');
      await expect
        .poll(async () => Math.abs((await measure()).textWidth - before.textWidth))
        .toBeLessThan(1);
      await fs.writeFile(
        path.join(output, `${viewport.name}-reading-width.json`),
        JSON.stringify({ colors, before, after }, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-reading-width.png`) });
    },
    async queuedMessageVisibility(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.pane.agent.status = 'unknown';
      await refresh(page, fixture);
      await send(page, 'UNKNOWN_STATE_NATIVE');
      await expect(page.locator('#commandInput')).toHaveValue('');
      assert.equal(session.queue.at(-1).status, 'dispatched');
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog')).not.toContainText('UNKNOWN_STATE_NATIVE');
    },
    async directMessageHandoff(page, fixture, viewport) {
      fixture.setSendBehavior('DIRECT_HANDOFF', 'hold');
      const input = page.locator('#commandInput');
      await send(page, 'DIRECT_HANDOFF');
      await expect
        .poll(() =>
          fixture.state.requests.some(
            (r) => r.route === 'POST /api/messages' && r.body.text === 'DIRECT_HANDOFF',
          ),
        )
        .toBe(true);
      const request = fixture.state.requests.find(
        (r) => r.route === 'POST /api/messages' && r.body.text === 'DIRECT_HANDOFF',
      );
      try {
        await expect(input).toHaveValue('DIRECT_HANDOFF');
        await expect(page.locator('.outbox-message')).toHaveCount(0);
        await expect(page.locator('#chatLog')).not.toContainText('DIRECT_HANDOFF');
        fixture.state.sessions['pane-codex'].messages.push({
          id: 'native-handoff',
          role: 'user',
          ts: timestamp,
          blocks: [{ kind: 'text', text: 'DIRECT_HANDOFF' }],
        });
        await refresh(page, fixture);
        await expect(
          page.locator('.chat-msg[data-role=user]').filter({ hasText: /^DIRECT_HANDOFF$/ }),
        ).toHaveCount(1);
      } finally {
        fixture.release(request.body.id);
      }
      await expect(input).toHaveValue('');
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^DIRECT_HANDOFF$/ }),
      ).toHaveCount(1);
      await expect(page.locator('.outbox-message')).toHaveCount(0);
    },
    async cachedNavigationAndBack(page, fixture, viewport) {
      await switchTo(page, 'claude');
      await switchTo(page, 'codex');
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/api/transcript?*', async (route) => {
        await gate;
        await route.continue();
      });
      try {
        const begin = Date.now();
        await switchTo(page, 'claude');
        assert(
          Date.now() - begin < 1500,
          'Cached conversation waited for the held network response',
        );
        await expect(page.locator('#chatLog')).toHaveAttribute('aria-busy', 'false');
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
      await openFilesPanel(page, viewport);
      await expect(page.locator('.doc-row')).toHaveCount(2);
      await page.locator('.doc-row').first().click();
      await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText('反向已跑通');
      assert.equal(await page.evaluate(() => window.StudioNavigation.back()), true);
      await expect(page.locator('#sessionFilesList')).toBeVisible();
      assert.equal(await page.evaluate(() => window.StudioNavigation.back()), true);
      await expect(page.locator('#chatLog')).toBeVisible();
      assert.equal(await page.evaluate(() => window.StudioNavigation.back()), false);
      await openFilesPanel(page, viewport);
      await expect(page.locator('.doc-row')).toHaveCount(2);
      await expect(
        page.locator(
          '#sessionFilesOpen, #sessionFilesBack, #sessionFilesRefresh, #sessionFileClose',
        ),
      ).toHaveCount(0);
      await page.screenshot({ path: path.join(output, `${viewport.name}-cached-files.png`) });
    },
    /** 活动行永远一行：放不下时从右往左循环滚动，放得下就静止；高度不随长短变化。 */
    async activityMarquee(page, fixture, viewport) {
      await require('./session-statusbar-cases').legacy(page, fixture, viewport, output);
    },
    /**
     * 实时状态观察的是选中会话自己的终端（2026-09-25）：不挂完整客户端、不改 pane 尺寸，
     * 焦点在别处也能显示；焦点终端的画面不会串进来。
     */
    async observeSelectedTerminal(page, fixture, viewport) {
      await expect.poll(() => (fixture.state.observeFrames || []).at(-1)).toBe('term-codex');
      await page
        .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
        .click();
      fixture.state.focusedPaneId = 'pane-claude';
      fixture.activity('✻ Pondering… (12s · ↓ 1.2k tokens)', 'pane-claude');
      await page.waitForTimeout(300);
      await expect(page.getByRole('region', { name: '会话状态', exact: true })).not.toContainText(
        'Pondering',
      );
      fixture.activity('• Working (8s • esc to interrupt)', 'pane-codex');
      await expect(page.locator('#chatExecutionElapsed')).toHaveText('8s');
      await page.keyboard.press('Escape');
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
      await expect.poll(() => (fixture.state.observeFrames || []).at(-1)).toBe('term-claude');
      fixture.activity('✻ Pondering… (12s · ↓ 1.2k tokens)', 'pane-claude');
      await page
        .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
        .click();
      await expect(page.getByRole('region', { name: '会话状态', exact: true })).toContainText(
        'Pondering',
      );
    },
    async activitySecondsFormat(page, fixture, viewport) {
      await require('./session-statusbar-cases').legacyClock(page, fixture);
    },
    async stableActivity(page, fixture, viewport) {
      await require('./session-statusbar-cases').legacy(page, fixture, viewport, output);
    },
    async sessionFilesAlignment(page, fixture, viewport) {
      const panel = page.locator('#sessionFilesPage'),
        head = page.locator('.session-files-head');
      const measure = () =>
        page.evaluate(() => {
          const rect = (selector) =>
            document.querySelector(selector).getBoundingClientRect().toJSON();
          const header = document.querySelector('.session-files-head');
          return {
            head: rect('.session-files-head'),
            main: rect('.chat-main'),
            sidebar: rect('.chat-sidebar-top'),
            panel: rect('#sessionFilesPage'),
            divider: getComputedStyle(header).boxShadow,
            centers: [...header.querySelectorAll('button, strong')]
              .filter((node) => node.getClientRects().length)
              .map((node) => ({
                id: node.id || 'title',
                center:
                  (node.getBoundingClientRect().top + node.getBoundingClientRect().bottom) / 2,
              })),
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
      const check = async (name) => {
        const data = await measure();
        await page.screenshot({
          path: path.join(output, `${viewport.name}-session-files-${name}.png`),
        });
        await fs.writeFile(
          path.join(output, `${viewport.name}-session-files-${name}.json`),
          JSON.stringify(data, null, 2),
        );
        assert(
          Math.abs(data.head.top - data.main.top) < 1 &&
            Math.abs(data.head.bottom - data.sidebar.bottom) < 1,
          JSON.stringify(data),
        );
        assert(
          Math.abs(data.head.left - data.panel.left) < 2 &&
            Math.abs(data.head.right - data.panel.right) < 1,
          'Header divider spans the whole panel',
        );
        assert.notEqual(data.divider, 'none');
        if (name === 'maximized')
          assert(
            Math.abs(data.panel.bottom - data.main.bottom) < 1,
            'Maximized files fill the available height',
          );
        for (const control of data.centers)
          assert(
            Math.abs(control.center - (data.head.top + data.head.bottom) / 2) < 1,
            JSON.stringify(control),
          );
        assert.equal(data.overflow, 0);
      };
      await page.locator('#commandInput').fill('会话文件对齐时保留草稿');
      await openFilesPanel(page, viewport);
      await expect(panel).toBeVisible();
      if (!viewport.touch) {
        await page.locator('#chatFilesMaximize').click();
        await expect(page.locator('#chatView')).toHaveClass(/files-max/);
        await check('maximized');
        await expect(page.locator('.chat-main > .chat-head')).toBeHidden();
        await page.locator('#chatFilesMaximize').click();
        await check('side-panel');
      } else await check('full-page');
      await page.locator('.doc-row').first().click();
      await expect(page.locator('#chatFilesListBack')).toBeVisible();
      await check('preview');
      await page.locator('#chatFilesListBack').click();
      if (!viewport.touch) await page.locator('#chatFilesListBack').click();
      else await page.evaluate(() => window.StudioNavigation.back());
      await expect(panel).toBeHidden();
      await expect(page.locator('#commandInput')).toHaveValue('会话文件对齐时保留草稿');
      assert(!fixture.state.requests.some((row) => row.route === 'POST /api/messages'));
    },
    async desktopFilesPanel(page, fixture, viewport) {
      const toggle = page.locator('#chatFilesToggle');
      const back = page.locator('#chatFilesListBack');
      if (viewport.touch) {
        if (viewport.width > 760) await expect(toggle).toBeVisible();
        else await expect(toggle).toBeHidden();
        await openFilesPanel(page, viewport);
        await expect(back).toBeHidden();
        await page.locator('.doc-row').first().click();
        await expect(back).toBeVisible();
        await expect(back).toHaveAttribute('aria-label', '返回文件列表');
        await back.click();
        await expect(page.locator('#sessionFilesList')).toBeVisible();
        await expect(back).toBeHidden();
        await page.screenshot({
          path: path.join(output, `${viewport.name}-files-list-no-desktop-back.png`),
        });
        return;
      }
      const input = page.locator('#commandInput');
      await input.fill('查看文件时保留草稿');
      await page.locator('#chatLog').evaluate((el) => {
        el.scrollTop = 100;
        el.dispatchEvent(new Event('scroll'));
      });
      const savedTop = await page.locator('#chatLog').evaluate((el) => el.scrollTop);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.doc-row')).toHaveCount(2);
      await expect(input).toBeVisible();
      await expect(input).toHaveValue('查看文件时保留草稿');
      const measure = () =>
        page.evaluate(() => {
          const rect = (selector) =>
            document.querySelector(selector).getBoundingClientRect().toJSON();
          return {
            chat: rect('.chat-conversation'),
            files: rect('#sessionFilesPage'),
            input: rect('#chatInput'),
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
      const check = async () => {
        const boxes = await measure();
        assert(boxes.files.left >= boxes.chat.right - 1, JSON.stringify(boxes));
        assert(
          boxes.files.width > 0 && boxes.input.right <= boxes.files.left + 1,
          JSON.stringify(boxes),
        );
        assert.equal(boxes.overflow, 0);
        return boxes;
      };
      const geometry = await check();
      await page.screenshot({ path: path.join(output, `${viewport.name}-files-panel.png`) });
      await page.locator('.doc-row').first().click();
      await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText('反向已跑通');
      await expect(page.locator('#workspaceFilesPage')).toBeVisible();
      await page.locator('.workspace-file-view:not([hidden]) .md-local-link').first().click();
      await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText('先按块划分');
      await page.getByRole('tab', { name: 'results.md', exact: true }).click();
      await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText('反向已跑通');
      await page.screenshot({
        path: path.join(output, `${viewport.name}-files-panel-preview.png`),
      });
      await page.getByRole('button', { name: '返回会话', exact: true }).click();
      await expect(page.locator('#sessionFilesList')).toBeVisible();
      await page.setViewportSize({ width: 900, height: 768 });
      await check();
      await page.screenshot({
        path: path.join(output, `${viewport.name}-files-panel-compact.png`),
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 列表与最大化页面都有同一个返回入口；原有文档阅读栈仍先退到列表。
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('aria-label', '返回会话');
      await back.click();
      await expect(page.locator('#sessionFilesPage')).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      await expect(input).toHaveValue('查看文件时保留草稿');
      assert.equal(await page.locator('#chatLog').evaluate((el) => el.scrollTop), savedTop);
      await toggle.click();
      await expect(page.locator('.doc-row')).toHaveCount(2);
      await page.locator('#chatFilesMaximize').click();
      await expect(page.locator('.chat-conversation')).toBeHidden();
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('aria-label', '返回会话');
      const rect = await back.boundingBox();
      assert.equal(rect.width, 32);
      assert.equal(rect.height, 32);
      await back.focus();
      await page.screenshot({ path: path.join(output, `${viewport.name}-files-max-back.png`) });
      await page.keyboard.press('Enter');
      await expect(page.locator('#sessionFilesPage')).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(input).toHaveValue('查看文件时保留草稿');
      assert.equal(await page.locator('#chatLog').evaluate((el) => el.scrollTop), savedTop);
      await toggle.click();
      await expect(back).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#sessionFilesPage')).toBeHidden();
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      await fs.writeFile(
        path.join(output, `${viewport.name}-files-panel.json`),
        JSON.stringify(geometry, null, 2),
      );
    },
    async sessionFilesAndRoot(page, fixture, viewport) {
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      if (!(await page.locator('#chatDeviceSettings').isVisible()))
        await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatDeviceSettings').click();
      await page.locator('#settingsConnectionTab').click();
      await expect(page.locator('#chatRootDirectory')).toHaveValue('/fixture/workdir');
      await expect(page.locator('.chat-brand-icon')).toHaveCount(0);
      await page.locator('#chatRootDirectory').scrollIntoViewIfNeeded();
      await withinViewport(page.locator('#chatRootDirectory'));
      await page.locator('#settingsBack').click();
      await page.locator('#settingsBack').click();
      if (await page.locator('#chatPickerScrim').isVisible())
        await page
          .locator('#chatPickerScrim')
          .click({ position: { x: viewport.width - 8, y: 100 } });
      await swipePage(page, '#chatLog', false);
      await expect(page.locator('#sessionFilesPage')).toBeVisible();
      if (viewport.touch) await expect(page.locator('#commandInput')).toBeHidden();
      else await expect(page.locator('#commandInput')).toBeVisible();
      await expect(page.locator('.doc-row')).toHaveCount(2);
      await expect(page.locator('.doc-row').first()).toContainText('当前结果');
      await withinViewport(page.locator('#sessionFilesPage'));
      await page.screenshot({ path: path.join(output, `${viewport.name}-session-files.png`) });
      await page.locator('.doc-row').first().click();
      await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText('反向已跑通');
      assert.equal(await page.evaluate(() => window.filePreviewExecuted), undefined);
      await expect(
        page.locator(
          '.workspace-file-view:not([hidden]) textarea, .workspace-file-view:not([hidden]) input, .workspace-file-view:not([hidden]) [contenteditable=true]',
        ),
      ).toHaveCount(0);
      await page.screenshot({ path: path.join(output, `${viewport.name}-file-preview.png`) });
      await page.keyboard.press('Escape');
      await expect(page.locator('#sessionFilesList')).toBeVisible();
      await swipePage(page, '#sessionFilesPage', true);
      await expect(page.locator('#chatLog')).toBeVisible();
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      assert(!fixture.state.requests.some((r) => r.route.startsWith('POST /api/session-files')));
    },
    async atomicSessionEntry(page, fixture, viewport) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let seen = false;
      await page.route('**/api/transcript?*', async (route) => {
        if (new URL(route.request().url()).searchParams.get('pane') === 'pane-claude') {
          seen = true;
          await gate;
        }
        await route.continue();
      });
      try {
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect.poll(() => seen).toBe(true);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(page.locator('#chatLog')).toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#chatLog .chat-msg')).toHaveCount(0);
        await expect(page.locator('#chatLog .chat-empty')).toHaveCount(0);
        await expect(page.locator('#chatLog details')).toHaveCount(0);
        await expect(page.locator('#chatLog')).not.toContainText('codex 浏览器验收样例');
        await page.screenshot({
          path: path.join(output, `${viewport.name}-session-entry-pending.png`),
        });
        release();
        await expect(page.locator('#chatLog')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        await expect(page.locator('#chatLog .tool-state')).toHaveCount(0);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-session-entry-ready.png`),
        });
        // Selecting the already displayed session must not clear or rebuild it.
        await page
          .locator('#chatLog .chat-msg')
          .first()
          .evaluate((el) => {
            window.entryFirstBubble = el;
          });
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        assert(await page.evaluate(() => window.entryFirstBubble.isConnected));
        await expect(page.locator('#chatLog')).toHaveAttribute('aria-busy', 'false');
      } finally {
        release();
      }
    },
    async commandReceipt(page, fixture, viewport) {
      await send(page, '/native-fixture-command argument');
      await expect(page.locator('#commandInput')).toHaveValue('');
      assert.equal(fixture.state.sessions['pane-codex'].queue.length, 0);
      assert.equal(
        fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
        0,
      );
      const writes = fixture.state.nativeCommandPanes['pane-codex'].writes;
      assert(writes.some((row) => row.text === '/native-fixture-command argument'));
      assert.equal(writes.filter((row) => row.keys?.includes('enter')).length, 1);
      await expect(page.locator('.native-command-panel')).toBeHidden();
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog')).not.toContainText('/native-fixture-command');
    },
    async herdrWorkspaceGrouping(page, fixture, viewport) {
      fixture.state.workspaces = [
        { workspaceId: 'workspace-fixture', label: 'Herdr 分组' },
        { workspaceId: 'empty-space', label: '空分组' },
      ];
      // A root-directory shell still belongs to its Herdr workspace, regardless of cwd or label.
      const shell = clone(fixture.state.sessions['pane-codex']);
      shell.pane = {
        ...shell.pane,
        paneId: 'pane-shell',
        title: '根目录 Shell',
        cwd: '/fixture/workdir',
        baseCwd: '/fixture/workdir',
        agent: null,
      };
      fixture.state.sessions['pane-shell'] = shell;
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarWorkspaces').click();
      await expect(page.locator('.chat-tree-name')).toHaveText(['Herdr 分组', '空分组']);
      const items = await page
        .locator('#chatPickerList')
        .evaluate((el) =>
          [...el.children].map((item) =>
            item.classList.contains('chat-tree-group') ? item.textContent : item.dataset.paneId,
          ),
        );
      assert(items.indexOf('pane-shell') < items.indexOf('空分组'));
      await expect(
        page.locator('#chatNewSession, #chatTemporarySession, #chatWorkspaceAdd'),
      ).toHaveCount(0);
      assert(
        !fixture.state.requests.some((r) =>
          /POST \/api\/(agents\/start|workspaces\/create)/.test(r.route),
        ),
      );
    },
    async consecutiveModelSelection(page, fixture, viewport) {
      return require('./native-command-browser-cases').consecutiveModelSelection(
        page,
        fixture,
        viewport,
        { output, switchTo, refresh },
      );
    },
    async sidebarSwipeHistory(page, fixture, viewport) {
      const swipe = async (right, sidebar = false) => {
        const target = sidebar ? '#chatSidebar' : '#chatLog';
        await page.locator(target).evaluate((el, right) => {
          const box = el.getBoundingClientRect(),
            x = box.left + (right ? 70 : 210),
            y = box.top + 200;
          const touch = (at) => ({ identifier: 1, target: el, clientX: at, clientY: y });
          const emit = (type, touches) =>
            el.dispatchEvent(
              Object.assign(new Event(type, { bubbles: true, cancelable: true }), { touches }),
            );
          emit('touchstart', [touch(x)]);
          emit('touchmove', [touch(x + (right ? 100 : -100))]);
          emit('touchend', []);
        }, right);
      };
      if (viewport.width <= 760) {
        await swipe(false);
        await expect(page.locator('#sessionFilesPage')).toBeVisible();
        await swipePage(page, '#sessionFilesPage', true);
        await swipe(true);
        await expect(page.locator('#chatSidebar')).toHaveClass(/open/);
        await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      }
      await page.locator('#sidebarRecent').click();
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      await expect(page.locator('#sidebarHistory')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#chatSidebar')).toBeVisible();
      await expect
        .poll(() => fixture.state.requests.some((r) => r.route === 'GET /api/history'))
        .toBe(true);
      await page.screenshot({ path: path.join(output, `${viewport.name}-swipe-history.png`) });
      await swipe(false, true);
      await expect(page.locator('#sidebarFiles')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarHistory')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      await expect(page.locator('#sidebarHistory')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      await expect(page.locator('#sidebarFiles')).toHaveAttribute('aria-selected', 'true');
      await swipe(false, true);
      if (viewport.width <= 760) await expect(page.locator('#chatSidebar')).not.toHaveClass(/open/);
      else await expect(page.locator('#chatView')).toHaveClass(/sidebar-collapsed/);
      await swipe(true);
      await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      await page.locator('#sidebarFiles').click();
      await swipe(true, true);
      await expect(page.locator('#sidebarHistory')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await swipe(true, true);
      await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
      await page.locator('#sidebarRecent').click();
      // 触控板同样经过这条导航路径，一次手势只走一步。
      // 系统校时不能延长手势冷却；冻结系统时钟，经过时间仍由单调时钟推进。
      await page.evaluate(() => {
        window.__swipeDateNow = Date.now;
        const now = Date.now();
        Date.now = () => now;
      });
      try {
        await page.locator('#chatSidebar').dispatchEvent('wheel', { deltaX: 100, deltaY: 0 });
        await expect(page.locator('#sidebarHistory')).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(450);
        await page.locator('#chatSidebar').dispatchEvent('wheel', { deltaX: -100, deltaY: 0 });
        await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      } finally {
        await page.evaluate(() => {
          Date.now = window.__swipeDateNow;
          delete window.__swipeDateNow;
        });
      }
    },
    async attachments(page, fixture, viewport) {
      const choosing = page.waitForEvent('filechooser');
      await page.locator('#attachButton').click();
      const chooser = await choosing;
      await chooser.setFiles([
        { name: '说明.md', mimeType: 'text/markdown', buffer: Buffer.from('文件的完整正文') },
        {
          name: 'image.png',
          mimeType: 'image/png',
          buffer: Buffer.from([137, 80, 78, 71, 0, 255]),
        },
      ]);
      const list = page.locator('#attachmentList');
      await expect(list).toContainText('说明.md');
      await expect(list).toContainText('image.png');
      await expect(list).not.toContainText('上传中');
      await expect(page.locator('#sendButton')).toBeEnabled();
      await withinViewport(list);
      await page.screenshot({ path: path.join(output, `${viewport.name}-attachments.png`) });
      await switchTo(page, 'claude');
      await expect(list).toBeHidden();
      await switchTo(page, 'codex');
      await expect(list).toContainText('说明.md');
      await page.getByRole('button', { name: '移除 image.png', exact: true }).click();
      await page.locator('#sendButton').click();
      await expect(list).toBeHidden();
      await expect(page.locator('#chatLog .outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog')).not.toContainText('附件：说明.md');
      const post = fixture.state.requests.filter((r) => r.route === 'POST /api/messages').at(-1);
      assert.equal(post.body.paneId, 'pane-codex');
      assert(post.body.text.includes('/fixture/uploads/'));
      assert(!post.body.text.includes('image.png'));
      await page.route('**/api/attachments?*', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: '测试上传失败' }),
        }),
      );
      await page
        .locator('#attachInput')
        .setInputFiles({ name: 'failed.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
      await expect(list).toContainText('上传失败');
      await expect(page.locator('#sendButton')).toBeDisabled();
      await page.getByRole('button', { name: '移除 failed.txt', exact: true }).click();
      await expect(list).toBeHidden();
      await page.unroute('**/api/attachments?*');
      // 图片附件的回显按正式消息的样子画成图片，不露出「附件：/文件路径：」原文。
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await page
        .locator('#attachInput')
        .setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: png });
      await expect(list).not.toContainText('上传中');
      await page.locator('#sendButton').click();
      await expect(page.locator('#commandInput')).toHaveValue('');
      await expect(list).toBeHidden();
      await expect(page.locator('#chatLog .outbox-message')).toHaveCount(0);
      assert(fixture.state.sessions['pane-codex'].queue.at(-1).text.includes('pic.png'));
    },

    async clipboardPaste(page, fixture, viewport) {
      const input = page.locator('#commandInput'),
        list = page.locator('#attachmentList');
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await input.fill('前后');
      await input.evaluate((el) => el.setSelectionRange(1, 1));
      await page.evaluate(() => navigator.clipboard.writeText('普通粘贴'));
      await input.press('Control+v');
      await expect(input).toHaveValue('前普通粘贴后');
      await input.press('Control+z');
      await expect(input).toHaveValue('前后');
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
      await input.press('Control+v');
      await expect(list).toContainText('image.png');
      await expect(list).not.toContainText('上传中');
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/attachments').length,
        1,
      );
      await page.getByRole('button', { name: '移除 image.png', exact: true }).click();
      await input.evaluate((el) => {
        el.setSelectionRange(0, 1);
        const data = new DataTransfer();
        data.items.add(new File(['剪贴板正文'], '说明.md', { type: 'text/markdown' }));
        data.items.add(
          new File([new Uint8Array([0, 255, 10, 128])], '文件.bin', {
            type: 'application/octet-stream',
          }),
        );
        data.setData('text/plain', '混合文字');
        data.setData('text/html', '<img src="https://invalid.test/never-fetch">');
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await expect(input).toHaveValue('混合文字后');
      await expect(list).toContainText('说明.md');
      await expect(list).toContainText('文件.bin');
      await expect(list).not.toContainText('上传中');
      await withinViewport(list);
      const uploads = fixture.state.requests.filter((r) => r.route === 'POST /api/attachments');
      assert.equal(uploads.length, 3, 'files and items must not upload duplicates');
      assert.equal(
        uploads[2].sha256,
        require('node:crypto')
          .createHash('sha256')
          .update(Buffer.from([0, 255, 10, 128]))
          .digest('hex'),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-clipboard.png`) });
      await page.locator('#sendButton').click();
      await expect
        .poll(() => fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length)
        .toBe(1);
      const sent = fixture.state.requests.filter((r) => r.route === 'POST /api/messages').at(-1);
      assert(
        sent.body.text.includes('混合文字后') &&
          sent.body.text.includes('说明.md') &&
          sent.body.text.includes('文件.bin'),
      );
    },
    async clipboardIsolation(page, fixture) {
      let release, entered;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      await page.route('**/api/attachments?*', async (route) => {
        entered();
        await held;
        await route.continue();
      });
      await page.locator('#commandInput').evaluate((el) => {
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
          value: {
            files: [],
            items: [
              { kind: 'file', getAsFile: () => new File(['a'], '第一份.txt') },
              { kind: 'file', getAsFile: () => null },
              { kind: 'file', getAsFile: () => new File(['b'], '第二份.txt') },
            ],
            getData: () => '',
          },
        });
        el.dispatchEvent(event);
      });
      await started;
      const list = page.locator('#attachmentList');
      await expect(list).toContainText('上传中');
      await expect(page.locator('#sendButton')).toBeDisabled();
      await switchTo(page, 'claude');
      await expect(list).toBeHidden();
      release();
      await expect
        .poll(
          () => fixture.state.requests.filter((r) => r.route === 'POST /api/attachments').length,
        )
        .toBe(2);
      assert(
        fixture.state.requests
          .filter((r) => r.route === 'POST /api/attachments')
          .every((r) => r.paneId === 'pane-codex'),
      );
      await expect(list).toBeHidden();
      await switchTo(page, 'codex');
      await expect(list).not.toContainText('上传中');
      await page.getByRole('button', { name: '移除 第一份.txt', exact: true }).click();
      await page.getByRole('button', { name: '移除 第二份.txt', exact: true }).click();
      await page.unroute('**/api/attachments?*');
      await page.route('**/api/attachments?*', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: '测试粘贴上传失败' }),
        }),
      );
      await page.locator('#commandInput').evaluate((el) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(20 * 1024 * 1024 + 1)], '过大.bin'));
        data.items.add(new File(['failure'], '失败.txt'));
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await expect(list).not.toContainText('过大.bin');
      await expect(list).toContainText('失败.txt · 上传失败');
      await expect(page.locator('#sendButton')).toBeDisabled();
      await page.getByRole('button', { name: '移除 失败.txt', exact: true }).click();
      await expect(list).toBeHidden();
    },
    async fullStatus(page, fixture, viewport) {
      const { chatStatus } = require('../../lib/chat-status');
      const session = fixture.state.sessions['pane-codex'];
      session.pane.cwd = '/home/user/a/very/long/workspace/directory/with-more-details';
      session.settings.model = 'gpt-test';
      session.settings.effort = 'xhigh';
      session.webStatus = chatStatus(
        { statusline: ['gpt-test · Context 39…'] },
        session.pane,
        {
          model: 'gpt-test',
          effort: 'xhigh',
          usage: { tokens: 113907, capacity: 258400 },
          rateLimits: {
            primary: { used_percent: 19, window_minutes: 10080, resets_at: 1790361116 },
          },
        },
        session.messages,
      );
      await refresh(page, fixture);
      await expect(page.locator('#chatQuotaAction')).toContainText('81%');
      await page
        .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
        .click();
      const details = page.getByRole('region', { name: '会话状态', exact: true });
      await expect(details).toContainText(session.pane.cwd);
      await expect(details).toContainText('gpt-test');
      await expect(details).toContainText('weekly 81% left');
      await withinViewport(details);
      const geometry = await details.evaluate((node) => ({
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }));
      assert(geometry.scrollWidth <= geometry.width + 1);
      await page.screenshot({ path: path.join(output, `${viewport.name}-full-status.png`) });
    },
    async initialLoading(page, fixture, viewport) {
      let releaseSnapshot, releaseTranscript;
      const snapshotGate = new Promise((resolve) => {
        releaseSnapshot = resolve;
      });
      const transcriptGate = new Promise((resolve) => {
        releaseTranscript = resolve;
      });
      let snapshotSeen = false,
        transcriptSeen = false;
      await page.route('**/api/snapshot', async (route) => {
        snapshotSeen = true;
        await snapshotGate;
        await route.continue();
      });
      await page.route('**/api/transcript?*', async (route) => {
        transcriptSeen = true;
        await transcriptGate;
        await route.continue();
      });
      try {
        await page.reload();
        await expect.poll(() => snapshotSeen).toBe(true);
        await expect(page.locator('#chatCurrentName')).toHaveText('');
        await expect(page.locator('#chatCurrentKind')).not.toContainText('0 个会话');
        await expect(page.locator('#chatPickerList .chat-empty')).toHaveCount(0);
        releaseSnapshot();
        await expect.poll(() => transcriptSeen).toBe(true);
        await expect(page.locator('#chatCurrentName')).toContainText('Codex');
        await expect(page.locator('#chatLog .chat-empty')).toHaveCount(0);
        await page.screenshot({ path: path.join(output, `${viewport.name}-initial-loading.png`) });
        releaseTranscript();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      } finally {
        releaseSnapshot();
        releaseTranscript();
      }
      await page.unroute('**/api/snapshot');
      await page.unroute('**/api/transcript?*');
      let releaseSwitch;
      const switchGate = new Promise((resolve) => {
        releaseSwitch = resolve;
      });
      await page.route('**/api/transcript?*', async (route) => {
        await switchGate;
        await route.continue();
      });
      try {
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#chatCurrentName')).toContainText('Claude');
        await expect(page.locator('#chatLog .chat-empty')).toHaveCount(0);
        await expect(page.locator('#chatLog')).not.toContainText('codex 浏览器验收样例');
        releaseSwitch();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
      } finally {
        releaseSwitch();
      }
    },
    async firstMessage(page, fixture, viewport) {
      const input = page.locator('#commandInput');
      await expect(page.locator('.chat-welcome')).toBeVisible();
      await send(page, 'FIRST_MESSAGE_NO_SESSION');
      await expect(input).toHaveValue('');
      await send(page, 'SECOND_MESSAGE_NO_SESSION');
      await expect(input).toHaveValue('');
      const posts = fixture.state.requests.filter((r) => r.route === 'POST /api/messages');
      assert.equal(posts.length, 2);
      assert(posts.every((r) => !Object.hasOwn(r.body, 'sessionId')));
      assert(fixture.state.sessions['pane-codex'].queue.every((m) => m.status === 'dispatched'));
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'native-first-turn',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'FIRST_MESSAGE_NO_SESSION\nSECOND_MESSAGE_NO_SESSION' }],
      });
      fixture.state.sessions['pane-codex'].pane.agent.session = {
        kind: 'uuid',
        value: 'native-first-session',
      };
      await refresh(page, fixture);
      await expect(page.locator('.chat-msg[data-role=user]')).toHaveCount(1);
      await expect(page.locator('.chat-msg[data-role=user]')).toContainText(
        'SECOND_MESSAGE_NO_SESSION',
      );
    },
    async tools(page, fixture) {
      const old = tool(page, 'old'),
        latest = tool(page, 'latest');
      await expect(old).not.toHaveAttribute('open', '');
      await expect(latest).not.toHaveAttribute('open', '');
      await expect(latest.locator('.tool-body > *')).toHaveCount(0);
      await latest.locator(':scope > summary').click();
      await expect(latest.locator('.tool-body')).toContainText('RESULT_PHASE_A');
      await old.locator(':scope > summary').click();
      await expect(old).toHaveAttribute('open', '');
      fixture.updateTool('pane-codex', {
        running: false,
        failed: true,
        result: { text: 'RESULT_PHASE_B', truncated: true, isError: true },
      });
      await refresh(page, fixture);
      await expect(latest).toHaveCount(1);
      await expect(latest).not.toContainText('内容较长，当前显示预览');
      await expect(latest).toHaveClass(/failed/);
      await expect(old).toHaveAttribute('open', '');
      await expect(latest).not.toHaveAttribute('open', '');
      await latest.locator(':scope > summary').click();
      await expect(latest.locator('.tool-body')).toContainText('RESULT_PHASE_B');
      await latest.getByRole('button', { name: '加载完整详情' }).click();
      await expect(latest).toContainText('FULL_TOOL_RESULT');
      // 用户主动折叠最新工具之后，轮询不能替用户重新展开。
      await latest.locator(':scope > summary').click();
      fixture.updateTool('pane-codex', { detail: 'npm test finished' });
      await refresh(page, fixture);
      await expect(latest).not.toHaveAttribute('open', '');
    },
    async compactToolSpacing(page, fixture, viewport) {
      const item = (index) => ({
        id: `spacing-${index}`,
        name: 'exec_command',
        detail: 'python3 verify.py',
        running: index === 7,
        failed: index === 6,
        input: { text: 'python3 verify.py' },
        result: { text: 'verification output' },
      });
      fixture.state.sessions['pane-codex'].messages = [
        {
          id: 'spacing-intro',
          role: 'assistant',
          ts: timestamp,
          blocks: [{ kind: 'text', text: '连续命令的间距应当一致。' }],
        },
        {
          id: 'spacing-group',
          role: 'assistant',
          blocks: [{ kind: 'tools', items: [0, 1, 2].map(item) }],
        },
        {
          id: 'spacing-blocks',
          role: 'assistant',
          blocks: [3, 4].map((index) => ({ kind: 'tools', items: [item(index)] })),
        },
        ...[5, 6, 7].map((index) => ({
          id: `spacing-message-${index}`,
          role: 'assistant',
          blocks: [{ kind: 'tools', items: [item(index)] }],
        })),
        {
          id: 'spacing-after',
          role: 'assistant',
          ts: timestamp,
          blocks: [{ kind: 'text', text: '执行后的说明保持正常间距。' }],
        },
      ];
      await refresh(page, fixture);
      const rows = page.locator('.chat-tool-row[data-tool-key^="pane-codex:spacing-"]');
      await expect(rows).toHaveCount(8);
      const measure = () =>
        rows.evaluateAll((nodes) => {
          const boxes = nodes.map((node) => node.getBoundingClientRect());
          return {
            heights: boxes.map((box) => box.height),
            gaps: boxes.slice(1).map((box, index) => box.top - boxes[index].bottom),
          };
        });
      const collapsed = await measure();
      assert(
        collapsed.heights.every((height) => height === (viewport.touch ? 38 : 28)),
        JSON.stringify(collapsed),
      );
      assert(
        collapsed.gaps.every((gap) => Math.abs(gap - 2) < 0.001),
        JSON.stringify(collapsed),
      );
      // The grouping boundary must not change spacing after opening a command,
      // or after an ordinary transcript refresh replaces its DOM nodes.
      await rows.nth(3).locator('summary').click();
      await expect(rows.nth(3).locator('.tool-body')).toBeVisible();
      // Firefox exposes fractional CSS geometry as floating-point rectangles;
      // subtracting adjacent edges can differ from 2px by about 0.00003px.
      assert((await measure()).gaps.every((gap) => Math.abs(gap - 2) < 0.001));
      fixture.state.sessions['pane-codex'].messages[2].blocks[0].items[0].result.text =
        'updated verification output';
      await refresh(page, fixture);
      await expect(rows.nth(3)).toHaveAttribute('open', '');
      await expect(rows.nth(3).locator('.tool-body')).toContainText('updated verification output');
      assert((await measure()).gaps.every((gap) => Math.abs(gap - 2) < 0.001));
      await rows.nth(3).locator('summary').click();
      const prose = page.locator('[data-message-id="spacing-after"]');
      assert(
        await prose.evaluate((node) => node.nextElementSibling.classList.contains('chat-meta')),
      );
      await fs.writeFile(
        path.join(output, `${viewport.name}-tool-spacing.json`),
        JSON.stringify(collapsed, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-tool-spacing.png`) });
    },
    async uploadedImageFormatAndAlias(page, fixture, viewport) {
      const directory = await fs.mkdtemp(
        path.join(require('node:os').tmpdir(), 'swift-image-preview-'),
      );
      try {
        const real = path.join(directory, 'real'),
          alias = path.join(directory, 'storage');
        await fs.mkdir(real);
        await fs.symlink(real, alias);
        const data = await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 382;
          canvas.height = 183;
          const context = canvas.getContext('2d');
          context.fillStyle = '#347a9e';
          context.fillRect(0, 0, 382, 183);
          context.fillStyle = '#f8f5e9';
          context.fillRect(12, 12, 358, 159);
          context.fillStyle = '#222';
          context.font = '20px sans-serif';
          context.fillText('PNG with a .jpg filename', 28, 78);
          return canvas.toDataURL('image/png').split(',')[1];
        });
        const bytes = Buffer.from(data, 'base64');
        const attachment = await require('../../lib/attachments').saveAttachment(
          require('node:stream').Readable.from([bytes]),
          'mmexport.jpg',
          alias,
        );
        assert.equal(attachment.path, await fs.realpath(attachment.path));
        const legacy = path.join(alias, attachment.id, attachment.name);
        const { parseTranscript, textOnly } = require('../../lib/agent-transcript');
        const messages = textOnly(
          parseTranscript('codex', [
            JSON.stringify({
              type: 'response_item',
              payload: {
                type: 'message',
                id: 'uploaded-native-image',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: `请查看这张附件。\n附件：mmexport.jpg\n文件路径：${JSON.stringify(legacy)}`,
                  },
                ],
              },
            }),
          ]),
        );
        const block = messages[0].blocks.find((block) => block.kind === 'image');
        assert(block);
        fixture.state.images = {
          [block.id]: {
            sources: require('../../lib/chat-images').imageSources(messages),
            attachmentsDirectory: alias,
            fail: true,
          },
        };
        fixture.state.sessions['pane-codex'].messages.push(...messages);
        await refresh(page, fixture);
        const card = page.locator(`.chat-image[data-image-id="${block.id}"]`);
        await card.scrollIntoViewIfNeeded();
        await expect(card).toHaveClass(/failed/);
        fixture.state.images[block.id].fail = false;
        await card.click();
        await expect(card).toHaveClass(/loaded/);
        await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 382);
        await expect(card.locator('img')).toHaveJSProperty('naturalHeight', 183);
        await expect(card.locator('.chat-image-notice')).toBeHidden();
        const dimensions = () =>
          card.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { width: r.width, height: r.height };
          });
        const size = await dimensions();
        assert(
          Math.abs(size.width / size.height - 382 / 183) < 0.04,
          'the card follows the decoded image aspect ratio',
        );
        await withinViewport(card);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        const node = await card.elementHandle();
        await refresh(page, fixture);
        assert(await node.evaluate((node) => node.isConnected));
        assert.equal(
          fixture.state.requests.filter((r) => r.route === 'GET /api/images').length,
          2,
          'one failure and one explicit retry, no refetch on ordinary refresh',
        );
        await card.click();
        await expect(page.locator('.chat-image-viewer img')).toHaveJSProperty('naturalWidth', 382);
        await page.getByRole('button', { name: '关闭图片', exact: true }).click();
        await page.screenshot({
          path: path.join(output, `${viewport.name}-uploaded-image-preview.png`),
        });
        await page.setViewportSize({
          width: viewport.width,
          height: Math.round(viewport.height * 0.55),
        });
        const resized = await dimensions();
        assert(
          Math.abs(resized.width - size.width) < 0.5 &&
            Math.abs(resized.height - size.height) < 0.5,
          'keyboard height does not resize the image',
        );
        assert.deepEqual(await fs.readFile(attachment.path), bytes);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },

    async inlineImages(page, fixture, viewport) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hoAAAAASUVORK5CYII=',
        'base64',
      );
      fixture.state.images = { 'inline-image': { bytes: png, mime: 'image/png' } };
      const message = {
        id: 'inline-image-message',
        role: 'assistant',
        ts: timestamp,
        blocks: [
          { kind: 'text', text: '生成的图片' },
          { kind: 'image', id: 'inline-image', alt: '<script>图片</script>', width: 1, height: 1 },
        ],
      };
      fixture.state.sessions['pane-codex'].messages.push(message);
      await refresh(page, fixture);
      const card = page.locator('.chat-image[data-image-id="inline-image"]');
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveClass(/loaded/);
      await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 1);
      await expect(card.locator('img')).toHaveCSS('opacity', '1');
      assert.equal(await card.locator('script').count(), 0);
      await withinViewport(card);
      const node = await card.elementHandle(),
        src = await card.locator('img').getAttribute('src');
      await card.click();
      await expect(page.locator('.chat-image-viewer')).toBeVisible();
      await withinViewport(page.locator('.chat-image-viewer img'));
      message.blocks[0].text += '已完成';
      await refresh(page, fixture);
      assert(
        await node.evaluate((node) => node.isConnected),
        'refresh preserves the decoded image node',
      );
      await expect(page.locator('.chat-image-viewer')).toBeVisible();
      assert(await page.evaluate(() => window.StudioNavigation.back()));
      await expect(page.locator('.chat-image-viewer')).not.toBeVisible();
      assert.equal(await card.locator('img').getAttribute('src'), src);
      const requests = fixture.state.requests.filter((r) => r.route === 'GET /api/images');
      assert.equal(requests.length, 1);
      assert(requests[0].authenticated);
      assert.equal(requests[0].sessionId, 'thread-codex');
      fixture.state.images.retry = { bytes: png, mime: 'image/png', fail: true };
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'retry-image',
        role: 'user',
        blocks: [{ kind: 'image', id: 'retry', alt: '附件', width: 1, height: 1 }],
      });
      await refresh(page, fixture);
      const retry = page.locator('.chat-image[data-image-id="retry"]');
      await retry.scrollIntoViewIfNeeded();
      await expect(retry).toHaveClass(/failed/);
      fixture.state.images.retry.fail = false;
      await retry.click();
      await expect(retry).toHaveClass(/loaded/);
      await withinViewport(retry);
      // 竖长图:圆角卡片必须和图片同比例,否则 contain 会在框里留出两条背景色的边。
      const tall = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAKCAIAAAAcmWhZAAAAU0lEQVR42g3HQQEAIAwDsYlABCIqAhGI6PMETAQiKpDll6pChYsUVQstvMiabLTxJnsiJCyiyUEHH3ImF118yZ0YGZt40qhxk5489PAjbxIUHBI+wPgwIbu9LvQAAAAASUVORK5CYII=',
        'base64',
      );
      fixture.state.images.tall = { bytes: tall, mime: 'image/png' };
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'tall-image',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'image', id: 'tall', alt: '竖图', width: 4, height: 10 }],
      });
      await refresh(page, fixture);
      const tallCard = page.locator('.chat-image[data-image-id="tall"]');
      await tallCard.scrollIntoViewIfNeeded();
      await expect(tallCard).toHaveClass(/loaded/);
      const fit = await tallCard.evaluate((el) => {
        const card = el.getBoundingClientRect(),
          image = el.querySelector('img').getBoundingClientRect();
        return {
          ratio: card.width / card.height,
          width: card.width,
          height: card.height,
          gaps: [
            image.left - card.left,
            image.top - card.top,
            card.right - image.right,
            card.bottom - image.bottom,
          ],
        };
      });
      assert(
        Math.abs(fit.ratio - 0.4) < 0.02,
        `card keeps the image ratio: ${JSON.stringify(fit)}`,
      );
      for (const gap of fit.gaps)
        assert(gap <= 2, `image reaches the rounded edge: ${JSON.stringify(fit.gaps)}`);
      // 输入法弹出时会话 APP 的 WebView 会被 resize;图片多大和键盘没有关系。
      await page.setViewportSize({
        width: viewport.width,
        height: Math.round(viewport.height * 0.55),
      });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const shrunk = await tallCard.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      assert(
        Math.abs(shrunk.width - fit.width) < 0.5 && Math.abs(shrunk.height - fit.height) < 0.5,
        `image size must not follow the viewport height: ${JSON.stringify([fit, shrunk])}`,
      );
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-inline-images.png`) });
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('[data-pane-id="pane-claude"]').click();
      await expect(page.locator('.chat-image')).toHaveCount(0);
    },
    async latestTool(page, fixture) {
      fixture.updateTool('pane-codex', { running: false });
      const blocks = fixture.state.sessions['pane-codex'].messages.at(-1).blocks;
      blocks[1].items.push({
        id: 'codex-tool-next',
        name: 'verify_output',
        running: true,
        input: { text: 'verify', truncated: false },
        result: { text: 'NEXT_RESULT', truncated: false, isError: false },
      });
      await refresh(page, fixture);
      await expect(tool(page, 'next')).not.toHaveAttribute('open', '');
      await expect(tool(page, 'latest')).not.toHaveAttribute('open', '');
      // 工具完成后立即折叠，用户仍可手动展开。
      blocks[1].items.at(-1).running = false;
      blocks.push({ kind: 'text', text: '工具之后的解释正文' });
      await refresh(page, fixture);
      await expect(tool(page, 'next')).not.toHaveAttribute('open', '');
      await tool(page, 'next').locator('summary').click();
      await expect(tool(page, 'next')).toHaveAttribute('open', '');
    },
    async draftsModelsMenus(page, fixture, viewport) {
      return require('./native-command-browser-cases').draftsModelsMenus(page, fixture, viewport, {
        output,
        switchTo,
        refresh,
      });
    },
    async submissionQueueCommands(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.queue.push(
        ...['queued', 'sending', 'uncertain', 'failed'].map((status, i) => ({
          id: `receipt-${i}`,
          paneId: 'pane-codex',
          text: `INTERNAL_RECEIPT_${i}`,
          status,
          createdAt: timestamp,
        })),
      );
      await refresh(page, fixture);
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      await expect(page.locator('#chatLog')).not.toContainText('INTERNAL_RECEIPT_');
      await send(page, 'NATIVE_INPUT_ONLY');
      await expect(page.locator('#commandInput')).toHaveValue('');
      await expect(page.locator('#chatLog')).not.toContainText('NATIVE_INPUT_ONLY');
      session.messages.push({
        id: 'native-input-only',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'NATIVE_INPUT_ONLY' }],
      });
      await refresh(page, fixture);
      await expect(
        page.locator('.chat-msg[data-role=user]').filter({ hasText: /^NATIVE_INPUT_ONLY$/ }),
      ).toHaveCount(1);
    },
    async httpFailure(page, fixture, viewport) {
      fixture.setSendBehavior('REJECTED_MESSAGE', 'fail');
      await send(page, 'REJECTED_MESSAGE');
      await expect(page.locator('#chatComposerError')).toContainText('模拟发送失败');
      await expect(page.locator('#commandInput')).toHaveValue('REJECTED_MESSAGE');
      await expect(page.locator('.outbox-message,#toast,.toast')).toHaveCount(0);
      fixture.setSendBehavior('REJECTED_MESSAGE', 'queued');
      await page.locator('#sendButton').click();
      await expect(page.locator('#commandInput')).toHaveValue('');
      const posts = fixture.state.requests.filter((r) => r.route === 'POST /api/messages');
      assert.equal(posts.length, 2);
      assert.equal(posts[0].body.id, posts[1].body.id);
      await expect(page.locator('#chatComposerError')).toBeHidden();
    },
    async durableRetry(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.pane.agent.status = 'blocked';
      await refresh(page, fixture);
      await send(page, 'DURABLE_FAILURE');
      await expect(page.locator('#chatComposerError')).toContainText('原生端正在等待交互');
      await expect(page.locator('#commandInput')).toHaveValue('DURABLE_FAILURE');
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      session.pane.agent.status = 'working';
      await refresh(page, fixture);
      await page.locator('#sendButton').click();
      await expect(page.locator('#commandInput')).toHaveValue('');
      const posts = fixture.state.requests.filter((r) => r.route === 'POST /api/messages');
      assert.equal(posts.length, 2);
      assert.equal(posts[0].body.id, posts[1].body.id);
      assert.equal(posts[1].body.retry, true);
      assert.equal(session.queue.length, 1);
    },
    async interrupt(page, fixture) {
      await switchTo(page, 'claude');
      const fields = await page.locator('#chatStatusScroll').evaluate((node) =>
        [...node.querySelectorAll('.chat-status-field')]
          .filter((field) => !field.hidden)
          .map((field) => ({
            name: field.dataset.statusSlot,
            separator: !field.querySelector('.chat-status-separator').hidden,
          })),
      );
      assert(!fields.some((field) => ['model', 'effort'].includes(field.name)));
      assert.equal(
        fields.filter((field) => field.separator).length,
        Math.max(0, fields.length - 1),
      );
      await page
        .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
        .click();
      const button = page.locator('#sendButton'),
        interrupt = page.locator('#chatInterrupt');
      await expect(button).toHaveAttribute('data-mode', 'send');
      await expect(button).toBeDisabled();
      await expect(interrupt).toBeVisible();
      await page.locator('#commandInput').fill('排队消息');
      await expect(button).toHaveAttribute('data-mode', 'send');
      await expect(button).toHaveAttribute('aria-label', '发送消息');
      await expect(interrupt).toBeVisible();
      await interrupt.click();
      const interruption = (r) =>
        ['POST /api/messages/interrupt', 'POST /api/agents/interrupt'].includes(r.route);
      await expect.poll(() => fixture.state.requests.filter(interruption).length).toBe(1);
      const stop = fixture.state.requests.find(interruption).body;
      assert.equal(stop.paneId, 'pane-claude');
      assert.equal(stop.sessionId, 'thread-claude');
      assert.match(stop.requestId, /^[\w-]{1,128}$/);
      assert.equal(fixture.state.frames.length, 0, 'stop must not target the focused PTY');
      await expect(page.locator('#commandInput')).toHaveValue('排队消息');
      await page.locator('#commandInput').fill('');
      fixture.state.sessions['pane-claude'].pane.agent.status = 'done';
      await refresh(page, fixture);
      await expect(interrupt).toBeDisabled();
      await expect(button).toHaveAttribute('data-mode', 'send');
      await expect(button).toBeDisabled();
      await page.locator('#commandInput').fill('下一轮');
      await expect(button).toBeEnabled();
      await expect(button).toHaveAttribute('aria-label', '发送消息');
    },
    async directDelivery(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      assert.equal(session.pane.agent.status, 'working');
      for (const text of ['忙碌中的第一条', '忙碌中的第二条']) {
        await send(page, text);
        await expect(page.locator('#commandInput')).toHaveValue('');
      }
      assert.equal(session.pane.agent.status, 'working');
      assert.deepEqual(
        session.queue.map((m) => m.status),
        ['dispatched', 'dispatched'],
      );
      await expect(page.locator('.outbox-message')).toHaveCount(0);
      assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages/deliver'));
      for (const [i, text] of ['忙碌中的第一条', '忙碌中的第二条'].entries())
        session.messages.push({
          id: `native-busy-${i}`,
          role: 'user',
          ts: timestamp,
          blocks: [{ kind: 'text', text }],
        });
      await refresh(page, fixture);
      for (const text of ['忙碌中的第一条', '忙碌中的第二条'])
        await expect(
          page.locator('.chat-msg[data-role=user]').filter({ hasText: new RegExp(`^${text}$`) }),
        ).toHaveCount(1);
      await page.screenshot({
        path: path.join(output, `${viewport.name}-native-busy-delivery.png`),
      });
    },
    async deliveryStability(page, fixture, viewport) {
      const log = page.locator('#chatLog');
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      await page.waitForTimeout(220);
      const before = await log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
      await send(page, 'STABLE_NATIVE_DELIVERY');
      await expect(page.locator('#commandInput')).toHaveValue('');
      await refresh(page, fixture);
      assert.deepEqual(
        await log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight })),
        before,
        'transport receipts must not add or move chat content',
      );
      await expect(page.locator('.outbox-message,#toast,#chatNoticeArea')).toHaveCount(0);
    },
    async questionReplyRendering(page, fixture, viewport) {
      const question =
        '真实页面测试需要恢复登录。请在本机终端运行 `python3 /fixture/hotline/scripts/start_live_review.py`，按隐藏输入提示登录，并保持终端运行。完成后回复“已登录”即可，不要把密码发到聊天中。';
      const answer = '我无法执行这个操作\n我授权你直接执行这个操作';
      const items = [
        {
          question,
          answer,
          questionItemId: JSON.stringify(['request_user_input_async', 'call-render-reply', 0]),
        },
        {
          question: '是否保留原来的小字体？',
          answer: '保留小字体。',
          questionItemId: JSON.stringify(['request_user_input_async', 'call-render-reply', 1]),
        },
      ];
      const envelope = `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>`;
      const text = `补充说明\n${envelope}\n\n请同时保留原来的页面布局。`;
      const session = fixture.state.sessions['pane-codex'];
      session.messages.push({
        id: 'native-question-reply',
        role: 'user',
        ts: timestamp,
        blocks: [{ kind: 'text', text }],
      });
      await refresh(page, fixture);
      const message = page.locator('[data-message-id="native-question-reply"]');
      await expect(message.locator('.codex-question-reply')).toHaveCount(2);
      await expect(message.locator('dt')).toHaveText(['问题', '回答', '问题', '回答']);
      await expect(message.locator('.codex-reply-answer').first()).toHaveText(answer);
      await expect(message.locator('.codex-reply-question code')).toHaveText(
        'python3 /fixture/hotline/scripts/start_live_review.py',
      );
      await expect(message).toContainText('补充说明');
      await expect(message).toContainText('请同时保留原来的页面布局。');
      for (const internal of [
        'send_user_message_question_reply',
        'questionItemId',
        'call-render-reply',
      ])
        await expect(message).not.toContainText(internal);
      await withinViewport(message);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      await page.evaluate(() => {
        window.copiedQuestionReply = '';
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.copiedQuestionReply = text;
            },
          },
        });
        window.questionReplyNode = document.querySelector(
          '[data-message-id="native-question-reply"]',
        );
      });
      await message
        .locator('xpath=following-sibling::*[1]')
        .getByRole('button', { name: '复制这条消息' })
        .click();
      const copied = await page.evaluate(() => window.copiedQuestionReply);
      assert(copied.includes('问题：真实页面测试'));
      assert(copied.includes('回答：我无法执行这个操作\n我授权你直接执行这个操作'));
      assert(
        !copied.includes('questionItemId') && !copied.includes('send_user_message_question_reply'),
      );
      for (let i = 0; i < 3; i++) await refresh(page, fixture);
      assert(
        await page.evaluate(
          () =>
            window.questionReplyNode ===
            document.querySelector('[data-message-id="native-question-reply"]'),
        ),
        'unchanged reply keeps its DOM node',
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-question-reply.png`) });
      await page.reload();
      await expect(message.locator('.codex-question-reply')).toHaveCount(2);
      // Native raw content remains the source. Reloading does not rewrite it.
      assert.equal(session.messages.at(-1).blocks[0].text, text);
      session.messages.push(
        {
          id: 'reply-quoted',
          role: 'user',
          ts: timestamp,
          blocks: [{ kind: 'text', text: '```xml\n' + envelope + '\n```' }],
        },
        {
          id: 'reply-assistant-example',
          role: 'assistant',
          ts: timestamp,
          blocks: [{ kind: 'text', text: '```xml\n' + envelope + '\n```' }],
        },
        {
          id: 'reply-safe-text',
          role: 'user',
          ts: timestamp,
          blocks: [
            {
              kind: 'text',
              text: `<send_user_message_question_reply>\n${JSON.stringify([{ question: '请确认 `<script>` 只是文字。', answer: '<img src=x onerror="window.replyUnsafe=true">' }])}\n</send_user_message_question_reply>`,
            },
          ],
        },
      );
      await refresh(page, fixture);
      await expect(
        page.locator('[data-message-id="reply-quoted"] .codex-question-reply'),
      ).toHaveCount(0);
      await expect(page.locator('[data-message-id="reply-quoted"]')).toContainText(
        'questionItemId',
      );
      await expect(page.locator('[data-message-id="reply-assistant-example"] pre')).toContainText(
        'questionItemId',
      );
      const safe = page.locator('[data-message-id="reply-safe-text"]');
      await expect(safe.locator('.codex-reply-answer')).toHaveText(
        '<img src=x onerror="window.replyUnsafe=true">',
      );
      await expect(safe.locator('img,script')).toHaveCount(0);
      assert.equal(await page.evaluate(() => Boolean(window.replyUnsafe)), false);
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
    },

    async questions(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-claude'];
      session.pane.agent.status = 'blocked';
      session.question = {
        paneId: 'pane-claude',
        sessionId: 'thread-claude',
        provider: 'claude',
        stage: 'question',
        index: 0,
        total: 2,
        challenge: 'question-1',
        draftKey: 'draft-1',
        question: '需要哪些功能？',
        multiSelect: true,
        options: [
          { label: '搜索', description: '查找工作区中的内容。' },
          { label: '导出', description: '将结果保存为文件。' },
        ],
      };
      await switchTo(page, 'claude');
      // 提问就在状态行上方、活动行之上，和普通消息一样贴在背景上：一进会话就看得见，
      // 不用先点开一个摘要条，也没有弹窗遮住正文。
      const box = page.locator('#chatInlineQuestion');
      const option = (name) => box.getByRole('button', { name: new RegExp(name) });
      const text = () => box.getByRole('textbox', { name: '自己写一个答案' });
      await expect(box).toBeVisible();
      // Claude 是分步提问，表头照搬终端的 `Question n/m`，选项带序号。
      await expect(box).toContainText('Question 1/2');
      await expect(box).toContainText('1. 搜索');
      await option('搜索').click();
      await refresh(page, fixture);
      await expect(option('搜索')).toHaveAttribute('aria-pressed', 'true');
      await option('导出').click();
      await expect(page.locator('#commandInput')).toBeDisabled();
      await box.scrollIntoViewIfNeeded();
      const geometry = await box.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          scrollWidth: el.scrollWidth,
          viewport: innerWidth,
        };
      });
      // 贴在背景上就要跟着正文换行，不能自己横着撑出去。高度不限：长问题照常滚动。
      assert(
        geometry.scrollWidth <= geometry.width + 2 &&
          geometry.left >= -1 &&
          geometry.right <= geometry.viewport + 1,
        `inline question overflows: ${JSON.stringify(geometry)}`,
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-agent-question.png`) });
      session.nextQuestion = {
        ...session.question,
        challenge: 'question-2',
        draftKey: 'draft-2',
        index: 1,
        multiSelect: false,
        question: '选择颜色',
        options: [
          { label: 'Red', description: '' },
          { label: 'Blue', description: '' },
        ],
      };
      await box.getByRole('button', { name: /提交并继续/ }).click();
      await expect(box).toContainText('选择颜色');
      await expect(box).toContainText('Question 2/2');
      let submitted = fixture.state.requests.filter(
        (r) => r.route === 'POST /api/agents/questions',
      );
      assert.deepEqual(submitted[0].body.choices, [0, 1]);
      await option('Red').click();
      await text().fill('自定义绿色');
      // 自填与选项互斥，标记要当场消失；但输入框不能因此被重建，否则打字会失焦。
      await expect(option('Red')).toHaveAttribute('aria-pressed', 'false');
      await expect(text()).toBeFocused();
      await refresh(page, fixture);
      await expect(text()).toHaveValue('自定义绿色');
      session.nextQuestion = {
        ...session.question,
        stage: 'review',
        challenge: 'question-3',
        draftKey: 'draft-3',
        question: '确认答案',
        review: '搜索、导出\n自定义绿色',
      };
      await box.getByRole('button', { name: /提交并继续/ }).click();
      await expect(box).toContainText('Review your answers');
      await expect(box).toContainText('自定义绿色');
      await box.getByRole('button', { name: '确认提交', exact: true }).click();
      await expect(box).toBeHidden();
      await expect(page.locator('#commandInput')).toBeEnabled();
      submitted = fixture.state.requests.filter((r) => r.route === 'POST /api/agents/questions');
      assert.equal(submitted.length, 3);
      assert.equal(submitted[1].body.text, '自定义绿色');
      assert.equal(submitted[2].body.confirm, true);
      assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
      session.question = {
        provider: 'claude',
        paneId: 'pane-claude',
        sessionId: 'thread-claude',
        stage: 'question',
        index: 0,
        total: 1,
        challenge: 'late-question',
        draftKey: 'late',
        question: '只属于 Claude',
        options: [],
      };
      await refresh(page, fixture);
      await expect(box).toBeVisible();
      await switchTo(page, 'codex');
      await expect(box).toBeHidden();
    },
    async herdrOwnsManagementMenus(page, fixture, viewport) {
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('[data-pane-id="pane-codex"]').first().click({ button: 'right' });
      await expect(page.locator('.popover')).toContainText('Fork 会话');
      await expect(page.locator('.popover')).not.toContainText(/分屏|Pane/);
      await page.keyboard.press('Escape');
      await page.locator('#sidebarWorkspaces').click();
      await page.locator('.chat-tree-toggle').first().click({ button: 'right' });
      await expect(page.locator('.popover')).toContainText('创建 worktree');
      await page.keyboard.press('Escape');
      assert(
        !fixture.state.requests.some((r) =>
          ['POST /api/herdr/action', 'POST /api/command-interaction'].includes(r.route),
        ),
        '打开原生操作菜单不能执行操作',
      );
    },
    async questionKeepsTypingDuringRefresh(page, fixture, viewport) {
      // 会话在跑时提问卡片几秒就被刷新一次；原来每次都整张重画，输入框被换掉，一个字一个字打不进去
      //（2026-09-25 用户指出）。终端里提问收起/展开、光标移动这些不显示在卡片上的变化，也不该重画。
      const session = fixture.state.sessions['pane-codex'];
      const base = {
        provider: 'codex',
        paneId: 'pane-codex',
        sessionId: 'thread-codex',
        stage: 'question',
        index: 1,
        total: 2,
        blocking: false,
        challenge: 'typing-card',
        draftKey: 'typing-card',
        question: '项目叫什么名字',
        options: [],
      };
      session.question = { ...base, collapsed: true, selected: -1 };
      await refresh(page, fixture);
      const box = page.locator('#chatInlineQuestion');
      await expect(box).toContainText('Codex 的问题 2/2');
      const text = box.getByRole('textbox', { name: '自己写一个答案' });
      await expect(text).toHaveAttribute('placeholder', '写下你的回答');
      await text.click();
      await text.evaluate((node) => {
        node.dataset.original = '1';
      });
      const typed = '探针项目名';
      for (const [i, ch] of [...typed].entries()) {
        await page.keyboard.type(ch);
        session.question =
          i % 2
            ? { ...base, collapsed: true, selected: -1 }
            : { ...base, expanded: true, textOnly: true, selected: -1, text: '' };
        await refresh(page, fixture);
      }
      await expect(text).toHaveValue(typed);
      assert.equal(await text.evaluate((node) => node.dataset.original), '1', '输入框不能被重建');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('chat-inline-question-text'),
        ),
        true,
        '焦点留在输入框里',
      );
      session.question = null;
      await refresh(page, fixture);
      await expect(box).toBeHidden();
    },
    async persistentQuestion(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.webStatus = {
        goal: { objective: 'Keep working on this goal', label: 'Pursuing goal', status: 'active' },
      };
      session.question = {
        provider: 'codex',
        paneId: 'pane-codex',
        sessionId: 'thread-codex',
        source: 'app-server',
        stage: 'question',
        index: 0,
        total: 1,
        blocking: false,
        challenge: 'pending-remote',
        draftKey: 'pending-remote',
        question: '这个问题已经在终端收起，Agent 继续执行，但仍然需要你回答。'.repeat(4),
        options: [
          { label: '继续', description: '' },
          { label: '调整方案', description: '' },
        ],
      };
      await refresh(page, fixture);
      const box = page.locator('#chatInlineQuestion');
      const text = () => box.getByRole('textbox', { name: '自己写一个答案' });
      await expect(box).toBeVisible();
      // Codex 一次给全部问题，没有分步，所以表头是「在问什么」而不是 `Question n/m`。
      await expect(box).toContainText('Codex 想确认一件事');
      // 非阻塞的提问不挡住输入框：Agent 还在跑，用户仍然可以继续说话。
      await expect(page.locator('#commandInput')).toBeEnabled();
      // 问题和状态分别异步返回，先等本用例需要测量的 Goal 摘要到达。
      await expect(page.locator('#chatGoal')).toBeVisible();
      await expect(page.locator('#chatGoal')).toContainText('Keep working on this goal');
      const geometry = await page.evaluate(() => {
        const question = document.querySelector('#chatInlineQuestion').getBoundingClientRect();
        const log = document.querySelector('#chatLog').getBoundingClientRect();
        const goal = document.querySelector('#chatGoal').getBoundingClientRect();
        return {
          left: question.left,
          right: question.right,
          top: question.top,
          logLeft: log.left,
          logRight: log.right,
          logTop: log.top,
          logBottom: log.bottom,
          goalTop: goal.top,
          width: innerWidth,
        };
      });
      // 提问长在聊天流里、跟着正文滚动，所以不比它「整体在视口内」——问题可以很长。
      // 要守住的是：它在聊天流的横向范围内，而聊天流整体在 goal 行之上。
      assert(
        geometry.logBottom <= geometry.goalTop + 1 &&
          geometry.top >= geometry.logTop - 1 &&
          geometry.left >= geometry.logLeft - 1 &&
          geometry.right <= geometry.logRight + 1 &&
          geometry.right <= geometry.width,
        `inline question misplaced: ${JSON.stringify(geometry)}`,
      );
      await page.screenshot({
        path: path.join(output, `${viewport.name}-persistent-question.png`),
      });
      await text().fill('保留未提交的答案');
      // 切走再回来不该丢掉写了一半的答案。
      await switchTo(page, 'claude');
      await expect(box).toBeHidden();
      await switchTo(page, 'codex');
      await expect(text()).toHaveValue('保留未提交的答案');
      // 草稿只在内存里，刷新之后问题还在、答案从头填。
      await page.reload();
      await expect(box).toBeVisible();
      await expect(text()).toHaveValue('');
      await box.getByRole('button', { name: /继续/ }).click();
      await box.getByRole('button', { name: '提交', exact: true }).click();
      await expect(box).toBeHidden();
      const sent = fixture.state.requests.filter((r) => r.route === 'POST /api/agents/questions');
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body.choices, [0]);
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      await fs.writeFile(
        path.join(output, `${viewport.name}-persistent-question.json`),
        JSON.stringify(geometry, null, 2),
      );
    },
    async codexGoalConfirmation(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.pane.agent.status = 'working';
      const { AgentQuestions } = require('../../lib/agent-questions');
      const objective = '根据公开信息重新审查精度问题，补充验收说明';
      const screen = `Replace goal?\nNew objective: ${objective}\n› 1. Replace current goal  Set the new objective and start it now\n  2. Cancel                Keep the current goal\nPress enter to confirm or esc to go back`;
      session.question = await new AgentQuestions({
        herdr: { readPane: async () => screen },
        readLines: async () => [],
      }).read(session.pane);
      assert.equal(session.question?.toolId, 'goal-confirmation');
      session.webStatus = {
        goal: { objective: 'Original goal', status: 'active', label: 'Pursuing goal' },
      };
      await switchTo(page, 'codex');
      await refresh(page, fixture);
      const box = page.locator('#chatInlineQuestion');
      await expect(box).toContainText(objective);
      const questionBox = await box.boundingBox(),
        inputBox = await page.locator('#chatInput').boundingBox();
      assert(
        questionBox.y >= (await page.locator('#chatGoal').boundingBox()).y &&
          questionBox.y + questionBox.height <= inputBox.y + 1,
      );
      // 确认替换 goal 只能二选一，没有自填。
      await expect(box.getByRole('textbox')).toHaveCount(0);
      const choice = box.getByRole('button', { name: /Replace current goal/ });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: path.join(output, `${viewport.name}-goal-confirmation.png`) });
      await box.getByRole('button', { name: '提交', exact: true }).click();
      await expect(box).toBeHidden();
      const answers = fixture.state.requests.filter(
        (r) => r.route === 'POST /api/agents/questions',
      );
      assert.equal(answers.length, 1);
      assert.deepEqual(answers[0].body.choices, [0]);
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      await expect(page.locator('#commandInput')).toBeEnabled();
    },
    async claudeModelConfirmation(page, fixture) {
      const session = fixture.state.sessions['pane-claude'];
      session.pane.agent.status = 'blocked';
      session.question = {
        provider: 'claude',
        paneId: 'pane-claude',
        sessionId: 'thread-claude',
        stage: 'question',
        index: 0,
        total: 1,
        challenge: 'cache-confirm',
        draftKey: 'cache-confirm',
        question: 'Switch model? Sonnet 5',
        allowText: false,
        options: [{ label: 'Yes, switch to Sonnet 5' }, { label: 'No, go back' }],
      };
      await switchTo(page, 'claude');
      const box = page.locator('#chatInlineQuestion');
      await expect(box).toBeVisible();
      await expect(box).toContainText('2. No, go back');
      await expect(box.getByRole('textbox')).toHaveCount(0);
      await box.getByRole('button', { name: /No, go back/ }).click();
      await box.getByRole('button', { name: '提交', exact: true }).click();
      await expect(box).toBeHidden();
      assert.deepEqual(
        fixture.state.requests.find((r) => r.route === 'POST /api/agents/questions').body.choices,
        [1],
      );
    },
    async startup(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-claude'];
      session.pane.agent.status = 'blocked';
      session.startup = {
        kind: 'directory-trust',
        paneId: 'pane-claude',
        cwd: '/fixture/untrusted-project',
        challenge: 'trust-fixture',
      };
      await switchTo(page, 'claude');
      const prompt = page.locator('#agentStartup');
      await expect(prompt).toContainText('/fixture/untrusted-project');
      await expect(page.locator('#commandInput')).toBeDisabled();
      await withinViewport(prompt);
      await page.reload();
      await expect(prompt).toBeVisible();
      await page.screenshot({ path: path.join(output, `${viewport.name}-startup.png`) });
      await prompt.getByRole('button', { name: '信任此目录并继续' }).click();
      await expect(prompt).toBeHidden();
      await expect(page.locator('#commandInput')).toBeEnabled();
      const submitted = fixture.state.requests.filter(
        (r) => r.route === 'POST /api/agents/startup',
      );
      assert.equal(submitted.length, 1);
      assert.deepEqual(submitted[0].body, {
        paneId: 'pane-claude',
        challenge: 'trust-fixture',
        choice: 'trust',
      });
      assert.equal(fixture.state.frames.length, 0);
    },
    async activityClockAfterNative(page) {
      await page.evaluate(() => {
        const pane = {
          paneId: 'clock-probe',
          terminalId: 'clock-terminal',
          agent: { status: 'working', session: { value: 'clock-session' } },
        };
        const status = { activity: '• Working (3s • esc to interrupt)', statusline: [] };
        const view = StudioChatStatus.create({
          nodes: { banner: { hidden: true }, chatView: { hidden: false } },
          context: () => ({ chatAgents: [pane], chatPaneId: pane.paneId, connected: true }),
          renderGoal: () => {},
        });
        view.render(status);
        view.claim(pane.paneId);
        view.beginScreen('clock-observer');
        view.screen({
          observerId: 'clock-observer',
          binding: 'clock-probe:clock-session',
          terminalId: pane.terminalId,
          revision: 1,
          rows: [],
          projection: { recognized: true, rows: [], statusRows: [], interaction: {} },
        });
        if (view.summary().elapsedSeconds !== null)
          throw new Error('Native observations must own current status.');
        view.invalidateStream();
        view.render(status);
        window.__activityClockProbe = view;
      });
      await expect
        .poll(() => page.evaluate(() => window.__activityClockProbe.summary().elapsedSeconds))
        .toBeGreaterThan(3);
      await page.evaluate(() => {
        window.__activityClockProbe.reset({ forgetPane: true });
        delete window.__activityClockProbe;
      });
    },
    async commandActivity(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.activity = '• Waiting for background terminal · sleep 12 (3s • esc to interrupt)';
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).toHaveText(
        'Waiting for background terminal · sleep 12',
      );
      await page
        .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
        .click();
      const details = page.getByRole('region', { name: '会话状态', exact: true });
      await expect(details).toContainText('Waiting for background terminal');
      await expect(details).toContainText('sleep 12');
      await expect(page.locator('#chatExecutionElapsed')).toHaveText(/(?:[4-9]|[1-5]\d)s/, {
        timeout: 3000,
      });
      session.activity =
        '• Working (5s • esc to interrupt) · 1 background terminal running · /ps to view';
      await refresh(page, fixture);
      await expect(details.locator('dt')).toContainText(['Background terminals']);
      session.activity = '';
      await refresh(page, fixture);
      await expect(details.locator('dt')).toContainText(['Background terminals']);
      fixture.updateTool('pane-codex', { running: false });
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).toContainText('Working');
      session.pane.agent.status = 'done';
      await refresh(page, fixture);
      await expect(page.locator('#chatExecutionState')).not.toContainText('Working');
      await page.screenshot({ path: path.join(output, `${viewport.name}-command-activity.png`) });
    },
    async runningCommand(page, fixture, viewport) {
      fixture.updateTool('pane-codex', { running: false });
      const pending = {
        id: 'codex-tool-running-command',
        name: 'exec_command',
        detail: 'sleep 12',
        running: true,
        failed: false,
        input: { text: '{"cmd":"sleep 12"}', truncated: false },
        result: null,
      };
      fixture.state.sessions['pane-codex'].messages.at(-1).blocks[1].items.push(pending);
      await refresh(page, fixture);
      const row = tool(page, 'running-command');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-status', 'running');
      await expect(row.locator('.tool-state')).toHaveCount(0);
      await expect(row.locator('.chat-tools-mark')).toHaveAttribute('aria-label', '正在执行');
      await expect(row.locator('.tool-pending')).toHaveText('等待结果…');
      await expect(row).toHaveJSProperty('open', false);
      await row.locator('summary').click();
      await withinViewport(row.locator('summary'));
      await page.screenshot({ path: path.join(output, `${viewport.name}-running-command.png`) });
      await row.locator('summary').click();
      await expect(row.locator('.tool-state')).toHaveCount(0);
      await expect(row.locator('.chat-tools-mark')).toBeVisible();
      const { parseCodexTranscript, textOnly } = require('../../lib/agent-transcript');
      const archive = [
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: pending.id,
            name: 'exec_command',
            arguments: '{"cmd":"sleep 12"}',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: pending.id,
            output: JSON.stringify({ session_id: 42, output: 'partial output' }),
          },
        },
      ];
      Object.assign(
        pending,
        textOnly(parseCodexTranscript(archive.map(JSON.stringify)))[0].blocks[0].items[0],
      );
      await refresh(page, fixture);
      await expect(row).toHaveAttribute('data-status', 'running');
      await expect(row.locator('.chat-tools-mark')).not.toHaveText('✓');
      await expect(row.locator('.tool-state')).toHaveCount(0);
      await expect(row.locator('.chat-tools-mark')).toBeVisible();
      pending.running = false;
      pending.statusUnknown = true;
      await refresh(page, fixture);
      await expect(row).toHaveAttribute('data-status', 'unknown');
      await expect(row).not.toHaveClass(/running/);
      await expect(row.locator('.chat-tools-mark')).not.toHaveText('✓');
      await expect(row.locator('.tool-state')).toHaveCount(0);
      await expect(row.locator('summary')).not.toContainText('未确认');
      await expect(row.locator('.chat-tools-mark')).toHaveAttribute('aria-label', '状态未确认');
      pending.statusUnknown = false;
      pending.result = { text: 'Process exited with code 0', truncated: false };
      await refresh(page, fixture);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-status', 'completed');
      await expect(row.locator('.tool-state')).toHaveCount(0);
      await expect(row.locator('.tool-pending')).toHaveCount(0);
      await row.locator('summary').click();
      await expect(row.locator('.tool-body')).toContainText('Process exited with code 0');
    },
    async compactComposerAndCommands(page, fixture, viewport) {
      return require('./native-command-browser-cases').compactComposerAndCommands(
        page,
        fixture,
        viewport,
        { output, switchTo, refresh },
      );
    },
    async localCommandBoundaries(page, fixture, viewport) {
      const input = page.locator('#commandInput'),
        panel = page.locator('.native-command-panel');
      await input.fill('/');
      await input.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '/mo';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      await expect(panel).toContainText('/model');
      await input.press('Enter');
      await expect(panel).toContainText('选择模型');
      await panel.getByRole('option').filter({ hasText: '测试模型二' }).click();
      await expect(panel).toContainText('推理强度');
      await panel.getByRole('button', { name: '返回模型列表' }).click();
      await expect(panel).toContainText('选择模型');
      assert.equal(
        fixture.state.requests.filter(
          (row) =>
            row.route === 'POST /api/command-interaction' ||
            row.route === 'POST /api/agent-settings',
        ).length,
        0,
      );
      await page.locator('#chatLog').click({ position: { x: 30, y: 30 } });
      await expect(panel).toBeHidden();
      assert.equal(await input.evaluate((el) => el.readOnly), false);
      await input.fill('中文输入法与取消后的普通消息');
      await page.locator('#sendButton').click();
      await expect(input).toHaveValue('');
      assert.equal(
        fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
        1,
      );
    },
    async localCommandLatency(page, fixture, viewport) {
      const input = page.locator('#commandInput'),
        panel = page.locator('.native-command-panel');
      await input.fill('/');
      await expect(panel.getByRole('option').first()).toBeVisible();
      const metrics = await page.evaluate(() => {
        const input = document.querySelector('#commandInput'),
          start = performance.now();
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
        return {
          elapsedMs: performance.now() - start,
          selected: document.querySelector('.native-command-panel [aria-selected="true"]')
            ?.textContent,
        };
      });
      assert(metrics.elapsedMs < 100, JSON.stringify(metrics));
      assert(metrics.selected.includes('/compact'));
      assert.equal(
        fixture.state.requests.filter((row) => row.route === 'POST /api/command-interaction')
          .length,
        0,
      );
      await input.fill('/model');
      await input.press('Enter');
      await panel.getByRole('option').filter({ hasText: '测试模型二' }).click();
      await expect(panel).toContainText('推理强度');
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      let requests = 0;
      await page.route('**/api/agent-settings', async (route) => {
        if (route.request().method() === 'POST') {
          requests++;
          await gate;
        }
        await route.continue();
      });
      await panel.getByRole('option').filter({ hasText: 'low' }).click();
      await expect(panel).toBeHidden();
      await expect.poll(() => requests).toBe(1);
      await expect(page.locator('#chatExecutionAction')).toBeVisible();
      await expect(page.locator('#chatExecutionAction')).toContainText('Applying settings');
      assert.equal(fixture.state.sessions['pane-codex'].settings.effort, 'high');
      await input.fill('保存设置时继续写的新草稿');
      await expect(input).toBeEnabled();
      assert.equal(requests, 1);
      await page.screenshot({
        path: path.join(output, `${viewport.name}-local-command-confirming.png`),
      });
      release();
      await expect.poll(() => fixture.state.sessions['pane-codex'].settings.effort).toBe('low');
      await expect(input).toHaveValue('保存设置时继续写的新草稿');
      await input.fill('菜单确认后的普通消息');
      await page.locator('#sendButton').click();
      await expect(input).toHaveValue('');
      await fs.writeFile(
        path.join(output, `${viewport.name}-local-command-latency.json`),
        JSON.stringify(
          {
            ...metrics,
            settingsRequests: requests,
            nativeRequests: fixture.state.requests.filter(
              (row) => row.route === 'POST /api/command-interaction',
            ).length,
          },
          null,
          2,
        ),
      );
    },
    async nativeCommandRecovery(page, fixture, viewport) {
      fixture.state.nativeCommands = require('./command-interaction-fixture').create(fixture.state);
      fixture.state.nativeCommandPanes['pane-codex'] = {
        input: 'external draft',
        phase: '',
        selected: 0,
        result: '',
        command: '',
        writes: [],
      };
      const input = page.locator('#commandInput'),
        panel = page.locator('.native-command-panel');
      await input.fill('/status');
      await input.press('Enter');
      await expect(panel).toContainText('已有内容');
      await panel.getByRole('button', { name: '结束命令交互' }).click();
      await expect(panel).toBeHidden();
      assert.equal(fixture.state.nativeCommandPanes['pane-codex'].input, 'external draft');
      fixture.state.nativeCommandPanes['pane-codex'].input = '';
      await input.fill('/status');
      await expect(panel).toContainText('/status');
      await expect(page.locator('#slashCommands')).toBeHidden();
      let aborted = false;
      await page.route('**/api/command-interaction', async (route) => {
        const body = route.request().postDataJSON();
        if (!aborted && body.action === 'execute') {
          aborted = true;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
      await input.press('Enter');
      await expect(panel).toBeHidden({ timeout: 10000 });
      assert.equal(
        fixture.state.nativeCommandPanes['pane-codex'].writes.filter((row) =>
          row.keys?.includes('enter'),
        ).length,
        1,
      );
      await input.fill('正常消息在命令失败恢复后仍可发送');
      await page.locator('#sendButton').click();
      await expect(input).toHaveValue('');
      assert.equal(
        fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
        1,
      );
    },
    async unifiedNotices(page, fixture, viewport) {
      await expect(page.locator('#toast,.toast,#chatNoticeArea,.chat-notice')).toHaveCount(0);
      fixture.setSendBehavior('INLINE_ERROR_ONLY', 'fail');
      await send(page, 'INLINE_ERROR_ONLY');
      await expect(page.locator('#chatComposerError')).toContainText('模拟发送失败');
      const error = page.locator('#chatComposerError');
      const top = await error.evaluate((el) => el.getBoundingClientRect().top);
      await page.waitForTimeout(2300);
      await expect(error).toContainText('模拟发送失败');
      assert.equal(await error.evaluate((el) => el.getBoundingClientRect().top), top);
      const placement = await error.evaluate((el) => {
        const row = el.closest('.chat-status-hint-row'),
          activity = document.querySelector('.chat-status-activity'),
          info = document.querySelector('.chat-status-scroll');
        const r = el.getBoundingClientRect(),
          a = activity.getBoundingClientRect(),
          i = info.getBoundingClientRect();
        const expected = getComputedStyle(info.querySelector('.chat-control-row')),
          actual = getComputedStyle(el);
        return {
          middle: !!row && r.top >= a.bottom && r.bottom <= i.top + 1,
          aligned: Math.abs(r.left - i.left) <= 2,
          font: actual.fontFamily === expected.fontFamily && actual.fontSize === expected.fontSize,
        };
      });
      assert.deepEqual(placement, { middle: true, aligned: true, font: true });
      await expect(page.locator('#commandInput')).toBeEnabled();
      await error.click();
      await expect(page.locator('.session-status-hint-content')).toHaveText('模拟发送失败');
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(output, viewport.width + '-operation-error.png') });
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
      await expect(error).toBeHidden();
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
      await expect(error).toBeHidden();

      await page.locator('#commandInput').fill('edited draft');
      await expect(error).toBeHidden();
      await expect(page.locator('#toast,.toast,#chatNoticeArea')).toHaveCount(0);
    },
    async frontendUpdateOnResume(page, fixture, viewport) {
      // 有新版本时，回到前台只检查、记下来；真正的重载留到切到后台 —— 当着人的面整页清空再
      // 从零加载，是手机上「一切回来就白屏一两秒」的来源（2026-09-24 用户指出）。
      const input = page.locator('#commandInput');
      const version = page.locator('meta[name="agent-studio-assets-version"]');
      const focus = async () => {
        const response = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/frontend-version.json',
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await response;
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };
      const background = () =>
        page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      const foreground = () =>
        page.evaluate(() => {
          delete document.hidden;
        });
      await input.fill('保留未发送的草稿');
      fixture.state.frontendVersion = 'fixture-next';
      await focus();
      await expect(version).toHaveAttribute('content', 'fixture');
      // 有草稿时切到后台也不重载。
      await background();
      await page.waitForTimeout(300);
      await foreground();
      await expect(version).toHaveAttribute('content', 'fixture');
      await expect(input).toHaveValue('保留未发送的草稿');
      await input.fill('');
      await input.blur();
      // 没有草稿、仍在前台：照样不重载。
      await focus();
      await expect(version).toHaveAttribute('content', 'fixture');
      // 切到后台：重载成新版本，回来时内容照常。
      await background();
      await expect(version).toHaveAttribute('content', 'fixture-next');
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(page.locator('.chat-brand-icon')).toHaveCount(0);
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      await focus();
      await expect(version).toHaveAttribute('content', 'fixture-next');
      await page.screenshot({ path: path.join(output, `${viewport.name}-frontend-updated.png`) });
      fixture.state.sessions['pane-codex'].pane.agent.session = null;
      await page.reload();
      await expect(page.locator('#chatLog .chat-welcome')).toBeVisible();
      fixture.state.frontendVersion = 'fixture-empty-update';
      await focus();
      await background();
      await expect(version).toHaveAttribute('content', 'fixture-empty-update');
      await expect(page.locator('#chatLog .chat-welcome')).toBeVisible();
    },
    async claudeWelcomeBeforeArchive(page, fixture, viewport) {
      const created = clone(fixture.state.sessions['pane-claude']);
      created.pane = {
        ...created.pane,
        paneId: 'pane-temporary',
        terminalId: 'terminal-temporary',
        agent: { ...created.pane.agent, session: { value: 'native-new-claude' } },
      };
      created.messages = [];
      created.archivePending = true;
      fixture.state.sessions['pane-temporary'] = created;
      await refresh(page, fixture);
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('[data-pane-id="pane-temporary"]').click();
      const illustration = page.locator('#chatLog .chat-welcome');
      await expect(illustration).toBeVisible();
      await expect(illustration.locator('img')).toHaveCount(0);
      await expect(illustration.locator('.chat-welcome-brand')).toBeHidden();
      const session = fixture.state.sessions['pane-temporary'];
      assert(session.pane.agent.session.value, 'Claude already has a native session ID');
      assert.equal(session.archivePending, true);
      await expect(page.locator('#chatLog')).not.toContainText('没有找到');
      await expect(page.locator('.chat-unavailable')).toHaveCount(0);
      await expect(page.locator('.chat-welcome-caption')).toHaveText(
        '正在读取原生会话记录，消息会自动同步',
      );
      const geometry = await illustration.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          images: el.querySelectorAll('img').length,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.equal(geometry.images, 0);
      assert.equal(geometry.overflow, 0);
      await withinViewport(illustration);
      await page.screenshot({
        path: path.join(output, `${viewport.name}-claude-welcome-pending.png`),
      });
      await page.evaluate(() => {
        window.welcomeStable = {
          image: document.querySelector('.chat-welcome'),
          status: document.querySelector('#chatStatus'),
          removals: 0,
        };
        new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.removedNodes)
              if (node === window.welcomeStable.status) window.welcomeStable.removals++;
        }).observe(document.querySelector('#chatLog'), { childList: true });
      });
      for (let i = 0; i < 2; i++) await refresh(page, fixture);
      assert(
        await page.evaluate(
          () => window.welcomeStable.image === document.querySelector('.chat-welcome'),
        ),
      );

      // A native receipt cannot create a bubble before the archive exists.
      // Keep the stable empty state until the native first message arrives.
      await send(page, 'Claude 的第一条消息');
      await expect(illustration).toBeVisible();
      await refresh(page, fixture);
      await expect(page.locator('#chatLog .chat-msg[data-role="user"]')).toHaveCount(0);
      await expect(page.locator('#chatLog .outbox-message')).toHaveCount(0);
      assert.equal(session.queue.length, 1);
      const pending = session.queue[0];
      session.messages = [
        {
          id: 'claude-first-message',
          role: 'user',
          ts: pending.createdAt,
          blocks: [{ kind: 'text', text: pending.text }],
        },
      ];
      session.archivePending = false;
      await refresh(page, fixture);
      await expect(page.locator('[data-message-id="claude-first-message"]')).toHaveCount(1);
      await expect(page.locator('#chatLog .chat-msg[data-role="user"]')).toHaveCount(1);
      await expect(illustration).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.welcomeStable.removals), 0);

      // Losing access later must not erase previously loaded conversation.
      session.archivePending = true;
      await refresh(page, fixture);
      await expect(page.locator('[data-message-id="claude-first-message"]')).toHaveCount(1);
      await expect(illustration).toHaveCount(0);
      await fs.writeFile(
        path.join(output, `${viewport.name}-claude-welcome-pending.json`),
        JSON.stringify(geometry, null, 2),
      );
    },
    async welcomeBranding(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.messages = [];
      session.pane.agent.status = 'idle';
      await page.reload();
      const welcome = page.locator('#chatLog .chat-welcome');
      await expect(welcome).toBeVisible();
      await expect(welcome.locator('img')).toHaveCount(0);
      await expect(welcome.locator('.chat-welcome-caption')).toBeHidden();
      await expect(welcome.locator('.chat-welcome-brand')).toHaveAttribute('aria-label', 'Codex');
      await expect(welcome.locator('.chat-welcome-brand')).toHaveAttribute(
        'data-provider',
        'codex',
      );
      await expect(welcome.locator('.chat-welcome-label')).toHaveText('codex');
      await expect(welcome.locator('.chat-welcome-directory')).toHaveText('/fixture/project');
      await expect(welcome.locator('.chat-welcome-brand')).toBeVisible();
      await expect(welcome.locator('.chat-welcome-permissions')).toBeHidden();
      await page.locator('#commandInput').fill('保留首页草稿');
      for (const theme of ['default', 'light']) {
        await page.evaluate((theme) => StudioDeviceTheme.apply(theme), theme);
        await withinViewport(welcome);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        await page.screenshot({ path: path.join(output, `${viewport.name}-welcome-${theme}.png`) });
      }
      session.pane.cwd = '/fixture/很长的工作目录/'.repeat(8);
      await refresh(page, fixture);
      await expect(welcome.locator('.chat-welcome-directory')).toHaveText(session.pane.cwd);
      await page.evaluate(() =>
        document.documentElement.style.setProperty('--device-font-scale', '1.5'),
      );
      await withinViewport(welcome);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      await expect(page.locator('#commandInput')).toHaveValue('保留首页草稿');
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      session.pane.cwd = '/fixture/project';
      await page.evaluate(() =>
        document.documentElement.style.removeProperty('--device-font-scale'),
      );
      session.pane.agent.session = null;
      await page.reload();
      await expect(welcome).toBeVisible();
      await expect(welcome.locator('img')).toHaveCount(0);
      await expect(welcome).not.toContainText('从一条消息开始');
      await expect(welcome.locator('.chat-welcome-brand')).toBeVisible();
      session.pane.agent.session = { value: 'thread-codex' };
      session.messages = [
        {
          id: 'first-message',
          role: 'user',
          ts: timestamp,
          blocks: [{ kind: 'text', text: '开始新的工作' }],
        },
      ];
      await refresh(page, fixture);
      await expect(page.locator('#chatLog')).toContainText('开始新的工作');
      await expect(welcome).toHaveCount(0);
    },
    async composerMenuKeepsFocus(page, fixture, viewport) {
      return require('./native-command-browser-cases').composerMenuKeepsFocus(
        page,
        fixture,
        viewport,
        { output, switchTo, refresh },
      );
    },
    async composerPopoverAnchoring(page, fixture, viewport) {
      await require('./native-command-browser-cases').nativeAnchoring(page, fixture, viewport);
      fixture.state.sessions['pane-claude'].settings.editable = true;
      const input = page.locator('#commandInput'),
        menu = page.locator('.composer-popover');
      const measurements = [];
      // 模拟键盘引起的 visualViewport 变化。触摸端走应用本身的下一帧布局；
      // 桌面模拟同样的延迟布局，以覆盖没有 window.resize 的输入框移动。
      const resize = (height) =>
        page.evaluate(
          async ({ height, touch }) => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: height });
            visualViewport.dispatchEvent(new Event('resize'));
            await new Promise((resolve) =>
              requestAnimationFrame(() => {
                if (!touch)
                  document.documentElement.style.setProperty(
                    '--visual-viewport-height',
                    `${height}px`,
                  );
                requestAnimationFrame(resolve);
              }),
            );
          },
          { height, touch: viewport.touch },
        );
      const check = async (stage) => {
        await withinViewport(menu);
        await menu.locator('.popover-item:enabled').first().focus();
        const focus = await menu
          .locator('.popover-item:enabled')
          .first()
          .evaluate((el) => {
            const style = getComputedStyle(el);
            return { outline: style.outlineStyle, background: style.backgroundColor };
          });
        assert.equal(
          focus.outline,
          'none',
          'model and effort menus must not show the global white focus box',
        );
        const geometry = await page.evaluate(() => {
          const card = document.querySelector('#chatInput').getBoundingClientRect();
          const popup = document.querySelector('.composer-popover').getBoundingClientRect();
          return {
            gap: card.top - popup.bottom,
            left: popup.left - card.left,
            top: popup.top,
            height: popup.height,
          };
        });
        assert(Math.abs(geometry.gap - 6) < 1, `${stage}: ${JSON.stringify(geometry)}`);
        assert(Math.abs(geometry.left - 10) < 1, `${stage}: ${JSON.stringify(geometry)}`);
        measurements.push({ stage, ...geometry });
      };
      for (const provider of ['claude']) {
        if (provider === 'claude') await switchTo(page, provider);
        await resize(viewport.height - 260);
        await openModel(page);
        await check(`${provider}:model-keyboard-open`);
        await resize(viewport.height);
        await check(`${provider}:model-keyboard-closed`);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-${provider}-model-anchored.png`),
        });
        await page.getByRole('menuitem').first().click();
        await expect(menu.locator('.popover-back')).toBeVisible();
        await check(`${provider}:effort`);
        await resize(viewport.height - 260);
        await check(`${provider}:effort-keyboard-open`);
        await input.evaluate((el) => {
          el.style.height = '110px';
        });
        await check(`${provider}:effort-multiline`);
        await input.evaluate((el) => el.style.removeProperty('height'));
        await page.screenshot({
          path: path.join(output, `${viewport.name}-${provider}-effort-anchored.png`),
        });
        await menu.locator('.popover-back').click();
        await check(`${provider}:back-to-model`);
        await page.keyboard.press('Escape');
        await expect(input).toBeFocused();
        await input.fill('/effort');
        await page.locator('#slashCommands').getByRole('option').first().click();
        await check(`${provider}:direct-effort`);
        await resize(viewport.height);
        await check(`${provider}:direct-effort-keyboard-closed`);
        await page.getByRole('menuitem', { name: /^low$/ }).click();
        await expect
          .poll(() => fixture.state.sessions[`pane-${provider}`].settings.effort)
          .toBe('low');
      }
      await fs.writeFile(
        path.join(output, `${viewport.name}-popover-anchoring.json`),
        JSON.stringify(measurements, null, 2),
      );
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
    },
    async claudeModelAndCompactMenus(page, fixture, viewport) {
      fixture.state.sessions['pane-claude'].settings.editable = true;
      await switchTo(page, 'claude');
      const input = page.locator('#commandInput');
      await input.fill('/mo');
      const list = page.locator('#slashCommands');
      await expect(list.locator('.slash-description')).toHaveCount(0);
      await expect(list.locator('.slash-caption')).toHaveCount(0);
      await list.getByRole('option').first().click();
      await page.getByRole('menuitem').first().click();
      await expect(page.locator('.popover-sub')).toHaveCount(0);
      await page.getByRole('menuitem', { name: /^low$/ }).click();
      await expect.poll(() => fixture.state.sessions['pane-claude'].settings.effort).toBe('low');
      assert.equal(
        fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
        0,
      );
      await input.fill('/');
      await expect(list.getByRole('option').first()).toBeVisible();
      const metrics = await page.evaluate(() => {
        const menu = document.querySelector('#slashCommands').getBoundingClientRect();
        const card = document.querySelector('#chatInput').getBoundingClientRect();
        const row = document.querySelector('.slash-option').getBoundingClientRect();
        return {
          width: menu.width,
          height: menu.height,
          gap: card.top - menu.bottom,
          rowHeight: row.height,
        };
      });
      assert(metrics.width <= 260 && metrics.height <= 210, JSON.stringify(metrics));
      assert(metrics.gap >= 4 && metrics.gap <= 9, JSON.stringify(metrics));
      assert(metrics.rowHeight >= 28 && metrics.rowHeight <= 34, JSON.stringify(metrics));
      await withinViewport(list);
      await page.screenshot({
        path: path.join(output, `${viewport.name}-compact-composer-menu.png`),
      });
    },
    async settingsActionsAndSkills(page, fixture, viewport) {
      return require('./native-command-browser-cases').settingsActionsAndSkills(
        page,
        fixture,
        viewport,
        { output, switchTo, refresh },
      );
    },
    async sidebarRecencyAndNames(page, fixture, viewport) {
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      const list = page.locator('#chatPickerList');
      await expect(page.locator('.sidebar-modes [role="tab"]')).toHaveText([
        'spaces',
        'agent',
        'archive',
        'files',
      ]);
      await page.locator('#sidebarRecent').click();
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      const codex = fixture.state.sessions['pane-codex'].pane,
        claude = fixture.state.sessions['pane-claude'].pane;
      Object.assign(codex, {
        tabTitle: '编译器',
        displayAgent: '审查 Agent',
        sessionTitle: '修复编译器',
        sessionFullTitle: '修复编译器在反向算子上的形状推断',
        lastMessageAt: 100,
      });
      Object.assign(claude, {
        tab: '说明',
        displayAgent: '文档 Agent',
        sessionTitle: '核对说明',
        lastMessageAt: 200,
      });
      await refresh(page, fixture);
      await expect(list.locator('.session-name')).toHaveText([
        '浏览器验收 · 编译器 · 审查 Agent',
        '浏览器验收 · 说明 · 文档 Agent',
      ]);
      await expect(list.locator('[data-pane-id="pane-codex"]')).toHaveAttribute(
        'title',
        /修复编译器在反向算子上的形状推断/,
      );
      assert.equal(
        await list
          .locator('.session-name')
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        13,
      );
      codex.lastMessageAt = 300;
      await refresh(page, fixture);
      await expect(list.locator('.session-name')).toHaveText([
        '浏览器验收 · 编译器 · 审查 Agent',
        '浏览器验收 · 说明 · 文档 Agent',
      ]);
      codex.workspace = '算子开发';
      codex.tabTitle = '反向算子';
      await refresh(page, fixture);
      await expect(list.locator('.session-name').first()).toHaveText(
        '算子开发 · 反向算子 · 审查 Agent',
      );
      await expect(list.locator('[data-pane-id="pane-codex"]')).toHaveAttribute(
        'title',
        /算子开发 · 反向算子 · 审查 Agent/,
      );
      await page.screenshot({
        path: path.join(output, `${viewport.name}-agent-context-names.png`),
        fullPage: true,
      });
      await page.locator('#chatSearchToggle').click();
      await page.locator('#chatPickerSearch').fill('反向算子');
      await expect(list.locator('.session-name')).toHaveText(['算子开发 · 反向算子 · 审查 Agent']);
      await page.locator('#chatPickerSearch').fill('');
      await page.locator('#chatSearchToggle').click();
      await page.locator('#sidebarWorkspaces').click();
      await expect(list.locator('.chat-tree-toggle')).toHaveCount(1);
      await list.locator('.chat-tree-toggle').click();
      await expect(list.locator('.session-item')).toHaveCount(0);
      await page.locator('#sidebarRecent').click();
      await expect(list.locator('.session-item')).toHaveCount(2);
      await page.reload();
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarRecent').click();
      await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
      await expect(list.locator('.session-item').first()).toContainText('审查 Agent');
    },
    async messageMetadataPlacement(page, fixture, viewport) {
      const blocks = fixture.state.sessions['pane-codex'].messages.at(-1).blocks;
      blocks.push({ kind: 'text', text: '命令后的补充说明' });
      await refresh(page, fixture);
      const pieces = page.locator('[data-message-id="codex-tools"]');
      await expect(pieces).toHaveCount(3);
      const order = await pieces.first().evaluate((el) => {
        const meta = el.nextElementSibling,
          tools = meta.nextElementSibling,
          after = tools.nextElementSibling;
        return {
          meta: meta.className,
          copy: meta.querySelectorAll('.chat-meta-button').length,
          tools: tools.dataset.content,
          after: after.dataset.content,
          lastMeta: after.nextElementSibling.className,
          above: meta.getBoundingClientRect().bottom <= tools.getBoundingClientRect().top,
        };
      });
      assert.equal(order.meta, 'chat-meta');
      assert.equal(order.copy, 1);
      assert.equal(order.tools, 'tools');
      assert.equal(order.after, 'text');
      assert.equal(order.lastMeta, 'chat-meta');
      assert(order.above);
      await page.screenshot({ path: path.join(output, `${viewport.name}-message-metadata.png`) });
    },
    async connectionStatus(page, fixture, viewport) {
      const line = page.locator('#connectionBanner');
      // 启动时连上用不了多久，连接提示一次都不该出现（出现了就是一闪、页面跳一下）。
      assert.equal(
        await page.evaluate(() => window.__bannerShown || false),
        false,
        '启动时出现了连接提示',
      );
      fixture.disconnect(true);
      // 短暂断连不提示，持续中断才显示不参与布局的说明。
      await page.waitForTimeout(1000);
      await expect(line).toBeHidden();
      await expect(line).toBeVisible({ timeout: 16000 });
      await expect(line).toContainText('连接恢复中');
      await expect(page.locator('#commandInput')).toBeEnabled();
      await page.locator('#commandInput').fill('断线期间可以编辑的草稿');
      await expect(page.locator('#sendButton')).toBeDisabled();
      await withinViewport(line);
      const style = await line.evaluate((el) => {
        const s = getComputedStyle(el);
        return { position: s.position };
      });
      assert.deepEqual(style, { position: 'absolute' });
      await refresh(page, fixture);
      await expect(line).toBeVisible();
      await page.screenshot({ path: path.join(output, `${viewport.name}-connection-status.png`) });
      fixture.disconnect(false);
      await expect(line).toBeHidden({ timeout: 6000 });
      await expect(page.locator('#commandInput')).toBeEnabled();
      await expect(page.locator('#commandInput')).toHaveValue('断线期间可以编辑的草稿');
    },
    async statusDot(page, fixture, viewport) {
      const dot = page.locator('#chatCurrentDot');
      const session = fixture.state.sessions['pane-codex'];
      const tools = session.messages.at(-1).blocks.find((b) => b.kind === 'tools').items;
      const colors = new Map();
      // Lifecycle is authoritative; rendered tools do not guess activity.
      // Visible loaded Chat marks its device-local completion seen.
      let stamp = Date.now();
      for (const [status, running, kind, label] of [
        ['working', true, 'working', '正在推理或执行'],
        ['working', false, 'working', '正在推理或执行'],
        ['blocked', true, 'blocked', '等待用户回答或确认'],
        ['done', true, 'idle', '空闲'],
        ['done', false, 'idle', '空闲'],
        // Loaded and visible messages are read, independently of lifecycle.
        ['idle', false, 'idle', '空闲'],
      ]) {
        session.pane.agent.status = status;
        session.pane.lastMessageAt = stamp += 60000;
        for (const tool of tools) tool.running = running;
        await refresh(page, fixture);
        await expect(dot).toHaveAttribute('data-status', kind);
        await expect(dot).toHaveAttribute('aria-label', label);
        const look = await dot.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            background: cs.backgroundColor,
            ring: cs.boxShadow,
            color: cs.color,
            animation: cs.animationName,
            text: el.textContent,
          };
        });
        if (colors.has(kind)) assert.deepEqual(colors.get(kind), look);
        else colors.set(kind, look);
        const sidebar = page.locator('#chatPickerList .session-item.active .status-dot');
        await expect(sidebar).toHaveAttribute('data-status', kind);
      }
      // 四态都是圆点，不带动画 —— ✽ 那一套试过几轮，字形对不齐一列圆点，已退回。
      for (const kind of ['working', 'blocked', 'idle']) {
        assert.equal(colors.get(kind).text, '', `${kind} 是圆点，不放字形`);
        assert.equal(colors.get(kind).animation, 'none', `${kind} 不该有动画`);
      }
      // 🔑 配色与 Herdr 对齐（它的 status_color）：忙→黄、有提问→红、结束→青、
      // 空闲使用灰圈，设备完成与正文未读分别显示。
      assert.equal(colors.get('working').background, 'rgb(245, 245, 67)', '忙 → 黄');
      assert.equal(colors.get('blocked').background, 'rgb(255, 107, 128)', '等我回答 → 浅红');
      // 「都看过了」是**空心灰圈**：实心灰混在一列彩色实心点里不够分明。
      assert.match(colors.get('idle').ring, /inset/, '看过了要画成圈');
      assert.match(colors.get('idle').ring, /rgb\(153, 153, 153\)/);
      assert.equal(colors.get('idle').background, 'rgba(0, 0, 0, 0)', '圈是空心的');
      // 忙与等我回答各一个实心色，看过了是空心圈；「还没看」那一种在下面单独验。
      assert.notEqual(colors.get('working').background, colors.get('blocked').background);

      // 「结束了」那一态属于**没在看的**会话：它结束了、消息还等着我去看。
      const other = fixture.state.sessions['pane-claude'];
      other.pane.agent.status = 'idle';
      other.pane.agent.completionSeq = 12;
      other.pane.agent.stateChangeSeq = 12;
      other.pane.lastMessageAt = stamp += 60000;
      session.pane.agent.status = 'idle';
      await refresh(page, fixture);
      const otherDot = page.locator('#chatPickerList [data-pane-id="pane-claude"] .status-dot');
      await expect(otherDot).toHaveAttribute('data-status', 'done');
      assert.equal(
        await otherDot.evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(59, 142, 234)',
        '本轮完成未查看 → 蓝',
      );
      // 切过去看一眼就转灰。
      await switchTo(page, 'claude');
      await expect(dot).toHaveAttribute('data-status', 'idle');
      await expect(dot).toHaveAttribute('aria-label', '空闲');
      // 整页重载之后，看过的仍然算看过。原来已读记录在设置取回之前就读了，读到的是空表，
      // 每次重载蓝点全亮（2026-09-24 用户指出）。设置写入有节流，等它落到服务端再重载。
      await switchTo(page, 'codex');
      await page.waitForTimeout(600);
      await page.reload();
      await expect(
        page.locator('#chatPickerList [data-pane-id="pane-claude"] .status-dot'),
      ).toHaveAttribute('data-status', 'idle');
      await switchTo(page, 'claude');
      // 又有新消息就不再算看过 —— 这一条只对**没在看的**会话成立：正看着的那个
      // 每次重绘都会被重新标成看过，它本来就在你眼前。
      await switchTo(page, 'codex');
      other.pane.lastMessageAt = stamp += 60000;
      await refresh(page, fixture);
      await expect(otherDot).toHaveAttribute('data-status', 'idle');
      await expect(otherDot).toHaveAttribute('data-unread', 'true');
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      await page.locator('#sidebarRecent').click();
      fixture.state.sessions['pane-shell'] = {
        pane: {
          paneId: 'pane-shell',
          tabId: 'tab-shell',
          workspaceId: 'workspace-fixture',
          tabTitle: 'Shell',
          agent: null,
          status: 'idle',
        },
        messages: [],
        queue: [],
      };
      await refresh(page, fixture);
      await expect(page.locator('#chatPickerList [data-pane-id="pane-shell"]')).toHaveCount(0);
      await page.locator('#sidebarWorkspaces').click();
      await expect(
        page.locator('#chatPickerList [data-pane-id="pane-shell"] .status-dot'),
      ).toHaveAttribute('data-status', 'shell');
      await page.screenshot({ path: path.join(output, `${viewport.name}-activity-dots.png`) });
      await expect(page.locator('.chat-head > #chatCurrentDot')).toHaveCount(1);
    },
    async longMessageEntry(page, fixture, viewport) {
      fixture.state.unified = true;
      const codex = fixture.state.sessions['pane-codex'],
        claude = fixture.state.sessions['pane-claude'];
      const paragraph = '这是较长的会话消息，用于检验进入会话时是否显示最新消息。\n\n';
      codex.messages = Array.from({ length: 181 }, (_, i) => ({
        id: `entry-codex-${i}`,
        role: 'assistant',
        ts: timestamp,
        blocks: [
          {
            kind: 'text',
            text:
              i === 180
                ? 'codex 浏览器验收样例 ENTRYLATESTCODEX'
                : `第 ${i} 段\n\n` + paragraph.repeat(i === 179 ? 90 : 4),
          },
        ],
      }));
      claude.messages = Array.from({ length: 60 }, (_, i) => ({
        id: `entry-claude-${i}`,
        role: 'assistant',
        ts: timestamp,
        blocks: [
          {
            kind: 'text',
            text:
              i === 59
                ? 'claude 浏览器验收样例 ENTRYLATESTCLAUDE\n\n' + paragraph.repeat(90)
                : paragraph.repeat(4),
          },
        ],
      }));
      const log = page.locator('#chatLog'),
        measurements = [];
      async function latest(stage) {
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const geometry = await log.evaluate((el) => ({
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
          gap: el.scrollHeight - el.scrollTop - el.clientHeight,
          count: el.querySelectorAll('.chat-msg').length,
        }));
        measurements.push({ stage, ...geometry });
        assert(
          Math.abs(geometry.gap) <= 2,
          `${stage} must show latest messages: ${JSON.stringify(geometry)}`,
        );
      }
      await page.reload();
      await expect(log).toContainText('ENTRYLATESTCODEX');
      await latest('fresh');
      // Load more than three groups, then recreate them through a cached switch.
      // The final group is one short message after a very tall previous group.
      while ((await log.locator('.chat-msg').count()) < 181) {
        const count = await log.locator('.chat-msg').count();
        await log.evaluate((el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
        });
        await expect.poll(() => log.locator('.chat-msg').count()).toBeGreaterThan(count);
      }
      await page.locator('#commandInput').fill('进入会话保留草稿');
      await switchTo(page, 'claude', 'ENTRYLATESTCLAUDE');
      await latest('long-Claude-tail');
      await switchTo(page, 'codex', 'ENTRYLATESTCODEX');
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await latest('cached-short-tail');
      assert.equal(
        await log.locator('.chat-msg').count(),
        181,
        'Cached entry must retain loaded history',
      );
      await expect(page.locator('#commandInput')).toHaveValue('进入会话保留草稿');
      await log.evaluate((el) => {
        el.scrollTop = 500;
        el.dispatchEvent(new Event('scroll'));
      });
      const reading = await log.evaluate((el) => el.scrollTop);
      fixture.changed();
      await page.waitForTimeout(300);
      assert(
        Math.abs((await log.evaluate((el) => el.scrollTop)) - reading) <= 2,
        'Background refresh must preserve reading',
      );
      await switchTo(page, 'codex', 'ENTRYLATESTCODEX');
      await latest('reselect');
      await page.reload();
      await expect(log).toContainText('ENTRYLATESTCODEX');
      await latest('reload');
      await switchTo(page, 'claude', 'ENTRYLATESTCLAUDE');
      await latest('cached-long-Claude-tail');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      await fs.writeFile(
        path.join(output, `${viewport.name}-long-message-entry.json`),
        JSON.stringify(measurements, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}-long-message-entry.png`) });
    },
    async restoreScrollBeforePaint(page, fixture, viewport) {
      const log = page.locator('#chatLog');
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      const saved = await log.evaluate((el) => el.scrollTop);
      await switchTo(page, 'claude');
      let release,
        requested = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/api/transcript?**', async (route) => {
        if (new URL(route.request().url()).searchParams.get('pane') === 'pane-codex') {
          requested = true;
          await gate;
        }
        await route.continue();
      });
      await page.evaluate(() => {
        window.restoreFrames = [];
        window.collectRestoreFrames = true;
        const sample = () => {
          const el = document.querySelector('#chatLog');
          if (el.dataset.paneId === 'pane-codex' && el.dataset.loading === 'false')
            window.restoreFrames.push(el.scrollTop);
          if (window.collectRestoreFrames) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      try {
        await switchTo(page, 'codex');
        await expect.poll(() => requested).toBe(true);
        await expect
          .poll(() => page.evaluate(() => window.restoreFrames.length))
          .toBeGreaterThan(3);
        const frames = await page.evaluate(() => {
          window.collectRestoreFrames = false;
          return window.restoreFrames;
        });
        await fs.writeFile(
          path.join(output, `${viewport.name}-restore-scroll.json`),
          JSON.stringify({ saved, frames }, null, 2),
        );
        await page.screenshot({ path: path.join(output, `${viewport.name}-restore-scroll.png`) });
        assert(
          frames.every((top) => Math.abs(top - saved) <= 2),
          `entry did not restore reading: ${JSON.stringify({ saved, frames })}`,
        );
        // A late refresh must not undo reading performed after entering.
        await log.evaluate((el) => {
          el.scrollTop = 650;
        });
        const reading = await log.evaluate((el) => el.scrollTop);
        const arrived = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === '/api/transcript' &&
            new URL(r.url()).searchParams.get('pane') === 'pane-codex',
        );
        release();
        await arrived;
        await refresh(page, fixture);
        assert(
          Math.abs((await log.evaluate((el) => el.scrollTop)) - reading) <= 2,
          'late refresh restored an obsolete position',
        );
        await log.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event('scroll'));
        });
        const bottomBefore = await log.evaluate((el) => ({
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
        }));
        await switchTo(page, 'claude');
        await switchTo(page, 'codex');
        const bottomAfter = await log.evaluate((el) => ({
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
        }));
        assert(
          bottomAfter.height - bottomAfter.top - bottomAfter.client < 3,
          `bottom reader did not return to latest: ${JSON.stringify({ bottomBefore, bottomAfter })}`,
        );
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    },
    async restoreLongHistory(page, fixture, viewport) {
      const session = fixture.state.sessions['pane-codex'];
      session.messages.unshift(
        ...Array.from({ length: 150 }, (_, i) => ({
          id: `old-${i}`,
          role: 'assistant',
          ts: timestamp,
          blocks: [{ kind: 'text', text: `Earlier history ${i}\n\n保留已经加载的阅读位置。` }],
        })),
      );
      await page.reload();
      const log = page.locator('#chatLog');
      await expect(log).toContainText('codex 浏览器验收样例');
      while ((await log.locator('.chat-msg').count()) < 140) {
        const count = await log.locator('.chat-msg').count();
        await log.evaluate((el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
        });
        await expect.poll(() => log.locator('.chat-msg').count()).toBeGreaterThan(count);
      }
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      const before = await log.evaluate((el) => ({
        top: el.scrollTop,
        count: el.querySelectorAll('.chat-msg').length,
        first: el.querySelector('.chat-msg').dataset.messageId,
      }));
      await switchTo(page, 'claude');
      await switchTo(page, 'codex');
      const after = await log.evaluate((el) => ({
        top: el.scrollTop,
        count: el.querySelectorAll('.chat-msg').length,
        first: el.querySelector('.chat-msg').dataset.messageId,
      }));
      assert.equal(after.count, before.count, 'entry must retain loaded history');
      assert.equal(after.first, before.first);
      assert(
        Math.abs(after.top - before.top) <= 2,
        're-entering loaded history must preserve reading',
      );
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      const reading = await log.evaluate((el) => el.scrollTop);
      await openFilesPanel(page, viewport);
      await expect(page.locator('#sessionFilesPage')).toBeVisible();
      await refresh(page, fixture); // Hidden chat geometry must not replace the saved viewport.
      if (viewport.width <= 760) {
        assert(await page.evaluate(() => window.StudioNavigation.back()));
        assert(
          Math.abs((await log.evaluate((el) => el.scrollTop)) - reading) <= 2,
          'files Back must preserve reading within the same session',
        );
      }
      await switchTo(page, 'claude');
      await switchTo(page, 'codex');
      assert(
        Math.abs((await log.evaluate((el) => el.scrollTop)) - reading) <= 2,
        'entering after files must preserve reading',
      );
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      await switchTo(page, 'codex');
      assert(
        await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3),
        'explicitly selecting the current session must open at bottom',
      );
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      await page.reload();
      await expect(log).toContainText('codex 浏览器验收样例');
      await expect
        .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
        .toBeLessThan(3);
    },
    async restoreUnavailableScroll(page, fixture, viewport) {
      const log = page.locator('#chatLog');
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      await switchTo(page, 'claude');
      fixture.state.sessions['pane-codex'].pane.agent.session.value =
        'replacement-without-cached-position';
      await refresh(page, fixture);
      await page.evaluate(() => {
        window.fallbackFrames = [];
        window.collectFallbackFrames = true;
        const sample = () => {
          const log = document.querySelector('#chatLog');
          if (log.dataset.paneId === 'pane-codex' && log.dataset.loading === 'false')
            window.fallbackFrames.push(log.scrollHeight - log.scrollTop - log.clientHeight);
          if (window.collectFallbackFrames) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await switchTo(page, 'codex');
      await expect.poll(() => page.evaluate(() => window.fallbackFrames.length)).toBeGreaterThan(3);
      const gaps = await page.evaluate(() => {
        window.collectFallbackFrames = false;
        return window.fallbackFrames;
      });
      await fs.writeFile(
        path.join(output, `${viewport.name}-restore-fallback.json`),
        JSON.stringify({ gaps }, null, 2),
      );
      assert(
        gaps.every((gap) => gap < 3),
        `missing position did not open directly at bottom: ${JSON.stringify(gaps)}`,
      );
    },
    async nestedMarkdownLinks(page, fixture, viewport) {
      const url =
        'https://gitcode.com/cann/asc-devkit/discussions/26?comment_id=ed621d789588451db240d1460b07fdaa';
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'nested-markdown-links',
        role: 'assistant',
        ts: timestamp,
        blocks: [
          {
            kind: 'text',
            text: `本次要求已完成：\n\n- **剩余三类精度问题已发到[讨论帖 26](${url})**：溢出 Inf、Cast 异常转换、Div 的 0 ULP／FTZ 偏差。\n\n[**查看说明**](https://example.com/docs)`,
          },
        ],
      });
      await refresh(page, fixture);
      const message = page.locator('.chat-msg[data-message-id="nested-markdown-links"]');
      await message.scrollIntoViewIfNeeded();
      const links = message.locator('a');
      const measure = await message.evaluate((el) => ({
        text: el.textContent,
        links: [...el.querySelectorAll('a')].map((a) => ({
          text: a.textContent,
          href: a.getAttribute('href'),
          weight: getComputedStyle(a).fontWeight,
        })),
        overflow: document.documentElement.scrollWidth - innerWidth,
      }));
      await fs.writeFile(
        path.join(output, `${viewport.name}-nested-markdown-links.json`),
        JSON.stringify(measure, null, 2),
      );
      await page.screenshot({
        path: path.join(output, `${viewport.name}-nested-markdown-links.png`),
      });
      await expect(links).toHaveCount(2);
      await expect(message.locator('strong > a')).toHaveAttribute('href', url);
      await expect(message.locator('a > strong')).toHaveText('查看说明');
      assert(!measure.text.includes('[讨论帖') && !measure.text.includes('comment_id='));
      assert.equal(measure.overflow, 0);
      assert(Number(measure.links[0].weight) >= 600);
      // Verify the click destination in an isolated popup without contacting GitCode.
      await page.context().route(url, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<p>Isolated link target</p>',
        }),
      );
      const popup = page.waitForEvent('popup');
      await message.getByRole('link', { name: '讨论帖 26', exact: true }).click();
      const opened = await popup;
      await opened.waitForLoadState('domcontentloaded').catch(() => {});
      assert.equal(opened.url(), url);
      await opened.close();
    },
    async scrolling(page, fixture) {
      const log = page.locator('#chatLog');
      await log.evaluate((el) => {
        el.scrollTop = 300;
      });
      await expect(page.locator('#jumpToLatest')).toHaveCount(0);
      const top = await log.evaluate((el) => el.scrollTop);
      fixture.updateTool('pane-codex', {
        result: { text: 'RESULT_PHASE_B', truncated: false, isError: false },
      });
      await refresh(page, fixture);
      assert(
        Math.abs((await log.evaluate((el) => el.scrollTop)) - top) <= 2,
        'tool refresh moved the reader',
      );
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'new-response',
        role: 'assistant',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'APPENDED_REPLY\n\n仍然保留历史阅读位置。' }],
      });
      await refresh(page, fixture);
      await expect(log).toContainText('APPENDED_REPLY');
      assert(
        Math.abs((await log.evaluate((el) => el.scrollTop)) - top) <= 2,
        'new message moved the reader',
      );
      await log.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await expect(page.locator('#jumpToLatest')).toHaveCount(0);
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'next-response',
        role: 'assistant',
        ts: timestamp,
        blocks: [{ kind: 'text', text: 'BOTTOM_FOLLOW\n\n贴底用户应跟随新内容。' }],
      });
      await refresh(page, fixture);
      await expect(log).toContainText('BOTTOM_FOLLOW');
      assert(
        (await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 3,
        'bottom following failed',
      );
    },
    async layout(page, fixture, viewport) {
      await expect(page.locator('#chatCurrentDot')).toHaveAttribute('aria-label', '正在推理或执行');
      await expect(page.locator('.chat-head > #chatCurrentDot')).toHaveCount(1);
      await expect(page.locator('#sessionStatus')).toHaveCount(0);
      await withinViewport(page.locator('.chat-input'));
      await withinViewport(page.locator('#commandInput'));
      await withinViewport(page.locator('#sendButton'));
      if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
      const sidebarHeight = await page
        .locator('#chatPickerList .session-item')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      assert(sidebarHeight >= 28 && sidebarHeight <= 36);
      if (viewport.width <= 760)
        await page
          .locator('#chatPickerScrim')
          .click({ position: { x: viewport.width - 8, y: 100 } });
      const measurements = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          log: rect('#chatLog'),
          card: rect('.chat-input'),
          messages: document.querySelectorAll('#chatLog .chat-msg').length,
          tools: document.querySelectorAll('details.chat-tool-row').length,
          field: rect('#commandInput'),
          send: rect('#sendButton'),
          attach: rect('#attachButton'),
          command: rect('details.chat-tool-row:not([open]) summary'),
          sidebarRow: rect('#chatPickerList .session-item'),
        };
      });
      assert.equal(measurements.overflow, 0);
      assert(measurements.card.height <= 74, 'composer should stay compact');
      assert(
        Math.abs(measurements.attach.y - measurements.send.y) <= 3,
        'attachment and send should share a row',
      );
      assert(
        measurements.field.x + measurements.field.width <= measurements.send.x,
        'input overlaps send',
      );
      assert(
        measurements.attach.x + measurements.attach.width <= measurements.send.x,
        'attachment should sit left of send',
      );
      assert(
        measurements.field.x + measurements.field.width <= measurements.attach.x,
        'text should not overlap buttons',
      );
      assert(measurements.command.height <= 28, 'collapsed command should stay compact');
      measurements.sidebarRow.height = sidebarHeight;
      assert(measurements.sidebarRow.height <= 68, 'two-line Agent rows should stay compact');
      assert.equal(await page.locator('.agent-action').count(), 0);
      assert.equal(measurements.messages, 26);
      assert.equal(measurements.tools, 2);
      assert(measurements.log.height > viewport.height / 2);
      await fs.writeFile(
        path.join(output, `${viewport.name}.json`),
        JSON.stringify(measurements, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${viewport.name}.png`), fullPage: true });
    },
  };
  if (selectedCase && !Object.hasOwn(cases, selectedCase))
    throw new Error(`Unknown case: ${selectedCase}`);
  const targets =
    selectedCase === 'nativeGoalStatus'
      ? [
          { name: 'desktop', width: 1920, height: 1080, touch: false },
          ...viewports.slice(1),
          { name: 'mobile-small', width: 320, height: 740, touch: true },
        ]
      : [
            'longMessageEntry',
            'welcomeBranding',
            'sessionFilesAlignment',
            'chatHighlighting',
          ].includes(selectedCase)
        ? [...viewports, { name: 'mobile-small', width: 320, height: 740, touch: true }]
        : viewports;
  try {
    for (const viewport of targets)
      for (const [name, test] of Object.entries(cases)) {
        if (selectedCase && name !== selectedCase) continue;
        const fixture = await createFixture();
        if (name === 'sessionFilesAlignment') fixture.state.productionPresentation = true;
        if (name === 'firstMessage') {
          const session = fixture.state.sessions['pane-codex'];
          session.pane.agent.session = null;
          session.pane.agent.status = 'idle';
          session.messages = [];
          session.settings = {
            model: null,
            effort: null,
            editable: false,
            reason: '尚未创建会话存档',
          };
        }
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          // 减少动效：三页之间的平移会让「打开后立刻量位置」量到半路；平移本身由 pageSlide 单独验。
          isMobile: browserType === firefox ? undefined : viewport.touch,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
        // 启动缓存在每次离开页面时写（public/app.js 的 persistBoot），用例里一重载就会先画出上次的样子。
        // 只有 bootFromCache 验这件事，其余用例每次导航前清掉，从空白状态开始。
        if (name !== 'bootFromCache')
          await context.addInitScript(() => {
            try {
              localStorage.removeItem('agentStudioBoot');
            } catch {}
          });
        // 记下连接提示有没有出现过（connectionStatus 用例检查启动时从不出现）。
        await context.addInitScript(() => {
          new MutationObserver(() => {
            const el = document.querySelector('#connectionBanner');
            if (el && !el.hidden && el.textContent.trim()) window.__bannerShown = true;
          }).observe(document, {
            subtree: true,
            attributes: true,
            childList: true,
            characterData: true,
          });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(30000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const result = {
          viewport: viewport.name,
          test: name,
          ok: false,
          sources: await fingerprint(),
        };
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === fixture.url
              ? route.continue()
              : route.abort(),
          );
          await page.goto(`${fixture.url}/?token=fixture&view=chat`);
          if (name !== 'firstMessage') {
            await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
          }
          await test(page, fixture, viewport);
          assert.deepEqual(errors, [], 'browser exceptions');
          assert.deepEqual(fixture.state.unexpected, [], 'unexpected API requests');
          result.ok = true;
          await fs.rm(path.join(output, `${viewport.name}-${name}-failure.png`), { force: true });
        } catch (error) {
          result.error = error.stack;
          result.browserErrors = errors;
          result.requests = fixture.state.requests;
          await page
            .screenshot({
              path: path.join(output, `${viewport.name}-${name}-failure.png`),
              fullPage: true,
            })
            .catch(() => {});
        } finally {
          // 失败时只打首行会把断言的期望与实得截掉，定位要靠猜。
          // 多打几行，它本来就只在失败时出现。
          const detail = result.ok
            ? ''
            : ': ' + result.error.split('\n').slice(0, 8).join('\n    ');
          console.log(`${result.ok ? 'PASS' : 'FAIL'} ${viewport.name} ${name}${detail}`);
          results.push(result);
          await context.close();
          await fixture.close();
        }
      }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceBefore,
        sourceAfter: await fingerprint(),
        results,
      },
      null,
      2,
    ),
  );
  const failures = results.filter((r) => !r.ok);
  assert.equal(
    failures.length,
    0,
    `${failures.length}/${results.length} failed; see ${output}/report.json`,
  );
}

module.exports = { createFixture, makeState, scenarios, viewports };
if (require.main === module) {
  const mode = process.argv[2];
  const task =
    mode === '--self-test'
      ? selfTest()
      : mode === '--capture'
        ? capture()
        : mode === '--run'
          ? runBrowserSuite()
          : null;
  if (task)
    task.catch((error) => {
      console.error(error.stack);
      process.exitCode = 1;
    });
  else {
    console.error('Usage: node scripts/testing/chat-harness.js --run | --self-test | --capture');
    process.exitCode = 2;
  }
}

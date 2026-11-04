'use strict';

// 会话的快照、历史、恢复、新建与关闭，以及会话级的提问、启动与命令目录。

const path = require('node:path');
const { buildDashboard } = require('../../sync/dashboard');

function register(router, ctx) {
  const {
    identityRepair,
    broadcastHerdrChanged,
    prepareWorkspace,
    Conversation,
    Profile,
    agentQuestions,
    answerStartup,
    apiError,
    clampInt,
    currentRoot,
    deviceId,
    exactPane,
    getMessageQueue,
    herdr,
    json,
    publicControllerState,
    readAgentCommands,
    readJson,
    readStartup,
    readTranscript,
    scopeDashboard,
    withinRoot,
    listCodexSkills,
  } = ctx;

  router.get('/api/snapshot', async (req, res, url) => {
    const dashboard = await buildDashboard(ctx);
    return json(res, 200, {
      ok: true,
      ...dashboard,
      settings: currentRoot().data.deviceSettings(deviceId(req)),
      profile: Profile.readProfile(currentRoot().data),
      controllers: publicControllerState(),
    });
  });

  router.get('/api/agent-skills', async (req, res, url) => {
    const pane = await exactPane(url.searchParams.get('pane'));
    if (pane.agent?.label !== 'codex')
      throw apiError(400, 'UNSUPPORTED_PROVIDER', '当前 Agent 不支持这个 Skill 接口。');
    // Skill 就是磁盘上的目录，直接读（lib/codex-skills.js），不经 app-server。
    const result = listCodexSkills(pane.cwd || pane.baseCwd || currentRoot().data.directory);
    return json(res, 200, {
      ok: true,
      ...result,
      skills: result.skills.filter((skill) => skill.enabled),
    });
  });

  router.get('/api/commands', async (req, res, url) => {
    const pane = await exactPane(url.searchParams.get('pane'), { input: true });
    const label = String(pane.agent?.label || '').toLowerCase();
    const provider = label.includes('claude') ? 'claude' : label.includes('codex') ? 'codex' : null;
    if (!provider) return json(res, 200, { commands: [], reason: '当前会话不支持斜杠命令' });
    const executable =
      provider === 'codex' && /^\d+:\d+$/.test(pane.runtimeId || '')
        ? `/proc/${pane.runtimeId.split(':')[0]}/exe`
        : null;
    return json(res, 200, {
      ok: true,
      ...(await readAgentCommands(
        provider,
        pane.cwd || pane.baseCwd || currentRoot().data.directory,
        { executable },
      )),
    });
  });

  router.post('/api/command-interaction', async (req, res) => {
    const body = await readJson(req);
    const result = await (body?.action === 'execute'
      ? ctx.commandInteraction.execute(body)
      : ctx.commandInteraction.handle(body));
    if (result.sessionChanged) broadcastHerdrChanged();
    return json(res, 200, result);
  });

  router.post('/api/agents/rewind', async (req, res) => {
    const body = await readJson(req);
    if (body?.action !== 'prepare')
      throw apiError(400, 'INVALID_REWIND_ACTION', '未知历史消息编辑操作。');
    return json(res, 200, await ctx.messageRewind.prepare(body));
  });

  router.add(['GET', 'POST'], '/api/agents/goal', async (req, res, url) => {
    if (req.method === 'POST')
      return json(res, 202, { ok: true, job: await ctx.goalActions.start(await readJson(req)) });
    if (url.searchParams.has('requestId'))
      return json(res, 200, {
        ok: true,
        job: ctx.goalActions.get(url.searchParams.get('requestId')),
      });
    return json(res, 200, await ctx.goalActions.preview(Object.fromEntries(url.searchParams)));
  });

  router.add(['GET', 'POST'], '/api/agents/fork', async (req, res, url) => {
    const job =
      req.method === 'POST'
        ? ctx.sessionFork.start(await readJson(req))
        : ctx.sessionFork.get(url.searchParams.get('requestId'));
    return json(res, req.method === 'POST' ? 202 : 200, { ok: true, job });
  });

  router.add(['GET', 'POST'], '/api/agents/interrupt', async (req, res, url) => {
    const result =
      req.method === 'POST'
        ? await ctx.sessionInterrupt.run(await readJson(req))
        : await ctx.sessionInterrupt.preview(Object.fromEntries(url.searchParams));
    return json(res, 200, result);
  });

  router.add(['GET', 'POST'], '/api/agents/questions', async (req, res, url) => {
    if (req.method === 'POST')
      return json(res, 200, await agentQuestions.answer(await readJson(req)));
    if (url.searchParams.get('requestId'))
      return json(
        res,
        200,
        await agentQuestions.receipt(
          url.searchParams.get('pane'),
          url.searchParams.get('requestId'),
        ),
      );
    const pane = await exactPane(url.searchParams.get('pane'));
    return json(res, 200, { ok: true, question: await agentQuestions.read(pane) });
  });

  router.post('/api/agents/native-draft', async (req, res) => {
    const result = await ctx.nativeDraft.handle(await readJson(req));
    return json(res, 200, result);
  });

  router.add(['GET', 'POST'], '/api/agents/side', async (req, res, url) => {
    if (req.method === 'POST') {
      const result = await ctx.codexSide.handle(await readJson(req));
      broadcastHerdrChanged();
      return json(res, 200, result);
    }
    const pane = await exactPane(url.searchParams.get('pane'), { input: true });
    const result =
      url.searchParams.get('transcript') === '1'
        ? await ctx.codexSide.transcript(pane)
        : await ctx.codexSide.read(pane);
    Conversation.assertIdentity(await exactPane(pane.paneId, { input: true }), {
      binding: Conversation.binding(pane),
    });
    return json(res, 200, result);
  });

  router.add(['GET', 'POST'], '/api/agents/startup', async (req, res, url) => {
    const payload = req.method === 'POST' ? await readJson(req) : {};
    const pane = await exactPane(payload.paneId || url.searchParams.get('pane'));
    if (req.method === 'GET')
      return json(res, 200, { ok: true, startup: await readStartup(herdr, pane) });
    return json(res, 200, { ok: true, ...(await answerStartup(herdr, pane, payload)) });
  });

  router.get('/api/history', async (req, res, url) => {
    const dashboard = await herdr.dashboard();
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset'), 10) || 0);
    const result = await currentRoot().history.list(dashboard.panes, {
      offset,
      limit: 100,
      query: url.searchParams.get('q') || '',
      rootDirectory: currentRoot().data.directory,
      // 打开归档栏要看到刚出现的存档；边打字边搜时每个字一次请求，给 2 秒缓存。
      maxAge: url.searchParams.get('q') ? 2000 : 0,
    });
    return json(res, 200, { ok: true, ...result });
  });

  /**
   * 归档会话的只读正文。
   *
   * 选中归档里的一条就能翻看过往记录，**但不能发消息** —— 那个会话已经停机了，
   * 要说话得先恢复（`/api/history/resume`）。所以这里只给正文：没有输入框回显、
   * 没有活动行、没有状态栏，也不碰发送队列 —— 它们都以「有一个活着的 pane」
   * 为前提，硬造一份出来只会让人以为还能用。
   */
  router.get('/api/history/transcript', async (req, res, url) => {
    const entry = await currentRoot().history.find(
      url.searchParams.get('provider') || '',
      url.searchParams.get('sessionId') || '',
    );
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 60);
    const before = url.searchParams.get('before') || '';
    const transcript = await ctx.readConversationPage(entry.file, entry.provider, {
      limit,
      before,
    });
    return json(res, 200, {
      ok: true,
      archived: true,
      agent: entry.provider,
      provider: entry.provider,
      sessionId: entry.sessionId,
      title: entry.title || '',
      cwd: entry.cwd || '',
      lastMessageAt: entry.lastMessageAt || 0,
      total: transcript.total,
      hasMore: transcript.hasMore,
      messages: transcript.messages,
      historyRevision: transcript.historyRevision,
      historyEpoch: transcript.historyEpoch,
      replace: transcript.replace,
    });
  });

  router.post('/api/history/resume', async (req, res, url) => {
    const payload = await readJson(req);
    if (!payload || typeof payload !== 'object')
      throw apiError(400, 'INVALID_SESSION', '会话标识无效。');
    const key = `${payload.provider}:${payload.sessionId}`;
    let pending = currentRoot().historyResumes.get(key);
    if (!pending) {
      pending = (async () => {
        const entry = await currentRoot().history.get(payload.provider, payload.sessionId);
        if (!withinRoot(currentRoot().data.directory, entry.cwd))
          throw apiError(409, 'ROOT_CHANGED', '这个会话不在当前根目录内。');
        const dashboard = await herdr.dashboard();
        const existing = dashboard.panes.find(
          (p) =>
            p.agent?.label?.toLowerCase() === entry.provider &&
            p.agent?.session?.value === entry.sessionId,
        );
        if (existing)
          return { paneId: existing.paneId, sessionId: entry.sessionId, alreadyOpen: true };
        let workspaceId =
          dashboard.workspaces.find((w) => w.workspaceId === entry.workspaceId)?.workspaceId ||
          dashboard.panes.find((p) => (p.baseCwd || p.cwd) === entry.cwd)?.workspaceId;
        if (!workspaceId) {
          const workspace = await herdr.createWorkspace({
            label: entry.workspace || path.basename(entry.cwd),
            cwd: entry.cwd,
          });
          workspaceId = workspace.workspace?.workspace_id;
          if (!workspaceId) throw apiError(500, 'WORKSPACE_ID_MISSING', '无法确定恢复工作区。');
          try {
            return await herdr.resumeAgent(entry, workspaceId, workspace.root_pane?.pane_id);
          } catch (error) {
            await herdr.closeWorkspace(workspaceId).catch(() => {});
            throw error;
          }
        }
        return herdr.resumeAgent(entry, workspaceId);
      })().finally(() => currentRoot().historyResumes.delete(key));
      currentRoot().historyResumes.set(key, pending);
    }
    const started = await pending;
    return json(res, 201, {
      ok: true,
      started,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/sessions/close', async (req, res, url) => {
    const payload = await readJson(req),
      pane = await exactPane(payload.target);
    if (payload.sessionId && pane.agent?.session?.value !== payload.sessionId)
      throw apiError(409, 'SESSION_CHANGED', '会话已经改变。');
    await currentRoot().history.remember(pane);
    // 会话身份上面已经核对过，交给 closeSession 的只有终端 id（移动后也不变），防关错。
    // ⚠️ 曾经在这里把 sessionId 再交给它按 Herdr 原始表比一遍，而当时 Codex 的身份由附属
    // 会话通道另外补充、原始表里没有，于是带身份关闭 Codex 会话一律 SESSION_CHANGED
    // （2026-09-23 实测）。现在身份只有 Herdr 这一份来源，但也没必要核对两遍。
    await herdr.closeSession(pane.paneId, { terminalId: payload.terminalId || pane.terminalId });
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  // 兼容旧启动接口。工作区是布局分组；缺少 cwd 时要求调用方明确选择目录。
  async function workspaceDirectory(root, workspace, requested) {
    const directory = requested ?? workspace.cwd;
    if (!directory)
      throw apiError(400, 'WORKSPACE_DIRECTORY_REQUIRED', '此工作区没有启动目录，请明确指定 cwd。');
    return (await prepareWorkspace(root, workspace.label || workspace.workspaceId, directory)).cwd;
  }

  router.post('/api/agents/start', async (req, res, url) => {
    const payload = await readJson(req);
    const kind = String(payload.kind || (payload.temporary === true ? 'chat' : '')).toLowerCase();
    if (kind === 'chat' || kind === 'quick') {
      if (payload.paneId) throw apiError(400, 'INVALID_TARGET', '这类会话要新建标签页。');
      payload.cwd = currentRoot().data.directory;
      if (
        payload.workspaceId &&
        !(await herdr.dashboard()).workspaces.some(
          (workspace) => workspace.workspaceId === payload.workspaceId,
        )
      )
        throw apiError(404, 'WORKSPACE_NOT_FOUND', '没有这个工作区，请刷新后重试。');
      const target = payload.workspaceId
        ? { workspaceId: payload.workspaceId, rootPaneId: null }
        : await herdr.workspaceForDirectory(payload.cwd);
      payload.workspaceId = target.workspaceId;
      payload.rootPaneId = target.rootPaneId;
    } else if (!payload.paneId && (payload.newWorkspace || payload.newProject)) {
      const label = String(payload.newWorkspace || payload.newProject).trim();
      const directory = await prepareWorkspace(
        currentRoot().data.directory,
        label,
        payload.cwd ?? currentRoot().data.directory,
      );
      const created = await herdr.createWorkspace({ label, cwd: directory.cwd });
      payload.workspaceId = created?.workspace?.workspace_id;
      payload.rootPaneId =
        created?.root_pane?.pane_id || created?.workspace?.root_pane?.pane_id || null;
      payload.cwd = directory.cwd;
      if (!payload.workspaceId)
        throw apiError(500, 'WORKSPACE_ID_MISSING', '工作区建好了，但没有拿到它的标识。');
    } else if (!payload.paneId) {
      const workspace = (await herdr.dashboard()).workspaces.find(
        (item) => item.workspaceId === payload.workspaceId,
      );
      if (!workspace) throw apiError(404, 'WORKSPACE_NOT_FOUND', '没有这个工作区，请刷新后重试。');
      payload.cwd = await workspaceDirectory(currentRoot().data.directory, workspace, payload.cwd);
      payload.rootPaneId = null;
    }
    // 给了 paneId 就是「在这个已有的终端标签页里起」,否则才新开一个标签页。
    // 前者正是终端里的动作顺序:先有一格停在提示符上的 shell,再把 agent 拉起来。
    const started = payload.paneId
      ? await herdr.startAgentInPane(payload.paneId, payload.provider, payload.name)
      : await herdr.startAgent(payload);
    return json(res, 201, {
      ok: true,
      started,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });

  router.post('/api/agents/rename', async (req, res, url) => {
    const payload = await readJson(req);
    await herdr.renameAgent(payload.target, payload.name);
    return json(res, 200, {
      ok: true,
      dashboard: scopeDashboard(await herdr.dashboard(), currentRoot().data.directory),
    });
  });
}

module.exports = { register };

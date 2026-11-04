'use strict';

// 会话正文、搜索、工具详情与图片。正文与发送队列遵循同一份有效历史。

function register(router, ctx) {
  const {
    Conversation,
    agentQuestions,
    apiError,
    chatStatus,
    clampInt,
    claudeControl,
    codexSettings,
    currentRoot,
    describeTool,
    exactPane,
    getAgentSettings,
    getMessageQueue,
    herdr,
    json,
    locatePaneTranscript,
    paneTranscriptFile,
    parseTranscript,
    readAgentCatalog,
    readCodexGoal,
    readImage,
    readPaneLines,
    readPaneStatus,
    readStartup,
    readTranscript,
    readConversationPage,
    securityHeaders,
    textOnly,
    transcriptWatcher,
    withinRoot,
  } = ctx;

  router.get('/api/tool', async (req, res, url) => {
    const id = url.searchParams.get('id');
    if (!id) throw apiError(400, 'TOOL_ID_REQUIRED', '缺少工具 id。');
    const pane = await exactPane(url.searchParams.get('pane'));
    if (
      url.searchParams.has('sessionId') &&
      url.searchParams.get('sessionId') !== pane.agent?.session?.value
    ) {
      throw apiError(409, 'SESSION_CHANGED', '目标会话已改变。');
    }
    if (url.searchParams.get('sideId'))
      return json(res, 200, {
        ok: true,
        tool: await ctx.codexSide.tool(pane, url.searchParams.get('sideId'), id),
      });
    if (require('../../providers/native').DATABASE.includes(pane.agent?.label)) {
      const native = require('../../providers/native'),
        page = native.readDatabase(pane);
      const tool = page?.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.kind === 'tool' && block.id === id);
      if (!tool) throw apiError(404, 'TOOL_NOT_FOUND', '当前会话没有这个工具调用。');
      if (pane.agent.label === 'opencode' && tool.result?.truncated) {
        const adapter = require('../../providers/upstream/opencode');
        const output = adapter.opencodeToolOutput(
          adapter.opencodeDatabasePath(),
          pane.agent.session.value,
          id,
        );
        if (output != null)
          tool.result = { text: output, truncated: false, isError: tool.result.isError };
      }
      Conversation.assertIdentity(await exactPane(pane.paneId), {
        binding: Conversation.binding(pane),
      });
      return json(res, 200, {
        ok: true,
        paneId: pane.paneId,
        sessionId: pane.agent?.session?.value,
        tool: describeTool(tool),
      });
    }
    const { tool } = await readTranscript(await paneTranscriptFile(pane), pane.agent?.label, [
      `tool:${id}`,
    ]);
    if (!tool) throw apiError(404, 'TOOL_NOT_FOUND', '当前会话没有这个工具调用。');
    Conversation.assertIdentity(await exactPane(pane.paneId), {
      binding: Conversation.binding(pane),
    });
    return json(res, 200, {
      ok: true,
      paneId: pane.paneId,
      sessionId: pane.agent?.session?.value,
      tool,
    });
  });

  router.get('/api/images', async (req, res, url) => {
    const pane = await exactPane(url.searchParams.get('pane'));
    const sessionId = pane.agent?.session?.value;
    if (!sessionId || url.searchParams.get('sessionId') !== sessionId)
      throw apiError(409, 'SESSION_CHANGED', '会话已改变，请重新打开图片。');
    const transcript = await readTranscript(await paneTranscriptFile(pane), pane.agent.label, [
      'images',
    ]);
    const image = await readImage(transcript.images, url.searchParams.get('id'), {
      attachmentsDirectory: require('node:path').join(currentRoot().data.path, 'attachments'),
    });
    const current = await exactPane(pane.paneId);
    if (current.terminalId !== pane.terminalId || current.agent?.session?.value !== sessionId)
      throw apiError(409, 'SESSION_CHANGED', '会话已改变，请重新打开图片。');
    const headers = securityHeaders({
      'content-type': image.mime,
      'cache-control': 'private, no-cache',
      etag: image.etag,
    });
    if (req.headers['if-none-match'] === image.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'content-length': image.bytes.length });
    return res.end(image.bytes);
  });

  router.get('/api/transcript', async (req, res, url) => {
    const paneId = url.searchParams.get('pane') || '';
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 60);
    const pane = await exactPane(paneId);
    if (!pane)
      return json(res, 404, { ok: false, code: 'PANE_NOT_FOUND', message: '找不到这个 pane。' });
    const agentKind = pane.agent?.label || '';
    const capabilities = require('../../../public/provider-capabilities').get(agentKind);
    const sessionId = pane.agent?.session?.value || '';
    Conversation.assertIdentity(
      pane,
      Object.fromEntries(
        ['binding', 'sessionId']
          .filter((k) => url.searchParams.has(k))
          .map((k) => [k, url.searchParams.get(k)]),
      ),
    );
    const windowOptions = {
      limit,
      navigation: url.searchParams.get('navigation') === '1',
      around: url.searchParams.get('around'),
      before: url.searchParams.get('before'),
      from: url.searchParams.get('from'),
      revision: url.searchParams.get('revision'),
      historyEpoch: url.searchParams.get('historyEpoch'),
    };
    // History rendering can proceed independently of slow terminal observers.
    // The control snapshot uses the original state=1 path and identity checks.
    const deferredState =
      url.searchParams.get('terminal') === '0' && url.searchParams.get('state') !== '1';
    const terminalStatusFor = () => (deferredState ? Promise.resolve({}) : readPaneStatus(paneId));
    const stateEnvelope = async (turnId) => {
      const extras =
        url.searchParams.get('state') === '1'
          ? await Promise.all([
              capabilities.settings
                ? getAgentSettings(pane, {
                    readLines: readPaneLines,
                    claudeControl,
                    codexSettings,
                    readCatalog: readAgentCatalog,
                  }).catch(() => null)
                : null,
              capabilities.questions ? agentQuestions.read(pane).catch(() => undefined) : null,
              capabilities.send ? getMessageQueue().list(paneId) : [],
              capabilities.create ? readStartup(herdr, pane).catch(() => null) : null,
            ])
          : null;
      Conversation.assertIdentity(await exactPane(paneId), { binding: Conversation.binding(pane) });
      return {
        binding: Conversation.binding(pane),
        identity: Conversation.identity(pane),
        turnId,
        capabilities,
        ...(deferredState ? { deferredState: true } : {}),
        // ⚠️ `agentQuestions.read()` 返回的就是提问对象本身，别再往里取一层：那个对象
        // 自己有一个 `question` 字段（提问正文），`extras[1]?.question` 取到的是**字符串**，
        // paneId、sessionId、options、challenge 全丢了。页面据此渲染出一个没有选项的空壳，
        // 提交时报「缺少 pane」。而正文接口带 binding 时提问正是走这条路 —— 也就是说
        // 主路径上的提问一直是坏的（2026-09-22 实测修复）。
        ...(extras
          ? {
              settings: extras[0],
              question: extras[1],
              outbox: extras[2].filter(
                (item) =>
                  item.sessionId === (sessionId || null) &&
                  (!item.terminalId || item.terminalId === pane.terminalId) &&
                  (!item.runtimeId || item.runtimeId === pane.runtimeId),
              ),
              startup: extras[3],
            }
          : {}),
      };
    };
    const native = require('../../providers/native');
    if (native.DATABASE.includes(agentKind)) {
      const page = native.readDatabase(pane, { before: windowOptions.before || undefined, limit });
      Conversation.assertIdentity(await exactPane(paneId), { binding: Conversation.binding(pane) });
      if (
        windowOptions.before &&
        windowOptions.revision &&
        page?.revision !== windowOptions.revision
      )
        throw apiError(409, 'HISTORY_CHANGED', '历史已改变，请重新读取。');
      return json(res, 200, {
        ok: true,
        paneId,
        sessionId,
        agent: agentKind,
        supported: true,
        readOnly: true,
        archivePending: !page,
        ...(await stateEnvelope(null)),
        ...(url.searchParams.get('window') === '0' && page
          ? { windowless: true }
          : { messages: page?.messages || [], replace: true }),
        hasMore: page?.hasMore || false,
        historyRevision: page?.revision || '',
        total: page?.messages.length || 0,
      });
    }
    if (!capabilities.history) {
      return json(res, 200, {
        ok: true,
        paneId,
        agent: agentKind,
        supported: false,
        reason: '这个 pane 没有可识别的 agent 会话',
        messages: [],
      });
    }
    // A goal may change while paused, without appending transcript messages.
    let goal;
    if (agentKind === 'codex' && sessionId) {
      try {
        goal = await readCodexGoal(sessionId, pane);
      } catch {
        /* Omit unavailable state; do not report a clear. */
      }
    }
    const file = await locatePaneTranscript(pane);
    if (!file) {
      // Native agents can publish a session ID before writing their first
      // archive. This is a supported session awaiting an archive, not a
      // failed launch. Keep polling and expose its current terminal status.
      const terminalStatus = await terminalStatusFor();
      return json(res, 200, {
        ok: true,
        paneId,
        sessionId,
        agent: agentKind,
        supported: true,
        readOnly: !capabilities.send,
        archivePending: true,
        associationPending:
          !sessionId &&
          Boolean(pane.agentTitle) &&
          !/^(?:codex|claude|Claude Code|新会话|临时会话)(?:\s*\|.*)?$/i.test(pane.agentTitle),
        ...Conversation.historyWindow([], windowOptions),
        ...(await stateEnvelope(null)),
        ...chatStatus(terminalStatus, pane, null),
        ...(goal !== undefined ? { goal } : {}),
        messages: [],
      });
    }
    transcriptWatcher.watch(file);
    const queue = getMessageQueue();
    const receiptIds = capabilities.send
      ? queue.items
          .filter(
            (item) =>
              item.paneId === paneId && item.status === 'consumed' && item.consumedMessageId,
          )
          .map((item) => item.consumedMessageId)
      : [];
    const [transcript, terminalStatus] = await Promise.all([
      readConversationPage(file, agentKind, {
        ...windowOptions,
        windowless: url.searchParams.get('window') === '0',
        receiptIds,
      }),
      terminalStatusFor(),
    ]);
    if (/claude/i.test(agentKind)) goal = transcript.goal;
    // 只发对话本身:工具调用和思考过程在手机上淹没正文,而且占了传输量的大头。
    const conversation = transcript.messages || [];
    // The index checks complete branch membership for the exact receipt IDs.
    // A missing record in a display page never implies a discarded delivery.
    if (capabilities.send && transcript.receipts)
      await queue.recheckConsumed(
        paneId,
        pane,
        transcript.receipts.messages,
        transcript.receipts.archive,
      );
    const envelope = await stateEnvelope(capabilities.stop ? transcript.turnId : null);
    return json(res, 200, {
      ok: true,
      paneId,
      sessionId,
      agent: agentKind,
      supported: true,
      readOnly: !capabilities.send,
      archivePending: false,
      // Codex 的模型、推理档位和额度优先来自原生存档记录；终端补充活动文字、
      // 计时和存档里没有的字段。不是所有状态都靠解析画面。
      ...chatStatus(
        terminalStatus,
        pane,
        transcript.status,
        conversation,
        envelope.settings || null,
      ),
      ...(goal !== undefined ? { goal } : {}),
      ...(transcript.navigation ? { navigation: transcript.navigation } : {}),
      total: transcript.total,
      hasMore: transcript.hasMore,
      historyRevision: transcript.historyRevision,
      historyEpoch: transcript.historyEpoch,
      ...(transcript.windowless
        ? { windowless: true }
        : { messages: conversation, replace: transcript.replace }),
      ...envelope,
      turnIds: capabilities.stop ? transcript.turnIds : [],
    });
  });

  // 会话记录搜索。不给 pane 就搜全部会话 —— 「我之前在哪个会话聊过这个」
  // 才是真正难回答的问题,在单个会话里翻反而次要。
  router.get('/api/transcript/search', async (req, res, url) => {
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (query.length < 2) {
      return json(res, 200, { ok: true, query, hits: [], truncated: false, scanned: 0 });
    }
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 60);
    const onlyPane = url.searchParams.get('pane') || '';
    const dashboard = await herdr.dashboard();
    const targets = (dashboard.panes || []).filter(
      (pane) =>
        withinRoot(currentRoot().data.directory, pane.cwd || pane.baseCwd) &&
        pane.agent?.label &&
        pane.agent?.session?.value &&
        (!onlyPane || pane.paneId === onlyPane),
    );

    const hits = [];
    let scanned = 0;
    let truncated = false;
    for (const pane of targets) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const file = await locatePaneTranscript(pane);
      if (!file) continue;
      scanned += 1;
      const transcript = await readTranscript(file, pane.agent.label);
      for (const message of textOnly(transcript.messages)) {
        const text = message.blocks.map((block) => block.text || '').join('\n');
        const at = text.toLowerCase().indexOf(query);
        if (at < 0) continue;
        hits.push({
          paneId: pane.paneId,
          title: pane.title || pane.paneId,
          workspace: pane.workspace || '',
          agent: pane.agent.label,
          id: message.id,
          role: message.role,
          ts: message.ts || null,
          // 命中处前后各留一点上下文,够判断是不是要找的那条就行
          excerpt: text
            .slice(Math.max(0, at - 40), at + query.length + 80)
            .replace(/\s+/g, ' ')
            .trim(),
        });
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
      }
    }
    return json(res, 200, { ok: true, query, hits, truncated, scanned });
  });
}

module.exports = { register };

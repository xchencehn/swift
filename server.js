#!/usr/bin/env node
'use strict';
const Conversation = require('./lib/conversation-state');
const { normalizeBasePath, securityHeaders, json, createHttp } = require('./lib/http');
const { authorizeDirect } = require('./lib/http/direct-auth');

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { HerdrClient, clampInt } = require('./lib/herdr-client');
const { prepareWorkspace } = require('./lib/workspace-root');
const { saveAttachment } = require('./lib/attachments');
const { readImage } = require('./lib/chat-images');
const { readAgentCommands } = require('./lib/agent-commands');
const { readAgentCatalog } = require('./lib/agent-catalog.js');
const { HerdrEvents } = require('./lib/herdr-events.js');
const { SessionIdentityRepair } = require('./lib/session-identity-repair');
const { TranscriptWatcher } = require('./lib/transcript-watcher');
const transcriptWatcher = new TranscriptWatcher(() => broadcastHerdrChanged());
const { MessageQueue, apiError } = require('./lib/message-queue');
const { RewindInteraction } = require('./lib/rewind-interaction');
const { RewindNative } = require('./lib/codex-rewind-native');
const { rewindHistory } = require('./lib/codex-rewind-history');
const { readStartup, answerStartup } = require('./lib/agent-startup');
const { AgentQuestions } = require('./lib/agent-questions');
const { sendPaneMessage, interruptPane } = require('./lib/herdr-input');
const { getAgentSettings: readAgentSettings, validateSettings } = require('./lib/agent-settings');
const {
  parseTranscript,
  locateTranscript,
  textOnly,
  describeTool,
} = require('./lib/agent-transcript');
const { CodexArchiveLocator } = require('./lib/codex-process-home');
const { readStatusArea } = require('./lib/agent-composer');
const { chatStatus } = require('./lib/chat-status');
const { readCodexGoal } = require('./lib/agent-goal');
const { listDirectory, createDirectory } = require('./lib/directory-browse');

const APP_NAME = (process.env.SWIFT_APP_NAME ?? process.env.AGENT_STUDIO_APP_NAME) || 'swift';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8792);
const TOKEN = require('./lib/http/server-token').serverToken();
const ANDROID_TOKEN =
  (process.env.SWIFT_ANDROID_TOKEN ?? process.env.AGENT_STUDIO_ANDROID_TOKEN) || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = Number(
  (process.env.SWIFT_MAX_BODY_BYTES ?? process.env.AGENT_STUDIO_MAX_BODY_BYTES) || 128 * 1024,
);
const MAX_WS_INPUT_BYTES = Number(
  (process.env.SWIFT_MAX_WS_INPUT_BYTES ?? process.env.AGENT_STUDIO_MAX_WS_INPUT_BYTES) ||
    128 * 1024,
);
const { withinRoot, scopeDashboard } = require('./lib/root-scope');
const { deviceId } = require('./lib/root-preferences');
const Profile = require('./lib/root-profile');
const { RootSettings } = require('./lib/root-settings');
const rootSettings = new RootSettings({
  storageDirectory:
    process.env.SWIFT_DATA_DIR ??
    process.env.AGENT_STUDIO_DATA_DIR ??
    ((process.env.SWIFT_ROOT_DIR ?? process.env.AGENT_STUDIO_ROOT_DIR)
      ? undefined
      : path.join(__dirname, '.local/data/roots')),
  file:
    process.env.SWIFT_SETTINGS_FILE ??
    process.env.AGENT_STUDIO_SETTINGS_FILE ??
    path.join(__dirname, '.local/config/settings.json'),
  directory:
    (process.env.SWIFT_ROOT_DIR ?? process.env.AGENT_STUDIO_ROOT_DIR) ||
    path.join(os.homedir(), 'workdir'),
  ...((process.env.SWIFT_SETTINGS_FILE ?? process.env.AGENT_STUDIO_SETTINGS_FILE)
    ? { file: process.env.SWIFT_SETTINGS_FILE ?? process.env.AGENT_STUDIO_SETTINGS_FILE }
    : {}),
});
const HIDE_STARTUP_URLS =
  (process.env.SWIFT_HIDE_STARTUP_URLS ?? process.env.AGENT_STUDIO_HIDE_STARTUP_URLS) === '1';
const BASE_PATH = normalizeBasePath(
  (process.env.SWIFT_BASE_PATH ?? process.env.AGENT_STUDIO_BASE_PATH) || '',
);
const { AsyncLocalStorage } = require('node:async_hooks');
const { RootState } = require('./lib/root-state');
const rootRequests = new AsyncLocalStorage();
const rootStates = new Map();
// Native Pane input is global to Herdr, even when clients choose different roots.
const nativeOperations = new (require('./lib/conversation-store').ConversationStore)();
const nativeDiagnostics = new (require('./lib/native-diagnostics').NativeDiagnostics)({
  file:
    process.env.SWIFT_NATIVE_DIAGNOSTICS_FILE ||
    path.join(
      process.env.SWIFT_DATA_DIR || path.join(__dirname, '.local/state'),
      'native-control-diagnostics.jsonl',
    ),
});
const herdrSession = process.env.HERDR_SESSION || 'swift';
const storageScope = { session: process.env.HERDR_SOCKET_PATH || herdrSession };
function stateFor(data) {
  let state = rootStates.get(data.directory);
  if (!state) {
    state = new RootState(data, {
      ...storageScope,
      onChange: () => broadcastHerdrChanged(),
      onArchiveFailure: (facts) =>
        nativeDiagnostics.observe({
          ...facts,
          source: 'archive',
          binding: data.directory,
          code: 'ARCHIVE_WORKER_FAILED',
        }),
    });
    state.sessionMetadata.locate = (_provider, _sessionId, _cwd, _home, pane) =>
      archiveLocator.locate(pane);
    rootStates.set(data.directory, state);
  } else state.data = data;
  return state;
}
function currentRoot() {
  return rootRequests.getStore() || stateFor(rootSettings.data);
}
const herdr = new HerdrClient({ session: herdrSession, socketPath: process.env.HERDR_SOCKET_PATH });
const archiveLocator = new CodexArchiveLocator({ herdr, locate: locateTranscript });
const locatePaneTranscript = (pane) => archiveLocator.locate(pane);
async function readPaneGoal(sessionId, pane) {
  const context = await archiveLocator.context(pane);
  return readCodexGoal(sessionId, context ? { home: context.sqliteHome } : undefined);
}
const sessionStatic = new Map();
const herdrSessions = new (require('./lib/herdr-sessions').HerdrSessions)({
  herdr,
  root: () => rootSettings.directory,
  dataDirectory: () => rootSettings.data.path,
});
// 新建会话不等 Agent 就绪（那几秒是 Agent 自己的启动时间）。后台跑完再广播一次，
// 客户端据此把「正在启动」换成真实状态；失败时标签页已被关掉，它会从列表里消失。
herdr.onAgentStarted = (paneId, error) => {
  if (error) console.error(`[agent-start] ${paneId} 启动失败：${error.message}`);
  broadcastHerdrChanged();
};
const agentQuestions = new AgentQuestions({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  readLines: readDisplayLines,
  readQuestionState: async (pane) => {
    try {
      return (
        await readConversationPage(await paneTranscriptFile(pane), pane.agent.label, {
          windowless: true,
          controls: true,
        })
      ).questionState;
    } catch (error) {
      if (['ENOENT', 'TRANSCRIPT_NOT_FOUND'].includes(error.code))
        return { pending: null, receipts: [] };
      throw error;
    }
  },
  beforeAnswer: async (pane, prompt) => {
    await guardNativeInput(pane);
    return agentQuestions.verifyQuestionThread(pane, prompt, () => codexSide.assertMain(pane));
  },
  restoreMain: true,
  requireProcess: true,
  operate: (paneId, run) => nativeOperations.operate(paneId, run),
  receiptFile: path.join(
    __dirname,
    '.local/state',
    'question-receipts-' +
      crypto.createHash('sha256').update(herdr.socketPath).digest('hex').slice(0, 16) +
      '.json',
  ),
  isControllingPane: (paneId) => claudeControl.busy.has(paneId) || codexSettings.busy.has(paneId),
});

async function exactPane(paneId, { input = false } = {}) {
  if (typeof paneId !== 'string' || !paneId.trim())
    throw apiError(400, 'PANE_REQUIRED', '缺少 pane。');
  const [pane, inputProcess] = input
    ? await Promise.all([herdr.agentPane(paneId), herdr.readProcessInfo(paneId).catch(() => null)])
    : [(await herdr.dashboard()).panes.find((item) => item.paneId === paneId), null];
  if (!pane) throw apiError(404, 'PANE_NOT_FOUND', '找不到这个 pane。');
  // 进程身份（pid + 启动时刻）：会话还没有 id 时（刚建、没发过第一句话），靠它确认目标没换人。
  if (pane.agent) {
    try {
      const info = input ? inputProcess : await herdr.readProcessInfo(paneId);
      const processes = (info?.foreground_processes || []).filter((p) =>
        [p.name, path.basename(p.argv?.[0] || '')].some((name) =>
          /^(?:claude(?:\.exe)?|codex)$/.test(name || ''),
        ),
      );
      if (processes.length === 1) {
        const pid = processes[0].pid;
        const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        pane.runtimeId = `${pid}:${start}`;
      }
    } catch {
      /* Missing process evidence cannot grant a new-session binding. */
    }
  }
  if (
    !input &&
    pane.agent?.label === 'codex' &&
    pane.agent.status === 'unknown' &&
    pane.runtimeId &&
    pane.agent.session?.value
  ) {
    try {
      const screen = await herdr.readPane(paneId, {
        source: 'recent',
        lines: 40,
        ansi: true,
        exact: true,
      });
      return require('./lib/agent-readiness').applyNativeReadiness(pane, screen);
    } catch {
      /* Unknown or unreadable UI remains queued. */
    }
  }
  return pane;
}
async function paneTranscriptFile(pane) {
  const file = await locatePaneTranscript(pane);
  if (!file) throw apiError(404, 'TRANSCRIPT_NOT_FOUND', '没有找到这个会话的存档。');
  return file;
}
async function getAgentSettings(pane, deps) {
  return readAgentSettings(pane, {
    ...deps,
    readLines: readDisplayLines,
    readArchived: async (target) =>
      (
        await readConversationPage(await paneTranscriptFile(target), target.agent.label, {
          windowless: true,
          controls: true,
        })
      ).status,
  });
}
async function readDisplayLines(pane) {
  return (
    await readConversationPage(await paneTranscriptFile(pane), pane.agent?.label, {
      windowless: true,
      controls: true,
    })
  ).controlLines;
}
async function readPaneLines(pane) {
  return (await readTranscript(await paneTranscriptFile(pane), pane.agent?.label, ['lines'])).lines;
}
const { clearNativeComposer } = require('./lib/native-composer');
const prepareNativeComposer = (pane) =>
  clearNativeComposer({ pane, herdr, exactPane: (id) => exactPane(id, { input: true }) });
const { ClaudeControl } = require('./lib/claude-control');
const claudeControl = new ClaudeControl({
  herdr,
  exactPane,
  readLines: readPaneLines,
  catalog: () => readAgentCatalog('claude'),
  operate: (id, run) => nativeOperations.operate(id, run),
});
const { CodexSettings } = require('./lib/codex-settings');
const codexSettings = new CodexSettings({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  operate: (id, run) => nativeOperations.operate(id, run),
  beforeApply: async (pane) => {
    await guardNativeInput(pane);
    await agentQuestions.ensureMain(pane);
    await prepareNativeComposer(pane);
    await codexSide.assertMain(pane);
  },
});
const terminalRefresh = new (require('./lib/codex-terminal-refresh').CodexTerminalRefresh)({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
});
const codexSide = new (require('./lib/codex-side').CodexSide)({
  herdr,
  diagnostics: nativeDiagnostics,
  receiptFile: () => currentRoot().data.file('state/side-message-receipts.json'),
  exactPane: (id) => exactPane(id, { input: true }),
  operate: (id, run) => nativeOperations.operate(id, run),
  beforeOpen: async (pane) => {
    await guardNativeInput(pane);
    return agentQuestions.ensureMain(pane);
  },
  recoverUnknown: async (options) => {
    await terminalRefresh.refresh(options);
    const current = await exactPane(options.pane.paneId, { input: true });
    if (Conversation.binding(current) !== Conversation.binding(options.pane))
      throw apiError(409, 'SESSION_CHANGED', '目标会话已改变，请重新选择会话后发送。');
    const question = await agentQuestions.read(current);
    if (question && !question.collapsed)
      throw apiError(409, 'QUESTION_PENDING', '请先完成原生问题，再发送消息。');
  },
});
const commandInteraction = new (require('./lib/command-interaction').CommandInteraction)({
  herdr,
  exactPane,
  inputPane: (id) => exactPane(id, { input: true }),
  operate: (paneId, run) => nativeOperations.operate(paneId, run),
  beforeWrite: async (
    pane,
    { continuingStatusView, continuingCommandInput, clearingCommandInput } = {},
  ) => {
    await guardNativeInput(pane);
    // Only CommandInteraction supplies these continuation scopes after checking
    // its same-process client lease and the current owned native surface.
    // A queued settings change must not strand this lease's unsubmitted text.
    if (
      !clearingCommandInput &&
      (codexSettings.busy.has(pane.paneId) || claudeControl.busy.has(pane.paneId))
    )
      throw apiError(409, 'SETTINGS_BUSY', '原生设置正在确认，请稍后操作命令。');
    let composerCleared = false;
    if (continuingStatusView !== 'warnings' && !continuingCommandInput) {
      await agentQuestions.ensureMain(pane);
      composerCleared = await prepareNativeComposer(pane);
      await codexSide.assertMain(pane);
    }
    return { composerCleared };
  },
});
async function readRewindHistory(pane) {
  const file = await paneTranscriptFile(pane);
  const transcript = await readTranscript(file, pane.agent.label, ['lines', 'messages']);
  if ((await paneTranscriptFile(pane)) !== file)
    throw apiError(409, 'ARCHIVE_CHANGED', '原生存档片段正在切换，请稍后重读。');
  return rewindHistory(transcript.lines, transcript.messages, { branch: file });
}
const rewindGenerations = new Map();
const rewindNative = new RewindNative({ herdr, readHistory: readRewindHistory });
const messageRewind = new RewindInteraction({
  target: (body) => commandInteraction.target(body),
  readHistory: readRewindHistory,
  native: rewindNative,
  scope: () => currentRoot().data.path,
  beforeWrite: async (pane, { requestId } = {}) => {
    if (
      claudeControl.busy.has(pane.paneId) ||
      codexSettings.busy.has(pane.paneId) ||
      agentQuestions.busy.has(pane.paneId)
    )
      throw apiError(409, 'AGENT_NOT_READY', '原生设置或问题正在确认，请完成后再编辑历史消息。');
    const suffix = `:${pane.terminalId}:${pane.agent.session.value}`;
    if (
      [...commandInteraction.leases].some(
        ([key, lease]) =>
          key.endsWith(suffix) &&
          lease.active &&
          Date.now() - lease.touched < 120000 &&
          lease.processRuntimeId === pane.runtimeId,
      )
    )
      throw apiError(409, 'COMMAND_IN_USE', '原生命令正在操作，请先关闭后再编辑历史消息。');
    if (await agentQuestions.read(pane))
      throw apiError(409, 'QUESTION_PENDING', '请先完成原生问题，再编辑历史消息。');
    await prepareNativeComposer(pane);
    await codexSide.assertMain(pane, { recoverUnknown: true, requestId });
    // A recovered screen may reveal an existing question; preparation must
    // remain read-only until that question has been handled explicitly.
    if (await agentQuestions.read(pane))
      throw apiError(409, 'QUESTION_PENDING', '请先完成原生问题，再编辑历史消息。');
  },
});
async function guardNativeInput(pane) {
  getMessageQueue();
  await messageRewind.ensureAvailable(pane);
}
const nativeDraft = new (require('./lib/native-draft').NativeDraft)({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  operate: (id, run) => nativeOperations.operate(id, run),
  beforeWrite: guardNativeInput,
});
const { listCodexSkills } = require('./lib/codex-skills');
const goalActions = new (require('./lib/goal-actions').GoalActions)({
  commands: commandInteraction,
  onChange: broadcastHerdrChanged,
});
const sessionFork = new (require('./lib/session-fork').SessionFork)({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  data: () => currentRoot().data,
  native: new (require('./lib/codex-fork').CodexFork)({
    herdr,
    exactPane: (id) => exactPane(id, { input: true }),
    operate: (id, work) => nativeOperations.operate(id, work),
  }),
  onChange: broadcastHerdrChanged,
});
const sessionInterrupt = new (require('./lib/session-interrupt').SessionInterrupt)({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  readTurn: async (pane) =>
    (
      await readConversationPage(await paneTranscriptFile(pane), pane.agent.label, {
        windowless: true,
      })
    ).turnId,
  operate: (id, work) => nativeOperations.operate(id, work),
  beforeWrite: async (pane) => {
    await guardNativeInput(pane);
    if (claudeControl.busy.has(pane.paneId) || codexSettings.busy.has(pane.paneId))
      throw apiError(409, 'SETTINGS_BUSY', '原生设置正在确认，请稍后中断。');
    await codexSide.assertMain(pane);
  },
  onInterrupted: (pane) => {
    getMessageQueue().interrupted(pane);
    broadcastHerdrChanged();
  },
});
const spaceActions = new (require('./lib/space-actions').SpaceActions)({
  herdr,
  exactPane: (id) => exactPane(id, { input: true }),
  operate: (id, run) => nativeOperations.operate(id, run),
  restart: new (require('./lib/codex-restart').CodexRestart)({
    herdr,
    exactPane: (id) => exactPane(id, { input: true }),
  }),
  file: path.join(
    __dirname,
    '.local/state',
    'space-actions-' +
      crypto.createHash('sha256').update(herdr.socketPath).digest('hex').slice(0, 16) +
      '.json',
  ),
  beforeControl: async (pane) => {
    if (claudeControl.busy.has(pane.paneId) || codexSettings.busy.has(pane.paneId))
      throw apiError(409, 'AGENT_NOT_READY', '原生设置正在确认，请稍后操作。');
  },
  onChange: broadcastHerdrChanged,
});
function getMessageQueue() {
  const context = currentRoot();
  if (!context.messageQueue) {
    context.messageQueue = new MessageQueue({
      file: context.messageFile,
      store: context.messageStore,
      onChange: broadcastHerdrChanged,
      // 正在终端里切换设置时不投递：两边的按键会搅在一起。
      inputAvailable: (paneId) =>
        !claudeControl.busy.has(paneId) && !codexSettings.busy.has(paneId),
      getPane: exactPane,
      getNativePane: (paneId) => exactPane(paneId, { input: true }),
      captureNativeSubmission: (body) => ({ generation: rewindGenerations.get(body?.paneId) || 0 }),
      sendNative: (item, persist, submission) => {
        const generation = submission.generation;
        if (
          !item.rewind &&
          [...messageRewind.running.values()].some((job) => job.paneId === item.paneId)
        )
          return Promise.reject(
            Object.assign(apiError(409, 'REWIND_BUSY', '历史消息正在回退，本条消息未发送。'), {
              deliveryUncertain: false,
            }),
          );
        return nativeOperations.operate(item.paneId, async () => {
          let fresh;
          try {
            fresh = await exactPane(item.paneId, { input: true });
          } catch (error) {
            error.deliveryUncertain = false;
            throw error;
          }
          const expected = {
            paneId: item.paneId,
            terminalId: item.terminalId,
            runtimeId: item.runtimeId,
            agent: { label: item.agent, session: { value: item.sessionId } },
          };
          if (Conversation.binding(fresh) !== Conversation.binding(expected))
            throw Object.assign(apiError(409, 'SESSION_CHANGED', '目标会话已改变。'), {
              deliveryUncertain: false,
            });
          if (item.spaceWorkspaceId && fresh.workspaceId !== item.spaceWorkspaceId)
            throw Object.assign(
              apiError(409, 'SPACE_CHANGED', '会话已离开原 Space，未发送消息。'),
              { deliveryUncertain: false },
            );
          if (claudeControl.busy.has(item.paneId) || codexSettings.busy.has(item.paneId))
            throw Object.assign(
              apiError(409, 'AGENT_NOT_READY', '原生设置正在操作，请完成后重新发送。'),
              { deliveryUncertain: false },
            );
          await messageRewind.ensureAvailable(fresh);
          if (!item.rewind && generation !== (rewindGenerations.get(item.paneId) || 0))
            throw Object.assign(
              apiError(
                409,
                'REWIND_HISTORY_CHANGED',
                '等待期间会话已回退，本条消息未发送，请核对当前历史后重新发送。',
              ),
              { deliveryUncertain: false },
            );
          if (item.rewind)
            return messageRewind.submit(item, async (fields) => {
              await persist(fields);
              if (fields.rewindProgress?.phase === 'revert_pending')
                rewindGenerations.set(item.paneId, (rewindGenerations.get(item.paneId) || 0) + 1);
            });
          try {
            await agentQuestions.ensureMain(fresh);
          } catch (error) {
            error.deliveryUncertain = false;
            throw error;
          }
          try {
            await prepareNativeComposer(fresh);
            await codexSide.assertMain(fresh, { recoverUnknown: true, requestId: item.id });
          } catch (error) {
            error.deliveryUncertain = false;
            throw error;
          }
          return sendPaneMessage(fresh.paneId, item.text, { socketFile: herdr.socketPath });
        });
      },

      readMessages: async (pane) => {
        try {
          return (await readTranscript(await paneTranscriptFile(pane), pane.agent.label)).messages;
        } catch (error) {
          // A fresh session may not create its archive until the first user turn.
          if (error.code === 'TRANSCRIPT_NOT_FOUND' || error.code === 'ENOENT') return [];
          throw error;
        }
      },
      // Share the raw-record index and active IDs from one cached file version.
      readArchive: async (pane) =>
        (await readTranscript(await paneTranscriptFile(pane), pane.agent.label)).archive,
      // 两家同一条路：确认目标还是这个会话，再写进它的终端。
      send: (pane, text, batchId, submission) =>
        nativeOperations.operate(pane.paneId, async () => {
          if (submission.generation !== (rewindGenerations.get(pane.paneId) || 0))
            throw Object.assign(
              apiError(409, 'REWIND_HISTORY_CHANGED', '等待期间会话已回退，本条消息未发送。'),
              { deliveryUncertain: false, retryable: false },
            );
          const fresh = await exactPane(pane.paneId);
          if (
            Conversation.binding(fresh) !== Conversation.binding(pane) ||
            fresh.terminalId !== pane.terminalId ||
            fresh.agent?.session?.value !== pane.agent?.session?.value ||
            fresh.agent?.label !== pane.agent?.label
          )
            throw Object.assign(apiError(409, 'SESSION_CHANGED', '目标会话已改变。'), {
              deliveryUncertain: false,
            });
          await guardNativeInput(fresh);
          await agentQuestions.ensureMain(fresh);
          await prepareNativeComposer(fresh);
          await codexSide.assertMain(fresh);
          return sendPaneMessage(fresh.paneId, text, { socketFile: herdr.socketPath });
        }),
    });
    for (const item of context.messageQueue.items)
      if (item.rewindProgress) messageRewind.restore(item);
  }
  return context.messageQueue;
}

// Herdr and archive changes carry no detail, so clients refetch. Outbox
// changes name the panes that moved and the event sequence they committed at,
// which lets a client skip a refetch it does not need and detect gaps.
function broadcastHerdrChanged(detail) {
  syncHub()?.poke();
  const message =
    detail?.scope === 'outbox'
      ? { type: 'studio.changed', scope: 'outbox', seq: detail.seq, paneIds: detail.paneIds }
      : { type: 'studio.changed' };
  for (const ws of sockets) safeWsSend(ws, message);
}
function wakeMessageQueue() {
  try {
    const context = stateFor(rootSettings.data);
    rootRequests.run(context, () =>
      getMessageQueue()
        .tick()
        .catch((error) => console.error(`[message-queue] ${error.message}`)),
    );
  } catch (error) {
    console.error(`[message-queue] ${error.message}`);
  }
}

const { isAuthorized, requireAuth, readJson, sendError } = createHttp({
  tokens: [TOKEN, ANDROID_TOKEN],
  maxBodyBytes: MAX_BODY_BYTES,
  authorizeDirect: (req) => process.env.SWIFT_DIRECT_AUTH !== 'token' && authorizeDirect(req),
});
const connectionInfo = () =>
  require('./lib/server-info').serverInfo({
    port: server.address()?.port || PORT,
    host: HOST,
    basePath: BASE_PATH,
    token: TOKEN,
    rootDirectory: rootSettings.directory,
  });

function getLanBases() {
  const bases = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) bases.add(`http://${net.address}:${PORT}`);
    }
  }
  return [...bases];
}

async function handleApi(req, res, url) {
  if (!requireAuth(req, res, url)) return;
  if (url.pathname === '/api/info') return json(res, 200, connectionInfo());
  return rootRequests.run(stateFor(rootSettings.data), () => handleRootApi(req, res, url));
}
// The API surface is a routing table, not a chain of comparisons. Each route
// module owns one domain and receives its dependencies explicitly, so a new
// endpoint lands in a named file instead of growing this one.
const { Router } = require('./lib/http/router');
// Built on first request: the terminal transport publishes `sockets` and the
// controller state below this point, and a route table assembled at load time
// would capture them before they exist.
let apiRouter = null;
function getApiRouter() {
  if (apiRouter) return apiRouter;
  const routerContext = {
    herdr,
    herdrSessions,
    claudeControl,
    codexSettings,
    codexSide,
    commandInteraction,
    nativeDraft,
    goalActions,
    sessionFork,
    messageRewind,
    sessionInterrupt,
    listCodexSkills,
    agentQuestions,
    transcriptWatcher,
    spaceActions,
    currentRoot,
    rootStates,
    rootSettings,
    stateFor,
    sockets,
    safeWsSend,
    exactPane,
    readPaneLines,
    paneTranscriptFile,
    readPaneStatus,
    readTranscript,
    readConversationPage,
    getMessageQueue,
    broadcastHerdrChanged,
    wakeMessageQueue,
    guardNativeInput,
    operateNative: (paneId, run) => nativeOperations.operate(paneId, run),
    json,
    readJson,
    sendError,
    apiError,
    securityHeaders,
    Profile,
    Conversation,
    readAgentCatalog,
    readAgentCommands,
    getAgentSettings,
    validateSettings,
    parseTranscript,
    locatePaneTranscript,
    textOnly,
    describeTool,
    chatStatus,
    readCodexGoal: readPaneGoal,
    listDirectory,
    createDirectory,
    saveAttachment,
    readImage,
    readStartup,
    answerStartup,
    prepareWorkspace,
    interruptPane,
    scopeDashboard,
    withinRoot,
    deviceId,
    clampInt,
    publicControllerState,
    getLanBases,
    APP_NAME,
    BASE_PATH,
    getManagementStatus: () => ({ configured: false, state: 'disabled', connected: false }),
    identityRepair,
    nativeDiagnostics,
  };
  apiRouter = new Router({ json, sendError });
  for (const name of [
    'settings',
    'messages',
    'sessions',
    'agents',
    'transcript',
    'files',
    'workspace-files',
    'workspaces',
    'doc-files',
    'herdr-ui',
    'space-actions',
  ]) {
    require(`./lib/http/routes/${name}`).register(apiRouter, routerContext);
  }
  return apiRouter;
}

async function handleRootApi(req, res, url) {
  if (await getApiRouter().dispatch(req, res, url)) return;
  json(res, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在。' });
}

/**
 * 读某个 pane 终端底部的状态区(输入框、正在做什么、状态栏)。
 *
 * 读取当前底部缓冲区，不随原生终端的历史滚动视口变化；读失败就当作空 ——
 * 状态显示不出来是小事,不该让整个会话接口跟着失败。
 */
async function readPaneStatus(paneId) {
  try {
    const screen = await herdr.readPane(paneId, { lines: 40, ansi: true, exact: true });
    return readStatusArea(screen);
  } catch {
    return { composer: '', activity: '', statusline: [] };
  }
}

function staticHandler() {
  return serveStatic;
}
const serveStatic = require('./lib/http/static').createStaticHandler({
  directory: PUBLIC_DIR,
  basePath: BASE_PATH,
  token: TOKEN,
  getSettings: (req) => rootSettings.data.deviceSettings(deviceId(req), false),
});

async function readTranscript(file, agentKind, fields) {
  return currentRoot().conversations.read(file, agentKind, fields);
}
async function readConversationPage(file, agentKind, options, priority = 0) {
  return currentRoot().conversations.page(file, agentKind, options, priority);
}

const server = http.createServer(async (req, res) => {
  req.swiftPublicBase = BASE_PATH;
  res.acceptsGzip = /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?(?:\s|,|$))[0-9.]+)?\s*(?:,|$)/i.test(
    req.headers['accept-encoding'] || '',
  );
  const originalUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (BASE_PATH && (originalUrl.pathname === '/' || originalUrl.pathname === BASE_PATH)) {
    res.writeHead(
      302,
      securityHeaders({
        location: `${BASE_PATH}/${originalUrl.search || ''}`,
        'cache-control': 'no-store',
      }),
    );
    return res.end();
  }
  if (BASE_PATH && !originalUrl.pathname.startsWith(`${BASE_PATH}/`)) {
    return json(res, 404, { ok: false, code: 'NOT_FOUND', message: '路径不存在。' });
  }
  const url = new URL(originalUrl);
  if (BASE_PATH) url.pathname = originalUrl.pathname.slice(BASE_PATH.length) || '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(
      204,
      securityHeaders({
        'access-control-allow-origin': 'null',
        'access-control-allow-headers':
          'content-type,x-agent-studio-token,x-agent-studio-device-id,x-swift-token,x-swift-device-id',
        'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS',
      }),
    );
    return res.end();
  }
  try {
    const named = /^\/herdr-sessions\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})(\/.*)$/.exec(url.pathname);
    if (named) {
      if (!requireAuth(req, res, url)) return;
      const target = new URL(url);
      target.pathname = named[2];
      if (target.pathname.startsWith('/api/')) {
        const connection = await herdrSessions.connect(named[1]);
        return herdrSessions.proxy(connection, req, res, target);
      }
      const staticKey = `${req.swiftPublicBase}:${named[1]}`;
      if (!sessionStatic.has(staticKey))
        sessionStatic.set(
          staticKey,
          require('./lib/http/static').createStaticHandler({
            directory: PUBLIC_DIR,
            basePath: `${req.swiftPublicBase}/herdr-sessions/${named[1]}`,
            token: TOKEN,
            getSettings: () => ({}),
          }),
        );
      return sessionStatic.get(staticKey)(req, res, target);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return staticHandler(req)(req, res, url);
    json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
});

// Named Sessions reuse the existing relay framing; only the local namespace adapter differs.
const sessionWss = new (require('ws').WebSocketServer)({
  noServer: true,
  maxPayload: MAX_WS_INPUT_BYTES * 2,
});
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return;
  const relative = BASE_PATH ? url.pathname.slice(BASE_PATH.length) : url.pathname;
  const named = /^\/herdr-sessions\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})(\/api\/terminal)$/.exec(
    relative,
  );
  if (!named) return;
  req.studioUpgradeHandled = true;
  if (!isAuthorized(req, url)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  try {
    const connection = await herdrSessions.connect(named[1]);
    url.searchParams.delete('token');
    sessionWss.handleUpgrade(req, socket, head, (client) => {
      const WebSocket = require('ws');
      const remote = new WebSocket(`ws://127.0.0.1:${connection.port}/api/terminal${url.search}`, {
        headers: {
          'x-agent-studio-token': connection.token,
          'x-agent-studio-device-id': deviceId(req),
          'x-forwarded-for': req.socket.remoteAddress || 'unknown',
        },
      });
      connection.peers.add(client);
      connection.peers.add(remote);
      const pending = [];
      let bytes = 0;
      const forward = (target, data, binary) => {
        if (target.readyState === WebSocket.OPEN) {
          if (target.bufferedAmount + data.length > 1024 * 1024)
            target.close(4008, 'session relay stalled');
          else target.send(data, { binary });
        }
      };
      client.on('message', (data, binary) => {
        if (remote.readyState === WebSocket.CONNECTING) {
          bytes += data.length;
          if (bytes > MAX_WS_INPUT_BYTES) client.close(1009);
          else pending.push([data, binary]);
        } else forward(remote, data, binary);
      });
      remote.on('open', () => {
        for (const [data, binary] of pending) forward(remote, data, binary);
        pending.length = 0;
      });
      remote.on('message', (data, binary) => forward(client, data, binary));
      const end = () => {
        connection.peers.delete(client);
        connection.peers.delete(remote);
        if (client.readyState < WebSocket.CLOSING) client.close();
        if (remote.readyState === WebSocket.CONNECTING) remote.terminate();
        else if (remote.readyState === WebSocket.OPEN) remote.close();
      };
      client.on('close', end);
      remote.on('close', end);
      client.on('error', end);
      remote.on('error', end);
    });
  } catch {
    socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n');
  }
});

const terminalTransport = require('./lib/terminal-transport').createTerminalTransport({
  server,
  herdr,
  basePath: BASE_PATH,
  maxInputBytes: MAX_WS_INPUT_BYTES,
  isAuthorized,
  getCwd: () => currentRoot().data.directory,
  diagnostics: nativeDiagnostics,
  onSync: (ws, message) => {
    const hub = syncHub();
    if (message.type === 'sync.watch') {
      hub?.watch(ws, message.interest);
      return;
    }
    if (message.type !== 'sync.hello') return;
    hub
      ?.hello(ws, message)
      .catch((error) => console.error(`[sync] hello failed: ${error.message}`));
  },
});

/**
 * 本地优先同步的中心（lib/sync/hub.js，设计见 docs/LOCAL_FIRST.md）。每个根目录一个，
 * 只有当前根目录的那个推送；切换根目录后客户端会收到新的 epoch 并重新 hello。
 */
const { SyncHub } = require('./lib/sync/hub');
let activeSyncHub = null;
const { buildDashboard } = require('./lib/sync/dashboard');
const { sessionDocuments } = require('./lib/http/routes/doc-files');
function syncHub() {
  if (typeof sockets === 'undefined') return null;
  const state = stateFor(rootSettings.data);
  if (!state.sync) {
    const inRoot = (work) => rootRequests.run(state, work);
    state.sync = new SyncHub({
      progressive: true,
      dashboard: () =>
        inRoot(() =>
          buildDashboard({
            herdr,
            currentRoot,
            scopeDashboard,
            getMessageQueue,
            identityRepair,
            broadcastHerdrChanged,
          }),
        ),
      locate: (_provider, _sessionId, _cwd, pane) => locatePaneTranscript(pane),
      archiveSignature: (file, provider) => state.conversations.sourceSignature(file, provider),
      read: (file, provider, pane) => {
        if (require('./public/provider-capabilities').get(provider).archive !== 'sqlite') {
          return state.conversations.page(file, provider, { limit: 60 }, 10).then((page) => ({
            conversation: page.messages,
            revision: page.historyRevision,
            historyEpoch: page.historyEpoch,
            total: page.total,
            hasMore: page.hasMore,
            bounded: true,
          }));
        }
        const page = require('./lib/providers/native').readDatabase(pane, { limit: 60 });
        return (
          page && { conversation: page.messages, revision: page.revision, hasMore: page.hasMore }
        );
      },
      // 文件页的列表与归档列表也由推送保持最新（docs/LOCAL_FIRST.md 步骤 3）。
      files: (pane, file) =>
        inRoot(async () => {
          const dashboard = await herdr.dashboard();
          const workspace = (dashboard.workspaces || []).find(
            (item) => item.workspaceId === pane?.workspaceId,
          );
          const root = state.data.directory;
          const directory =
            workspace?.cwd && path.resolve(workspace.cwd) !== path.resolve(root)
              ? workspace.cwd
              : null;
          return sessionDocuments({
            sessionFiles: state.sessionFiles,
            transcript: { file, provider: pane?.agent?.label },
            cwd: pane?.baseCwd || pane?.cwd || root,
            workspace: directory,
            rootDirectory: root,
          });
        }),
      history: (dashboard) =>
        inRoot(async () => {
          const { sessions, nextOffset } = await state.history.list(dashboard.panes, {
            limit: 100,
            rootDirectory: state.data.directory,
          });
          return { sessions, nextOffset };
        }),
      watch: (file) => transcriptWatcher.watch(file),
      clients: () => sockets,
      send: safeWsSend,
      active: () => stateFor(rootSettings.data) === state,
      log: (message) => console.log(`[sync] ${message}`),
    });
  }
  // 根目录切换了：客户端手里是另一个根的副本与版本，让它们向当前的中心重新追平。
  if (activeSyncHub && activeSyncHub !== state.sync) {
    for (const ws of sockets) {
      ws.syncReady = false;
      safeWsSend(ws, { type: 'sync.reset' });
    }
    state.sync.poke();
  }
  activeSyncHub = state.sync;
  return state.sync;
}
const {
  clients: sockets,
  rawTerminals,
  send: safeWsSend,
  controllers: publicControllerState,
  environment: rawTerminalEnvironment,
} = terminalTransport;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  herdrSessions.close();
  sessionWss.close();

  transcriptWatcher.close();
  for (const state of rootStates.values()) {
    state.sync?.close();
    void state.conversations.close(); /* SQLite closes with the process, after in-flight queue operations. */
  }
  herdrEvents.stop();
  clearInterval(messageQueueTimer);
  terminalTransport.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (process.env.SWIFT_SESSION_CHILD === '1' && process.connected)
  process.on('disconnect', shutdown);

/**
 * 订阅 Herdr 的变更事件,推给所有在线的页面。
 *
 * 🔑 这条通道替代的是前端「4 秒轮一次」:agent 的状态跳变(开始干活、被挡住要审批、
 * 跑完了)恰恰最需要立刻看见,而轮询的延迟是整整一个间隔。
 *
 * 🔑 推的是**一个空信号**而不是数据:页面收到就自己去拉一次快照。理由是事件种类多、
 * 语义细,逐条打补丁迟早和真相漂移;重拉一次只要 9ms,便宜且永远对。
 *
 * ⚠️ 前端**不能**因此把兜底轮询删掉:Herdr 没起、socket 断开重连的那几秒都收不到事件。
 * 事件是让它变快,不是让它变成唯一依赖。
 */
// Herdr 丢掉的会话身份，按进程自己的恢复参数补报一次（lib/session-identity-repair.js）。
const sessionHook = new (require('./lib/codex-session-hook').CodexSessionHook)();
const identityRepair = new SessionIdentityRepair({
  herdr,
  locate: (provider, sessionId, cwd, pane) =>
    locatePaneTranscript({ ...pane, agent: { label: provider, session: { value: sessionId } } }),
  prepare: async (pane, info) => {
    const context = await archiveLocator.context(pane, info);
    if (context)
      for (const home of new Set([context.home, context.sqliteHome]))
        await sessionHook.ensure(home);
  },
  discovery: {
    discover: async (pane, screen) => {
      const context = await archiveLocator.context(pane);
      return new (require('./lib/codex-session-discovery').CodexSessionDiscovery)(
        context ? { home: context.sqliteHome, archiveHome: context.home } : {},
      ).discover(pane, screen);
    },
  },
  activeSession: new (require('./lib/codex-active-session').CodexActiveSession)({
    homes: archiveLocator.homes,
    readScreen: (pane) =>
      herdr.readPane(pane.paneId, { source: 'recent_unwrapped', lines: 160, ansi: true }),
  }),
  log: (message) => console.log(`[identity] ${message}`),
});

const herdrEvents = new HerdrEvents({
  listPaneIds: async () => {
    const dashboard = await herdr.dashboard();
    return (dashboard.panes || []).map((pane) => pane.paneId).filter(Boolean);
  },
  onChange: () => {
    wakeMessageQueue();
    broadcastHerdrChanged();
  },
  onLog: (message) => console.log(`[herdr-events] ${message}`),
});

let messageQueueTimer;
async function startService() {
  stateFor(rootSettings.data);
  wakeMessageQueue();
  messageQueueTimer = setInterval(wakeMessageQueue, 1000);
  messageQueueTimer.unref?.();
  herdrEvents.start();
  server.listen(PORT, HOST, () => {
    if (process.send && process.env.SWIFT_SESSION_CHILD === '1')
      process.send({ swiftSessionPort: server.address().port });
    console.log(`\n${APP_NAME} execution service is running.`);
    if (HIDE_STARTUP_URLS) {
      console.log(`Listening on ${HOST}:${PORT}. Startup URLs are hidden.`);
      return;
    }
    console.log(require('./lib/server-info').formatSummary(connectionInfo()));
  });
}
if (require.main === module)
  startService().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

server.on('close', () => {
  transcriptWatcher.close();
});

// `apiPaths` lets a test confirm the routing table still covers every endpoint,
// which a linear chain of comparisons could not report on.
module.exports = {
  server,
  herdr,
  codexSettings,
  getMessageQueue,
  rawTerminals,
  isAuthorized,
  normalizeBasePath,
  rawTerminalEnvironment,
  get apiPaths() {
    return getApiRouter().paths();
  },
};

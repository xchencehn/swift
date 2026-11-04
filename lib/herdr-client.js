'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { readStartup } = require('./agent-startup');
const { launchWithUpdates } = require('./agent-updates');
const { socketPath } = require('./herdr-events');

class HerdrError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HerdrError';
    this.code = options.code || 'HERDR_ERROR';
    this.stderr = options.stderr || '';
    this.exitCode = options.exitCode;
  }
}

function parseCliEnvelope(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new HerdrError('Herdr 没有返回数据。', { code: 'EMPTY_RESPONSE' });
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new HerdrError(`Herdr 返回了无效 JSON：${error.message}`, { code: 'INVALID_JSON' });
  }
  if (envelope.error) {
    throw new HerdrError(envelope.error.message || 'Herdr 请求失败。', {
      code: envelope.error.code || 'HERDR_API_ERROR',
    });
  }
  return envelope.result || envelope;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

class HerdrClient {
  constructor(options = {}) {
    this.bin = options.bin || process.env.HERDR_BIN || 'herdr';
    this.session = options.session ?? process.env.HERDR_SESSION ?? '';
    this.startingPanes = new Set();
    this.processInfoRequests = new Map();
    this.snapshotRequest = null;
    this.socketPath =
      options.socketPath ||
      (options.session !== undefined
        ? path.join(
            os.homedir(),
            '.config',
            'herdr',
            'sessions',
            this.session || 'default',
            'herdr.sock',
          )
        : socketPath());
    this.timeoutMs = Number(options.timeoutMs || process.env.HERDR_CLI_TIMEOUT_MS || 8000);
  }

  env(extra = {}) {
    const env = { ...process.env, ...extra };
    if (this.session) env.HERDR_SESSION = this.session;
    else delete env.HERDR_SESSION;
    return env;
  }

  run(args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: options.cwd || os.homedir(),
        env: this.env(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new HerdrError(`Herdr 命令 ${this.timeoutMs}ms 超时。`, { code: 'TIMEOUT' }));
      }, options.timeoutMs || this.timeoutMs);
      timeout.unref?.();

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result);
      };

      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) =>
        finish(new HerdrError(error.message, { code: error.code || 'SPAWN_FAILED' })),
      );
      child.on('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          return finish(
            new HerdrError(err || `Herdr 退出，状态码 ${code}`, {
              code: /not running|connect/i.test(err) ? 'SERVER_NOT_RUNNING' : 'COMMAND_FAILED',
              stderr: err,
              exitCode: code,
            }),
          );
        }
        finish(null, out);
      });
    });
  }

  async json(args, options = {}) {
    return parseCliEnvelope(await this.run(args, options));
  }

  async status() {
    try {
      const output = await this.run(['status']);
      const match = output.match(/server:\s*[\s\S]*?status:\s*([^\s]+)/i);
      return { running: match?.[1] === 'running', output };
    } catch (error) {
      return { running: false, error: error.message };
    }
  }

  /**
   * 直接走 Herdr 的 Unix socket 发一个请求（一个连接一个请求，服务端答完就关）。
   *
   * 读快照、读画面、读进程信息这几样每个页面请求都要调好几次。原来每次都起一个 herdr 子进程：
   * spawn 在 Node 里要同步 fork，服务进程内存越大越慢，实测每次卡住事件循环约 14ms，
   * 一次正文请求要调五六次（2026-09-24）。socket 上同样的请求不到 2ms。
   * 连不上 socket（没有这个文件、测试里指向临时目录）时退回 CLI，结果形状一样。
   */
  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(
        () =>
          finish(new HerdrError(`Herdr 请求 ${method} ${timeoutMs}ms 超时。`, { code: 'TIMEOUT' })),
        timeoutMs,
      );
      timer.unref?.();
      socket.setEncoding('utf8');
      // 发起连接时就写：Herdr 0.9.0 接受连接后若读不到请求会整整睡 100ms，越早写越少撞上
      // （~/workdir/herdr 的 agent-studio 分支已修，见 docs/RUNTIME_SOURCE.md）。
      socket.write(`${JSON.stringify({ id: `studio:${method}`, method, params })}\n`);
      socket.on('data', (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try {
          finish(null, parseCliEnvelope(buffer.slice(0, end)));
        } catch (error) {
          finish(error);
        }
      });
      socket.on('error', (error) =>
        finish(
          new HerdrError(error.message, {
            code: ['ENOENT', 'ECONNREFUSED'].includes(error.code)
              ? 'SOCKET_UNAVAILABLE'
              : 'SOCKET_FAILED',
          }),
        ),
      );
      socket.on('close', () =>
        finish(new HerdrError('Herdr 没有返回数据就关闭了连接。', { code: 'EMPTY_RESPONSE' })),
      );
    });
  }

  /** 先走 socket；socket 不可用时用等价的 CLI 命令。Herdr 自己报的错照原样抛出，不再重试。 */
  async query(method, params, cliArgs) {
    try {
      return await this.request(method, params);
    } catch (error) {
      if (!['SOCKET_UNAVAILABLE', 'SOCKET_FAILED', 'EMPTY_RESPONSE'].includes(error.code))
        throw error;
      return this.json(cliArgs);
    }
  }

  // 并发的调用共用同一次请求；不跨时间缓存，每一批都是新的。
  async snapshot() {
    if (!this.snapshotRequest) {
      this.snapshotRequest = this.query('session.snapshot', {}, ['api', 'snapshot']).finally(() => {
        this.snapshotRequest = null;
      });
    }
    const result = await this.snapshotRequest;
    return result.snapshot || result;
  }

  normalizeSnapshot(snapshot) {
    // The socket inode survives Swift restarts and changes when Herdr restarts.
    // Scope completion counters to that runtime, so reused sequence values cannot
    // inherit another server generation's seen records.
    let completionScope = '';
    try {
      const stat = fs.statSync(this.socketPath);
      completionScope = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch {
      /* Remote/fixture snapshots still bind to terminal and conversation. */
    }
    const workspaces = new Map(
      (snapshot.workspaces || []).map((item) => [item.workspace_id, item]),
    );
    const tabs = new Map((snapshot.tabs || []).map((item) => [item.tab_id, item]));
    const agentsByPane = new Map();
    for (const agent of snapshot.agents || []) {
      const paneId = agent.pane_id || agent.terminal?.pane_id;
      if (paneId) agentsByPane.set(paneId, agent);
    }
    const panes = (snapshot.panes || []).map((pane) => {
      const workspace = workspaces.get(pane.workspace_id) || {};
      const tab = tabs.get(pane.tab_id) || {};
      const agent = agentsByPane.get(pane.pane_id) || null;
      return {
        paneId: pane.pane_id,
        terminalId: pane.terminal_id,
        workspaceId: pane.workspace_id,
        workspace: workspace.label || pane.workspace_id,
        workspaceNumber: workspace.number || 0,
        tabId: pane.tab_id,
        tab: tab.label || pane.tab_id,
        tabNumber: tab.number || 0,
        cwd: pane.foreground_cwd || pane.cwd || '',
        baseCwd: pane.cwd || '',
        focused: Boolean(pane.focused),
        status: agent?.status || agent?.agent_status || pane.agent_status || 'unknown',
        agent: agent
          ? {
              name: agent.name || agent.display_name || agent.agent || '',
              label: agent.agent || agent.label || '',
              status: agent.status || agent.agent_status || pane.agent_status || 'unknown',
              message: agent.message || '',
              interactiveReady: agent.interactive_ready,
              launchPending: agent.launch_pending,
              ...(Object.hasOwn(agent, 'completion_seq')
                ? { completionSeq: agent.completion_seq, completionScope }
                : {}),
              ...(Object.hasOwn(agent, 'state_change_seq')
                ? { stateChangeSeq: agent.state_change_seq }
                : {}),
              session: agent.session_ref || agent.agent_session || null,
            }
          : null,
        tabTitle: tab.label || '',
        displayAgent: pane.display_agent || agent?.display_agent || '',
        agentTitle: pane.terminal_title_stripped || agent?.display_name || '',
        title: tab.label || pane.label || pane.terminal_title_stripped || '',
        scroll: pane.scroll || null,
        label: pane.label || '',
        restoreError: pane.restore_error || '',
        tokens: pane.tokens || agent?.tokens || {},
        stateLabels: pane.state_labels || agent?.state_labels || {},
      };
    });
    panes.sort(
      (a, b) =>
        a.workspaceNumber - b.workspaceNumber ||
        a.tabNumber - b.tabNumber ||
        a.paneId.localeCompare(b.paneId),
    );
    return {
      runtimeId: completionScope,
      version: snapshot.version || '',
      protocol: snapshot.protocol || 0,
      focusedPaneId: snapshot.focused_pane_id || '',
      focusedWorkspaceId: snapshot.focused_workspace_id || '',
      focusedTabId: snapshot.focused_tab_id || '',
      layouts: snapshot.layouts || [],
      panes,
      // 字段名与 panes 保持一致(workspaceId 而不是 workspace_id)。
      // 两边命名不统一已经坑过两次:拿原始名去查规范化后的数据,得到的是空集,
      // 而空集看着就像「没有」而不是「查错了」。
      workspaces: [...workspaces.values()].map((item) => ({
        workspaceId: item.workspace_id,
        label: item.label || item.workspace_id,
        // 可选启动目录，不能据标签或子 pane 目录推断。
        cwd: item.cwd || '',
        number: item.number || 0,
        tabCount: item.tab_count || 0,
        activeTabId: item.active_tab_id || '',
        status: item.agent_status || 'unknown',
        tokens: item.tokens || {},
        worktree: item.worktree || null,
        paneCount: item.pane_count || 0,
        focused: Boolean(item.focused),
      })),
      tabs: [...tabs.values()],
    };
  }

  /**
   * 规范化后的快照。会话身份全部来自 Herdr 自己的识别（`agent_session`），两家同一条路。
   *
   * ⚠️ 这里曾经为连着 codex app-server（`--remote`）的会话补身份：那种 TUI 的对话跑在
   * app-server 进程里，Herdr 盯着的终端进程看不到它，只能靠一张绑定表去猜。2026-09-23
   * 全面改走 PTY 后 Codex 都独立启动，Herdr 能自己认出会话，这张表连同它带来的「身份
   * 两份、互相对不上」一起拆掉了。
   */
  async dashboard() {
    return this.normalizeSnapshot(await this.snapshot());
  }

  // Input needs the current occupant, not every workspace and terminal.
  async agentPane(paneId) {
    const result = await this.query('agent.get', { target: paneId }, ['agent', 'get', paneId]);
    const agent = result.agent;
    if (!agent || agent.pane_id !== paneId)
      throw new HerdrError('找不到目标 Agent。', { code: 'TARGET_NOT_FOUND' });
    return this.normalizeSnapshot({ panes: [agent], agents: [agent] }).panes[0];
  }

  readProcessInfo(paneId) {
    // Coalesce concurrent reads only; do not cache evidence across process exits.
    if (!this.processInfoRequests.has(paneId)) {
      const request = this.query('pane.process_info', { pane_id: paneId }, [
        'pane',
        'process-info',
        '--pane',
        paneId,
      ])
        .then((result) => result.process_info)
        .finally(() => this.processInfoRequests.delete(paneId));
      this.processInfoRequests.set(paneId, request);
    }
    return this.processInfoRequests.get(paneId);
  }

  async resolveTarget(target) {
    const clean = String(target || '').trim();
    if (!clean) throw new HerdrError('缺少终端目标。', { code: 'TARGET_REQUIRED' });
    const dashboard = await this.dashboard();
    const pane = dashboard.panes.find(
      (item) => item.paneId === clean || item.terminalId === clean || item.agent?.name === clean,
    );
    if (!pane) throw new HerdrError('目标终端不存在或已经关闭。', { code: 'TARGET_NOT_FOUND' });
    return pane;
  }

  /**
   * Herdr 里「起一个 agent」是两步,不是一步:
   *
   *   herdr tab create --workspace <ws> --cwd <path>     开一个标签页(落在 shell 提示符上)
   *   herdr agent start <name> --kind <kind> --pane <id> 在那个标签页里把 agent 拉起来
   *
   * 这正是人在终端里的动作顺序:先开 tab、cd 过去,再敲 codex。
   *
   * ⚠️ `agent start` 没有 `--cwd` 这个选项 —— 目录是开 tab 时定的。
   * 之前这里拼的是 `agent start <name> --cwd <path> -- <bin>`,herdr 直接回
   * `unknown option: --cwd`,也就是说这个功能一直是坏的,只是从没被验证过。
   */
  async createTab({ workspaceId = '', cwd = '', label = '' } = {}) {
    const args = ['tab', 'create', '--no-focus'];
    if (workspaceId) args.push('--workspace', String(workspaceId));
    if (cwd) {
      const resolved = path.resolve(cwd);
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        stat = null;
      }
      if (!stat?.isDirectory()) throw new HerdrError('工作目录不存在。', { code: 'CWD_NOT_FOUND' });
      args.push('--cwd', resolved);
    }
    if (label) args.push('--label', String(label).trim().slice(0, 80));
    return this.json(args, { timeoutMs: 15000 });
  }

  /**
   * agent 的名字是个标识符,不是给人看的标题:herdr 要求小写字母开头、
   * 只含 `[a-z0-9_-]`、1-32 字符。会话名称与 Herdr 默认的数字标签页名称独立。
   */
  static agentName(kind, preferred = '') {
    const slug = String(preferred || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/, '')
      .slice(0, 32);
    return slug || `${kind}-${Date.now().toString(36)}`.slice(0, 32);
  }

  /** 在一个已经停在 shell 提示符上的标签页里拉起 agent。 */
  async startAgentInPane(target, kind, name = '') {
    const clean = String(kind || '').toLowerCase();
    // 只放行我们确实支持、也确实装了的两种;herdr 认得更多,但这里不替用户乱试。
    if (clean !== 'codex' && clean !== 'claude') {
      throw new HerdrError('只能起 codex 或 claude。', { code: 'KIND_NOT_ALLOWED' });
    }
    const pane = await this.resolveTarget(target);
    const agentName = HerdrClient.agentName(clean, name);
    const args = ['agent', 'start', agentName, '--kind', clean, '--pane', pane.paneId];
    if (pane.agent?.label || this.startingPanes.has(pane.paneId)) {
      throw new HerdrError('这个标签页已有 agent，不能重复启动。', { code: 'PANE_NOT_AVAILABLE' });
    }
    this.startingPanes.add(pane.paneId);
    try {
      return await launchWithUpdates(this, args, pane, clean);
    } catch (error) {
      if (
        clean === 'claude' &&
        (error.code === 'agent_not_ready' || /agent_not_ready/.test(error.stderr || error.message))
      ) {
        const current = await this.resolveTarget(pane.paneId);
        const startup = await readStartup(this, current);
        if (startup) return { paneId: pane.paneId, status: 'awaiting_confirmation', startup };
      }
      throw error;
    } finally {
      this.startingPanes.delete(pane.paneId);
    }
  }

  /**
   * 新建会话 = 开一个标签页,再在里面起 agent。
   *
   * ⚠️ **默认不等它就绪。** `herdr agent start` 会一直阻塞到 Agent 的 TUI 能接收输入,
   * 而那几秒是 Agent 自己的启动时间,不是我们的开销 —— 实测 codex 约 4.4 秒、
   * claude 约 3.9 秒,其中 Herdr 在就绪后 40 毫秒内就返回,并没有多等
   * (`node scripts/testing/new-session-latency.js`)。等着它返回再响应,界面就要僵住五秒。
   *
   * 开标签页只要 10 毫秒,所以标签页一建好就回,剩下的在后台跑完再广播一次变化。
   * 客户端看到的是一个还没有 agent 的 pane,界面据此显示「正在启动」。
   *
   * 失败的代价要说清楚:响应已经发出去了,所以失败只能事后收拾 —— 关掉标签页并广播,
   * 那个会话会从列表里消失。`wait: true` 保留同步语义,给需要当场知道结果的调用方。
   */
  async startAgent(options = {}) {
    const provider = String(options.provider || '').toLowerCase();
    if (!['codex', 'claude'].includes(provider))
      throw new HerdrError('只允许启动 Codex 或 Claude Code。', { code: 'PROVIDER_NOT_ALLOWED' });
    // 旧启动接口的 name 只作为新建 Tab 的标签，不覆盖原生会话标题。
    // (docs/PRODUCT_SPEC.md 2.5)。不填就留 Herdr 的默认编号,等内容够了自动命名。
    // 刚建出来的工作区自带一格 shell:直接用它,别再开一格把它剩在那儿没人管。
    let paneId = options.rootPaneId || '';
    if (paneId) {
      if (options.name) await this.renameTab(paneId, options.name).catch(() => {});
    } else {
      const created = await this.createTab({
        workspaceId: options.workspaceId,
        cwd: options.cwd,
        label: options.name,
      });
      paneId = created?.root_pane?.pane_id || created?.pane?.pane_id || created?.pane_id;
    }
    if (!paneId) throw new HerdrError('未能取得新会话的 pane id。', { code: 'PANE_ID_MISSING' });
    const launch = this.startAgentInPane(paneId, provider, options.name);
    if (options.wait) {
      try {
        return { ...(await launch), paneId };
      } catch (error) {
        await this.closeSession(paneId).catch(() => {});
        throw error;
      }
    }
    launch.then(
      () => this.onAgentStarted?.(paneId, null),
      async (error) => {
        await this.closeSession(paneId).catch(() => {});
        this.onAgentStarted?.(paneId, error);
      },
    );
    return { paneId, provider, status: 'starting' };
  }

  async resumeAgent(entry, workspaceId, existingPaneId = null) {
    const created = existingPaneId
      ? { root_pane: { pane_id: existingPaneId } }
      : await this.createTab({ workspaceId, cwd: entry.cwd });
    const paneId = created?.root_pane?.pane_id || created?.pane?.pane_id || created?.pane_id;
    if (!paneId) throw new HerdrError('未能取得恢复会话的 pane id。', { code: 'PANE_ID_MISSING' });
    try {
      const pane = await this.resolveTarget(paneId);
      if (pane.agent) throw new HerdrError('恢复目标已被占用。', { code: 'PANE_NOT_AVAILABLE' });
      const agentName = HerdrClient.agentName(entry.provider);
      const args = ['agent', 'start', agentName, '--kind', entry.provider, '--pane', paneId, '--'];
      // 两家都在终端里原生恢复：Codex 是 `resume <id>`，Claude 是 `--resume <id>`。标签页已经建在
      // 原目录里，不必再给目录。
      // ⚠️ Codex 的参数必须**恰好**是 `resume <id>` 两项：Herdr 只认这个规范形式，据此知道这个
      // pane 是哪个会话（运行时源码 src/agent_resume.rs 的 persisted_session_from_launch_args）。
      // 多带一个 `--cd` 它就不认，要等 Codex 下一次写存档才有身份，这之间网页读不到历史。
      if (entry.provider === 'codex') args.push('resume', entry.sessionId);
      else args.push('--resume', entry.sessionId);
      let result;
      try {
        result = await launchWithUpdates(this, args, pane, entry.provider);
      } catch (error) {
        const current = await this.resolveTarget(paneId);
        const startup = entry.provider === 'claude' && (await readStartup(this, current));
        if (!startup) throw error;
        result = { status: 'awaiting_confirmation', startup };
      }
      return { ...result, paneId, sessionId: entry.sessionId };
    } catch (error) {
      await this.closeSession(paneId).catch(() => {});
      throw error;
    }
  }

  async closeSession(target, expected = {}) {
    const pane = await this.resolveTarget(target);
    if (
      (expected.sessionId && pane.agent?.session?.value !== expected.sessionId) ||
      (expected.terminalId && pane.terminalId !== expected.terminalId)
    )
      throw new HerdrError('会话已经改变，请刷新后重试。', { code: 'SESSION_CHANGED' });
    const dashboard = await this.dashboard();
    const current = dashboard.panes.find((p) => p.paneId === pane.paneId);
    if (
      !current ||
      current.terminalId !== pane.terminalId ||
      current.agent?.session?.value !== pane.agent?.session?.value
    )
      throw new HerdrError('会话已经改变，请刷新后重试。', { code: 'SESSION_CHANGED' });
    // A split tab can contain other sessions: close only the selected pane there.
    const siblings = dashboard.panes.filter((p) => p.tabId === pane.tabId);
    const result =
      pane.tabId && siblings.length === 1
        ? await this.json(['tab', 'close', pane.tabId])
        : await this.json(['pane', 'close', pane.paneId]);
    return result;
  }

  async closePane(target) {
    const pane = await this.resolveTarget(target);
    return this.json(['pane', 'close', pane.paneId]);
  }

  /** 工作区的增删改。herdr 的 workspace 子命令直接对应,不必自己拼层次。 */
  async createWorkspace({ label = '', cwd = '' } = {}) {
    const args = ['workspace', 'create'];
    if (cwd) args.push('--cwd', cwd);
    if (label) args.push('--label', label);
    return this.json(args);
  }

  /** 兼容旧客户端：只复用唯一且明确报告 cwd 的工作区；标签不构成目录证据。 */
  async workspaceForDirectory(cwd, dashboard = null) {
    const resolved = path.resolve(String(cwd || ''));
    const label = path.basename(resolved);
    if (!label) throw new HerdrError('无法从目录推出工作区名称。', { code: 'BAD_REQUEST' });
    const view = dashboard || (await this.dashboard());
    // 同目录允许多个工作区，不能擅自挑选。
    const workspaces = view.workspaces || [];
    const matches = workspaces.filter((item) => item.cwd && path.resolve(item.cwd) === resolved);
    if (matches.length > 1)
      throw new HerdrError('多个工作区使用这个目录，请明确指定 workspaceId。', {
        code: 'WORKSPACE_AMBIGUOUS',
      });
    const found = matches[0];
    if (found) return { workspaceId: found.workspaceId, rootPaneId: null };
    const created = await this.createWorkspace({ label, cwd: resolved });
    const workspaceId = created?.workspace?.workspace_id;
    if (!workspaceId) throw new HerdrError('未能取得工作区 id。', { code: 'WORKSPACE_ID_MISSING' });
    return { workspaceId, rootPaneId: created?.root_pane?.pane_id || null };
  }

  async renameWorkspace(workspaceId, label) {
    if (!workspaceId || !label)
      throw new HerdrError('缺少工作区或新名称。', { code: 'BAD_REQUEST' });
    return this.json(['workspace', 'rename', String(workspaceId), String(label)]);
  }

  async closeWorkspace(workspaceId) {
    if (!workspaceId) throw new HerdrError('缺少工作区。', { code: 'BAD_REQUEST' });
    return this.json(['workspace', 'close', String(workspaceId)]);
  }

  /**
   * 把一个 pane 移到别的工作区。herdr 的层次是 workspace → tab → pane,
   * 所以「移到别的工作区」= 在目标工作区里**新开一个标签页**把它装进去。
   *
   * ⚠️ `--workspace` **必须和 `--new-tab` 一起给**,单独给会被 herdr 直接拒掉
   * (`usage: herdr pane move <pane_id> --new-tab [--workspace ID] ...`)。
   * 这里原来只拼了 `--workspace`,也就是说 `/api/panes/move` 从来就没成功过 ——
   * 和当年 `agent start --cwd` 一样,是个没被端到端跑过的写操作。
   *
   * ⚠️ 带 `--no-focus`:移动不该把用户的终端视角拽到别的工作区去。实测移动**不会**
   * 打断 pane 里正在跑的进程。
   *
   * 新建目标 Tab 时保留原布局标签。标签属于布局，不覆盖 Pane 的会话标题。
   */
  async movePane(target, workspaceId) {
    const pane = await this.resolveTarget(target);
    if (!workspaceId) throw new HerdrError('缺少目标工作区。', { code: 'BAD_REQUEST' });
    const args = [
      'pane',
      'move',
      pane.paneId,
      '--new-tab',
      '--workspace',
      String(workspaceId),
      '--no-focus',
    ];
    const label = String(pane.tabTitle ?? pane.tab ?? '').trim();
    if (label) args.push('--label', label.slice(0, 80));
    return this.json(args);
  }

  /** 兼容显式定位准确 Pane；聊天查看使用带身份核验的 herdr-view。 */
  async focusPane(target) {
    const pane = await this.resolveTarget(target);
    // CLI 的 pane focus 是方向导航；socket pane.focus 才是按 ID 定位。
    await this.request('pane.focus', { pane_id: pane.paneId });
    return { paneId: pane.paneId, tabId: pane.tabId, label: pane.tab };
  }

  /**
   * 读一个 pane 的终端画面。默认取当前可见区域 —— 输入框在最底下,
   * 要的是此刻的样子而不是历史输出。
   */
  // 默认读缓冲区末尾（recent），不读视口（visible）：visible 跟着 Herdr 里的滚动走，
  // 有人在终端里往上翻过，读到的就是翻到的那一屏，输入框、状态栏、菜单全读错。
  async readPane(target, { source = 'recent', lines = 40, ansi = false, exact = false } = {}) {
    const pane = exact ? { paneId: target } : await this.resolveTarget(target);
    // 状态栏在终端里是有颜色的,那些颜色本身是信息(强度、占用、告警),要照着画就得带上。
    const params = {
      pane_id: pane.paneId,
      source: String(source),
      lines: Number(lines),
      format: ansi ? 'ansi' : 'text',
    };
    try {
      return (await this.request('pane.read', params)).read.text;
    } catch (error) {
      if (!['SOCKET_UNAVAILABLE', 'SOCKET_FAILED', 'EMPTY_RESPONSE'].includes(error.code))
        throw error;
    }
    const args = [
      'pane',
      'read',
      pane.paneId,
      '--source',
      String(source),
      '--lines',
      String(lines),
    ];
    if (ansi) args.push('--format', 'ansi');
    // 用 run 不用 json:`pane read` 吐的是终端画面本身,不是 JSON 信封。
    return this.run(args);
  }

  async renameTab(target, label) {
    const pane = await this.resolveTarget(target);
    const clean = String(label || '')
      .trim()
      .slice(0, 80);
    if (!clean) throw new HerdrError('名称不能为空。', { code: 'NAME_REQUIRED' });
    if (!pane.tabId) throw new HerdrError('找不到标签页。', { code: 'TAB_REQUIRED' });
    return this.json(['tab', 'rename', pane.tabId, clean]);
  }

  async renameAgent(target, name) {
    const pane = await this.resolveTarget(target);
    const clean = String(name || '')
      .trim()
      .slice(0, 80);
    if (!clean) throw new HerdrError('名称不能为空。', { code: 'NAME_REQUIRED' });
    return this.json(['agent', 'rename', pane.paneId, clean]);
  }

  async tabs() {
    const result = await this.json(['tab', 'list']);
    return (result.tabs || [])
      .map((tab) => ({
        tabId: tab.tab_id,
        workspaceId: tab.workspace_id,
        label: tab.label || tab.tab_id,
        number: tab.number || 0,
        focused: Boolean(tab.focused),
        agentStatus: tab.agent_status || 'unknown',
      }))
      .sort((a, b) => a.number - b.number || a.tabId.localeCompare(b.tabId));
  }

  async cycleTab(direction = 'next') {
    const step = direction === 'prev' ? -1 : 1;
    const tabs = await this.tabs();
    if (!tabs.length) throw new HerdrError('当前没有标签页。', { code: 'NO_TABS' });
    if (tabs.length === 1) return tabs[0];
    const current = tabs.findIndex((tab) => tab.focused);
    const target = tabs[current < 0 ? 0 : (current + step + tabs.length) % tabs.length];
    const result = await this.json(['tab', 'focus', target.tabId]);
    return { ...target, focused: true, label: result.tab?.label || target.label };
  }
}

module.exports = {
  HerdrClient,
  HerdrError,
  clampInt,
  parseCliEnvelope,
};

'use strict';

// 补报 Herdr 丢掉的会话身份。
//
// 会话身份只有一个来源：Herdr（AGENTS.md）。Codex/Claude 恢复会话时，由它们的 SessionStart
// 钩子把会话 id 报给 Herdr（`pane.report_agent_session`）。但 Herdr 只接受「已经认出这个 pane
// 里是 Codex/Claude 进程」之后到达的上报（运行时源码 src/terminal/state.rs 的 process_present）。
// 用 `herdr pane run` 敲命令重启时进程要过一会儿才被认出，上报先到就被丢了：pane 上有 Agent、
// 却没有会话身份，网页按身份找存档，于是显示成一个空会话，直到下一次有动静才补上
//（2026-09-23 用户指出，另一个会话重启了这个会话之后就这样）。
//
// 会话 id 优先取自进程自己的恢复参数。普通启动的 Codex 没有恢复参数时，核对原生
// 会话名称、存档元数据与当前终端内容，且在上报前再次检查进程与终端。名称或目录
// 只能筛选候选，多个内容匹配的候选不自动绑定。确认后的身份仍由 Herdr 保存。

const { herdrRequest } = require('./herdr-input');
const fs = require('node:fs/promises');
const path = require('node:path');
const { matchEvidence } = require('./codex-session-discovery');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATTERNS = {
  codex: new RegExp(
    `(?:^|\\s)(?:\\S*/)?codex(?:\\.js)?\\s+(?:.*\\s)?resume\\s+(${UUID})(?:\\s|$)`,
    'i',
  ),
  claude: new RegExp(
    `(?:^|\\s)(?:\\S*/)?claude(?:\\.js)?\\s+(?:.*\\s)?--resume[=\\s]+(${UUID})(?:\\s|$)`,
    'i',
  ),
};

// Herdr already supplies argument boundaries. Codex accepts options after the
// resume subcommand, so joining argv and expecting its UUID immediately after
// "resume" loses valid launches such as resume --no-daemon -m model -c ... ID.
const CODEX_FLAGS = new Set([
  '--no-daemon',
  '--no-alt-screen',
  '--search',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--oss',
  '--all',
]);
const CODEX_VALUES = new Set([
  '--model',
  '-m',
  '--config',
  '-c',
  '--cd',
  '-C',
  '--profile',
  '-p',
  '--sandbox',
  '-s',
  '--ask-for-approval',
  '-a',
  '--enable',
  '--disable',
  '--image',
  '-i',
  '--local-provider',
]);
function codexResumeId(argv) {
  const executable = argv.findIndex((value) =>
    /^(?:codex(?:\.exe)?|codex\.js)$/.test(path.basename(value)),
  );
  if (executable < 0) return null;
  let resumed = false,
    sessionId = null;
  for (let at = executable + 1; at < argv.length; at++) {
    const value = argv[at],
      equal = value.indexOf('='),
      option = equal < 0 ? value : value.slice(0, equal);
    // These modes do not prove the UUID of the running conversation.
    if (['--last', '--fork'].includes(option)) return null;
    if (CODEX_FLAGS.has(value)) continue;
    if (CODEX_VALUES.has(option)) {
      if (equal < 0 && ++at >= argv.length) return null;
      continue;
    }
    if (value === '--' && resumed) {
      const id = argv[at + 1];
      return sessionId || (new RegExp(`^${UUID}$`, 'i').test(id || '') ? id.toLowerCase() : null);
    }
    if (value.startsWith('-')) return null;
    if (!resumed) {
      if (value !== 'resume') return null;
      resumed = true;
    } else if (!sessionId) {
      if (!new RegExp(`^${UUID}$`, 'i').test(value)) return null;
      sessionId = value.toLowerCase();
    }
  }
  return sessionId;
}

/** 从进程参数里取出被恢复的会话 id；认不出就返回 null。 */
function resumedSessionId(provider, argvs) {
  const pattern = PATTERNS[provider];
  if (!pattern) return null;
  for (const argv of argvs) {
    if (provider === 'codex' && Array.isArray(argv)) {
      const id = codexResumeId(argv);
      if (id) return id;
      continue;
    }
    const match = pattern.exec(Array.isArray(argv) ? argv.join(' ') : String(argv || ''));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

class SessionIdentityRepair {
  constructor({
    herdr,
    locate,
    discovery = null,
    activeSession = null,
    prepare = null,
    readFile = fs.readFile,
    request = herdrRequest,
    now = Date.now,
    retryMs = 20000,
    log = () => {},
  }) {
    Object.assign(this, {
      herdr,
      locate,
      discovery,
      activeSession,
      prepare,
      readFile,
      request,
      now,
      retryMs,
      log,
    });
    this.attempts = new Map();
    this.inflight = new Map();
  }

  /** 快照里有 Agent 却没有会话身份的 pane，逐个试一次（同一个 pane 至少间隔 retryMs）。 */
  check(panes = []) {
    const tasks = [];
    for (const pane of panes) {
      const provider = pane.agent?.label;
      if (
        !PATTERNS[provider] ||
        (pane.agent?.session?.value && !(provider === 'codex' && this.activeSession)) ||
        this.inflight.has(pane.paneId)
      )
        continue;
      const last = this.attempts.get(pane.paneId);
      if (last !== undefined && this.now() - last < this.retryMs) continue;
      this.attempts.set(pane.paneId, this.now());
      if (this.attempts.size > 512) this.attempts.delete(this.attempts.keys().next().value);
      const task = this.repair(pane, provider)
        .catch((error) => this.log(`${pane.paneId}: ${error.message}`))
        .finally(() => this.inflight.delete(pane.paneId));
      this.inflight.set(pane.paneId, task);
      tasks.push(task);
    }
    return Promise.all(tasks);
  }

  async repair(pane, provider) {
    const info = await this.herdr.readProcessInfo(pane.paneId);
    if (provider === 'codex') await this.prepare?.(pane, info);
    if (provider === 'codex' && this.activeSession) {
      const active = await this.activeSession.read(pane, info);
      if (active) {
        if (active.sessionId === pane.agent?.session?.value) return false;
        const fresh = (await this.herdr.dashboard()).panes.find(
          (item) => item.paneId === pane.paneId,
        );
        if (
          !fresh ||
          fresh.terminalId !== pane.terminalId ||
          fresh.agent?.label !== provider ||
          fresh.agent.session?.value !== pane.agent?.session?.value ||
          (fresh.baseCwd || fresh.cwd) !== (pane.baseCwd || pane.cwd)
        )
          return false;
        const confirmed = await this.activeSession.read(
          fresh,
          await this.herdr.readProcessInfo(pane.paneId),
        );
        if (
          !confirmed ||
          confirmed.runtime !== active.runtime ||
          confirmed.sessionId !== active.sessionId ||
          confirmed.file !== active.file
        )
          return false;
        await this.report(pane, provider, active.sessionId, 'active-archive');
        return true;
      }
      // A shared app-server owns the writers instead of the foreground TUI.
      // Its inherited hook environment can also have reported another TUI's
      // identity. Only fresh, unique screen/archive proof can replace that
      // binding; launch arguments and titles alone still cannot do so.
      if (pane.agent?.session?.value && !this.discovery) return false;
    }
    const previousSession = pane.agent?.session?.value;
    const argvs = (info?.foreground_processes || []).map((process) => process.argv || []);
    let sessionId = previousSession ? null : resumedSessionId(provider, argvs),
      source = 'resume';
    if (!sessionId && provider === 'codex' && this.discovery) {
      const runtime = await this.runtime(info);
      if (!runtime) return false;
      const screen = await this.herdr.readPane(pane.paneId, {
        source: 'recent_unwrapped',
        lines: 160,
        ansi: true,
      });
      const candidate = await this.discovery.discover(pane, screen);
      if (!candidate) return false;
      if (candidate.sessionId === previousSession) return false;
      const fresh = (await this.herdr.dashboard()).panes.find(
        (item) => item.paneId === pane.paneId,
      );
      if (
        !fresh ||
        fresh.terminalId !== pane.terminalId ||
        fresh.agent?.label !== provider ||
        fresh.agent.session?.value !== previousSession ||
        fresh.agentTitle !== pane.agentTitle ||
        (fresh.baseCwd || fresh.cwd) !== (pane.baseCwd || pane.cwd)
      )
        return false;
      const confirmation = await this.herdr.readPane(pane.paneId, {
        source: 'recent_unwrapped',
        lines: 160,
        ansi: true,
      });
      if (
        !matchEvidence(candidate.texts, confirmation) ||
        (await this.runtime(await this.herdr.readProcessInfo(pane.paneId))) !== runtime
      )
        return false;
      sessionId = candidate.sessionId;
      source = previousSession ? 'verified-archive' : 'native-archive';
    }
    if (!sessionId) return false;
    // 存档要确实在：参数写错了、或会话已被清理，就不报一个找不到内容的身份。
    const file = await Promise.resolve()
      .then(() => this.locate(provider, sessionId, pane.baseCwd || pane.cwd, pane))
      .catch(() => null);
    if (!file) return false;
    await this.report(pane, provider, sessionId, source);
    return true;
  }

  async report(pane, provider, sessionId, source) {
    await this.request(
      'pane.report_agent_session',
      {
        pane_id: pane.paneId,
        source: `herdr:${provider}`,
        agent: provider,
        // Herdr requires a recognized SessionStart source to replace an existing
        // identity. Re-associate the verified live session, not its launch ID.
        seq: this.now() * 1e6,
        agent_session_id: sessionId,
        ...(['resume', 'active-archive', 'verified-archive'].includes(source)
          ? { session_start_source: 'resume' }
          : {}),
      },
      { timeoutMs: 3000, socketFile: this.herdr.socketPath },
    );
    this.log(`${pane.paneId}: 补报会话身份 ${sessionId} (${source})`);
  }

  async runtime(info) {
    const processes = (info?.foreground_processes || []).filter(
      (process) => process.name === 'codex' && Number.isSafeInteger(process.pid) && process.pid > 0,
    );
    if (processes.length !== 1) return null;
    try {
      const process = processes[0],
        stat = await this.readFile(`/proc/${process.pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return /^\d+$/.test(start || '') ? `${process.pid}:${start}` : null;
    } catch {
      return null;
    }
  }
}

module.exports = { SessionIdentityRepair, resumedSessionId };

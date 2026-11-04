'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { apiError } = require('./message-queue');
const { herdrRequest } = require('./herdr-input');
const { readCodexGoalRecord } = require('./agent-goal');
const { codexGoalDialog } = require('./questions/codex');
const { readStatusArea } = require('./agent-composer');
const { stripAnsi } = require('../public/ansi');
const { managedCodexBinary } = require('./codex-runtime');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text) => "'" + String(text).replace(/'/g, "'\\''") + "'";
const fail = (message) => apiError(409, 'RESTART_UNCONFIRMED', message);

// Preserve launch options without replaying an initial prompt, --last, or fork.
// Unknown launch modes fail before touching the old process.
function resumeArgs(argv, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /[\x00-\x1f]/.test(sessionId))
    throw fail('原会话 ID 无效，未退出 Codex。');
  const values = new Set([
    '-c',
    '--config',
    '-m',
    '--model',
    '-p',
    '--profile',
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '--enable',
    '--disable',
    '--add-dir',
    '--local-provider',
  ]);
  const flags = new Set([
    '--no-alt-screen',
    '--no-daemon',
    '--oss',
    '--full-auto',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable-underthinking-mode',
  ]);
  const kept = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'resume') {
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    if (['--last', '--all'].includes(arg)) continue;
    if (arg === '-C' || arg === '--cd' || arg === '-i' || arg === '--image') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) continue; // Original user prompt is never replayed.
    const [key] = arg.split('=');
    if (flags.has(key)) {
      kept.push(arg);
      continue;
    }
    if (!values.has(key)) throw fail('启动参数无法安全恢复，请在该会话的终端中手动重启。');
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value))
      throw fail('启动参数无效，原会话未退出。');
    // Never place credentials in a shell command or in an operation receipt.
    if (
      ['-c', '--config'].includes(key) &&
      /(?:api[_-]?key|token|password|secret|credential|http_headers)\s*(?:\.|=)/i.test(value)
    )
      throw fail('会话使用了私有启动参数，请在原终端中手动恢复。');
    kept.push(key, value);
  }
  return [...kept, 'resume', sessionId];
}

async function processStart(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return `${pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
}

async function captureLaunch(herdr, pane, { binaryOverride } = {}) {
  const info = await herdr.readProcessInfo(pane.paneId);
  const pid = Number(pane.runtimeId?.split(':')[0]);
  if (
    !pid ||
    !info?.foreground_processes?.some((p) => p.pid === pid) ||
    (await processStart(pid)) !== pane.runtimeId
  )
    throw fail('无法核对 Codex 进程身份，原会话未退出。');
  const [binary, cwd, command, environment] = await Promise.all([
    fs.readlink(`/proc/${pid}/exe`),
    fs.readlink(`/proc/${pid}/cwd`),
    fs.readFile(`/proc/${pid}/cmdline`),
    fs.readFile(`/proc/${pid}/environ`),
  ]);
  // Only path-valued environment entries are retained, never credentials.
  const allowed = new Set([
    'HOME',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
  ]);
  const env = {};
  for (const entry of environment.toString().split('\0')) {
    const at = entry.indexOf('='),
      key = entry.slice(0, at),
      value = entry.slice(at + 1);
    if (allowed.has(key)) {
      if (!path.isAbsolute(value) || /[\x00-\x1f]/.test(value))
        throw fail('会话目录配置无法恢复。');
      env[key] = value;
    }
  }
  environment.fill(0);
  const originalBinary = binaryOverride ? binary.replace(/ \(deleted\)$/, '') : binary;
  if (
    !env.HOME ||
    path.basename(originalBinary) !== 'codex' ||
    /[\x00-\x1f]/.test(binary + cwd) ||
    (binaryOverride && (!path.isAbsolute(binaryOverride) || /[\x00-\x1f]/.test(binaryOverride)))
  )
    throw fail('当前 Codex 启动方式不支持原位恢复，原会话未退出。');
  const args = resumeArgs(command.toString().split('\0').filter(Boolean), pane.agent.session.value);
  const goalHome = env.CODEX_SQLITE_HOME || env.CODEX_HOME || path.join(env.HOME, '.codex');
  return {
    binary: binaryOverride || binary,
    cwd,
    env,
    args,
    shellPid: info.shell_pid,
    shellRuntimeId: await processStart(info.shell_pid),
    goalHome,
  };
}

class CodexRestart {
  constructor({ herdr, exactPane, settleMs = 150 }) {
    Object.assign(this, { herdr, exactPane, settleMs });
  }
  async restart(original, { validate, progress }) {
    const id = original.paneId,
      sessionId = original.agent?.session?.value;
    if (!sessionId || !original.runtimeId)
      throw fail('这个 Codex 尚未建立可恢复的会话，请先完成一次输入。');
    const launch = await captureLaunch(this.herdr, original, {
      binaryOverride: managedCodexBinary() || undefined,
    });
    const runtimeId = (await this.herdr.dashboard()).runtimeId;
    const readGoal = () => readCodexGoalRecord(sessionId, { home: launch.goalHome });
    const goal = readGoal();
    let keyRuntimeId = original.runtimeId;
    const verifyInput = async () => {
      const pane = await this.exactPane(id);
      if (
        pane.runtimeId !== keyRuntimeId ||
        pane.terminalId !== original.terminalId ||
        pane.workspaceId !== original.workspaceId ||
        pane.agent?.session?.value !== sessionId
      )
        throw fail('会话在恢复期间发生变化，请查看终端。');
    };
    const press = async (keys) => {
      await verifyInput();
      return herdrRequest(
        'agent.send_keys',
        { target: id, keys },
        { socketFile: this.herdr.socketPath },
      );
    };
    // send_text writes exact bytes. send_input would bracket this as a paste,
    // and send_keys can encode Ctrl+C as CSI 99;5:1u during terminal handoff.
    const rawInput = (text) =>
      herdrRequest('pane.send_text', { pane_id: id, text }, { socketFile: this.herdr.socketPath });
    const screen = () =>
      this.herdr.readPane(id, { source: 'recent', lines: 50, ansi: true, exact: true });
    const sameTerminal = async () => {
      const view = await this.herdr.dashboard(),
        pane = view.panes.find((p) => p.paneId === id);
      if (
        view.runtimeId !== runtimeId ||
        !pane ||
        pane.terminalId !== original.terminalId ||
        pane.workspaceId !== original.workspaceId ||
        pane.tabId !== original.tabId
      )
        throw fail('原终端的位置或身份已变化，请检查该会话。');
      return pane;
    };
    const shellReady = async () => {
      await sameTerminal();
      if ((await processStart(launch.shellPid)) !== launch.shellRuntimeId)
        throw fail('原 Shell 已变化，未发送恢复命令。');
      const info = await this.herdr.readProcessInfo(id);
      return (
        info?.shell_pid === launch.shellPid &&
        info.foreground_process_group_id === launch.shellPid &&
        info.foreground_processes?.length > 0 &&
        info.foreground_processes.every((p) => p.pid === launch.shellPid)
      );
    };
    const originalAlive = async () => {
      try {
        return (
          (await processStart(Number(original.runtimeId.split(':')[0]))) === original.runtimeId
        );
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    };
    await validate();
    progress('正在退出 Codex…');
    // Use legacy ETX for the native Ctrl+C exit path. Enhanced keyboard escape
    // sequences queued during shutdown become editable text in Bash/readline.
    let exited = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sameTerminal();
      if (!(await originalAlive())) break;
      await verifyInput();
      await rawInput('\x03');
      await delay(250);
    }
    for (let i = 0; i < 60; i++) {
      if (!(await originalAlive()) && (await shellReady())) {
        exited = true;
        break;
      }
      await delay(this.settleMs);
      if (i === 59) throw fail('未确认 Codex 已退出；未发送恢复命令。请查看终端。');
    }
    if (!exited) throw fail('未确认 Codex 已退出。');
    // Cancel any typeahead left by the exiting TUI before writing the command.
    // Keep ETX and the command in separate writes: the tty may flush its input
    // queue on SIGINT. Recheck the exact original shell after it has settled.
    progress('正在准备原终端…');
    if (!(await shellReady())) throw fail('原 Shell 尚未就绪，未发送恢复命令。');
    await rawInput('\x03');
    await delay(this.settleMs);
    if (!(await shellReady())) throw fail('终端前台进程已变化，未发送恢复命令。');
    progress('正在恢复原会话…');
    const command = `cd -- ${quote(launch.cwd)} && env -u CODEX_HOME -u CODEX_SQLITE_HOME -u CODEX_SESSION_ID -u CODEX_THREAD_ID ${Object.entries(
      launch.env,
    )
      .map(([key, value]) => quote(`${key}=${value}`))
      .join(' ')} ${[launch.binary, ...launch.args].map(quote).join(' ')}`;
    // Raw CR does not depend on a stale enhanced-keyboard or paste mode.
    // A timeout is uncertain; this command must never be submitted twice.
    await rawInput(command + '\r');
    let fresh,
      goalResumed = false;
    for (let i = 0; i < 100; i++) {
      await delay(this.settleMs);
      await sameTerminal();
      fresh = await this.exactPane(id).catch(() => null);
      if (
        !fresh?.runtimeId ||
        fresh.runtimeId === original.runtimeId ||
        fresh.agent?.label !== 'codex'
      )
        continue;
      if (!fresh.agent.session?.value) {
        // Herdr may observe SessionStart before it detects the new foreground
        // process. Repair only from that process's explicit resume argument.
        const pid = Number(fresh.runtimeId.split(':')[0]);
        const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8'))
          .split('\0')
          .filter(Boolean);
        if (
          argv[argv.indexOf('resume') + 1] !== sessionId ||
          (await processStart(pid)) !== fresh.runtimeId
        )
          throw fail('新进程未恢复原会话，请查看终端。');
        await sameTerminal();
        await herdrRequest(
          'pane.report_agent_session',
          {
            pane_id: id,
            source: 'herdr:codex',
            agent: 'codex',
            seq: Date.now() * 1e6,
            agent_session_id: sessionId,
            session_start_source: 'resume',
          },
          { socketFile: this.herdr.socketPath },
        );
        continue;
      }
      if (fresh.agent.session.value !== sessionId)
        throw fail('新进程的会话身份与原会话不符，请查看终端。');
      if (keyRuntimeId !== original.runtimeId && keyRuntimeId !== fresh.runtimeId)
        throw fail('恢复后的 Codex 再次变化，请查看终端。');
      keyRuntimeId = fresh.runtimeId;
      const raw = await screen(),
        text = stripAnsi(raw),
        dialog = codexGoalDialog(text);
      const currentGoal = readGoal();
      if (
        goal &&
        (!currentGoal ||
          currentGoal.objective !== goal.objective ||
          currentGoal.token_budget !== goal.token_budget)
      )
        throw fail('原会话已恢复，但 Goal 已变化，请在终端核对目标。');
      const continueGoal =
        goal &&
        !['complete', 'budget_limited'].includes(goal.status) &&
        !['complete', 'budget_limited'].includes(currentGoal.status);
      if (continueGoal && dialog?.question.startsWith('Resume paused goal?') && !goalResumed) {
        progress('正在继续原 Goal…');
        if (dialog.selected !== 0) await press(['up']);
        // Re-read the exact native dialog before confirming, never a generic Enter.
        const check = codexGoalDialog(stripAnsi(await screen()));
        if (!check || check.selected !== 0 || check.question !== dialog.question) continue;
        await press(['enter']);
        goalResumed = true;
        continue;
      }
      const area = readStatusArea(raw);
      if (dialog || !area.composerHint) continue;
      if (continueGoal && currentGoal.status !== 'active') {
        // The composer can appear before Codex opens its resume dialog. Wait
        // for that exact dialog; typing here could enter a pending prompt.
        continue;
      }
      if (continueGoal && !area.activity) continue;
      if (original.agent.name && fresh.agent.name !== original.agent.name)
        await this.herdr.json(['agent', 'rename', id, original.agent.name]);
      return {
        message:
          currentGoal?.status === 'budget_limited'
            ? '已恢复原会话；Goal 预算已耗尽，请手动调整。'
            : currentGoal?.status === 'complete'
              ? '已恢复原会话；Goal 已完成。'
              : goal
                ? '已恢复原会话，Goal 已继续运行。'
                : '已恢复原会话。',
        sessionId,
        goalContinued: Boolean(continueGoal),
        attention: currentGoal?.status === 'budget_limited',
      };
    }
    throw fail('恢复结果尚未确认，请查看原终端；不会自动重启第二次。');
  }
}
module.exports = { CodexRestart, resumeArgs, captureLaunch, processStart };

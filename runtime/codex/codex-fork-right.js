#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function quote(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('命令参数不能包含控制字符。');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function callHerdr(args) {
  const socketMove = args[0] === 'tab' && args[1] === 'move';
  const output = execFileSync(socketMove ? process.execPath : process.env.HERDR_BIN_PATH || 'herdr',
    socketMove ? [path.join(__dirname, 'herdr-tab-move.js'), ...args.slice(2)] : args, {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // pane run acknowledges success through its exit status, with no JSON on stdout.
  if (args[1] === 'run' && !output.trim()) return {};
  const response = JSON.parse(output);
  if (response.error || !response.result) throw new Error('Herdr 操作失败。');
  return response.result;
}

function createFork(sourceSession, cwd, environment) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HERDR_') || ['CODEX_THREAD_ID', 'CODEX_HOME', 'CODEX_SQLITE_HOME'].includes(key)) {
      delete childEnv[key];
    }
  }
  for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
    if (environment[key] !== undefined) childEnv[key] = environment[key];
  }
  // No prompt: create a durable fork without running an agent turn.
  let output;
  try {
    output = execFileSync('codex', ['exec', '--cd', cwd, 'fork', sourceSession,
      '--json', '--thread-source', 'user', '--skip-git-repo-check'], {
      cwd, env: childEnv, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Codex fork 未确认成功，未打开新会话；请检查原会话后再重试。');
  }
  const started = output.trim().split('\n').map(line => JSON.parse(line))
    .find(event => event.type === 'thread.started');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(started?.thread_id)
      || started.thread_id === sourceSession) {
    throw new Error('Codex 未返回新的会话 ID，未打开新会话。');
  }
  return started.thread_id;
}

function codexEnvironment(pid) {
  // Only forward storage locations. Never print or copy credentials or the full environment.
  const fields = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const environment = {};
  for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
    const value = fields.find(field => field.startsWith(`${key}=`));
    if (value !== undefined) environment[key] = value.slice(key.length + 1);
  }
  return environment;
}

function sessionId(pane) {
  const session = pane?.agent_session;
  if (pane?.agent !== 'codex' || session?.agent !== 'codex' || session.kind !== 'id'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.value)) {
    throw new Error('原终端没有可识别的 Codex 会话 ID，未打开新会话。');
  }
  return session.value;
}

function forkRight({ paneId, expectedSessionId, dryRun = false, env = process.env,
  herdr = callHerdr, readEnvironment = codexEnvironment, fork = createFork } = {}) {
  // Custom commands receive the invoking client's pane, which may differ from global focus.
  const target = paneId || env.HERDR_ACTIVE_PANE_ID || (env.HERDR_ENV === '1' && env.HERDR_PANE_ID);
  if (!target) throw new Error('请在 Herdr 内执行，或用 --pane 指定原 pane。');
  const source = herdr(['pane', 'get', target]).pane;
  const sourceSession = sessionId(source);
  if (expectedSessionId !== undefined && expectedSessionId !== sourceSession) {
    throw new Error('Herdr 记录的会话与当前 Codex 会话不同，未打开新会话。');
  }
  const info = herdr(['pane', 'process-info', '--pane', target]).process_info;
  const codex = info?.foreground_processes?.find(proc => proc.name === 'codex');
  if (!codex || !Number.isSafeInteger(codex.pid) || codex.pid <= 0) {
    throw new Error('原终端当前未运行 Codex，未打开新会话。');
  }
  const cwd = source.foreground_cwd || source.cwd;
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('无法确认原 pane 的工作目录。');
  const environment = readEnvironment(codex.pid);
  const launch = ['env', '-u', 'CODEX_HOME', '-u', 'CODEX_SQLITE_HOME',
    ...['CODEX_HOME', 'CODEX_SQLITE_HOME'].filter(key => environment[key] !== undefined)
      .map(key => `${key}=${environment[key]}`),
    'codex', 'resume'];
  // Validate shell input before creating a session or a pane.
  [...launch, cwd].forEach(quote);
  const tabPlacement = env.HERDR_SESSION === 'swift'
    || path.basename(path.dirname(env.HERDR_SOCKET_PATH || '')) === 'swift';
  const plan = { sourcePane: source.pane_id, sourceSession, cwd, direction: 'right', placement: tabPlacement ? 'tab' : 'split' };
  if (dryRun) return { ...plan, dryRun: true };

  const current = herdr(['pane', 'get', target]).pane;
  if (current?.terminal_id !== source.terminal_id || sessionId(current) !== sourceSession) {
    throw new Error('原 pane 的会话已变化，请重新触发。');
  }
  // Starting `codex fork <parent>` directly makes Herdr 0.9.3 identify the pane
  // by the parent argument. Resume the newly created UUID so future forks target it.
  const newSession = fork(sourceSession, cwd, environment);
  const command = [...launch, newSession, '--cd', cwd].map(quote).join(' ');
  let split;
  try {
    const latest = herdr(['pane', 'get', target]).pane;
    if (latest?.terminal_id !== source.terminal_id || sessionId(latest) !== sourceSession) {
      throw new Error('source changed');
    }
    if (tabPlacement) {
      if (!latest.tab_id || !latest.workspace_id) throw new Error('source location missing');
      const siblings = herdr(['tab', 'list', '--workspace', latest.workspace_id]).tabs;
      if (!siblings?.some(tab => tab.tab_id === latest.tab_id)) throw new Error('source Tab missing');
      split = herdr(['tab', 'create', '--workspace', latest.workspace_id, '--cwd', cwd, '--label', 'Codex fork', '--no-focus']);
    } else {
      split = herdr(['pane', 'split', '--pane', target, '--direction', 'right',
        '--cwd', cwd, '--no-focus']);
    }
  } catch {
    throw new Error(`会话 ${newSession} 已 fork，但${tabPlacement ? '新 Tab' : '分屏'}未确认成功；请先查看实际状态再重试。`);
  }
  const newPane = split.root_pane?.pane_id || split.pane?.pane_id;
  if (!newPane || newPane === source.pane_id) throw new Error('Herdr 未返回新的 pane ID。');
  let newTab;
  if (tabPlacement) {
    newTab = split.tab?.tab_id;
    try {
      const latest = herdr(['pane', 'get', target]).pane;
      if (latest.terminal_id !== source.terminal_id || sessionId(latest) !== sourceSession) throw new Error('source changed');
      const siblings = herdr(['tab', 'list', '--workspace', latest.workspace_id]).tabs;
      const index = siblings?.findIndex(tab => tab.tab_id === latest.tab_id);
      if (!newTab || index < 0 || index === undefined || !siblings.some(tab => tab.tab_id === newTab)) throw new Error('Tab missing');
      herdr(['tab', 'move', newTab, String(index + 1)]);
    } catch {
      throw new Error(`新 Tab ${newTab || newPane} 和会话 ${newSession} 已创建，但排列结果未确认；请查看 Tab 后再恢复该会话。`);
    }
  }
  try {
    herdr(['pane', 'run', newPane, command]);
  } catch {
    throw new Error(`新${tabPlacement ? " Tab " + newTab : "终端 " + newPane}和会话 ${newSession} 已创建，但启动命令未确认成功；请查看该会话。`);
  }
  return { ...plan, newPane, ...(newTab ? { newTab } : {}), newSession, commandSent: true };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run') options.dryRun = true;
      else if (args[i] === '--pane' && args[i + 1]) options.paneId = args[++i];
      else if (args[i] === '--expected-session-id' && args[i + 1]) options.expectedSessionId = args[++i];
      else if (args[i] === '--help' || args[i] === '-h') {
        console.log('Usage: herdr-codex-fork-right [--pane ID] [--expected-session-id UUID] [--dry-run]\nSwift 在右侧相邻的新 Tab 中 fork；其他 Session 沿用右侧分屏。保留原会话和焦点。');
        process.exit(0);
      } else throw new Error(`未知参数：${args[i]}`);
    }
    console.log(JSON.stringify(forkRight(options)));
  } catch (error) {
    // execFileSync errors can include process output; do not expose them.
    console.error(error.cmd || error.stderr ? 'Herdr 命令执行失败，请检查服务与 pane 状态。' : error.message);
    process.exitCode = 1;
  }
}

module.exports = { forkRight, quote, callHerdr, createFork };

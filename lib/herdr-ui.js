'use strict';
const { performance } = require('node:perf_hooks');

// Structured UI operations are explicit native operations, never arbitrary RPC.
const ACTIONS = Object.freeze({
  'workspace.create': ['label', 'cwd'],
  'workspace.rename': ['workspace_id', 'label'],
  'workspace.close': ['workspace_id', 'close_group'],
  'workspace.move': ['workspace_id', 'insert_index'],
  'tab.create': ['workspace_id', 'cwd', 'label'],
  'tab.rename': ['tab_id', 'label'],
  'tab.close': ['tab_id'],
  'tab.move': ['tab_id', 'insert_index'],
  // These two methods belong to the Swift adapter, not the native RPC API.
  'tab.separate': ['tab_id'],
  'tab.move_to_workspace': ['tab_id', 'workspace_id'],
  'pane.focus': ['pane_id'],
  'agent.rename': ['target', 'name'],
  'worktree.create': ['workspace_id', 'branch', 'base'],
  'worktree.open': ['workspace_id', 'branch'],
  'worktree.remove': ['workspace_id'],
  'plugin.action.invoke': ['plugin_id', 'action_id', 'context'],
  'plugin.link': ['path'],
  'plugin.unlink': ['plugin_id'],
  'plugin.enable': ['plugin_id'],
  'plugin.disable': ['plugin_id'],
  'plugin.pane.open': ['plugin_id', 'entrypoint', 'target_pane_id', 'placement', 'direction'],
  'integration.install': ['target'],
  'integration.uninstall': ['target'],
  'agent.start': ['pane_id', 'name', 'kind'],
  'server.reload_config': [],
  'server.reload_agent_manifests': [],
});
const READS = Object.freeze({
  'layout.export': ['tab_id'],
  'worktree.list': ['workspace_id'],
  'agent.explain': ['target'],
  'server.agent_manifests': [],
  'integration.list': [],
  'plugin.list': [],
  'plugin.action.list': [],
  'plugin.log.list': ['plugin_id'],
  'pane.read': ['pane_id'],
});
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'fish',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'elvish',
  'xonsh',
  'nu',
  'pwsh',
  'powershell',
  'cmd',
]);
function availableShell(info) {
  const pid = info?.shell_pid,
    processes = info?.foreground_processes;
  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    info.foreground_process_group_id === pid &&
    Array.isArray(processes) &&
    processes.length > 0 &&
    processes.every((process) => process.pid === pid) &&
    processes.some((process) =>
      SHELL_NAMES.has(
        String(process.name || '')
          .split(/[\\/]/)
          .pop()
          .replace(/^-+/, '')
          .replace(/(?:\.exe)+$/, '')
          .toLowerCase(),
      ),
    )
  );
}
async function beforeDeadline(read, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw fail('SHELL_NOT_READY', 'Shell 尚未完成启动，未发送 Agent 启动命令。请稍后重试。', 409);
  let timer;
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              fail(
                'SHELL_NOT_READY',
                'Shell 尚未完成启动，未发送 Agent 启动命令。请稍后重试。',
                409,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitForShell(
  herdr,
  originalView,
  originalPane,
  name,
  { timeoutMs = 10000, pollMs = 100 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let shellPid,
    stable = false;
  for (;;) {
    const current = await beforeDeadline(() => herdr.dashboard(), deadline);
    if (current.runtimeId !== originalView.runtimeId)
      throw fail('RUNTIME_CHANGED', 'Herdr 运行实例已经改变，未发送 Agent 启动命令。', 409);
    const pane = current.panes.find((item) => item.paneId === originalPane.paneId);
    if (!pane) throw fail('TARGET_GONE', '目标终端已经关闭，未发送 Agent 启动命令。', 409);
    if (
      pane.terminalId !== originalPane.terminalId ||
      pane.workspaceId !== originalPane.workspaceId ||
      pane.tabId !== originalPane.tabId
    )
      throw fail('TARGET_CHANGED', '目标终端的身份或位置已经改变，未发送 Agent 启动命令。', 409);
    if (pane.agent) throw fail('PANE_NOT_AVAILABLE', '这个 Tab 已有 Agent，未重复启动。', 409);
    if (name && current.panes.some((item) => item.agent?.name === name))
      throw fail('AGENT_NAME_TAKEN', '这个 Agent 名称已被使用，请选择其他名称。', 409);
    const info = await beforeDeadline(() => herdr.readProcessInfo(pane.paneId), deadline);
    if (
      info?.pane_id !== pane.paneId ||
      !Number.isSafeInteger(info?.shell_pid) ||
      info.shell_pid <= 0
    )
      throw fail('SHELL_UNAVAILABLE', '目标 Shell 已退出或不可用，未发送 Agent 启动命令。', 409);
    if (shellPid && info.shell_pid !== shellPid)
      throw fail('TARGET_CHANGED', '目标 Shell 已经改变，未发送 Agent 启动命令。', 409);
    shellPid = info.shell_pid;
    const ready = availableShell(info);
    // A newly spawned Shell can briefly own its foreground group before its
    // startup script runs. Observe it again before submitting a single start.
    if (ready && stable) return;
    stable = ready;
    await beforeDeadline(() => delay(pollMs), deadline);
  }
}
function parameters(method, value, reads = false) {
  const allowed = (reads ? READS : ACTIONS)[method];
  if (!allowed) throw fail('UNSUPPORTED_ACTION', '没有开放这个 Herdr 操作。');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail('BAD_REQUEST', '操作参数无效。');
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw fail('BAD_REQUEST', '操作包含未支持的参数。');
  if (JSON.stringify(value).length > 16384) throw fail('BAD_REQUEST', '操作参数过长。');
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'workspace_id',
        'tab_id',
        'pane_id',
        'target',
        'target_pane_id',
        'label',
        'cwd',
        'branch',
        'base',
        'name',
        'plugin_id',
        'action_id',
        'pane_key',
        'entrypoint',
        'kind',
      ].includes(key) &&
      (typeof item !== 'string' || !item.trim() || item.length > 4096)
    )
      throw fail('BAD_REQUEST', `${key} 无效。`);
  }
  if (
    method === 'plugin.link' &&
    (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 4096)
  )
    throw fail('BAD_REQUEST', '请选择现存的插件目录。');
  if (
    'insert_index' in value &&
    (!Number.isSafeInteger(value.insert_index) || value.insert_index < 0)
  )
    throw fail('BAD_REQUEST', '排列位置无效。');
  if ('direction' in value) throw fail('BAD_REQUEST', 'Tab 不提供分屏方向。');
  if ('close_group' in value && typeof value.close_group !== 'boolean')
    throw fail('BAD_REQUEST', '关闭范围无效。');
  if ('placement' in value && value.placement !== 'tab')
    throw fail('BAD_REQUEST', '插件终端只能在新 Tab 中打开。');
  return { ...value };
}
async function invoke(herdr, method, supplied, expected, { read = false, shellWait } = {}) {
  const params = parameters(method, supplied, read);
  const view = await herdr.dashboard();
  if (!read && view.runtimeId && expected?.runtimeId !== view.runtimeId)
    throw fail('RUNTIME_CHANGED', 'Herdr 运行实例已经改变，请刷新并重新选择操作对象。', 409);
  for (const field of ['workspace_id', 'tab_id', 'pane_id', 'target_pane_id', 'target']) {
    if (field === 'target' && method.startsWith('integration.')) continue;
    const required =
      (ACTIONS[method] || READS[method]).includes(field) && !['workspace.create'].includes(method);
    if (required && !params[field]) throw fail('TARGET_REQUIRED', '请明确选择操作对象。');
    if (!params[field]) continue;
    const entries =
      field === 'workspace_id' ? view.workspaces : field === 'tab_id' ? view.tabs : view.panes;
    const key = field === 'workspace_id' ? 'workspaceId' : field === 'tab_id' ? 'tab_id' : 'paneId';
    const item = entries.find((entry) => entry[key] === params[field]);
    if (!item) throw fail('TARGET_GONE', '操作对象已经离开当前 Herdr Session，请刷新。', 409);
    if (
      !read &&
      (['pane_id', 'target'].includes(field) ||
        (method === 'plugin.pane.open' && field === 'target_pane_id')) &&
      (!expected?.terminalId ||
        item.terminalId !== expected.terminalId ||
        (expected.sessionId && item.agent?.session?.value !== expected.sessionId))
    )
      throw fail('TARGET_CHANGED', '终端或 Agent 会话已经改变，请重新选择。', 409);
  }
  if (method === 'plugin.action.invoke' && params.context?.focused_pane_id) {
    const pane = view.panes.find((p) => p.paneId === params.context?.focused_pane_id);
    if (!pane || !expected?.terminalId || pane.terminalId !== expected.terminalId)
      throw fail('TARGET_CHANGED', '插件操作的目标终端已经改变。', 409);
    params.context = {
      invocation_source: 'swift',
      focused_pane_id: pane.paneId,
      workspace_id: pane.workspaceId,
      tab_id: pane.tabId,
    };
  }
  if (method === 'plugin.action.invoke' && !params.context?.focused_pane_id)
    params.context = { invocation_source: 'swift' };
  if (method === 'tab.separate')
    return require('./tab-operations').separate(herdr, view, params.tab_id, expected);
  if (method === 'tab.move_to_workspace')
    return require('./tab-operations').move(herdr, view, params, expected);
  if (!read && method.startsWith('tab.') && expected?.terminalId) {
    const members = view.panes.filter((p) => p.tabId === params.tab_id);
    if (
      members.length !== 1 ||
      members[0].terminalId !== expected.terminalId ||
      (expected.sessionId && members[0].agent?.session?.value !== expected.sessionId)
    )
      throw fail('TARGET_CHANGED', 'Tab 中的会话已经改变，请重新选择。', 409);
  }
  if (method === 'plugin.pane.open') params.placement = 'tab';
  if (
    [
      'workspace.create',
      'tab.create',
      'worktree.create',
      'worktree.open',
      'plugin.pane.open',
    ].includes(method)
  )
    params.focus = false;
  if (method === 'pane.read')
    Object.assign(params, {
      source: 'recent_unwrapped',
      lines: 160,
      format: 'text',
      strip_ansi: true,
    });
  herdr.uiMethodSupport ||= {};
  const starting = method === 'agent.start';
  if (starting) {
    herdr.startingPanes ||= new Set();
    if (herdr.startingPanes.has(params.pane_id))
      throw fail('PANE_NOT_AVAILABLE', '这个 Tab 正在启动 Agent，请等待当前操作完成。', 409);
    herdr.startingPanes.add(params.pane_id);
  }
  try {
    if (starting)
      await waitForShell(
        herdr,
        view,
        view.panes.find((pane) => pane.paneId === params.pane_id),
        params.name,
        shellWait,
      );
    const result = await herdr.request(method, params);
    herdr.uiMethodSupport[method] = 'supported';
    return result;
  } catch (error) {
    if (['unknown_method', 'method_not_found', 'unsupported_method'].includes(error.code))
      herdr.uiMethodSupport[method] = 'unsupported';
    throw error;
  } finally {
    if (starting) herdr.startingPanes.delete(params.pane_id);
  }
}
module.exports = { ACTIONS, READS, parameters, invoke };

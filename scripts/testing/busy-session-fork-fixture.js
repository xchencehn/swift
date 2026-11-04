'use strict';

// Browser-only API fixture. It does not run Codex, Herdr, or the native fork
// engine. Native input and Goal below are explicit mock state, not PTY evidence.
const assert = require('node:assert/strict');
const { createFixture } = require('./chat-harness');
const { withinRoot } = require('../../lib/root-scope');

const clone = (value) => structuredClone(value);
const bindingKeys = ['runtimeId', 'paneId', 'terminalId', 'sessionId', 'processRuntimeId'];
const bindingOf = (body) => Object.fromEntries(bindingKeys.map((key) => [key, body[key] || '']));
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

async function createBusyForkFixture() {
  const fixture = await createFixture(),
    state = fixture.state;
  state.productionPresentation = true;
  state.unified = true;
  state.sync = false;
  state.runtimeId = 'fixture-runtime';
  state.rootDirectory = '/fixture/project';
  state.focusedPaneId = 'pane-codex';

  const other = clone(state.sessions['pane-codex']);
  Object.assign(other.pane, {
    paneId: 'other-codex',
    terminalId: 'term-other',
    tabId: 'tab-other',
    title: '未选中的运行中 Codex',
    sessionTitle: '未选中的运行中 Codex',
  });
  other.pane.agent.session.value = 'thread-other';
  state.sessions['other-codex'] = other;
  for (const [paneId, session] of Object.entries(state.sessions)) {
    session.pane.runtimeId = 'fixture-process-' + paneId;
    if (!/^codex$/i.test(session.pane.agent?.label || '')) continue;
    session.pane.agent.status = 'working';
    session.nativeDraft = paneId + ' 保留的原生草稿';
    session.input = paneId + ' 保留的原生输入';
    session.goal = { objective: paneId + ' 持续执行的目标', status: 'active' };
    session.webStatus = { ...session.webStatus, goal: clone(session.goal) };
  }
  state.tabs = Object.values(state.sessions).map(({ pane }) => ({
    tab_id: pane.tabId,
    workspace_id: pane.workspaceId,
    label: pane.title,
  }));

  const starts = [],
    reads = [],
    trace = [],
    children = [];
  const jobsMap = new Map(),
    bindings = new Map(),
    pending = new Map(),
    attached = new WeakSet();
  let loseStartReply = false;

  function snapshotParent(paneId = 'pane-codex') {
    const session = state.sessions[paneId];
    assert(session, 'Unknown fixture parent ' + paneId);
    return clone({
      pane: session.pane,
      nativeDraft: session.nativeDraft,
      input: session.input,
      goal: session.goal,
      focusedPaneId: state.focusedPaneId,
    });
  }

  function validate(binding, rootDirectory) {
    if (binding.runtimeId !== (state.runtimeId || 'fixture-runtime'))
      throw failure(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已改变，请重新打开菜单。');
    const session = state.sessions[binding.paneId],
      pane = session?.pane;
    if (
      !/^codex$/i.test(pane?.agent?.label || '') ||
      !pane.runtimeId ||
      pane.terminalId !== binding.terminalId ||
      pane.agent.session?.value !== binding.sessionId ||
      (binding.processRuntimeId && pane.runtimeId !== binding.processRuntimeId)
    )
      throw failure(409, 'SESSION_CHANGED', 'Fork 目标会话已改变，请重新打开菜单。');
    if (
      rootDirectory !== state.rootDirectory ||
      !withinRoot(rootDirectory, pane.cwd || pane.baseCwd || '')
    )
      throw failure(409, 'ROOT_CHANGED', '这个会话不在当前根目录内。');
    return session;
  }

  function start(body) {
    if (
      !body ||
      !/^[\w-]{1,100}$/.test(body.requestId || '') ||
      bindingKeys
        .slice(0, 4)
        .some((key) => typeof body[key] !== 'string' || !body[key] || body[key].length > 256) ||
      ['action', 'text', 'leaseId'].some((key) => Object.hasOwn(body, key))
    )
      throw failure(400, 'INVALID_FORK_REQUEST', 'Fork 操作标识或会话身份无效。');
    const binding = bindingOf(body),
      previous = jobsMap.get(body.requestId);
    if (previous) {
      if (JSON.stringify(bindings.get(body.requestId)) !== JSON.stringify(binding))
        throw failure(409, 'FORK_REQUEST_CHANGED', '同一操作标识不能用于其他 Fork 目标。');
      return clone(previous);
    }
    if (
      [...pending.values()].some(
        (entry) =>
          entry.binding.runtimeId === binding.runtimeId &&
          entry.binding.terminalId === binding.terminalId &&
          entry.binding.sessionId === binding.sessionId,
      )
    )
      throw failure(409, 'FORK_BUSY', '这个会话的 Fork 正在创建，请等待当前操作完成。');
    const job = { requestId: body.requestId, status: 'running', phase: 'validating' };
    jobsMap.set(body.requestId, job);
    bindings.set(body.requestId, binding);
    try {
      const session = validate(binding, state.rootDirectory);
      pending.set(body.requestId, {
        binding,
        rootDirectory: state.rootDirectory,
        processRuntimeId: session.pane.runtimeId,
        tabId: session.pane.tabId,
        workspaceId: session.pane.workspaceId,
        cwd: session.pane.cwd || session.pane.baseCwd,
      });
    } catch (error) {
      Object.assign(job, { status: 'failed', code: error.code, message: error.message });
    }
    return clone(job);
  }

  function finish(requestId, status, message, code) {
    const job = jobsMap.get(requestId);
    assert(job, 'Unknown fixture fork ' + requestId);
    if (job.status !== 'running') return clone(job);
    pending.delete(requestId);
    Object.assign(job, {
      status,
      code: code || (status === 'uncertain' ? 'FORK_RESULT_UNCERTAIN' : 'FORK_FAILED'),
      message,
    });
    trace.push({ action: status, requestId, status, code: job.code, childCount: children.length });
    fixture.changed();
    return clone(job);
  }

  function complete(requestId) {
    const job = jobsMap.get(requestId);
    assert(job, 'Unknown fixture fork ' + requestId);
    if (job.status !== 'running') return clone(job);
    const entry = pending.get(requestId);
    assert(entry, 'No pending fixture fork ' + requestId);
    let source;
    try {
      source = validate(
        { ...entry.binding, processRuntimeId: entry.processRuntimeId },
        entry.rootDirectory,
      );
    } catch (error) {
      return finish(requestId, 'failed', error.message, error.code);
    }
    if (
      source.pane.tabId !== entry.tabId ||
      source.pane.workspaceId !== entry.workspaceId ||
      (source.pane.cwd || source.pane.baseCwd) !== entry.cwd
    )
      return finish(
        requestId,
        'failed',
        '原会话的 Tab 或目录已改变，请重新打开菜单。',
        'FORK_TARGET_MOVED',
      );
    const number = children.length + 1,
      childId = 'busy-fork-' + number,
      child = clone(source);
    child.pane = {
      ...child.pane,
      paneId: childId,
      terminalId: childId + '-terminal',
      tabId: childId + '-tab',
      runtimeId: childId + '-process',
      title: 'Fork 子会话 ' + number,
      sessionTitle: 'Fork 子会话 ' + number,
    };
    child.pane.agent = {
      ...child.pane.agent,
      status: 'idle',
      session: { ...child.pane.agent.session, value: childId + '-session' },
    };
    child.nativeDraft = '';
    child.input = '';
    const pauseGoal = source.goal?.status === 'active';
    child.goal = source.goal
      ? { ...clone(source.goal), ...(pauseGoal ? { status: 'paused' } : {}) }
      : null;
    child.webStatus = { ...child.webStatus, goal: clone(child.goal) };
    for (const message of child.messages)
      for (const block of message.blocks || [])
        for (const tool of block.items || []) tool.running = false;
    const index = state.tabs.findIndex((tab) => tab.tab_id === source.pane.tabId);
    assert(index >= 0, 'The parent Tab must exist before completing a fork');
    state.sessions[childId] = child;
    state.tabs.splice(index + 1, 0, {
      tab_id: child.pane.tabId,
      workspace_id: child.pane.workspaceId,
      label: child.pane.title,
    });
    children.push(clone(child.pane));
    pending.delete(requestId);
    Object.assign(job, {
      status: 'succeeded',
      phase: 'complete',
      sessionId: child.pane.agent.session.value,
      tabId: child.pane.tabId,
      paneId: childId,
      terminalId: child.pane.terminalId,
      goalPaused: child.goal?.status === 'paused',
      goalStatus: child.goal?.status || null,
    });
    trace.push({ action: 'complete', requestId, status: job.status, childCount: children.length });
    fixture.changed();
    return clone(job);
  }

  async function attach(page) {
    if (attached.has(page)) return;
    attached.add(page);
    await page.route(
      (url) => url.origin === fixture.url && url.pathname === '/api/agents/fork',
      async (route) => {
        const request = route.request(),
          method = request.method(),
          url = new URL(request.url());
        let body,
          requestId,
          job,
          httpStatus = method === 'POST' ? 202 : 200,
          error;
        try {
          if (method === 'POST') {
            body = request.postDataJSON();
            starts.push(clone(body));
            requestId = body?.requestId;
            job = start(body);
          } else if (method === 'GET') {
            body = Object.fromEntries(url.searchParams);
            reads.push(clone(body));
            requestId = body.requestId;
            job = jobsMap.get(requestId);
            if (!job)
              throw failure(
                404,
                'FORK_RECEIPT_UNKNOWN',
                '尚未找到这次 Fork 的操作记录；不会自动重发，请查看 Tab 列表。',
              );
            job = clone(job);
          } else throw failure(405, 'METHOD_NOT_ALLOWED', 'Unsupported fixture fork method');
        } catch (cause) {
          error = cause;
          httpStatus = cause.status || 400;
        }
        const loseReply = method === 'POST' && !error && loseStartReply;
        if (loseReply) loseStartReply = false;
        trace.push({
          action: method === 'POST' ? 'start' : 'read',
          method,
          body: clone(body),
          requestId,
          httpStatus,
          status: job?.status || 'rejected',
          code: error?.code,
          childCount: children.length,
          lostReply: loseReply,
        });
        if (loseReply) return route.abort('failed');
        return route.fulfill({
          status: httpStatus,
          contentType: 'application/json',
          body: JSON.stringify(
            error
              ? { ok: false, code: error.code || 'INVALID_FORK_REQUEST', message: error.message }
              : { ok: true, job },
          ),
        });
      },
    );
  }

  const controls = {
    complete,
    fail: (requestId, message = '模拟 Fork 失败') => finish(requestId, 'failed', message),
    uncertain: (
      requestId,
      message = 'Fork 结果尚未确认，请查看已创建的 Tab；Swift 不会自动重复创建。',
    ) => finish(requestId, 'uncertain', message),
    loseNextStartReply() {
      loseStartReply = true;
    },
    snapshotParent,
    setRestoreError(text, paneId = 'pane-codex') {
      const session = state.sessions[paneId];
      assert(session, 'Unknown fixture pane ' + paneId);
      session.pane = { ...session.pane };
      if (text) session.pane.restoreError = text;
      else delete session.pane.restoreError;
      fixture.changed();
    },
  };
  return {
    ...fixture,
    fixture,
    attach,
    starts,
    reads,
    trace,
    jobsMap,
    pending,
    children,
    ...controls,
    controls,
  };
}

module.exports = { createBusyForkFixture };

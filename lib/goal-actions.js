'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises'),
  path = require('node:path');
const { codexGoal, readCodexGoalRecord } = require('./agent-goal');
const { processStart } = require('./codex-restart');
const { stripAnsi } = require('../public/ansi');
const { apiError } = require('./message-queue');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Usage counters change while a Goal runs; only changes to the Goal itself invalidate an action.
const revision = (goal) =>
  digest(goal && [goal.objective, goal.status, goal.token_budget, goal.created_at_ms]);
const editor = (raw) => {
  const text = stripAnsi(raw).replace(/\r/g, '');
  const start = text.lastIndexOf('\n  Edit goal\n');
  return start >= 0 && /^\s*enter submit · esc (?:back|normal mode)\s*$/m.test(text.slice(start))
    ? text.slice(start)
    : null;
};
function editorInputMatches(raw, expected) {
  const view = editor(raw);
  if (!view) return false;
  const lines = view.split('\n'),
    start = lines.findIndex((line) => /^› /.test(line));
  if (start < 0) return false;
  const parts = [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s*enter submit · esc /.test(lines[i])) break;
    parts.push(i === start ? lines[i].replace(/^› /, '') : lines[i].replace(/^ {2}/, ''));
  }
  // Terminal soft wrapping and actual newlines look the same. A long native
  // text area shows only its final eight rows; acknowledge that visible suffix.
  const normalize = (text) => text.replace(/\s/g, '');
  const visible = normalize(parts.join(''));
  return Boolean(visible) && normalize(expected).endsWith(visible);
}
async function readPaneGoal(pane) {
  const pid = Number(pane.runtimeId?.split(':')[0]);
  if (!pid || (await processStart(pid)) !== pane.runtimeId)
    throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变，请重新打开 Goal。');
  const buffer = await fs.readFile(`/proc/${pid}/environ`),
    dirs = {};
  try {
    for (const entry of buffer.toString().split('\0')) {
      const at = entry.indexOf('='),
        name = entry.slice(0, at);
      if (['HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME'].includes(name))
        dirs[name] = entry.slice(at + 1);
    }
  } finally {
    buffer.fill(0);
  }
  const home =
    dirs.CODEX_SQLITE_HOME || dirs.CODEX_HOME || (dirs.HOME && path.join(dirs.HOME, '.codex'));
  if (!home || !path.isAbsolute(home) || (await processStart(pid)) !== pane.runtimeId)
    throw apiError(409, 'GOAL_UNAVAILABLE', '暂时无法读取当前 Goal，请重新打开。');
  // Before Herdr reports the first thread, reuse the existing process-owned
  // archive validation. Never infer its identity from the newest file or cwd.
  let sessionId = pane.agent?.session?.value;
  if (!sessionId) {
    const archiveHome = dirs.CODEX_HOME || (dirs.HOME && path.join(dirs.HOME, '.codex')) || home;
    const active = new (require('./codex-active-session').CodexActiveSession)({
      home,
      homes: { read: async () => ({ home: archiveHome, sqliteHome: home }) },
      native: async () => null,
    });
    sessionId = (await active.read(pane, { foreground_processes: [{ name: 'codex', pid }] }))
      ?.sessionId;
  }
  return readCodexGoalRecord(sessionId, { home });
}

class GoalActions {
  constructor({
    commands,
    readGoal = readPaneGoal,
    timeoutMs = 8000,
    stepMs = 80,
    onChange = () => {},
  }) {
    Object.assign(this, { commands, readGoal, timeoutMs, stepMs, onChange });
    this.jobs = new Map();
    this.running = new Map();
  }
  async preview(body) {
    const pane = await this.commands.target(body);
    if (!pane.runtimeId) throw apiError(409, 'GOAL_UNAVAILABLE', '请等待 Codex 会话就绪。');
    const goal = await this.readGoal(pane);
    if ((await this.commands.target(body)).runtimeId !== pane.runtimeId)
      throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变。');
    return {
      ok: true,
      goal: codexGoal(goal),
      revision: revision(goal),
      processRuntimeId: pane.runtimeId,
    };
  }
  get(id) {
    const entry = this.jobs.get(id);
    if (!entry)
      throw apiError(
        404,
        'GOAL_RECEIPT_UNKNOWN',
        '无法确认上次操作结果，请查看当前 Goal；不会自动重发。',
      );
    return entry.job;
  }
  async start(body) {
    if (
      !body ||
      !['set', 'edit', 'pause', 'resume', 'clear'].includes(body.action) ||
      !/^[\w-]{1,100}$/.test(body.requestId || '')
    )
      throw apiError(400, 'INVALID_GOAL_ACTION', 'Goal 操作无效。');
    if (
      ['set', 'edit'].includes(body.action) &&
      (typeof body.objective !== 'string' ||
        !body.objective.trim() ||
        body.objective.length > 12000 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(body.objective))
    )
      throw apiError(400, 'INVALID_GOAL_OBJECTIVE', '请输入有效的 Goal，最多 12000 个字符。');
    if (
      body.action === 'set' &&
      (body.objective.trim().length > 2000 ||
        /^(?:edit|pause|resume|clear)$/i.test(body.objective.trim()))
    )
      throw apiError(
        400,
        'INVALID_GOAL_OBJECTIVE',
        '新目标最多 2000 个字符，且不能仅为 edit、pause、resume 或 clear。',
      );
    const fingerprint = digest(body),
      previous = this.jobs.get(body.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw apiError(409, 'GOAL_REQUEST_CHANGED', '同一操作标识不能用于不同 Goal 操作。');
      return previous.job;
    }
    const job = { requestId: body.requestId, status: 'running', action: body.action };
    this.jobs.set(body.requestId, { fingerprint, job });
    const work = Promise.resolve()
      .then(async () => {
        const pane = await this.commands.target(body);
        return this.commands.operate(pane.paneId, () => this.apply(body));
      })
      .then(
        (result) => {
          Object.assign(job, { status: 'succeeded', ...result });
          this.onChange();
        },
        (error) =>
          Object.assign(job, {
            status: 'failed',
            message: error.message,
            code: error.code,
            uncertain: Boolean(error.deliveryUncertain),
          }),
      );
    this.running.set(body.requestId, work);
    void work.finally(() => this.running.delete(body.requestId));
    // Retain receipts for this server lifetime: an uncertain action must never be replayed.
    return job;
  }
  async apply(body) {
    const commands = this.commands,
      pane = await commands.target(body);
    const initialGoal = body.action === 'set' && !body.sessionId;
    let currentPane = pane,
      sessionId = body.sessionId;
    const check = async () => {
      currentPane = await commands.target({ ...body, sessionId }, initialGoal && !sessionId);
      if (currentPane.runtimeId !== body.processRuntimeId)
        throw apiError(409, 'SESSION_CHANGED', 'Codex 进程已改变，请重新打开 Goal。');
      if (initialGoal && !sessionId && currentPane.commandSessionChanged)
        sessionId = currentPane.agent.session.value;
    };
    await check();
    const original = await this.readGoal(pane);
    if ((body.action !== 'set' && !original) || revision(original) !== body.revision)
      throw apiError(409, 'GOAL_CHANGED', 'Goal 已改变，请重新打开后操作。');
    if (body.action === 'set' && original && body.confirmReplace !== true)
      throw apiError(409, 'GOAL_REPLACE_REQUIRED', '已有 Goal，请先确认是否替换当前目标。');
    await commands.beforeWrite(pane);
    if (revision(await this.readGoal(pane)) !== body.revision)
      throw apiError(409, 'GOAL_CHANGED', 'Goal 已改变，未继续操作。');
    if (
      body.action === 'resume' &&
      ['complete', 'budget_limited', 'budgetLimited'].includes(original.status)
    )
      throw apiError(
        409,
        'GOAL_NOT_RESUMABLE',
        '此 Goal 已完成或预算耗尽，请先修改目标或在 Codex 中调整预算。',
      );
    if (body.action === 'resume' && original.status === 'active')
      return { goal: codexGoal(original), message: '当前 Goal 正在运行。' };
    if (body.action === 'pause' && original.status === 'paused')
      return { goal: codexGoal(original), message: '当前 Goal 已暂停。' };
    const screen = () =>
      commands.herdr.readPane(pane.paneId, { lines: 160, ansi: true, exact: true });
    const wait = async (predicate) => {
      const until = Date.now() + this.timeoutMs;
      do {
        await check();
        const value = await predicate();
        if (value) return value;
        await delay(this.stepMs);
      } while (Date.now() < until);
      const error = apiError(
        409,
        'GOAL_UNCONFIRMED',
        '操作结果尚未确认，请查看终端和当前 Goal；不会自动重发。',
      );
      error.deliveryUncertain = true;
      throw error;
    };
    const press = async (keys) => {
      await check();
      await commands.press(pane.paneId, keys);
    };
    // Reuse the slash-command guard, input acknowledgement and native operation lock.
    let view = await commands.execute(
      { ...body, text: '/goal ' + (body.action === 'set' ? body.objective.trim() : body.action) },
      true,
    );
    if (body.action === 'set' && original && original.status !== 'complete') {
      await wait(async () => {
        if (
          view?.mode === 'menu' &&
          !view.pending &&
          view.options?.some((option) =>
            ['Replace current goal', 'Replace goal'].includes(option.label),
          ) &&
          view.rows?.some(
            (row) =>
              row
                .map((span) => span.text)
                .join('')
                .trim() === 'Replace goal?',
          )
        )
          return true;
        view = await commands.handle({ ...body, action: 'read', leaseId: view?.leaseId }, true);
        return false;
      });
      if (revision(await this.readGoal(pane)) !== body.revision)
        throw apiError(409, 'GOAL_CHANGED', 'Goal 已改变，未确认替换。');
      await commands.handle(
        {
          ...body,
          action: 'pick',
          option: view.options.find((option) =>
            ['Replace current goal', 'Replace goal'].includes(option.label),
          ).label,
          leaseId: view.leaseId,
          revision: view.revision,
          requestId: body.requestId + '-replace',
        },
        true,
      );
    }
    if (body.action === 'edit') {
      await wait(async () => editor(await screen()));
      // The native editor starts with the cursor at the end. Ctrl+U removes a
      // logical line, then its preceding newline. Verify empty before pasting.
      const max = Math.min(2000, original.objective.split('\n').length * 2 + 4);
      for (let i = 0; i < max; i++) {
        await check();
        const raw = await screen();
        if (!editor(raw))
          throw apiError(409, 'GOAL_EDITOR_CHANGED', '原生 Goal 编辑器已改变，请查看终端。');
        if (editor(raw).includes('Type a goal objective and press Enter')) break;
        await press(['ctrl+u']);
        await delay(this.stepMs);
        if (i === max - 1)
          throw apiError(409, 'GOAL_EDITOR_CHANGED', '未能清空原生编辑框，请在终端完成修改。');
      }
      if (revision(await this.readGoal(pane)) !== body.revision)
        throw apiError(409, 'GOAL_CHANGED', 'Goal 已改变，未保存修改，请查看终端。');
      await check();
      await commands.paste(pane.paneId, body.objective.trim());
      await wait(async () => {
        const raw = await screen();
        return editorInputMatches(raw, body.objective.trim());
      });
      if (revision(await this.readGoal(pane)) !== body.revision)
        throw apiError(409, 'GOAL_CHANGED', 'Goal 已改变，未保存修改，请查看终端。');
      await press(['enter']);
    }
    let goal;
    await wait(async () => {
      goal = await this.readGoal(currentPane);
      if (body.action === 'clear') return !goal;
      if (body.action === 'set')
        return (
          goal?.objective === body.objective.trim() &&
          (!original || goal.created_at_ms !== original.created_at_ms)
        );
      if (!goal || goal.token_budget !== original.token_budget) return false;
      return ['resume', 'pause'].includes(body.action)
        ? goal.objective === original.objective &&
            goal.status === (body.action === 'pause' ? 'paused' : 'active')
        : goal.objective === body.objective.trim();
    });
    // Release only this interaction's lease; no extra terminal input on close.
    const lease = commands.leases.get(`${body.runtimeId}:${body.terminalId}:${body.sessionId}`);
    if (lease?.clientId === body.clientId) lease.active = false;
    return {
      goal: codexGoal(goal),
      message:
        body.action === 'set'
          ? original
            ? 'Goal 已替换。'
            : 'Goal 已设置。'
          : body.action === 'clear'
            ? '当前 Goal 已清空。'
            : body.action === 'edit'
              ? 'Goal 已修改。'
              : body.action === 'pause'
                ? '当前 Goal 已暂停。'
                : '当前 Goal 已继续。',
    };
  }
}
module.exports = { GoalActions, revision, editor, editorInputMatches, readPaneGoal };

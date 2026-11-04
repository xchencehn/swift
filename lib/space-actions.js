'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const Conversation = require('./conversation-state');
const { apiError } = require('./message-queue');
const { interruptPane } = require('./herdr-input');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = (value) => structuredClone(value);
const actions = new Set(['stop', 'restart', 'send']);

class SpaceActions {
  constructor({
    herdr,
    exactPane,
    operate,
    restart,
    file,
    beforeControl = async () => {},
    onChange = () => {},
    interrupt = interruptPane,
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      operate,
      restart,
      file,
      beforeControl,
      onChange,
      interrupt,
    });
    this.jobs = [];
    this.running = new Map();
    if (file && fs.existsSync(file)) {
      this.jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs || [];
      for (const job of this.jobs) {
        for (const item of job.items)
          if (['pending', 'running'].includes(item.status))
            Object.assign(item, {
              status: item.status === 'pending' ? 'failed' : 'uncertain',
              message:
                item.status === 'pending'
                  ? 'Swift 重启前尚未执行。'
                  : 'Swift 重启前未收到最终结果，请核对会话；不会自动重试。',
            });
        job.done = true;
      }
      this.persist(false);
    }
  }
  persist(notify = true) {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ version: 1, jobs: this.jobs }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    }
    if (notify) this.onChange();
  }
  public(job) {
    if (!job) return null;
    const result = copy(job);
    delete result.fingerprint;
    return result;
  }
  get(requestId) {
    const job = this.jobs.find((j) => j.requestId === requestId);
    if (!job) throw apiError(404, 'SPACE_ACTION_NOT_FOUND', '没有找到这次操作。');
    return this.public(job);
  }
  async preview(workspaceId, paneId = null) {
    const view = await this.herdr.dashboard();
    const workspace = view.workspaces.find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw apiError(404, 'SPACE_NOT_FOUND', '这个 Space 已关闭。');
    const panes = view.panes.filter(
      (p) => p.workspaceId === workspaceId && p.agent && (!paneId || p.paneId === paneId),
    );
    const targets = await Promise.all(
      panes.map(async (pane) => {
        try {
          const exact = await this.exactPane(pane.paneId);
          if (exact.workspaceId !== workspaceId || exact.terminalId !== pane.terminalId)
            throw new Error('会话已变化');
          return {
            paneId: exact.paneId,
            terminalId: exact.terminalId,
            sessionId: exact.agent?.session?.value || '',
            binding: Conversation.binding(exact),
            provider: exact.agent?.label,
            name: pane.tab || pane.agent.name || pane.paneId,
            runtimeId: exact.runtimeId || '',
            available: Boolean(exact.runtimeId),
          };
        } catch {
          return {
            paneId: pane.paneId,
            name: pane.tab || pane.paneId,
            provider: pane.agent.label,
            available: false,
          };
        }
      }),
    );
    return {
      workspaceId,
      label: workspace.label,
      runtimeId: view.runtimeId,
      targets,
      recent: this.public(
        this.jobs.findLast(
          (job) => job.workspaceId === workspaceId && job.runtimeId === view.runtimeId,
        ),
      ),
    };
  }
  async validate(job, item) {
    const view = await this.herdr.dashboard();
    if (view.runtimeId !== job.runtimeId)
      throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 已重启，请重新打开 Space 菜单。');
    const member = view.panes.find((p) => p.paneId === item.paneId);
    if (!member || member.workspaceId !== job.workspaceId || member.terminalId !== item.terminalId)
      throw apiError(409, 'SPACE_CHANGED', '会话已离开这个 Space，未执行操作。');
    const pane = await this.exactPane(item.paneId);
    if (!item.available || !pane.runtimeId || Conversation.binding(pane) !== item.binding)
      throw apiError(409, 'SESSION_CHANGED', '会话进程已变化，请刷新后操作。');
    if (job.action !== 'stop' && pane.agent?.label !== 'codex')
      throw apiError(409, 'CODEX_REQUIRED', '这个会话不是 Codex。');
    return pane;
  }
  async start(body, queue) {
    if (
      !body ||
      !actions.has(body.action) ||
      !/^[\w-]{1,128}$/.test(body.requestId || '') ||
      typeof body.workspaceId !== 'string' ||
      !body.runtimeId ||
      !Array.isArray(body.targets) ||
      body.targets.length > 256 ||
      !body.targets.length ||
      body.targets.some((t) => !t || typeof t.paneId !== 'string') ||
      new Set(body.targets.map((t) => t.paneId)).size !== body.targets.length
    )
      throw apiError(400, 'INVALID_SPACE_ACTION', '请选择 Space 中的会话后重试。');
    if (
      body.action === 'send' &&
      (typeof body.text !== 'string' ||
        !body.text.trim() ||
        Buffer.byteLength(body.text) > 100 * 1024 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(body.text.replace(/\r\n/g, '\n')))
    )
      throw apiError(400, 'INVALID_MESSAGE', '请输入有效消息，不能包含终端控制字符。');
    const fingerprint = hash(body),
      recorded = this.jobs.find((j) => j.requestId === body.requestId);
    if (recorded) {
      if (recorded.fingerprint !== fingerprint)
        throw apiError(409, 'SPACE_ACTION_CONFLICT', '同一请求不能执行不同操作。');
      return this.public(recorded);
    }
    if (this.jobs.some((j) => !j.done && j.workspaceId === body.workspaceId))
      throw apiError(409, 'SPACE_ACTION_BUSY', '这个 Space 的上一批操作仍在进行，请查看操作结果。');
    if (this.running.size >= 16)
      throw apiError(429, 'SPACE_ACTION_LIMIT', '批量操作较多，请稍后重试。');
    const view = await this.herdr.dashboard();
    if (
      view.runtimeId !== body.runtimeId ||
      !view.workspaces.some((w) => w.workspaceId === body.workspaceId)
    )
      throw apiError(409, 'SPACE_CHANGED', 'Space 已变化，请重新打开菜单。');
    // Recheck after the async snapshot, before claiming the request ID.
    if (
      this.jobs.some(
        (j) => j.requestId === body.requestId || (!j.done && j.workspaceId === body.workspaceId),
      )
    )
      return this.start(body, queue);
    const job = {
      requestId: body.requestId,
      fingerprint,
      action: body.action,
      workspaceId: body.workspaceId,
      runtimeId: body.runtimeId,
      createdAt: Date.now(),
      done: false,
      items: body.targets.map((t) => ({
        paneId: t.paneId,
        terminalId: t.terminalId,
        sessionId: t.sessionId || '',
        binding: t.binding,
        available: t.available,
        name: String(t.name || t.paneId).slice(0, 200),
        status: 'pending',
        message: '等待执行',
      })),
    };
    this.jobs = this.jobs.filter((j) => !j.done || Date.now() - j.createdAt < 7 * 86400000);
    while (this.jobs.length >= 128) {
      const at = this.jobs.findIndex((j) => j.done);
      if (at < 0) break;
      this.jobs.splice(at, 1);
    }
    this.jobs.push(job);
    this.persist();
    const work = Promise.all(job.items.map((item) => this.runItem(job, item, body.text, queue)))
      .then(() => {
        job.done = true;
        this.persist();
      })
      .finally(() => this.running.delete(job.requestId));
    this.running.set(job.requestId, work);
    work.catch(() => {});
    return this.public(job);
  }
  async runItem(job, item, text, queue) {
    let wrote = false;
    const progress = (message) => {
      item.message = message;
      this.persist();
    };
    try {
      item.status = 'running';
      this.persist();
      const run = async () => {
        const pane = await this.validate(job, item);
        if (job.action === 'send') {
          progress('正在发送…');
          const receipt = await queue.submitNative({
            id: `space-${job.requestId}-${hash(item.paneId).slice(0, 16)}`,
            paneId: item.paneId,
            binding: item.binding,
            sessionId: item.sessionId || null,
            text,
            spaceWorkspaceId: job.workspaceId,
          });
          if (receipt.status !== 'dispatched')
            throw Object.assign(new Error(receipt.error?.message || '投递未确认，请查看会话。'), {
              deliveryUncertain: receipt.deliveryUncertain,
            });
          return { message: '已发送。' };
        }
        await this.beforeControl(pane);
        if (job.action === 'stop') {
          progress('正在发送 Esc…');
          await this.validate(job, item);
          wrote = true;
          await this.interrupt(item.paneId, { socketFile: this.herdr.socketPath });
          queue.interrupted(pane);
          return { message: '已发送 Esc。' };
        }
        return this.restart.restart(pane, {
          validate: async () => {
            await this.validate(job, item);
            wrote = true;
          },
          progress,
        });
      };
      // MessageQueue owns the same per-Pane lock; do not acquire it recursively.
      const result = job.action === 'send' ? await run() : await this.operate(item.paneId, run);
      Object.assign(item, result, { status: result.attention ? 'attention' : 'succeeded' });
    } catch (error) {
      Object.assign(item, {
        status:
          error.deliveryUncertain === false || (!wrote && !error.deliveryUncertain)
            ? 'failed'
            : 'uncertain',
        message: error.message || '操作失败，请查看会话。',
      });
    }
    this.persist();
  }
}
module.exports = { SpaceActions };

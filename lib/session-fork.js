'use strict';
const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('./root-data');
const { withinRoot } = require('./root-scope');
const { apiError } = require('./message-queue');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unknown = 'Fork 结果尚未确认，请查看已创建的 Tab；Swift 不会自动重复创建。';
// One controller per root/socket within this execution process, including
// callers constructed by adapters. Separate Herdr sockets never share files.
const stores = new Map(),
  running = new Map(),
  parents = new Set();

// Receipts survive a server restart. An interrupted native mutation is never
// replayed: the child may already exist even when its reply was lost.
class SessionFork {
  constructor({ herdr, exactPane, native, data, onChange = () => {} }) {
    Object.assign(this, { herdr, exactPane, native, data, onChange });
    this.scope = herdr.socketPath ? digest(herdr.socketPath).slice(0, 16) : '';
    this.stores = stores;
    this.running = running;
    this.parents = parents;
  }
  store() {
    const data = this.data(),
      file = data.file(`state/session-forks${this.scope ? '-' + this.scope : ''}.json`);
    if (!this.stores.has(file)) {
      const stored = readJson(file, { version: 1, jobs: {} });
      if (
        stored?.version !== 1 ||
        !stored.jobs ||
        typeof stored.jobs !== 'object' ||
        Array.isArray(stored.jobs)
      )
        throw apiError(500, 'FORK_RECEIPTS_INVALID', '无法读取 Fork 操作记录，请检查执行端。');
      for (const [id, entry] of Object.entries(stored.jobs)) {
        if (
          !/^[a-zA-Z0-9][\w-]{0,99}$/.test(id) ||
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint || '') ||
          !/^[a-f0-9]{64}$/.test(entry.parentKey || '') ||
          !entry.job ||
          typeof entry.job !== 'object' ||
          Array.isArray(entry.job) ||
          entry.job.requestId !== id ||
          !['running', 'succeeded', 'failed', 'uncertain'].includes(entry.job.status) ||
          typeof entry.job.phase !== 'string'
        )
          throw apiError(500, 'FORK_RECEIPTS_INVALID', 'Fork 操作记录不完整。');
      }
      for (const entry of Object.values(stored.jobs)) {
        if (entry.job.status === 'running')
          Object.assign(entry.job, {
            status: 'uncertain',
            message: unknown,
            code: 'FORK_SERVER_RESTARTED',
          });
      }
      writeJson(file, stored);
      this.stores.set(file, { file, directory: data.directory, stored });
    }
    return this.stores.get(file);
  }
  get(id) {
    const jobs = this.store().stored.jobs;
    const entry = Object.hasOwn(jobs, id) && jobs[id];
    if (!entry)
      throw apiError(
        404,
        'FORK_RECEIPT_UNKNOWN',
        '尚未找到这次 Fork 的操作记录；不会自动重发，请查看 Tab 列表。',
      );
    return structuredClone(entry.job);
  }
  async target(body, directory, processRuntimeId) {
    const runtimeId = this.herdr.normalizeSnapshot
      ? this.herdr.normalizeSnapshot({}).runtimeId
      : (await this.herdr.dashboard()).runtimeId;
    if (body.runtimeId !== runtimeId)
      throw apiError(409, 'RUNTIME_CHANGED', 'Herdr 运行实例已改变，请重新打开菜单。');
    const pane = await this.exactPane(body.paneId);
    if (
      !/^codex$/i.test(pane?.agent?.label || '') ||
      !pane.runtimeId ||
      pane.terminalId !== body.terminalId ||
      pane.agent.session?.value !== body.sessionId ||
      (processRuntimeId && processRuntimeId !== pane.runtimeId)
    )
      throw apiError(409, 'SESSION_CHANGED', 'Fork 目标会话已改变，请重新打开菜单。');
    if (!withinRoot(directory, pane.cwd || pane.baseCwd || ''))
      throw apiError(409, 'ROOT_CHANGED', '这个会话不在当前根目录内。');
    return pane;
  }
  start(body) {
    if (
      !body ||
      !/^[a-zA-Z0-9][\w-]{0,99}$/.test(body.requestId || '') ||
      ['runtimeId', 'paneId', 'terminalId', 'sessionId'].some(
        (key) => typeof body[key] !== 'string' || !body[key] || body[key].length > 256,
      )
    )
      throw apiError(400, 'INVALID_FORK_REQUEST', 'Fork 操作标识或会话身份无效。');
    if (body.sideId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.sideId))
      throw apiError(400, 'INVALID_SIDE_ID', '临时会话身份无效。');
    const binding = Object.fromEntries(
      ['runtimeId', 'paneId', 'terminalId', 'sessionId', 'processRuntimeId'].map((key) => [
        key,
        body[key] || '',
      ]),
    );
    if (body.sideId) binding.sideId = body.sideId;
    const fingerprint = digest(binding),
      store = this.store(),
      previous =
        Object.hasOwn(store.stored.jobs, body.requestId) && store.stored.jobs[body.requestId];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw apiError(409, 'FORK_REQUEST_CHANGED', '同一操作标识不能用于其他 Fork 目标。');
      return structuredClone(previous.job);
    }
    const parentKey = digest([binding.runtimeId, binding.terminalId, binding.sessionId]);
    if (this.parents.has(parentKey))
      throw apiError(409, 'FORK_BUSY', '这个会话的 Fork 正在创建，请等待当前操作完成。');
    if (Object.keys(store.stored.jobs).length >= 10000)
      throw apiError(409, 'FORK_RECEIPTS_FULL', 'Fork 操作记录已满，请检查执行端。');
    const job = { requestId: body.requestId, status: 'running', phase: 'validating' };
    store.stored.jobs[body.requestId] = { fingerprint, parentKey, job };
    try {
      writeJson(store.file, store.stored);
    } catch (error) {
      delete store.stored.jobs[body.requestId];
      throw error;
    }
    this.parents.add(parentKey);
    const progress = async (fields) => {
      const next = { ...job, ...fields };
      writeJson(store.file, {
        ...store.stored,
        jobs: { ...store.stored.jobs, [body.requestId]: { fingerprint, parentKey, job: next } },
      });
      Object.assign(job, next);
    };
    const work = Promise.resolve()
      .then(async () => {
        const pane = await this.target(binding, store.directory, binding.processRuntimeId);
        const validate = async () => {
          const fresh = await this.target(binding, store.directory, pane.runtimeId);
          if (
            fresh.tabId !== pane.tabId ||
            fresh.workspaceId !== pane.workspaceId ||
            (fresh.cwd || fresh.baseCwd) !== (pane.cwd || pane.baseCwd)
          )
            throw apiError(409, 'FORK_TARGET_MOVED', '原会话的 Tab 或目录已改变，请重新打开菜单。');
          return fresh;
        };
        return this.native.run(pane, { validate, progress, sideId: binding.sideId || null });
      })
      .then(async (result) => {
        await progress({ ...result, status: 'succeeded', phase: 'complete' });
      })
      .catch(async (error) => {
        const uncertain = Boolean(error?.deliveryUncertain || error?.uncertain);
        const partial = Object.fromEntries(
          ['phase', 'sessionId', 'tabId', 'paneId', 'terminalId', 'goalPaused', 'goalStatus']
            .filter((key) => Object.hasOwn(error?.partial || {}, key))
            .map((key) => [key, error.partial[key]]),
        );
        try {
          await progress({
            ...partial,
            status: uncertain ? 'uncertain' : 'failed',
            code: error?.code || 'FORK_FAILED',
            message: error?.message || unknown,
          });
        } catch {
          Object.assign(job, partial, {
            status: 'uncertain',
            message: unknown,
            code: 'FORK_RECEIPT_WRITE_FAILED',
          });
        }
      })
      .finally(() => {
        this.parents.delete(parentKey);
        this.running.delete(`${store.file}:${body.requestId}`);
        this.onChange();
      });
    this.running.set(`${store.file}:${body.requestId}`, work);
    return structuredClone(job);
  }
}
module.exports = { SessionFork };

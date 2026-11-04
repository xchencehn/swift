'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { NativeWatch } = require('./codex-rewind-watch');
const { surface } = require('./codex-rewind-native');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frameWaitExpired = Symbol('frameWaitExpired');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code, message) =>
  Object.assign(new Error(message), { code, status: 409, deliveryUncertain: false });
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));
const binding = (pane) => [
  pane?.paneId,
  pane?.terminalId,
  pane?.workspaceId,
  pane?.tabId,
  pane?.runtimeId,
  pane?.agent?.label,
  pane?.agent?.session?.kind ?? null,
  pane?.agent?.session?.value,
];

function snapshotGuard(snapshot, pane) {
  if (snapshot.focused_pane_id !== pane.paneId)
    throw error('NATIVE_REFRESH_NOT_FOCUSED', '原生焦点已改变，未调整终端尺寸。');
  const nativePane = snapshot.panes?.find((item) => item.pane_id === pane.paneId);
  const layout = snapshot.layouts?.find((item) => item.tab_id === nativePane?.tab_id);
  if (
    !nativePane ||
    nativePane.terminal_id !== pane.terminalId ||
    !layout ||
    (pane.workspaceId && nativePane.workspace_id !== pane.workspaceId) ||
    (pane.tabId && nativePane.tab_id !== pane.tabId)
  )
    throw error('NATIVE_REFRESH_TARGET_CHANGED', '原生终端身份或布局已改变，未调整尺寸。');
  const agent = snapshot.agents?.find(
    (item) => (item.pane_id || item.terminal?.pane_id) === pane.paneId,
  );
  return structuredClone({
    focus: pick(snapshot, ['focused_pane_id', 'focused_workspace_id', 'focused_tab_id']),
    pane: pick(nativePane, ['pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'agent_session']),
    paneAgent: agent
      ? pick(agent, ['id', 'pane_id', 'terminal_id', 'session_ref', 'agent_session'])
      : null,
    layout,
  });
}

async function processIdentity(pane) {
  const match = /^(\d+):(\d+)$/.exec(pane.runtimeId || '');
  if (!match) throw error('NATIVE_REFRESH_PROCESS_UNKNOWN', '缺少可核验的 Codex 进程身份。');
  const pid = Number(match[1]),
    prefix = `/proc/${pid}`;
  const [stat, comm, tty] = await Promise.all([
    fs.readFile(`${prefix}/stat`, 'utf8'),
    fs.readFile(`${prefix}/comm`, 'utf8'),
    fs.readlink(`${prefix}/fd/0`),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (
    fields[19] !== match[2] ||
    comm.trim() !== 'codex' ||
    !/^\/dev\/pts\/\d+$/.test(tty) ||
    !Number(fields[4]) ||
    Number(fields[2]) <= 0 ||
    fields[2] !== fields[5]
  )
    throw error('NATIVE_REFRESH_PROCESS_CHANGED', 'Codex 的进程、前台进程组或终端已改变。');
  return { pid, start: match[2], tty, pgrp: Number(fields[2]), ttyNr: Number(fields[4]) };
}

async function socketIdentity(socketPath) {
  const stat = await fs.lstat(socketPath, { bigint: true });
  if (!stat.isSocket())
    throw error('NATIVE_REFRESH_SOCKET_CHANGED', 'Herdr 连接已改变，未调整终端。');
  return { dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs) };
}

class RefreshHelper {
  constructor(config, { spawnProcess = spawn, timeoutMs = 11000 } = {}) {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.failure = null;
    this.child = spawnProcess(
      'python3',
      ['-I', '-u', path.join(__dirname, 'codex-terminal-refresh.py')],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      },
    );
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    let wire = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      wire += chunk;
      if (wire.length > 1024 * 1024)
        return this.invalidate(error('NATIVE_REFRESH_PROTOCOL', '终端恢复响应过大。'));
      let newline;
      while ((newline = wire.indexOf('\n')) >= 0) {
        const line = wire.slice(0, newline);
        wire = wire.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return this.invalidate(error('NATIVE_REFRESH_PROTOCOL', '终端恢复响应无法解析。'));
        }
        if (!message || typeof message.type !== 'string')
          return this.invalidate(error('NATIVE_REFRESH_PROTOCOL', '终端恢复响应无效。'));
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.queue.push(message);
      }
    });
    this.child.stderr.resume(); // Never log private environment or process arguments.
    this.child.on('error', () =>
      this.invalidate(error('NATIVE_REFRESH_HELPER_UNAVAILABLE', '无法启动本机终端恢复工具。')),
    );
    this.child.on('close', (code, signal) => {
      this.closed = true;
      clearTimeout(this.timer);
      this.resolveClosed();
      this.invalidate(
        error(
          code === 0 && !signal ? 'NATIVE_REFRESH_HELPER_CLOSED' : 'NATIVE_REFRESH_HELPER_FAILED',
          '终端恢复工具已退出，请核对本次结果。',
        ),
      );
    });
    this.child.stdin.on('error', () =>
      this.invalidate(error('NATIVE_REFRESH_HELPER_CLOSED', '终端恢复工具的输入连接已关闭。')),
    );
    this.timer = setTimeout(
      () => this.invalidate(error('NATIVE_REFRESH_TIMEOUT', '终端恢复工具响应超时。')),
      timeoutMs,
    );
    this.timer.unref?.();
    this.child.stdin.write(JSON.stringify(config) + '\n');
  }
  invalidate(cause) {
    if (!this.failure) this.failure = cause;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }
  async next(type) {
    // A clean EOF may follow the final queued acknowledgement immediately.
    // A timeout or protocol failure must never be hidden by earlier messages.
    if (this.failure && this.failure.code !== 'NATIVE_REFRESH_HELPER_CLOSED') throw this.failure;
    let message;
    if (this.queue.length) message = this.queue.shift();
    else {
      if (this.failure) throw this.failure;
      message = await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    if (message.type !== type) {
      const cause = error(
        message.code || 'NATIVE_REFRESH_UNCONFIRMED',
        '原生终端恢复未能确认，未继续发送内容。',
      );
      cause.refreshObservation = message;
      throw cause;
    }
    return message;
  }
  command(command) {
    if (this.failure || this.closed || !this.child.stdin.writable)
      throw this.failure || error('NATIVE_REFRESH_HELPER_CLOSED', '终端恢复工具已关闭。');
    this.child.stdin.write(JSON.stringify({ command }) + '\n');
  }
  async close() {
    if (!this.closed && this.child.stdin.writable) {
      // The helper alone owns its held FD and cleanup. No second process opens
      // the tty to restore it, including when this connection has failed.
      try {
        this.child.stdin.end(JSON.stringify({ command: 'abort' }) + '\n');
      } catch {}
    }
    const wait = (ms) =>
      Promise.race([this.closedPromise.then(() => true), delay(ms).then(() => false)]);
    if (!(await wait(2500))) {
      try {
        this.child.kill('SIGTERM');
      } catch {}
      if (!(await wait(2500))) {
        try {
          this.child.kill('SIGKILL');
        } catch {}
        await this.closedPromise;
      }
    }
    clearTimeout(this.timer);
  }
}

class CodexTerminalRefresh {
  constructor({
    herdr,
    exactPane,
    readScreen,
    startHelper = (config) => new RefreshHelper(config),
    readIdentity = processIdentity,
    readSocketIdentity = socketIdentity,
    platform = process.platform,
    cooldownMs = 2000,
    frameTimeoutMs = 2000,
    stepMs = 40,
    now = () => performance.now(),
  }) {
    Object.assign(this, {
      herdr,
      exactPane,
      readScreen,
      startHelper,
      readIdentity,
      readSocketIdentity,
      platform,
      cooldownMs,
      frameTimeoutMs,
      stepMs,
      now,
    });
    this.inflight = new Map();
    this.lastAttempt = new Map();
  }
  refresh(options) {
    const { pane, requestId, reason } = options || {};
    if (
      this.platform !== 'linux' ||
      reason !== 'prewrite-unknown' ||
      !/^[\w:.-]{1,200}$/.test(requestId || '') ||
      !pane?.paneId ||
      !pane.terminalId ||
      !pane.runtimeId ||
      pane.agent?.label !== 'codex' ||
      !pane.agent?.session?.value
    )
      return Promise.reject(
        error('NATIVE_REFRESH_UNAVAILABLE', '本次操作不具备原生终端恢复条件。'),
      );
    const key = digest(binding(pane)),
      active = this.inflight.get(key);
    if (active)
      return active.requestId === requestId
        ? active.promise
        : Promise.reject(error('NATIVE_REFRESH_BUSY', '该终端正在恢复，请等待本次结果。'));
    const previous = this.lastAttempt.get(key);
    if (previous !== undefined && this.now() - previous < this.cooldownMs)
      return Promise.reject(error('NATIVE_REFRESH_COOLDOWN', '终端刚刚尝试恢复，请稍后再次发送。'));
    const pending = this.apply(options, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, { requestId, promise: pending });
    return pending;
  }
  async apply({ pane, requestId, verify = async () => {} }, key) {
    const expectedBinding = digest(binding(pane));
    let expectedGuard, expectedSocket, expectedProcess, watch, helper;
    const check = async () => {
      await verify();
      const current = await this.exactPane(pane.paneId);
      if (digest(binding(current)) !== expectedBinding)
        throw error('NATIVE_REFRESH_TARGET_CHANGED', '原生会话或进程已改变，未继续恢复。');
      const identity = await this.readIdentity(current);
      const info = await this.herdr.readProcessInfo(pane.paneId);
      if (
        !info.foreground_processes?.some((item) => item.pid === identity.pid) ||
        (info.foreground_process_group_id && info.foreground_process_group_id !== identity.pgrp)
      )
        throw error('NATIVE_REFRESH_PROCESS_CHANGED', 'Codex 已不在原终端前台，未继续恢复。');
      const guard = snapshotGuard(await this.herdr.snapshot(), current);
      const socket = await this.readSocketIdentity(this.herdr.socketPath);
      if (
        expectedGuard &&
        (digest(guard) !== digest(expectedGuard) ||
          digest(socket) !== digest(expectedSocket) ||
          digest(identity) !== digest(expectedProcess))
      )
        throw error('NATIVE_REFRESH_OWNER_CHANGED', '终端焦点、布局或控制方已改变，未继续恢复。');
      return { identity, guard, socket };
    };
    const read = async () => {
      await check();
      if (!this.readScreen && !watch)
        watch = new NativeWatch({ herdr: this.herdr, pane, timeoutMs: this.frameTimeoutMs });
      const frame = await (this.readScreen ? this.readScreen(pane) : watch.read());
      await check();
      if (!Number.isSafeInteger(frame.frameSequence) || !frame.watchId)
        throw error('NATIVE_REFRESH_FRAME_UNKNOWN', '缺少本次原生观察帧，未继续恢复。');
      return { frame, state: surface(frame) };
    };
    const fullMain = (view) => view.state.mode === 'main' && view.state.composer?.cursorIn === true;
    const nextFrame = async (previous, predicate = () => true) => {
      const deadline = this.now() + this.frameTimeoutMs;
      do {
        const view = await read();
        if (view.frame.watchId !== previous.frame.watchId)
          throw error('NATIVE_REFRESH_OBSERVER_CHANGED', '原生观察流已改变，未复用旧画面。');
        if (view.frame.frameSequence > previous.frame.frameSequence && predicate(view)) return view;
        await delay(this.stepMs);
      } while (this.now() < deadline);
      const cause = error('NATIVE_REFRESH_UNCONFIRMED', '未确认原生画面恢复，本次内容未发送。');
      cause[frameWaitExpired] = true;
      throw cause;
    };
    try {
      const initial = await check();
      expectedGuard = initial.guard;
      expectedSocket = initial.socket;
      expectedProcess = initial.identity;
      let view = await read();
      if (fullMain(view)) return { ok: true, refreshed: false, mainConfirmed: true, requestId };
      if (view.state.mode !== 'unknown')
        throw error('NATIVE_REFRESH_NOT_UNKNOWN', '原生界面状态已有变化，未触发画面恢复。');
      helper = this.startHelper({
        ...initial.identity,
        socketPath: this.herdr.socketPath,
        socketIdentity: initial.socket,
        guard: initial.guard,
        timeoutMs: 8000,
      });
      const prepared = await helper.next('prepared');
      await check();
      view = await read();
      if (fullMain(view)) return { ok: true, refreshed: false, mainConfirmed: true, requestId };
      if (view.state.mode !== 'unknown')
        throw error('NATIVE_REFRESH_STATE_CHANGED', '原生界面已切换，未触发恢复。');
      this.lastAttempt.set(key, this.now());
      for (const [other, stamp] of this.lastAttempt)
        if (this.now() - stamp >= this.cooldownMs) this.lastAttempt.delete(other);
      while (this.lastAttempt.size > 256)
        this.lastAttempt.delete(this.lastAttempt.keys().next().value);
      await check();
      helper.command('narrow');
      await helper.next('narrowed');
      let narrowed = view,
        temporaryViewConfirmed = false;
      try {
        narrowed = await nextFrame(view, (current) => {
          narrowed = current;
          return fullMain(current);
        });
        temporaryViewConfirmed = true;
      } catch (cause) {
        // The temporary kernel width differs from Herdr's logical VT width.
        // Only an expired paint wait may proceed to the helper's guarded CAS
        // restore; identity, ownership and observer failures still abort.
        if (!cause[frameWaitExpired]) throw cause;
      }
      await check();
      helper.command('restore');
      await helper.next('restored');
      const restored = await nextFrame(narrowed, fullMain);
      await check();
      return {
        ok: true,
        refreshed: true,
        mainConfirmed: fullMain(restored),
        requestId,
        method: 'tty-winsize',
        originalSize: prepared.original,
        temporaryViewConfirmed,
      };
    } finally {
      try {
        if (helper) await helper.close();
      } finally {
        if (watch) await watch.close();
      }
    }
  }
}

module.exports = {
  CodexTerminalRefresh,
  RefreshHelper,
  snapshotGuard,
  processIdentity,
  socketIdentity,
};

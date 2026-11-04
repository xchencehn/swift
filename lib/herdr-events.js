'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 订阅 Herdr 的变更事件,取代「4 秒轮一次」。
 *
 * 🔑 为什么值得做:轮询的延迟是「最坏一整个间隔」,而 agent 的状态跳变(开始干活、
 * 被挡住要审批、跑完了)恰恰是最需要立刻看见的。Herdr 本来就能主动推,
 * 本机的企微通知机器人已经在生产里这么用了。
 *
 * 🔑 用法是「事件只当唤醒信号」,不是「用事件增量更新状态」:收到任何一条就重拉一次
 * `session.snapshot`(9ms 给全 13 个工作区)整体替换。理由是事件种类多、语义细,
 * 逐条打补丁迟早和真相漂移;重拉一次便宜且永远对。
 *
 * 已知的四个坑(都踩过或验证过,别再踩):
 *   ⚠️ 一个连接只处理一个请求就被服务端关掉 —— `events.subscribe` 是唯一例外,
 *      它把连接当事件流保持打开。所以这里**专开一条连接**只用来订阅。
 *   ⚠️ `pane.agent_status_changed` **没有通配**,必须逐 pane 订阅。pane 集合一变
 *      就得整批重订 —— 所以同时订阅 `pane.created`,拿它当「该重订了」的信号。
 *   ⚠️ `events.wait` 名不副实,只支持 agent 状态匹配,别拿它当通用等待。
 *   ⚠️ `pane.output_matched` 是一次性的(订阅那刻对既有内容匹配一次),不能当持续流。
 */

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const session = process.env.HERDR_SESSION || 'default';
  return path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock');
}

class HerdrEvents {
  /**
   * @param {object} options
   * @param {() => Promise<string[]>} options.listPaneIds 当前有哪些 pane(用于逐个订阅)
   * @param {() => void} options.onChange 收到任何变更时调用(调用方去重拉快照)
   * @param {(message: string) => void} [options.onLog]
   */
  constructor({ listPaneIds, onChange, onLog = () => {} }) {
    this.listPaneIds = listPaneIds;
    this.onChange = onChange;
    this.onLog = onLog;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
    this.retryMs = 1000;
    this.paneKey = '';
    this.resubscribeTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect().catch((error) => this.onLog(`subscribe failed: ${error.message}`));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.resubscribeTimer);
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async connect() {
    if (this.stopped) return;
    const file = socketPath();
    if (!fs.existsSync(file)) {
      // Herdr 没在跑就安静退避重试 —— 这不是错误,开发机上很常见。
      return this.scheduleReconnect('socket not present');
    }
    const paneIds = await this.listPaneIds().catch(() => []);
    this.paneKey = paneIds.join(',');

    if (this.stopped) return;
    this.buffer = '';
    const socket = net.createConnection(file);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.retryMs = 1000;
      const subscriptions = [
        { type: 'pane.created' },
        { type: 'pane.closed' },
        { type: 'pane.agent_detected' },
        { type: 'workspace.created' },
        { type: 'workspace.closed' },
        { type: 'workspace.updated' },
        { type: 'workspace.renamed' },
        { type: 'workspace.moved' },
        { type: 'workspace.reordered' },
        { type: 'workspace.focused' },
        { type: 'tab.created' },
        { type: 'tab.closed' },
        { type: 'tab.renamed' },
        { type: 'tab.moved' },
        { type: 'tab.focused' },
        { type: 'pane.updated' },
        { type: 'pane.moved' },
        { type: 'pane.focused' },
        { type: 'pane.exited' },
        { type: 'layout.updated' },
        // 逐 pane 订阅状态跳变 —— 没有通配,只能这么写
        ...paneIds.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
      ];
      socket.write(
        `${JSON.stringify({
          id: 'swift-events',
          method: 'events.subscribe',
          params: { subscriptions },
        })}\n`,
      );
      this.onLog(`subscribed: ${paneIds.length} panes`);
    });
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', (error) => this.scheduleReconnect(error.message));
    socket.on('close', () => this.scheduleReconnect('closed'));
  }

  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.buffer = '';
      this.scheduleReconnect('event frame too large');
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // 订阅确认不是变更,别拿它触发一次刷新
      if (message?.result?.type === 'subscription_started') {
        if (this.hasSubscribed) this.onChange();
        this.hasSubscribed = true;
        continue;
      }
      if (message?.error) {
        this.onLog(`event error: ${message.error.message}`);
        continue;
      }
      this.onChange();
      // pane 集合可能变了 —— 重订一次,否则新 pane 的状态跳变永远收不到。
      // 合并抖动:一串连续事件只重订一次。
      const type = message?.params?.type || message?.event || message?.method || '';
      if (/pane[._](created|closed)|agent_detected/.test(String(type))) this.scheduleResubscribe();
    }
  }

  scheduleResubscribe() {
    clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = setTimeout(async () => {
      const paneIds = await this.listPaneIds().catch(() => []);
      if (paneIds.join(',') === this.paneKey) return; // 集合没变就别白重连
      this.onLog('pane set changed, resubscribing');
      if (this.socket) this.socket.destroy();
    }, 400);
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30000); // 指数退避,封顶 30s
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), wait);
    this.onLog(`reconnect in ${wait}ms (${reason})`);
  }
}

module.exports = { HerdrEvents, socketPath };

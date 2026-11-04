'use strict';
const pty = require('node-pty');
const { spawn } = require('node:child_process');
const { WatchStreamParser } = require('./watch-stream');
const { TerminalScreen } = require('./terminal-screen');
const { randomUUID } = require('node:crypto');
const { createOutputControl } = require('./output-control');
const { createScreenOutput } = require('./screen-output');
const { createJsonOutput } = require('./json-output');
const { WebSocketServer, WebSocket } = require('ws');
const { clampInt } = require('./herdr-client');
const { deviceId } = require('./root-preferences');

function createTerminalTransport({
  server,
  herdr,
  basePath: BASE_PATH,
  maxInputBytes: MAX_WS_INPUT_BYTES,
  isAuthorized,
  getCwd,
  onSync = () => {},
  diagnostics,
}) {
  const rawTerminals = new Set();
  const sockets = new Set();
  function publicControllerState() {
    return [...rawTerminals].map((entry) => ({
      terminalId: 'herdr-client',
      connectedAt: entry.connectedAt,
      client: entry.client,
      transport: 'raw-pty',
    }));
  }

  function controllerOwnerLabel(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    return forwarded || req.socket.remoteAddress || 'unknown';
  }

  function safeWsSend(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    ws.jsonOutput ||= createJsonOutput(ws);
    return ws.jsonOutput.send(value);
  }

  function rawTerminalEnvironment() {
    const env = herdr.env({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'agent-studio',
    });
    for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID'])
      delete env[key];
    return env;
  }

  function stopRawTerminal(entry) {
    if (!entry || entry.stopped) return;
    entry.stopped = true;
    rawTerminals.delete(entry);
    entry.output?.stop();
    try {
      entry.dataDisposable?.dispose();
    } catch {}
    try {
      entry.exitDisposable?.dispose();
    } catch {}
    try {
      entry.pty.kill();
    } catch {}
  }

  function attachRawTerminal(ws, req, url) {
    const cols = clampInt(url.searchParams.get('cols'), 20, 400, 100);
    const rows = clampInt(url.searchParams.get('rows'), 5, 200, 32);
    const args = herdr.session ? ['--session', herdr.session] : [];
    let child;
    try {
      child = pty.spawn(herdr.bin, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: getCwd(),
        env: rawTerminalEnvironment(),
      });
    } catch (error) {
      safeWsSend(ws, { type: 'terminal.error', code: 'PTY_SPAWN_FAILED', message: error.message });
      ws.close(1011, 'PTY spawn failed');
      return;
    }

    const entry = {
      ws,
      pty: child,
      connectedAt: new Date().toISOString(),
      client: controllerOwnerLabel(req),
      stopped: false,
      dataDisposable: null,
      exitDisposable: null,
    };
    entry.output = createOutputControl({
      ws,
      acknowledged: ws.flowAcknowledged,
      pause: () => child.pause(),
      resume: () => child.resume(),
    });
    ws.rawTerminalEntry = entry;
    rawTerminals.add(entry);
    safeWsSend(ws, {
      type: 'terminal.ready',
      transport: 'raw-pty',
      session: herdr.session || 'default',
      cols,
      rows,
    });

    entry.dataDisposable = child.onData((data) => {
      entry.output.write(Buffer.from(data, 'utf8'));
    });
    entry.exitDisposable = child.onExit(({ exitCode, signal }) => {
      rawTerminals.delete(entry);
      entry.output.stop();
      if (entry.stopped) return;
      entry.stopped = true;
      safeWsSend(ws, { type: 'terminal.exit', exitCode, signal });
      ws.close(exitCode === 0 ? 1000 : 1011, 'raw terminal exited');
    });

    ws.on('message', (raw, isBinary) => {
      if (entry.stopped) return;
      if (isBinary) {
        if (raw.length <= MAX_WS_INPUT_BYTES) child.write(raw);
        return;
      }
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'terminal.input') {
        if (typeof message.data !== 'string') return;
        const data = message.data;
        if (Buffer.byteLength(data, 'utf8') <= MAX_WS_INPUT_BYTES) child.write(data);
        return;
      }
      if (message.type === 'terminal.resize') {
        child.resize(clampInt(message.cols, 20, 400, cols), clampInt(message.rows, 5, 200, rows));
      }
    });
  }

  /**
   * 会话页的实时状态：只读观察**选中会话的终端**（`herdr terminal session observe`），不挂完整客户端。
   *
   * 完整客户端会成为 Herdr 的前台客户端，pane 的尺寸跟着它走：页面一连上，正在跑的会话就被缩成 120×40，
   * Claude Code 按窄宽度把状态栏的目录截成 `chenchen2@…`，电脑终端里的这个会话也跟着变小，
   * 页面一断开又恢复——用户看到的就是状态栏一闪一闪（2026-09-25 实测 53 行 ⇄ 39 行）。
   * 观察者不抢前台、不改尺寸，给的是这个终端按实际大小画的画面；按大尺寸（250×120）请求，
   * 小于它的终端完整落在左上角，底部的活动行与状态栏都在。流本身只属于这个终端，也不必再按焦点过滤。
   * 终端 APP 的连接不走这里，它要的是真正的终端。
   */
  function observeTerminal(ws, terminalId, binding = '', requestId = '') {
    stopObserver(ws);
    if (typeof terminalId !== 'string' || !/^[\w:.-]{1,128}$/.test(terminalId)) return;
    const child = spawn(
      herdr.bin,
      ['terminal', 'session', 'observe', terminalId, '--cols', '250', '--rows', '120'],
      {
        cwd: getCwd(),
        env: rawTerminalEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const entry = {
      child,
      terminalId,
      binding: typeof binding === 'string' ? binding.slice(0, 512) : '',
      observerId: randomUUID(),
      stopped: false,
    };
    const ended = () =>
      safeWsSend(ws, {
        type: 'terminal.observe.ended',
        terminalId,
        binding: entry.binding,
        observerId: entry.observerId,
      });
    ws.observer = entry;
    entry.output = ws.structuredStatus
      ? createScreenOutput({
          ws,
          terminalId,
          binding: entry.binding,
          observerId: entry.observerId,
          requestId: String(requestId).slice(0, 128),
          diagnostics,
        })
      : createOutputControl({
          ws,
          acknowledged: ws.flowAcknowledged,
          pause: () => child.stdout.pause(),
          resume: () => child.stdout.resume(),
        });
    let screenTimer, latestScreen;
    const publish = () => {
      screenTimer = null;
      if (!entry.stopped && ws.observer === entry && latestScreen) {
        if (ws.structuredStatus) entry.output.write(latestScreen);
        else
          safeWsSend(ws, {
            type: 'terminal.screen',
            terminalId,
            binding: entry.binding,
            observerId: entry.observerId,
            ...latestScreen,
          });
      }
    };
    entry.screen = new TerminalScreen({
      snapshotIntervalMs: ws.structuredStatus ? 40 : 0,
      onScreen: (screen) => {
        latestScreen = screen;
        // Coalesce redraw bursts, publishing complete decoded snapshots only.
        if (ws.structuredStatus) publish();
        else if (!screenTimer) screenTimer = setTimeout(publish, 40);
      },
    });
    entry.clearScreen = () => {
      clearTimeout(screenTimer);
      entry.screen.close();
    };
    const finishObserver = () => {
      if (entry.stopped || entry.ending || ws.observer !== entry) return;
      entry.ending = true;
      // Decode and publish the final frame before reporting disconnection.
      entry.screen.pending
        .finally(() => {
          if (entry.stopped || ws.observer !== entry) return;
          entry.screen.flush();
          clearTimeout(screenTimer);
          publish();
          ended();
          stopObserver(ws);
        })
        .catch(() => {});
    };
    const parser = new WatchStreamParser({
      onFull: () => {
        if (!ws.structuredStatus)
          safeWsSend(ws, {
            type: 'terminal.observe.full',
            terminalId,
            binding: entry.binding,
            observerId: entry.observerId,
            screen: true,
          });
      },
      onFrame: (data, frame) => {
        entry.screen.feed(data, frame).catch(() => {
          if (!entry.stopped) ws.close(1011, 'terminal screen unavailable');
        });
        if (!entry.stopped && ws.observer === entry && !ws.structuredStatus)
          entry.output.write(Buffer.from(data, 'utf8'));
      },
      onEnd: finishObserver,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (entry.stopped || ws.observer !== entry) return;
      parser.push(chunk);
    });
    child.stdout.on('end', () => {
      if (!entry.stopped) parser.finish();
    });
    child.on('error', finishObserver);
    child.on('close', finishObserver);
  }
  function stopObserver(ws) {
    const entry = ws.observer;
    if (!entry) return;
    entry.stopped = true;
    ws.observer = null;
    entry.clearScreen?.();
    entry.output?.stop();
    try {
      entry.child.kill('SIGTERM');
    } catch {}
  }

  // 终端数据重复度极高(整屏重绘里大量相同的转义序列和空格),实测两次 resize 的
  // 约 100 KB 输出压完只剩 16.5%。慢链路上这是最划算的一项:公网入口往返约 167 ms,
  // 传输量直接决定重绘要等几个 RTT。threshold 以下的小帧不压,按键回显不为此多花 CPU。
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_INPUT_BYTES * 2,
    perMessageDeflate: {
      threshold: Number(
        (process.env.SWIFT_DEFLATE_THRESHOLD ?? process.env.AGENT_STUDIO_DEFLATE_THRESHOLD) || 256,
      ),
      zlibDeflateOptions: { level: 6, memLevel: 8 },
      concurrencyLimit: 10,
    },
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.studioUpgradeHandled) return;
    const originalUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (BASE_PATH && !originalUrl.pathname.startsWith(`${BASE_PATH}/`)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(originalUrl);
    if (BASE_PATH) url.pathname = originalUrl.pathname.slice(BASE_PATH.length) || '/';
    if (url.pathname !== '/api/terminal' || !isAuthorized(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
  });

  wss.on('connection', (ws, req, url) => {
    ws.deviceId = deviceId(req);
    ws.flowAcknowledged = url.searchParams.get('flow') === 'ack';
    ws.structuredStatus = url.searchParams.get('screen') === 'structured';
    sockets.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => {
      sockets.delete(ws);
      ws.jsonOutput?.stop();
      stopRawTerminal(ws.rawTerminalEntry);
      stopObserver(ws);
      ws.shellTerminal?.stop();
    });
    // 本地优先同步的控制消息（docs/LOCAL_FIRST.md）与终端输入同走这条连接，按类型分开。
    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > 64 * 1024) return;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message?.type === 'terminal.screen.ack') {
        if (ws.structuredStatus) ws.observer?.output?.acknowledge(message);
        return;
      }
      if (message?.type === 'terminal.ack')
        (
          ws.shellTerminal?.output ||
          ws.observer?.output ||
          ws.rawTerminalEntry?.output
        )?.acknowledge(message);
      if (typeof message?.type === 'string' && message.type.startsWith('sync.'))
        onSync(ws, message);
      if (ws.observing && message?.type === 'terminal.observe')
        observeTerminal(ws, message.terminalId, message.binding, message.requestId);
    });
    if (url.searchParams.get('shell') === '1') {
      if (url.searchParams.get('channel') === '2') {
        require('./terminal-multiplexer').attachTerminalMultiplexer({
          ws,
          url,
          herdr,
          cwd: getCwd(),
          env: { ...rawTerminalEnvironment(), HERDR_SOCKET_PATH: herdr.socketPath },
          maxInputBytes: MAX_WS_INPUT_BYTES,
        });
        return;
      }
      if (url.searchParams.get('channel') === '1') {
        require('./terminal-channel').attachTerminalChannel({
          ws,
          url,
          herdr,
          cwd: getCwd(),
          env: { ...rawTerminalEnvironment(), HERDR_SOCKET_PATH: herdr.socketPath },
          maxInputBytes: MAX_WS_INPUT_BYTES,
        });
        return;
      }
      void require('./shell-terminal').attachShellTerminal({
        ws,
        url,
        herdr,
        cwd: getCwd(),
        env: { ...rawTerminalEnvironment(), HERDR_SOCKET_PATH: herdr.socketPath },
        maxInputBytes: MAX_WS_INPUT_BYTES,
      });
      return;
    }
    if (url.searchParams.get('observe') === '1') {
      // 会话页：不挂完整客户端，按页面指定的终端观察（见 observeTerminal）。
      ws.observing = true;
      safeWsSend(ws, { type: 'terminal.ready', transport: 'observe' });
      return;
    }
    attachRawTerminal(ws, req, url);
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);
  heartbeat.unref?.();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const ws of sockets) {
      stopRawTerminal(ws.rawTerminalEntry);
      stopObserver(ws);
      ws.shellTerminal?.stop();
      ws.close(1012, 'server restart');
    }
    wss.close();
  }
  server.once('close', close);
  return {
    clients: sockets,
    rawTerminals,
    send: safeWsSend,
    controllers: publicControllerState,
    environment: rawTerminalEnvironment,
    close,
  };
}
module.exports = { createTerminalTransport };

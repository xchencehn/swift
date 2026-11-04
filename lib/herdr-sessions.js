'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { fork } = require('node:child_process');
const http = require('node:http');
const { HerdrClient } = require('./herdr-client');
const valid = (name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

// Each named Herdr namespace has its own Swift stores, controllers and observers.
// Switching one browser never mutates another browser's HerdrClient.session.
class HerdrSessions {
  constructor({ herdr, root, dataDirectory, spawn = fork }) {
    Object.assign(this, { herdr, root, dataDirectory, spawn });
    this.directory = path.dirname(path.dirname(herdr.socketPath));
    this.connections = new Map();
    this.pending = new Map();
    this.stopped = false;
  }
  list() {
    const sessions = [];
    try {
      for (const name of fs.readdirSync(this.directory)) {
        if (!valid(name)) continue;
        const socketPath = path.join(this.directory, name, 'herdr.sock');
        try {
          if (fs.statSync(socketPath).isSocket()) sessions.push({ name, running: true });
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const current = this.herdr.session || 'default';
    if (!sessions.some((s) => s.name === current))
      sessions.unshift({ name: current, running: fs.existsSync(this.herdr.socketPath) });
    return sessions;
  }
  async connect(name) {
    if (!valid(name) || !this.list().some((s) => s.name === name && s.running))
      throw fail('SESSION_OFFLINE', '这个 Herdr Session 当前未运行。');
    if (this.stopped) throw fail('SESSION_STOPPED', 'Swift 服务正在停止。');
    if (this.pending.has(name)) return this.pending.get(name);
    if (this.connections.has(name)) return this.connections.get(name);
    const promise = this.open(name).finally(() => this.pending.delete(name));
    this.pending.set(name, promise);
    return promise;
  }
  async open(name) {
    const socketPath =
      name === (this.herdr.session || 'default')
        ? this.herdr.socketPath
        : path.join(this.directory, name, 'herdr.sock');
    // A stale socket must not cause a native server to be started by discovery/selection.
    await new HerdrClient({ session: name, socketPath, timeoutMs: 1500 }).request(
      'session.snapshot',
      {},
    );
    const token = crypto.randomBytes(32).toString('base64url');
    const privateDirectory = path.join(this.dataDirectory(), 'herdr-sessions', name);
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      SWIFT_TOKEN: token,
      SWIFT_DIRECT_AUTH: 'token',
      HERDR_SESSION: name,
      HERDR_SOCKET_PATH: socketPath,
      SWIFT_BASE_PATH: '',
      SWIFT_HIDE_STARTUP_URLS: '1',
      SWIFT_ROOT_DIR: this.root(),
      SWIFT_DATA_DIR: path.join(privateDirectory, 'roots'),
      SWIFT_SETTINGS_FILE: path.join(privateDirectory, 'settings.json'),
      SWIFT_SESSION_CHILD: '1',
    };
    delete env.SWIFT_MANAGEMENT_CONFIG;
    const child = this.spawn(path.resolve(__dirname, '../server.js'), [], {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const connection = { name, child, token, port: null, basePath: '', peers: new Set() };
    this.connections.set(name, connection);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(fail('SESSION_TIMEOUT', 'Session 接入超时，请刷新后重试。')),
          15000,
        );
        const finish = (error) => {
          clearTimeout(timer);
          child.off('message', ready);
          child.off('error', failed);
          child.off('exit', exited);
          error ? reject(error) : resolve();
        };
        const ready = (message) => {
          if (Number.isInteger(message?.swiftSessionPort) && message.swiftSessionPort > 0) {
            connection.port = message.swiftSessionPort;
            finish();
          }
        };
        const failed = () => finish(fail('SESSION_UNAVAILABLE', 'Session 接入服务启动失败。'));
        const exited = () => finish(fail('SESSION_UNAVAILABLE', 'Session 接入服务已退出。'));
        child.on('message', ready);
        child.once('error', failed);
        child.once('exit', exited);
      });
      if (this.stopped) throw fail('SESSION_STOPPED', 'Swift 服务正在停止。');
      child.once('exit', () => {
        if (this.connections.get(name) === connection) this.connections.delete(name);
        for (const peer of connection.peers) {
          try {
            peer.close?.();
          } catch {}
        }
      });
      return connection;
    } catch (error) {
      this.disconnect(name);
      throw error;
    }
  }
  proxy(connection, req, res, url) {
    const clean = new URL(url);
    clean.searchParams.delete('token');
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: connection.port,
        method: req.method,
        path: clean.pathname + clean.search,
        headers: {
          'content-type': req.headers['content-type'] || 'application/json',
          'x-agent-studio-token': connection.token,
          'x-agent-studio-device-id':
            req.headers['x-agent-studio-device-id'] ||
            req.headers['x-swift-device-id'] ||
            'default',
          'x-forwarded-for': req.socket.remoteAddress || 'unknown',
        },
        timeout: 30000,
      },
      (response) => {
        res.writeHead(response.statusCode, {
          'content-type': response.headers['content-type'] || 'application/json',
          'cache-control': 'no-store',
        });
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  disconnect(name) {
    const item = this.connections.get(name);
    if (!item) return;
    this.connections.delete(name);
    for (const peer of item.peers) {
      try {
        peer.close?.();
      } catch {}
    }
    item.child.kill('SIGTERM');
  }
  close() {
    this.stopped = true;
    for (const name of [...this.connections.keys()]) this.disconnect(name);
  }
}
module.exports = { HerdrSessions, valid };

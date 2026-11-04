'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'scripts', 'testing', 'raw-terminal-fixture.js');

async function waitFor(check, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'raw terminal websocket carries PTY output, input, and resize without frame messages',
  { timeout: 20000 },
  async () => {
    const port = 19100 + (process.pid % 400);
    const token = `raw-pty-test-${process.pid}`;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-raw-test-'));
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        AGENT_STUDIO_TOKEN: token,
        HERDR_BIN: fixture,
        HERDR_SESSION: 'raw-test',
        HERDR_SOCKET_PATH: path.join(stateDir, 'no-live.sock'),
        CODEX_SIDE_SOCKET: path.join(stateDir, 'no-side.sock'),
        AGENT_STUDIO_ROOT_DIR: path.join(stateDir, 'root'),
        AGENT_STUDIO_SETTINGS_FILE: path.join(stateDir, 'bootstrap.json'),
        AGENT_STUDIO_MESSAGES_FILE: path.join(stateDir, 'messages.json'),
        AGENT_STUDIO_HIDE_STARTUP_URLS: '1',
        AGENT_STUDIO_BASE_PATH: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    try {
      await waitFor(async () => {
        try {
          return (
            await fetch(`http://127.0.0.1:${port}/api/config`, {
              headers: { 'x-agent-studio-token': token },
            })
          ).ok;
        } catch {
          return false;
        }
      });

      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=80&rows=24`,
      );
      const metadata = [];
      const output = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) output.push(raw.toString('utf8'));
        else metadata.push(JSON.parse(String(raw)));
      });

      await waitFor(() => metadata.find((message) => message.type === 'terminal.ready'));
      await waitFor(() => output.join('').includes('RAW_SCROLL_240'));
      assert.equal(
        metadata.find((message) => message.type === 'terminal.ready').transport,
        'raw-pty',
      );
      assert.equal(
        metadata.some((message) => message.type === 'terminal.frame'),
        false,
      );

      ws.send(JSON.stringify({ type: 'terminal.input', data: 'hello\r' }));
      await waitFor(() => output.join('').includes('RAW_ECHO:hello'));
      ws.send(JSON.stringify({ type: 'terminal.resize', cols: 96, rows: 30 }));
      await waitFor(() => output.join('').includes('RAW_RESIZED'));
      ws.close();
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('close', resolve));
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      // Node 22 emits this SQLite warning; all other stderr output still fails the test.
      const unexpectedStderr = stderr
        .join('')
        .replace(
          /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm,
          '',
        );
      assert.equal(unexpectedStderr, '');
    }
  },
);

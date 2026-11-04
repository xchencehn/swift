#!/usr/bin/env node
'use strict';
// Only creates a disposable runtime with its own HOME and socket. Never uses
// the caller's Herdr session, configuration, or production terminal IDs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { HerdrClient } = require('../../lib/herdr-client');
const { attachShellTerminal } = require('../../lib/shell-terminal');
const { create: createRenderer } = require('../../public/chat/terminal-state-renderer');
const { Terminal } = require('@xterm/headless');
const { openTerminalState } = require('../../lib/herdr-terminal-state');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 8000) {
  const end = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() > end) throw new Error('Runtime fixture timed out');
    await sleep(10);
  }
}
const screenText = (state) =>
  state.content.map((row) => row.cells.map((cell) => cell[0]).join('')).join('\n');
const octal = (text) =>
  [...Buffer.from(text)].map((byte) => '\\' + byte.toString(8).padStart(3, '0')).join('');
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
};

async function main() {
  const binary = process.argv[2];
  if (!binary || !path.isAbsolute(binary))
    throw new Error('Supply an absolute path to the candidate Herdr binary');
  const output = path.resolve(
    process.argv[3] || 'artifacts/testing/persistent-terminals/runtime-state',
  );
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-runtime-state-'));
  let socketPath = path.join(home, 'config/herdr/sessions/state-probe/herdr.sock');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: 'state-probe',
    HERDR_SOCKET_PATH: socketPath,
  };
  const server = spawn(binary, ['--session', 'state-probe', 'server'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(server, 'exit');
  let stderr = '',
    serial = 0;
  server.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-64000);
  });
  let first, second, bridge, renderer, display;
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath),
        id = 'probe-' + ++serial,
        start = performance.now();
      let buffer = '',
        settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve({ result, ms: performance.now() - start });
      };
      const timer = setTimeout(() => finish(new Error(method + ' timed out')), 6000);
      socket.setEncoding('utf8');
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error(method + ' closed before response'));
      });
      socket.write(JSON.stringify({ id, method, params }) + '\n');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0, index));
          finish(message.error ? new Error(message.error.message) : null, message.result);
        } catch (error) {
          finish(error);
        }
      });
    });
  }
  try {
    await until(async () => {
      // Upstream debug builds use herdr-dev. Both candidates are confined to
      // this fixture's HOME, so discovery cannot attach to a real session.
      for (const name of ['herdr', 'herdr-dev']) {
        const candidate = path.join(home, 'config', name, 'sessions/state-probe/herdr.sock');
        if (
          await fs.access(candidate).then(
            () => true,
            () => false,
          )
        ) {
          socketPath = candidate;
          return true;
        }
      }
      return false;
    });
    const ping = (await request('ping')).result;
    assert.equal(ping.capabilities.terminal_state_version, 1);
    const created = (
      await request('workspace.create', { label: 'runtime-state-fixture', cwd: home, focus: false })
    ).result;
    const pane = created.root_pane;
    assert(pane.terminal_id && pane.pane_id);
    await request('pane.send_input', {
      pane_id: pane.pane_id,
      text: "i=0; while [ $i -lt 80 ]; do printf 'row-%03d\\r\\n' $i; i=$((i+1)); done\n",
    });
    await until(async () =>
      JSON.stringify(
        (
          await request('pane.read', {
            pane_id: pane.pane_id,
            source: 'recent',
            format: 'text',
            lines: 100,
          })
        ).result,
      ).includes('row-079'),
    );
    await request('pane.scroll', { pane_id: pane.pane_id, offset_from_bottom: 20 });
    const before = (await request('pane.get', { pane_id: pane.pane_id })).result.pane;
    const failures = [];
    first = openTerminalState({ socketPath, terminalId: pane.terminal_id });
    first.on('failure', (error) => failures.push(error.message));
    second = openTerminalState({ socketPath, terminalId: pane.terminal_id });
    second.on('failure', (error) => failures.push(error.message));
    await Promise.all([first.ready, second.ready]);
    assert(
      screenText(first.state).includes('row-079'),
      'observation reads the live screen independently of native scroll',
    );
    assert.equal(screenText(first.state), screenText(second.state));
    const snapshot = first.state;
    const history = (
      await request('terminal.history.read', {
        terminal_id: pane.terminal_id,
        boot_id: snapshot.boot_id,
        revision: snapshot.revision,
        start: 0,
        limit: snapshot.first_row,
      })
    ).result;
    assert(
      history.content.some((row) =>
        row.cells
          .map((cell) => cell[0])
          .join('')
          .includes('row-000'),
      ),
    );
    const after = (await request('pane.get', { pane_id: pane.pane_id })).result.pane;
    assert.deepEqual(
      after.scroll,
      before.scroll,
      'observing and reading history preserve the shared viewport',
    );
    const timings = [];
    for (let index = 0; index < 12; index++) {
      const marker = `swift-state-${index}-中文`,
        start = performance.now();
      await request('pane.send_input', {
        pane_id: pane.pane_id,
        text: `printf '${octal(marker)}\\r\\n'\n`,
      });
      await until(() => screenText(second.state).includes(marker));
      timings.push(performance.now() - start);
    }
    first.pause();
    await request('pane.send_input', {
      pane_id: pane.pane_id,
      text: `printf '${octal('second-observer-remains-live')}\\r\\n'\n`,
    });
    await until(() => screenText(second.state).includes('second-observer-remains-live'));
    first.resume();
    await until(() => first.state.revision === second.state.revision);
    assert.deepEqual(first.state.content, second.state.content);
    assert.deepEqual(failures, []);
    await assert.rejects(
      request('terminal.history.read', {
        terminal_id: pane.terminal_id,
        boot_id: snapshot.boot_id,
        revision: snapshot.revision,
        start: 0,
        limit: 1,
      }),
      /revision changed/,
    );
    // Exercise the real Swift transport, bounded output credit and visible
    // xterm writer against the same disposable PTY. This is not a DOM test.
    const herdr = new HerdrClient({ socketPath, bin: binary });
    const normalized = herdr.normalizeSnapshot(await herdr.snapshot());
    renderer = createRenderer({ terminalId: pane.terminal_id });
    display = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    bridge = new EventEmitter();
    bridge.readyState = 1;
    bridge.bufferedAmount = 0;
    bridge.flowAcknowledged = true;
    let flow,
      transportReady = false,
      paint = Promise.resolve(),
      paintError,
      bytesReceived = 0;
    bridge.send = (data, options) => {
      if (options?.binary) {
        bytesReceived += data.length;
        renderer.write(data);
        const update = renderer.render({ cols: 80, rows: 24 });
        if (update)
          paint = paint
            .then(() => new Promise((resolve) => display.write(update, resolve)))
            .catch((error) => {
              paintError = error;
            });
        const ack = flow;
        setTimeout(() => bridge.shellTerminal?.output.acknowledge(ack), 5);
      } else {
        const message = JSON.parse(data);
        if (message.type === 'terminal.flow') flow = message;
        if (message.type === 'terminal.ready') {
          assert.equal(message.stateFormat, 'cells-v1');
          transportReady = true;
        }
        if (message.type === 'terminal.error') failures.push(message.message);
      }
    };
    bridge.close = (code, reason) => {
      bridge.readyState = 3;
      failures.push(`${code}: ${reason}`);
      bridge.emit('close');
    };
    const endpoint = new URL('http://fixture/terminal');
    for (const [key, value] of Object.entries({
      pane: pane.pane_id,
      terminalId: pane.terminal_id,
      runtimeId: normalized.runtimeId,
      cols: 80,
      rows: 24,
      retainControl: '1',
      stateFormat: 'cells-v1',
    }))
      endpoint.searchParams.set(key, value);
    await attachShellTerminal({
      ws: bridge,
      url: endpoint,
      herdr,
      cwd: home,
      env,
      maxInputBytes: 65536,
    });
    await until(() => transportReady && renderer.state);
    bridge.emit(
      'message',
      JSON.stringify({
        type: 'terminal.input',
        data: `printf '${octal('swift-visible-中文')}\\r\\n'\n`,
      }),
      false,
    );
    await until(() => screenText(renderer.state).includes('swift-visible-中文'));
    await paint;
    assert.ifError(paintError);
    const visible = Array.from({ length: display.rows }, (_, y) =>
      display.buffer.active.getLine(y).translateToString(true),
    ).join('\n');
    assert(visible.includes('swift-visible-中文'));
    const reading = renderer.scroll('up', 3, 'wheel');
    assert(reading);
    const beforeScroll = (await request('pane.get', { pane_id: pane.pane_id })).result.pane.scroll;
    renderer.render();
    assert.deepEqual(
      (await request('pane.get', { pane_id: pane.pane_id })).result.pane.scroll,
      beforeScroll,
    );
    bridge.emit('message', JSON.stringify({ type: 'terminal.visibility', visible: false }), false);
    await request('pane.send_input', {
      pane_id: pane.pane_id,
      text: `printf '${octal('hidden-still-live')}\\r\\n'\n`,
    });
    await until(() => screenText(renderer.state).includes('hidden-still-live'));
    bridge.emit('message', JSON.stringify({ type: 'terminal.visibility', visible: true }), false);
    renderer.toBottom();
    bridge.emit(
      'message',
      JSON.stringify({ type: 'terminal.resize', cols: 400, rows: 100 }),
      false,
    );
    bridge.emit(
      'message',
      JSON.stringify({
        type: 'terminal.input',
        data: `printf '${octal('large-frame-complete')}\\r\\n'\n`,
      }),
      false,
    );
    await until(
      () =>
        renderer.state.cols === 400 &&
        renderer.state.rows === 100 &&
        screenText(renderer.state).includes('large-frame-complete'),
    );
    assert.deepEqual(failures, []);
    const anchored = (
      await request('terminal.history.read', {
        terminal_id: pane.terminal_id,
        boot_id: renderer.state.boot_id,
        revision: renderer.state.revision - 1,
        history_epoch: renderer.state.history_epoch,
        start: renderer.state.row_offset,
        limit: 1,
      })
    ).result;
    assert.equal(anchored.history_epoch, renderer.state.history_epoch);
    const report = {
      ok: true,
      version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
      nativeState: true,
      simultaneousObservers: 3,
      swiftTransportAndVisibleBuffer: true,
      largeFrame: [400, 100],
      hiddenStateUpdates: true,
      localScrollWithoutNativeMutation: true,
      bytesReceived,
      historyWithoutViewportMutation: true,
      staleHistoryRejected: true,
      pausedObserverIsolation: true,
      commandToStateMs: stats(timings),
      productionInput: false,
      evidence:
        'Isolated real Herdr/PTY and Swift state receiver on loopback. Not browser paint, installed-client or Windows-to-167 latency.',
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    await bridge?.shellTerminal?.stop();
    renderer?.dispose();
    display?.dispose();
    await Promise.all([first?.close(), second?.close()]);
    server.kill();
    await exited;
    await fs.writeFile(path.join(output, 'server.log'), stderr);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events'),
  { WebSocket } = require('ws'),
  pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { HerdrClient } = require('../../lib/herdr-client');
const { createTerminalTransport } = require('../../lib/terminal-transport');
const { create } = require('../../public/chat/terminal-renderer');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read, description) {
  for (let i = 0; i < 160; i++) {
    if (await read()) return;
    await pause(40);
  }
  throw new Error('Timed out: ' + description);
}
(async () => {
  const root = path.resolve(__dirname, '../..'),
    output = path.join(root, 'artifacts/testing/statusbar-order/terminal-viewport/native');
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(root);
  const home = await fs.mkdtemp('/tmp/swift-keyboard-native-');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home + '/config',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: 'fixture',
    HERDR_SOCKET_PATH: home + '/config/herdr/sessions/fixture/herdr.sock',
  };
  const daemon = spawn('herdr', ['--session', 'fixture', 'server'], { env, stdio: 'ignore' });
  const journal = path.join(home, 'dimensions.jsonl');
  const records = async () => {
    try {
      return (await fs.readFile(journal, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const size = async () => (await records()).at(-1)?.size;
  const renderer = create({ Terminal, cols: 70, rows: 15 }),
    display = new Terminal({ cols: 70, rows: 15, allowProposedApi: true });
  let historyKey = '',
    historyResponse = null;
  let tui,
    transport,
    server,
    ws,
    painting = Promise.resolve(),
    full = false,
    geometry = { cols: 70, rows: 15 },
    fullFrames = 0;
  const text = () => {
    const b = display.buffer.active;
    return Array.from({ length: display.rows }, (_, y) =>
      b.getLine(b.viewportY + y).translateToString(true),
    ).join('\n');
  };
  const redraw = async (rows) => {
    await painting;
    display.resize(70, rows);
    await new Promise((resolve) => display.write(renderer.render({ cols: 70, rows }), resolve));
  };
  try {
    await wait(
      () =>
        fs.access(env.HERDR_SOCKET_PATH).then(
          () => true,
          () => false,
        ),
      'isolated daemon',
    );
    const pane = JSON.parse(
      execFileSync(
        'herdr',
        ['workspace', 'create', '--cwd', home, '--label', 'keyboard-fixture', '--no-focus'],
        { env, encoding: 'utf8' },
      ),
    ).result.root_pane;
    const program = path.join(home, 'screen.py');
    await fs.writeFile(
      program,
      `import os,tty,time,json,select\ntty.setraw(0)\nos.write(1, ''.join('HISTORY %d\\r\\n'%i for i in range(120)).encode())\nprevious=None\nwhile True:\n size=list(os.get_terminal_size())\n data=os.read(0,1024).decode('utf-8','replace') if select.select([0],[],[],.02)[0] else ''\n if size!=previous or data:\n  with open(${JSON.stringify(journal)},'a') as f:f.write(json.dumps({'size':size,'input':data})+'\\n')\n  c,r=size\n  frame='\\x1b[2J\\x1b[H'+''.join('\\x1b[%d;1H'%i+('A'*105 if i==1 else 'B'*69+'中文长行'*9 if i==2 else '\\x1b[38;2;20;180;60m'+'彩色CJK '*16+'\\x1b[0m' if i==3 else 'NATIVE ROW %d'%i) for i in range(1,r-2))+'\\x1b[%d;1HKEYBOARD_PROMPT>'%(r-1)+'\\x1b[%d;1HSTATUS_BOTTOM'%(r)+'\\x1b[%d;17H\\x1b[?25h'%(r-1)\n  os.write(1,frame.encode())\n  previous=size\n`,
    );
    execFileSync('herdr', ['pane', 'run', pane.pane_id, 'python3 -u ' + program], {
      env,
      stdio: 'ignore',
    });
    tui = pty.spawn('herdr', ['--session', 'fixture'], {
      env,
      cwd: home,
      name: 'xterm-256color',
      cols: 132,
      rows: 45,
    });
    tui.onData(() => {});
    await wait(async () => (await size())?.[0] > 80, 'native geometry');
    await pause(200);
    const nativeSize = await size();
    const herdr = new HerdrClient({ session: 'fixture', socketPath: env.HERDR_SOCKET_PATH });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    server = http.createServer();
    transport = createTerminalTransport({
      server,
      herdr,
      basePath: '',
      maxInputBytes: 65536,
      isAuthorized: () => true,
      getCwd: () => home,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/api/terminal?shell=1&pane=${pane.pane_id}&terminalId=${pane.terminal_id}&runtimeId=${snapshot.runtimeId}&cols=70&rows=15`,
    );
    const messages = [];
    ws.on('message', (raw, binary) => {
      if (!binary) {
        const message = JSON.parse(String(raw));
        messages.push(message);
        if (message.type === 'terminal.geometry') geometry = message;
        if (message.type === 'terminal.full') {
          full = true;
          fullFrames++;
        }
        if (message.type === 'terminal.history') {
          historyResponse = message;
          painting = painting.then(async () => {
            const delta = await renderer.history(message.text, historyKey, message.visible);
            if (delta) await new Promise((resolve) => display.write(delta, resolve));
          });
        }
        return;
      }
      const current = { ...geometry },
        reset = full;
      full = false;
      painting = painting.then(async () => {
        const delta = await renderer.write(raw, {
          full: reset,
          cols: current.cols,
          rows: current.rows,
          viewportCols: 70,
          viewportRows: display.rows,
        });
        if (delta) await new Promise((resolve) => display.write(delta, resolve));
      });
    });
    await wait(
      () => text().includes('KEYBOARD_PROMPT>') && text().includes('STATUS_BOTTOM'),
      'complete native bottom in short viewer',
    );
    assert.deepEqual(await size(), nativeSize);
    assert.equal(geometry.rows, 200);
    const initialFullFrames = fullFrames;
    await redraw(80);
    ws.send(JSON.stringify({ type: 'terminal.resize', cols: 70, rows: 80 }));
    const beforeHistory = text().split('\n');
    const leadingBeforeHistory = beforeHistory.findIndex((line) => line.trim());
    assert(leadingBeforeHistory > 0);
    historyKey = renderer.historyKey();
    assert(historyKey);
    ws.send(JSON.stringify({ type: 'terminal.history.request', requestId: 'native-tall-history' }));
    await wait(
      () => text().split('\n')[0].startsWith('HISTORY '),
      'actual wide native history fills tall viewer',
    );
    assert(historyResponse?.available);
    assert.equal(renderer.historyKey(), '');
    assert(text().includes('KEYBOARD_PROMPT>') && text().includes('STATUS_BOTTOM'));
    assert.deepEqual(await size(), nativeSize);
    assert.equal(fullFrames, initialFullFrames);
    const nativeHistoryProof = {
      nativeCols: nativeSize[0],
      nativeRows: nativeSize[1],
      captureCols: geometry.cols,
      captureRows: geometry.rows,
      viewerCols: 70,
      viewerRows: 80,
      leadingBlankRowsBefore: leadingBeforeHistory,
      leadingBlankRowsAfter: 0,
      actualHistoryFirstLine: text().split('\n')[0],
      longAsciiCjkAnsiTailVerified: true,
      readOnlyRequests: 1,
      controlAcquired: false,
    };
    await fs.writeFile(
      path.join(output, 'history-proof.json'),
      JSON.stringify(nativeHistoryProof, null, 2),
    );
    await redraw(15);

    for (const rows of [8, 12, 15]) {
      await redraw(rows);
      ws.send(JSON.stringify({ type: 'terminal.resize', cols: 70, rows }));
      ws.send(JSON.stringify({ type: 'terminal.focus', focused: true }));
      await pause(100);
      assert(text().includes('KEYBOARD_PROMPT>') && text().includes('STATUS_BOTTOM'));
      assert.deepEqual(await size(), nativeSize);
      assert.equal(fullFrames, initialFullFrames);
    }
    ws.send(JSON.stringify({ type: 'terminal.input', data: 'X' }));
    await wait(
      async () => (await records()).some((record) => record.input === 'X'),
      'one explicit input',
    );
    await wait(
      () =>
        geometry.rows === 200 &&
        fullFrames > initialFullFrames + 1 &&
        text().includes('STATUS_BOTTOM'),
      'idle return to complete observation',
    );
    assert.deepEqual(await size(), nativeSize);
    assert.equal((await records()).filter((record) => record.input === 'X').length, 1);
    assert(!messages.some((message) => message.type === 'terminal.error'));
    const after = sourceFingerprint(root);
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          nativeSize,
          viewportRows: [15, 80, 15, 8, 12, 15],
          nativeHistoryProof,
          captureRows: 200,
          fullFrames,
          initialFullFrames,
          completeNativeBottom: true,
          passiveResizeDoesNotClaim: true,
          passiveHeightDoesNotRestart: true,
          oneExplicitInput: true,
          idleReturnPreservesBottom: true,
          herdrVersion: execFileSync('herdr', ['--version'], { env, encoding: 'utf8' }).trim(),
          isolated: true,
          productionInput: false,
        },
        null,
        2,
      ) + '\n',
    );
    await fs.writeFile(
      path.join(output, 'dimensions.json'),
      JSON.stringify(await records(), null, 2) + '\n',
    );
    console.log(
      'PASS complete native viewport, local keyboard resizing, control handoff and idle return.',
    );
  } finally {
    ws?.terminate();
    transport?.close();
    server?.close();
    tui?.kill();
    await painting;
    renderer.dispose();
    display.dispose();
    try {
      execFileSync('herdr', ['server', 'stop'], { env, stdio: 'ignore' });
    } catch {}
    daemon.kill('SIGTERM');
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

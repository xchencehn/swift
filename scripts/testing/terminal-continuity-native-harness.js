'use strict';
// Read/write only an isolated Herdr fixture and PTY, never a production session.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process'),
  { once } = require('node:events');
const pty = require('node-pty'),
  { firefox, expect } = require('@playwright/test');
const { HerdrClient } = require('../../lib/herdr-client'),
  { createTerminalTransport } = require('../../lib/terminal-transport');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (value) return value;
    await pause(20);
  }
  throw new Error('Native fixture timeout');
}
(async () => {
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_CONTINUITY_NATIVE_OUTPUT ||
      'artifacts/testing/terminal-continuity/native',
  );
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    home = await fs.mkdtemp('/tmp/swift-continuity-');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home + '/config',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: 'fixture',
    HERDR_SOCKET_PATH: home + '/config/herdr/sessions/fixture/herdr.sock',
  };
  const native = spawn('herdr', ['--session', 'fixture', 'server'], { env, stdio: 'ignore' });
  const json = (args) => JSON.parse(execFileSync('herdr', args, { env, encoding: 'utf8' })).result;
  const journal = path.join(home, 'input.jsonl');
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
  let tui, browser, server, transport;
  try {
    await wait(() =>
      fs.access(env.HERDR_SOCKET_PATH).then(
        () => true,
        () => false,
      ),
    );
    const pane = json([
      'workspace',
      'create',
      '--cwd',
      home,
      '--label',
      'continuity-fixture',
      '--no-focus',
    ]).root_pane;
    const program = path.join(home, 'echo.py');
    await fs.writeFile(
      program,
      `import os,sys,tty,termios,select,json,time\nold=termios.tcgetattr(0)\nreceived='';previous=None\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[2J\\x1b[HNATIVE_READY\\x1b[3;1HECHO_')\n while True:\n  size=list(os.get_terminal_size())\n  value=os.read(0,1024).decode('utf-8','replace') if select.select([0],[],[],.01)[0] else ''\n  if size!=previous or value:\n   with open(${JSON.stringify(journal)},'a') as f:f.write(json.dumps({'size':size,'input':value,'at':time.time()})+'\\n')\n   previous=size\n  if value:\n   received+=value\n   os.write(1,('\\x1b[3;1HECHO_'+received+'\\x1b[?25h').encode())\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n`,
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
    await wait(async () => (await records()).at(-1)?.size[0] > 80);
    await pause(250); // Wait for the fixture TUI's initial layout to settle.
    const nativeSize = (await records()).at(-1).size;
    const herdr = new HerdrClient({ session: 'fixture', socketPath: env.HERDR_SOCKET_PATH });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot()),
      target = { paneId: pane.pane_id, terminalId: pane.terminal_id };
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{display:block}#terminal{width:820px;height:500px;flex:none;--bg:#161616;--text:#ddd}</style><section id="terminal" class="shell-terminal"></section>
      <script src="/core/socket.js"></script><script src="/chat/terminal-renderer.js"></script><script src="/chat/shell-terminal.js"></script><script>
      window.target=${JSON.stringify(target)};window.runtime=${JSON.stringify(snapshot.runtimeId)};
      window.surface=StudioShellTerminal.create({host:document.querySelector('#terminal'),appPath:p=>p,socketUrl:()=>new URL('/api/terminal?flow=ack',location.href.replace('http:','ws:'))});surface.update(target,runtime,true);</script>`;
    server = http.createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      const name = new URL(req.url, 'http://fixture').pathname;
      if (
        !/^\/(?:vendor\/xterm\/[\w.-]+|core\/socket\.js|chat\/(?:shell-terminal|terminal-renderer)\.js|style\.css)$/.test(
          name,
        )
      ) {
        res.writeHead(404);
        return res.end();
      }
      try {
        res.setHeader(
          'Content-Type',
          name.endsWith('.css') ? 'text/css' : 'application/javascript',
        );
        res.end(await fs.readFile(path.join(process.cwd(), 'public', name)));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    transport = createTerminalTransport({
      server,
      herdr,
      basePath: '',
      maxInputBytes: 65536,
      isAuthorized: () => true,
      getCwd: () => home,
    });
    let connections = 0;
    server.on('upgrade', () => connections++);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await firefox.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.locator('#terminal')).toContainText('NATIVE_READY');
    assert.deepEqual(
      (await records()).at(-1).size,
      nativeSize,
      'Observation must not take control',
    );
    const input = page.locator('#terminal .xterm-helper-textarea');
    await input.focus();
    const latencies = [];
    for (const key of 'abc') {
      const at = Date.now();
      await page.keyboard.type(key);
      await expect
        .poll(async () =>
          (await records())
            .filter((record) => record.input)
            .map((record) => record.input)
            .join(''),
        )
        .toBe('abc'.slice(0, latencies.length + 1));
      await expect(page.locator('#terminal')).toContainText(
        'ECHO_' + 'abc'.slice(0, latencies.length + 1),
      );
      const nativeAt = (await records()).find((record) => record.input.includes(key)).at * 1000;
      latencies.push({
        key,
        actionToNativeMs: nativeAt - at,
        actionToContentObservedMs: Date.now() - at,
      });
    }
    const controlledSize = (await records()).at(-1).size;
    assert.notDeepEqual(controlledSize, nativeSize);
    const retained = await page.evaluate(() => {
      window.savedScreen = document.querySelector('.xterm-screen');
      surface.update(null, runtime, false);
      return window.savedScreen.textContent;
    });
    await wait(
      async () => JSON.stringify((await records()).at(-1).size) === JSON.stringify(nativeSize),
    );
    const immediate = await page.evaluate(() => {
      surface.update(target, runtime, true);
      return (
        document.querySelector('.xterm-screen') === window.savedScreen &&
        window.savedScreen.textContent.includes('ECHO_abc')
      );
    });
    assert(immediate);
    assert(retained.includes('ECHO_abc'));
    assert.equal(connections, 1);
    assert.deepEqual(
      (await records()).at(-1).size,
      nativeSize,
      'Returning to a cached view must not take control',
    );
    await input.focus();
    await page.keyboard.type('d');
    await expect(page.locator('#terminal')).toContainText('ECHO_abcd');
    assert.equal(
      (await records())
        .filter((record) => record.input)
        .map((record) => record.input)
        .join(''),
      'abcd',
    );
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(
      async () => JSON.stringify((await records()).at(-1).size) === JSON.stringify(nativeSize),
    );
    assert.deepEqual(errors, []);
    const after = sourceFingerprint(process.cwd());
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          nativeSize,
          controlledSize,
          connections,
          immediateReturn: immediate,
          inputExactlyOnce: true,
          nativeControlReleased: true,
          latencies,
          records: await records(),
          evidence:
            'Isolated Firefox and real Herdr/PTY; action timings include browser automation and polling, not physical key-to-photon latency.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS real Herdr/PTY: cached return, control release, first and continuous input exactly once.',
    );
  } catch (error) {
    await fs.writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify({ error: error.message, records: await records(), source: before }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    transport?.close();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    tui?.kill();
    native.kill();
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

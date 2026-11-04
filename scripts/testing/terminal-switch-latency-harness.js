'use strict';
// Local software timing only: isolated Herdr/PTY, loopback and Firefox.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http'),
  net = require('node:net');
const assert = require('node:assert/strict'),
  cp = require('node:child_process'),
  { once } = require('node:events');
const { firefox, expect } = require('@playwright/test'),
  pty = require('node-pty');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const runtimeCandidate = process.env.SWIFT_HERDR_RUNTIME_BIN,
  binary = runtimeCandidate || 'herdr';
const tuiBinary = process.env.SWIFT_HERDR_TUI_BIN || binary;
const paneCount = Number(process.env.SWIFT_TERMINAL_PANES || 8),
  flood = process.env.SWIFT_TERMINAL_FLOOD === '1';
assert(Number.isInteger(paneCount) && paneCount >= 1 && paneCount <= 64);
const rttMs = Number(process.env.SWIFT_TERMINAL_RTT_MS || 0);
assert(Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 1000);
const inputKeys = 'abcdefghijklmnopqrstuvwxyz0123456789'.slice(
  0,
  Number(process.env.SWIFT_TERMINAL_INPUT_SAMPLES || 3),
);
assert(inputKeys.length >= 3);
const baseline = process.argv.includes('--baseline'),
  baselineRevision = '1b407bd75b8566a99057c97bc566b0dc39cf0228';
const originalSpawn = cp.spawn,
  nativeStarts = [];
const terminalModule = require('../../lib/herdr-terminal-session'),
  openSession = terminalModule.openTerminalSession,
  nativeConnections = [];
const trackedSessions = new WeakSet();
function trackSession(session, mode) {
  if (trackedSessions.has(session)) return session;
  trackedSessions.add(session);
  const start = Date.now(),
    record = { mode, start, frames: 0, controlReady: 0 };
  nativeConnections.push(record);
  session.once('ready', () => {
    record.handshakeMs = Date.now() - start;
  });
  session.once('close', () => {
    record.closedAt = Date.now();
  });
  session.on('frame', () => {
    record.frames++;
    record.firstFrameMs ??= Date.now() - start;
  });
  session.on('controlReady', () => {
    record.controlReady++;
  });
  return session;
}
terminalModule.openTerminalSession = (options) => trackSession(openSession(options), options.mode);
const prepare = terminalModule.createTerminalPreparation;
terminalModule.createTerminalPreparation = (socketPath) => {
  const preparation = prepare(socketPath),
    take = preparation.take;
  preparation.take = () => trackSession(take(), 'pending');
  return preparation;
};
cp.spawn = (bin, args, options) => {
  if (args?.[0] === 'terminal' && args[1] === 'session') nativeStarts.push(args[2]);
  return originalSpawn(bin, args, options);
};
if (baseline) {
  const filename = require.resolve('../lib/shell-terminal'),
    Module = require('node:module'),
    previous = new Module(filename, module);
  previous.filename = filename;
  previous.paths = module.paths;
  previous._compile(
    cp.execFileSync('git', ['show', baselineRevision + ':lib/shell-terminal.js'], {
      encoding: 'utf8',
    }),
    filename,
  );
  require.cache[filename] = previous;
}
const { HerdrClient } = require('../../lib/herdr-client'),
  { createTerminalTransport } = require('../../lib/terminal-transport');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read) {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (value) return value;
    await pause(10);
  }
  throw new Error('Terminal latency fixture timeout');
}
(async () => {
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_LATENCY_OUTPUT ||
      `artifacts/testing/terminal-switch-latency/${baseline ? 'baseline' : 'native'}`,
  );
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    home = await fs.mkdtemp('/tmp/swift-latency-');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home + '/config',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: 'fixture',
    HERDR_SOCKET_PATH: home + '/config/herdr/sessions/fixture/herdr.sock',
  };
  const native = originalSpawn(binary, ['--session', 'fixture', 'server'], {
    env,
    stdio: 'ignore',
  });
  const json = (args) =>
    JSON.parse(cp.execFileSync(binary, args, { env, encoding: 'utf8' })).result;
  const records = async (index) => {
    try {
      return (await fs.readFile(path.join(home, `input-${index}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
    } catch {
      return [];
    }
  };
  let tui, browser, server, transport, proxy;
  const proxySockets = new Set(),
    proxyTimers = new Set();
  try {
    await wait(async () => {
      for (const name of ['herdr', 'herdr-dev']) {
        const candidate = `${home}/config/${name}/sessions/fixture/herdr.sock`;
        if (
          await fs.access(candidate).then(
            () => true,
            () => false,
          )
        ) {
          env.HERDR_SOCKET_PATH = candidate;
          return true;
        }
      }
      return false;
    });
    const panes = [];
    for (let i = 0; i < paneCount; i++) {
      const pane = json([
        'workspace',
        'create',
        '--cwd',
        home,
        '--label',
        `latency-${i}`,
        '--no-focus',
      ]).root_pane;
      panes.push({ paneId: pane.pane_id, terminalId: pane.terminal_id });
      const program = path.join(home, `echo-${i}.py`),
        journal = path.join(home, `input-${i}.jsonl`);
      await fs.writeFile(
        program,
        `import os,tty,termios,select,json,time\nold=termios.tcgetattr(0);previous=None;count=0;mode=None\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HNATIVE_${i}_READY')\n while True:\n  requested=open('keyboard-mode').read() if os.path.exists('keyboard-mode') else ''\n  if requested!=mode:\n   mode=requested;os.write(1,{'application':b'\\x1b[?1h','kitty':b'\\x1b[>31u'}.get(mode,b''));open('keyboard-mode-ready-${i}','w').write(mode)\n  if ${flood && paneCount > 1 && i === paneCount - 1 ? 'True' : 'False'}:\n   os.write(1,(''.join('\\x1b['+str(y)+';1HFLOOD_'+str(time.time_ns())+'x'*40 for y in range(4,35))).encode())\n  data=os.read(0,65536) if select.select([0],[],[],.005)[0] else b''\n  size=list(os.get_terminal_size())\n  if size!=previous or data:\n   with open(${JSON.stringify(journal)},'a') as f:f.write(json.dumps({'size':size,'input':data.hex(),'at':time.time()*1000})+'\\n')\n   previous=size\n  if data:\n   count+=1;os.write(1,('\\x1b[3;1HEVENT_'+str(count)).encode())\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n`,
      );
      cp.execFileSync(binary, ['pane', 'run', pane.pane_id, 'python3 -u ' + program], {
        env,
        stdio: 'ignore',
      });
    }
    await Promise.all(panes.map((_, i) => wait(async () => (await records(i)).length > 0)));
    const preTuiSize = (await records(0)).at(-1).size;
    tui = pty.spawn(tuiBinary, ['--session', 'fixture'], {
      env,
      cwd: home,
      name: 'xterm-256color',
      cols: 132,
      rows: 45,
    });
    tui.onData(() => {});
    await wait(
      async () => JSON.stringify((await records(0)).at(-1)?.size) !== JSON.stringify(preTuiSize),
    );
    await pause(200);
    const nativeSizes = await Promise.all(
      panes.map((_, i) => records(i).then((rows) => rows.at(-1).size)),
    );
    const herdr = new HerdrClient({
      bin: binary,
      session: 'fixture',
      socketPath: env.HERDR_SOCKET_PATH,
    });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    assert.equal(snapshot.protocol, 22);
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{display:block}#terminal{width:820px;height:500px;flex:none;--bg:#161616;--text:#ddd}</style><section id="terminal" class="shell-terminal"></section>
      <script src="/ansi.js"></script><script src="/native-status.js"></script><script src="/core/socket.js"></script><script src="/chat/terminal-keyboard.js"></script><script src="/chat/terminal-state.js"></script><script src="/chat/terminal-state-renderer.js"></script><script src="/chat/terminal-renderer.js"></script><script src="/chat/terminal-channel.js"></script><script src="/chat/shell-terminal.js"></script><script>
      window.targets=${JSON.stringify(panes)};window.runtime=${JSON.stringify(snapshot.runtimeId)};
      window.surface=StudioShellTerminal.create({host:document.querySelector('#terminal'),appPath:p=>p,getChannelVersion:()=>${runtimeCandidate ? 2 : 0},socketUrl:()=>new URL('/api/terminal?flow=ack',location.href.replace('http:','ws:'))});</script>`;
    server = http.createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      const name = new URL(req.url, 'http://fixture').pathname;
      if (
        !/^\/(?:vendor\/xterm\/[\w.-]+|core\/socket\.js|ansi\.js|native-status\.js|chat\/(?:shell-terminal|terminal-renderer|terminal-state|terminal-state-renderer|terminal-channel|terminal-keyboard)\.js|style\.css)$/.test(
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
        const data =
          baseline && name === '/chat/shell-terminal.js'
            ? cp.execFileSync('git', ['show', baselineRevision + ':public' + name])
            : await fs.readFile(path.join(process.cwd(), 'public', name));
        res.end(data);
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
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    if (rttMs) {
      proxy = net.createServer((front) => {
        const back = net.createConnection(server.address().port, '127.0.0.1');
        for (const socket of [front, back]) {
          proxySockets.add(socket);
          socket.setNoDelay(true);
          socket.on('error', () => {
            front.destroy();
            back.destroy();
          });
          socket.once('close', () => {
            proxySockets.delete(socket);
            front.destroy();
            back.destroy();
          });
        }
        for (const [from, to] of [
          [front, back],
          [back, front],
        ]) {
          from.on('data', (bytes) => {
            const timer = setTimeout(() => {
              proxyTimers.delete(timer);
              if (!to.destroyed && !to.write(bytes)) from.pause();
            }, rttMs / 2);
            proxyTimers.add(timer);
          });
          to.on('drain', () => from.resume());
        }
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
    }
    browser = await firefox.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => {
      window.sentInputs = [];
      window.nativeFormats = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const message = JSON.parse(data);
          if (
            [
              'terminal.input',
              'terminal.scroll',
              'terminal.key',
              'terminal.resize',
              'terminal.open',
            ].includes(message.type)
          )
            sentInputs.push({ ...message, at: performance.timeOrigin + performance.now() });
        } catch {}
        return send.call(this, data);
      };
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (proxy || server).address().port);
    await page.evaluate(() => {
      window.hiddenParsers = 0;
      const create = StudioTerminalRenderer.create;
      StudioTerminalRenderer.create = (options) => {
        window.hiddenParsers++;
        return create(options);
      };
    });
    const switches = [],
      input = [],
      scroll = [];
    for (const index of [
      ...panes.keys(),
      ...Array.from({ length: Math.ceil(20 / paneCount) }, () => [...panes.keys()]).flat(),
      0,
    ]) {
      const sample = await page.evaluate(
        async ({ index, marker }) => {
          const start = performance.now();
          surface.update(targets[index], runtime, true);
          await new Promise((resolve, reject) => {
            const deadline = performance.now() + 8000;
            const check = () => {
              if (document.querySelector('#terminal .xterm-screen')?.textContent.includes(marker))
                return resolve();
              if (performance.now() > deadline)
                return reject(
                  new Error(
                    'No terminal content for ' +
                      index +
                      ': ' +
                      document.querySelector('#terminal .xterm-screen')?.textContent.slice(0, 300),
                  ),
                );
              requestAnimationFrame(check);
            };
            check();
          });
          return { index, switchToContentMs: performance.now() - start };
        },
        {
          index,
          marker:
            flood && paneCount > 1 && index === paneCount - 1 ? 'FLOOD_' : `NATIVE_${index}_READY`,
        },
      );
      switches.push(sample);
      assert.deepEqual(
        (await records(index)).at(-1).size,
        nativeSizes[index],
        'Viewing cannot resize a PTY',
      );
    }
    if (!baseline)
      assert(
        switches.slice(paneCount).every((sample) => sample.switchToContentMs < 50),
        'Revisiting more than six terminals uses retained display state: ' +
          JSON.stringify(switches.slice(paneCount)),
      );
    const caret = page.locator('#terminal .xterm-helper-textarea');
    for (const key of inputKeys) {
      await caret.focus();
      const at = Date.now();
      await page.keyboard.type(key);
      const record = await wait(async () =>
        (await records(0)).find((row) => row.input === Buffer.from(key).toString('hex')),
      );
      assert.notDeepEqual(
        record.size,
        nativeSizes[0],
        'Input follows the applied control geometry: ' +
          JSON.stringify({
            actual: record.size,
            native: nativeSizes[0],
            controls: await page.evaluate(() =>
              sentInputs.filter((message) =>
                ['terminal.resize', 'terminal.open'].includes(message.type),
              ),
            ),
          }),
      );
      const sent = await page.evaluate(
        (key) =>
          sentInputs.find(
            (message) =>
              (message.type === 'terminal.input' && message.data === key) ||
              (message.type === 'terminal.key' && message.kind === 'press' && message.key === key),
          ),
        key,
      );
      const echoAt = await page.evaluate(async (count) => {
        await new Promise((resolve, reject) => {
          const deadline = performance.now() + 8000;
          const check = () => {
            if (
              document
                .querySelector('#terminal .xterm-screen')
                ?.textContent.includes(`EVENT_${count}`)
            )
              return resolve();
            if (performance.now() > deadline) return reject(new Error('No native input echo'));
            requestAnimationFrame(check);
          };
          check();
        });
        return performance.timeOrigin + performance.now();
      }, input.length + 1);
      input.push({
        key,
        actionToNativeMs: record.at - at,
        sendToNativeMs: record.at - sent.at,
        sendToVisibleEchoMs: echoAt - sent.at,
      });
    }
    await page.evaluate(() => surface.update(null, runtime, false));
    await wait(
      async () => JSON.stringify((await records(0)).at(-1).size) === JSON.stringify(nativeSizes[0]),
    );
    if (!baseline)
      await wait(() =>
        nativeConnections
          .filter((record) => record.mode === 'observe')
          .every((record) => record.closedAt),
      );
    await page.evaluate(() => surface.update(targets[0], runtime, true));
    for (let i = 0; i < 3; i++) {
      const count = (await records(0)).filter((row) => row.input).length;
      const at = await page.evaluate(() => {
        const canvas = document.querySelector('.shell-terminal-canvas'),
          rect = canvas.getBoundingClientRect();
        const at = performance.timeOrigin + performance.now();
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -120,
            clientX: rect.x + 35,
            clientY: rect.y + 35,
          }),
        );
        return at;
      });
      const record = await wait(async () => (await records(0)).filter((row) => row.input)[count]);
      assert.match(Buffer.from(record.input, 'hex').toString(), /^\x1b\[<64;/);
      scroll.push({ firstAfterRelease: i === 0, actionToNativeMs: record.at - at });
    }
    await expect(page.locator('#terminal')).toContainText(`EVENT_${inputKeys.length + 3}`);
    const received = (await records(0)).filter((row) => row.input);
    assert.equal(received.length, inputKeys.length + 3);
    for (let i = 1; i < panes.length; i++)
      assert.equal((await records(i)).filter((row) => row.input).length, 0);
    if (!baseline)
      assert.equal(
        nativeStarts.length,
        0,
        'No terminal CLI process is created for display or control',
      );
    if (runtimeCandidate)
      assert.equal(
        await page.evaluate(() => hiddenParsers),
        0,
        'Native cell rendering creates no hidden xterm',
      );
    const semanticKeys = [];
    if (runtimeCandidate) {
      assert(
        nativeConnections.some((connection) => connection.controlReady > 0),
        'Control readiness arrives independently',
      );
      assert(
        nativeConnections.every((connection) => connection.frames === 0),
        'Native control does not produce redraw frames',
      );
      const keyboardMode = async (mode) => {
        await fs.writeFile(path.join(home, 'keyboard-mode'), mode);
        await wait(
          async () =>
            (await fs
              .readFile(path.join(home, 'keyboard-mode-ready-0'), 'utf8')
              .catch(() => '')) === mode,
        );
      };
      const keyCheck = async (key, expected) => {
        const offset = (await records(0)).filter((row) => row.input).length;
        await caret.focus();
        await page.keyboard.press(key);
        const bytes = await wait(async () => {
          const hex = (await records(0))
            .filter((row) => row.input)
            .slice(offset)
            .map((row) => row.input)
            .join('');
          return hex.length >= Buffer.from(expected).length * 2 ? hex : null;
        });
        assert.equal(Buffer.from(bytes, 'hex').toString(), expected, key);
        semanticKeys.push(key);
      };
      await keyboardMode('application');
      await keyCheck('ArrowUp', '\x1bOA');
      await keyCheck('Control+c', '\x03');
      await keyCheck('Shift+Tab', '\x1b[Z');
      await keyCheck('Alt+ArrowUp', '\x1b[1;3A');
      // Raw text is ordered after prior key releases on the same connection.
      // Observe it before changing the native mode outside that input stream.
      await page.keyboard.insertText('~');
      await wait(async () => (await records(0)).some((record) => record.input === '7e'));
      await keyboardMode('kitty');
      await keyCheck('a', '\x1b[97;;97u\x1b[97;1:3u');
      assert(
        await page.evaluate(() =>
          sentInputs.some(
            (message) => message.type === 'terminal.key' && message.kind === 'release',
          ),
        ),
      );
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.evaluate(() => surface.update(null, runtime, false));
    await wait(
      async () => JSON.stringify((await records(0)).at(-1).size) === JSON.stringify(nativeSizes[0]),
    );
    if (!baseline)
      await wait(() =>
        nativeConnections
          .filter((record) => record.mode === 'observe')
          .every((record) => record.closedAt),
      );
    const after = sourceFingerprint(process.cwd());
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          baseline,
          paneCount,
          flood,
          rttMs,
          tuiBinary,
          runtimeCandidate: runtimeCandidate || null,
          baselineRevision,
          before,
          after,
          switches,
          input,
          scroll,
          semanticKeys,
          nativeStarts,
          nativeConnections,
          inputExactlyOnce: true,
          observerDoesNotResize: true,
          nativeControlReleased: true,
          evidence:
            'Real isolated Herdr/PTY and Firefox; rttMs is controlled TCP delay between browser and Swift. Timings include automation/DOM scheduling, not physical key-to-photon or public network latency.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `PASS ${paneCount} real terminals, cached switching, first/continuous input and scrolling, ownership and isolation; flood=${flood}.`,
    );
  } catch (error) {
    await fs.writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify({ error: error.stack, nativeStarts, before }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    for (const timer of proxyTimers) clearTimeout(timer);
    for (const socket of proxySockets) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    transport?.close();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    tui?.kill();
    const exited = native.exitCode === null ? once(native, 'exit') : Promise.resolve();
    native.kill();
    await exited;
    cp.spawn = originalSpawn;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
// Local software timing only: isolated Herdr/PTY, loopback and Firefox.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  cp = require('node:child_process'),
  { once } = require('node:events');
const { firefox, expect } = require('@playwright/test'),
  pty = require('node-pty');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const multiplex = process.argv.includes('--multiplex');
const baseline = process.argv.includes('--baseline'),
  baselineRevision = '9a3bcb3dec22c7e92256a58a254f395750d45af9';
const originalSpawn = cp.spawn,
  nativeStarts = [];
const terminalModule = require('../../lib/herdr-terminal-session'),
  openSession = terminalModule.openTerminalSession,
  nativeConnections = [];
terminalModule.openTerminalSession = (options) => {
  const start = Date.now(),
    session = openSession(options),
    record = { mode: options.mode, start };
  nativeConnections.push(record);
  session.once('ready', () => {
    record.handshakeMs = Date.now() - start;
  });
  session.once('close', () => {
    record.closedAt = Date.now();
  });
  session.once('frame', () => {
    record.firstFrameMs = Date.now() - start;
  });
  return session;
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
      `artifacts/testing/terminal-channel/${baseline ? 'baseline' : 'native'}`,
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
  const channels = [];
  let activeChannelPeak = 0;
  const native = originalSpawn('herdr', ['--session', 'fixture', 'server'], {
    env,
    stdio: 'ignore',
  });
  const nativeClosed = once(native, 'close');
  const json = (args) =>
    JSON.parse(cp.execFileSync('herdr', args, { env, encoding: 'utf8' })).result;
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
  let tui, browser, server, transport;
  try {
    await wait(() =>
      fs.access(env.HERDR_SOCKET_PATH).then(
        () => true,
        () => false,
      ),
    );
    const panes = [];
    for (let i = 0; i < 8; i++) {
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
        `import os,tty,termios,select,json,time\nold=termios.tcgetattr(0);previous=None;count=0;version=-1\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HNATIVE_${i}_READY')\n while True:\n  try:current=int(open(${JSON.stringify(path.join(home, `version-${i}`))}).read())\n  except (OSError,ValueError):current=0\n  if current!=version:\n   version=current;os.write(1,('\\x1b[1;1HNATIVE_${i}_REV_'+str(version)+'\\x1b[K').encode())\n   with open(${JSON.stringify(journal)},'a') as f:f.write(json.dumps({'version':version,'input':'','size':list(os.get_terminal_size()),'at':time.time()*1000})+'\\n')\n  size=list(os.get_terminal_size())\n  data=os.read(0,65536) if select.select([0],[],[],.005)[0] else b''\n  if size!=previous or data:\n   with open(${JSON.stringify(journal)},'a') as f:f.write(json.dumps({'size':size,'input':data.hex(),'at':time.time()*1000})+'\\n')\n   previous=size\n  if data:\n   count+=1;os.write(1,('\\x1b[3;1HEVENT_'+str(count)).encode())\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n`,
      );
      cp.execFileSync('herdr', ['pane', 'run', pane.pane_id, 'python3 -u ' + program], {
        env,
        stdio: 'ignore',
      });
    }
    tui = pty.spawn('herdr', ['--session', 'fixture'], {
      env,
      cwd: home,
      name: 'xterm-256color',
      cols: 132,
      rows: 45,
    });
    tui.onData(() => {});
    await wait(async () => (await records(0)).at(-1)?.size[0] > 80);
    await pause(200);
    const nativeSizes = await Promise.all(
      panes.map((_, i) => records(i).then((rows) => rows.at(-1).size)),
    );
    const herdr = new HerdrClient({ session: 'fixture', socketPath: env.HERDR_SOCKET_PATH });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    assert.equal(snapshot.protocol, 22);
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{display:block}#terminal{width:820px;height:500px;flex:none;--bg:#161616;--text:#ddd}</style><section id="terminal" class="shell-terminal"></section>
      <script src="/ansi.js"></script><script src="/native-status.js"></script><script src="/core/socket.js"></script><script src="/chat/terminal-keyboard.js"></script><script src="/chat/terminal-state.js"></script><script src="/chat/terminal-state-renderer.js"></script><script src="/chat/terminal-renderer.js"></script><script src="/chat/terminal-channel.js"></script><script src="/chat/shell-terminal.js"></script><script>
      window.targets=${JSON.stringify(panes)};window.runtime=${JSON.stringify(snapshot.runtimeId)};
      window.surface=StudioShellTerminal.create({host:document.querySelector('#terminal'),appPath:p=>p,getChannelVersion:()=>${baseline ? 0 : multiplex ? 2 : 1},socketUrl:()=>new URL('/api/terminal?flow=ack',location.href.replace('http:','ws:'))});</script>`;
    server = http.createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      const name = new URL(req.url, 'http://fixture').pathname;
      if (
        !/^\/(?:vendor\/xterm\/[\w.-]+|core\/socket\.js|ansi\.js|native-status\.js|chat\/(?:shell-terminal|terminal-renderer|terminal-state|terminal-state-renderer|terminal-keyboard|terminal-channel)\.js|style\.css)$/.test(
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
    browser = await firefox.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => {
      window.sentInputs = [];
      window.selections = [];
      window.subscriptions = [];
      window.parserWrites = [];
      window.parserCount = 0;
      window.acknowledgements = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const message = JSON.parse(data);
          if (['terminal.input', 'terminal.scroll'].includes(message.type))
            sentInputs.push({ ...message, at: performance.timeOrigin + performance.now() });
          if (message.type === 'terminal.subscribe') subscriptions.push(message);
          if (['terminal.select', 'terminal.activate'].includes(message.type)) {
            selections.push(message);
            window.channelSocket = this;
          }
          if (message.type === 'terminal.ack') acknowledgements.push(message);
        } catch {}
        return send.call(this, data);
      };
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      const create = StudioTerminalRenderer.create;
      function instrument(renderer, index) {
        const write = renderer.write,
          restart = renderer.restart;
        renderer.write = (...args) => {
          window.parserWrites[index]++;
          if (!window.blockNextTerminalParse) return write(...args);
          window.blockNextTerminalParse = false;
          window.terminalParseHeld = true;
          return new Promise((resolve) => {
            window.releaseTerminalParse = resolve;
          }).then(() => write(...args));
        };
        if (restart) renderer.restart = () => instrument(restart(), index);
        return renderer;
      }
      StudioTerminalRenderer.create = (options) => {
        const index = window.parserCount++;
        window.parserWrites[index] = 0;
        return instrument(create(options), index);
      };
    });
    let stalledParserRecovery = null;
    const switches = [],
      input = [],
      scroll = [];
    let revision = 0;
    page.on('websocket', (socket) => channels.push(socket.url()));
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0]) {
      const parsedBefore =
        multiplex && revision >= 8
          ? await page.evaluate((index) => parserWrites[index], index)
          : null;
      revision++;
      await fs.writeFile(path.join(home, `version-${index}`), String(revision));
      await wait(async () => (await records(index)).some((row) => row.version === revision));
      if (parsedBefore != null)
        await page.waitForFunction(({ index, before }) => parserWrites[index] > before, {
          index,
          before: parsedBefore,
        });
      const sample = await page.evaluate(
        async ({ index, revision }) => {
          const start = performance.now();
          surface.update(targets[index], runtime, true);
          await new Promise((resolve, reject) => {
            const deadline = performance.now() + 8000;
            const check = () => {
              if (
                document
                  .querySelector('#terminal .xterm-screen')
                  ?.textContent.includes(`NATIVE_${index}_REV_${revision}`)
              )
                return resolve();
              if (performance.now() > deadline) return reject(new Error('No terminal content'));
              requestAnimationFrame(check);
            };
            check();
          });
          return { index, revision, switchToLatestContentMs: performance.now() - start };
        },
        { index, revision },
      );
      activeChannelPeak = Math.max(activeChannelPeak, transport.clients.size);
      switches.push(sample);
      assert.deepEqual(
        (await records(index)).at(-1).size,
        nativeSizes[index],
        'Viewing cannot resize a PTY',
      );
    }
    if (!baseline) {
      assert.equal(channels.length, 1, 'All selections reuse one WebSocket');
      assert.equal(activeChannelPeak, 1);
    }
    if (multiplex)
      assert.equal(
        await page.evaluate(() => subscriptions.length),
        8,
        'Warm switches must never resubscribe',
      );
    const caret = page.locator('#terminal .xterm-helper-textarea');
    for (const key of 'abc') {
      await caret.focus();
      const at = Date.now();
      await page.keyboard.type(key);
      const record = await wait(async () =>
        (await records(0)).find((row) => row.input === Buffer.from(key).toString('hex')),
      );
      assert.notDeepEqual(
        record.size,
        nativeSizes[0],
        'Input follows the applied control geometry',
      );
      const sent = await page.evaluate(
        (key) =>
          sentInputs.find((message) => message.type === 'terminal.input' && message.data === key),
        key,
      );
      input.push({ key, actionToNativeMs: record.at - at, sendToNativeMs: record.at - sent.at });
    }
    await page.evaluate(() => surface.update(null, runtime, false));
    await wait(
      async () => JSON.stringify((await records(0)).at(-1).size) === JSON.stringify(nativeSizes[0]),
    );

    await page.evaluate(() => surface.update(targets[0], runtime, true));
    await page.waitForFunction(
      () => document.querySelector('.shell-terminal-canvas').getAttribute('aria-busy') === 'false',
    );
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
    await expect(page.locator('#terminal')).toContainText('EVENT_6');
    const received = (await records(0)).filter((row) => row.input);
    assert.equal(received.length, 6);
    for (let i = 1; i < panes.length; i++)
      assert.equal((await records(i)).filter((row) => row.input).length, 0);
    if (!baseline)
      assert.equal(
        nativeStarts.length,
        0,
        'No terminal CLI process is created for display or control',
      );
    const normalSwitchConnections = channels.length;
    if (!baseline) {
      const second = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      let secondConnections = 0;
      second.on('websocket', () => secondConnections++);
      second.on('pageerror', (error) => errors.push(error.message));
      await second.goto('http://127.0.0.1:' + server.address().port);
      await second.evaluate(() => surface.update(targets[1], runtime, true));
      await expect(second.locator('#terminal')).toContainText('NATIVE_1_REV_');
      await second.locator('.xterm-helper-textarea').focus();
      await second.keyboard.type('z');
      await wait(async () => (await records(1)).some((row) => row.input === '7a'));
      await caret.focus();
      await page.keyboard.type('d');
      await wait(async () => (await records(0)).some((row) => row.input === '64'));
      assert.equal(transport.clients.size, 2);
      const otherSize = (await records(1)).at(-1).size;
      await fs.writeFile(path.join(home, 'version-2'), '900');
      await wait(async () => (await records(2)).some((row) => row.version === 900));
      await page.evaluate(() => {
        const previous = selections.at(-1).selectionId;
        for (const index of [3, 4, 5, 6, 7, 2]) surface.update(targets[index], runtime, true);
        channelSocket.send(
          JSON.stringify({
            type: 'terminal.input',
            selectionId: previous,
            subscriptionId: subscriptions[0]?.subscriptionId,
            data: 'STALE_INPUT',
          }),
        );
      });
      await expect(page.locator('#terminal')).toContainText('NATIVE_2_REV_900');
      await caret.focus();
      await page.keyboard.type('k');
      await wait(async () => (await records(2)).some((row) => row.input === '6b'));
      assert.deepEqual(
        (await records(1)).at(-1).size,
        otherSize,
        'Other client retains its control geometry',
      );
      await page.evaluate(() => channelSocket.close(4008, 'fixture reconnect'));
      await expect(page.locator('.shell-terminal-canvas')).toHaveAttribute('aria-busy', 'true');
      await page.keyboard.type('must-not-replay');
      await expect(page.locator('.shell-terminal-canvas')).toHaveAttribute('aria-busy', 'false');
      await page.keyboard.type('r');
      await wait(async () => (await records(2)).some((row) => row.input === '72'));
      assert.equal(channels.length, 2, 'Only disconnection creates another channel');
      await second.locator('.xterm-helper-textarea').focus();
      await second.keyboard.type('y');
      await wait(async () => (await records(1)).some((row) => row.input === '79'));
      assert.equal(secondConnections, 1, 'The other window never reconnects');
      assert.deepEqual(
        (await records(1)).filter((row) => row.input).map((row) => row.input),
        ['7a', '79'],
      );
      assert.deepEqual(
        (await records(2)).filter((row) => row.input).map((row) => row.input),
        ['6b', '72'],
      );
      for (let i = 3; i < panes.length; i++)
        assert.equal((await records(i)).filter((row) => row.input).length, 0);
      assert(
        !(await records(0)).some((row) =>
          Buffer.from(row.input, 'hex').toString().includes('STALE'),
        ),
      );
      await second.close();
      await wait(
        async () =>
          JSON.stringify((await records(1)).at(-1).size) === JSON.stringify(nativeSizes[1]),
      );
      await page.evaluate(() => {
        window.blockNextTerminalParse = true;
      });
      await fs.writeFile(path.join(home, 'version-2'), '1001');
      await page.waitForFunction(() => window.terminalParseHeld);
      const start = Date.now();
      const oldStream = await page.evaluate(() => {
        const stream = acknowledgements.at(-1).streamId;
        surface.update(targets[3], runtime, true);
        return stream;
      });
      await expect(page.locator('#terminal')).toContainText('NATIVE_3_REV_');
      await page.waitForFunction(
        (old) =>
          acknowledgements.some(
            (message) => message.streamId !== old && message === acknowledgements.at(-1),
          ),
        oldStream,
      );
      const switchToAcknowledgedFrameMs = Date.now() - start;
      await caret.focus();
      await page.keyboard.type('v');
      const received = await wait(async () => (await records(3)).find((row) => row.input === '76'));
      const sent = await page.evaluate(() => sentInputs.find((message) => message.data === 'v'));
      stalledParserRecovery = {
        switchToAcknowledgedFrameMs,
        sendToNativeMs: received.at - sent.at,
        oldParserStillHeld: true,
      };
      assert.deepEqual(
        (await records(3)).filter((row) => row.input).map((row) => row.input),
        ['76'],
      );
      if (multiplex) {
        await page.evaluate(() => channelSocket.close(4008, 'fixture replaces stalled parser'));
        await expect(page.locator('.shell-terminal-canvas')).toHaveAttribute('aria-busy', 'false', {
          timeout: 8000,
        });
        await page.evaluate(() => surface.update(targets[2], runtime, true));
        await expect(page.locator('#terminal')).toContainText('NATIVE_2_REV_1001');
        stalledParserRecovery.reconnectedBeforeOldParserFinished = true;
      }
      await page.evaluate(() => releaseTerminalParse());
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.evaluate(() => surface.update(null, runtime, false));
    await wait(
      async () => JSON.stringify((await records(0)).at(-1).size) === JSON.stringify(nativeSizes[0]),
    );
    if (!baseline)
      await wait(
        async () =>
          JSON.stringify((await records(2)).at(-1).size) === JSON.stringify(nativeSizes[2]),
      );

    const after = sourceFingerprint(process.cwd());
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          multiplex,
          baseline,
          baselineRevision,
          before,
          after,
          switches,
          input,
          scroll,
          nativeStarts,
          nativeConnections,
          channels: normalSwitchConnections,
          activeChannelPeak,
          clientIsolation: !baseline,
          staleInputRejected: !baseline,
          reconnectNoReplay: !baseline,
          stalledParserRecovery,
          inputExactlyOnce: true,
          observerDoesNotResize: true,
          nativeControlReleased: true,
          evidence:
            'Real isolated Herdr/PTY over loopback and Firefox. Timings include automation/DOM scheduling, not physical key-to-photon or public network latency.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS one channel across eight real terminals, latest hidden updates, input, scrolling and ownership.',
    );
  } catch (error) {
    await fs.writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify({ error: error.stack, nativeStarts, before }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    transport?.close();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    tui?.kill();
    native.kill();
    await nativeClosed;
    cp.spawn = originalSpawn;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events'),
  { WebSocket } = require('ws'),
  pty = require('node-pty');
const { HerdrClient } = require('../../lib/herdr-client');
const { createTerminalTransport } = require('../../lib/terminal-transport');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read, description) {
  for (let i = 0; i < 160; i++) {
    const result = await read();
    if (result) return result;
    await pause(40);
  }
  throw new Error('Timed out: ' + description);
}
(async () => {
  const baseline = process.argv.includes('--baseline'),
    root = path.resolve(__dirname, '../..');
  const output = process.env.SWIFT_TERMINAL_OWNERSHIP_OUTPUT
    ? path.resolve(process.env.SWIFT_TERMINAL_OWNERSHIP_OUTPUT)
    : path.join(
        root,
        'artifacts/testing/terminal-size-ownership',
        baseline ? 'baseline' : 'native',
      );
  await fs.mkdir(output, { recursive: true });
  if (baseline) {
    const Module = require('node:module'),
      filename = require.resolve('../lib/shell-terminal');
    const original = new Module(filename, module);
    original.filename = filename;
    original.paths = module.paths;
    original._compile(
      execFileSync('git', ['show', 'a8d54c1:lib/shell-terminal.js'], { encoding: 'utf8' }),
      filename,
    );
    require.cache[filename] = original;
  }
  const before = sourceFingerprint(root),
    home = await fs.mkdtemp('/tmp/swift-ownership-');
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
  let tui,
    transport,
    server,
    ws,
    phoneWs,
    tuiOutput = '';
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
  const dimensions = async () => (await records()).at(-1)?.size;
  const keyCount = async (key) => (await records()).filter((record) => record.input === key).length;
  try {
    await wait(
      () =>
        fs.access(env.HERDR_SOCKET_PATH).then(
          () => true,
          () => false,
        ),
      'isolated daemon',
    );
    const pane = json([
      'workspace',
      'create',
      '--cwd',
      home,
      '--label',
      'size-fixture',
      '--no-focus',
    ]).root_pane;
    const program = path.join(home, 'dimensions.py');
    await fs.writeFile(
      program,
      `import os,sys,tty,termios,time,json,select\nold=termios.tcgetattr(0)\nprevious=None\ntry:\n tty.setraw(0)\n while True:\n  size=list(os.get_terminal_size())\n  data=os.read(0,1024).decode('utf-8','replace') if select.select([0],[],[],.02)[0] else ''\n  if size!=previous or data:\n   with open(${JSON.stringify(journal)},'a') as f: f.write(json.dumps({'size':size,'input':data,'at':time.time()})+'\\n')\n   os.write(1,('\\r\\nGEOMETRY:'+str(size)+' KEY:'+repr(data)+'\\r\\n').encode())\n   previous=size\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n`,
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
    tui.onData((data) => {
      tuiOutput = (tuiOutput + data).slice(-100000);
    });
    await wait(async () => {
      const size = await dimensions();
      return size && size[0] > 80;
    }, 'native TUI geometry');
    await pause(200);
    let nativeSize = await dimensions();
    assert(nativeSize[0] > 80 && nativeSize[1] > 25);
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
      `ws://127.0.0.1:${server.address().port}/api/terminal?shell=1&pane=${pane.pane_id}&terminalId=${pane.terminal_id}&runtimeId=${snapshot.runtimeId}&cols=47&rows=18&retainControl=1`,
    );
    let ready = false,
      bytes = 0;
    const messages = [];
    ws.on('message', (raw, binary) => {
      if (binary) bytes += raw.length;
      else {
        const record = JSON.parse(String(raw));
        messages.push(record);
        ready ||= record.type === 'terminal.ready';
      }
    });
    await wait(() => ready && bytes > 0, 'Swift read stream');
    const send = (value) => ws.send(JSON.stringify(value));
    if (!baseline) {
      for (let i = 0; i < 4; i++) send({ type: 'terminal.focus', focused: true });
      await pause(250);
      assert.deepEqual(
        await dimensions(),
        nativeSize,
        'Passive browser focus must not change the real PTY geometry',
      );
    }
    if (baseline) {
      await wait(
        async () => JSON.stringify(await dimensions()) === '[47,18]',
        'original persistent controller size',
      );
      tui.resize(140, 49);
      await pause(1400);
      assert.deepEqual(await dimensions(), [47, 18]);
    } else {
      assert.deepEqual(
        await dimensions(),
        nativeSize,
        'An idle Swift observer must not resize the native TUI',
      );
      send({ type: 'terminal.input', data: 'C' });
      await wait(
        async () => JSON.stringify(await dimensions()) === '[47,18]',
        'Swift claims geometry through activity',
      );
      const readingStart = (await records()).length;
      tui.resize(140, 49);
      nativeSize = [nativeSize[0] + 8, nativeSize[1] + 4];
      await pause(1500);
      assert.deepEqual(
        await dimensions(),
        [47, 18],
        'Reading after input must not return to the native TUI dimensions',
      );
      assert(
        (await records())
          .slice(readingStart)
          .every((record) => JSON.stringify(record.size) === '[47,18]'),
        'No intermediate geometry changes are allowed while the foreground terminal is idle',
      );
      send({ type: 'terminal.input', data: 'A' });
      await wait(
        async () => (await keyCount('A')) === 1 && JSON.stringify(await dimensions()) === '[47,18]',
        'first input after reading is delivered exactly once',
      );
      const blurAt = Date.now();
      send({ type: 'terminal.focus', focused: false });
      await wait(
        async () => JSON.stringify(await dimensions()) === JSON.stringify(nativeSize),
        'blur returns geometry',
      );
      assert(
        Date.now() - blurAt < 900,
        'Blur should release the foreground controller immediately',
      );
      send({ type: 'terminal.resize', cols: 61, rows: 22 });
      await pause(200);
      assert.deepEqual(
        await dimensions(),
        nativeSize,
        'Passive layout changes must not claim geometry',
      );
      send({ type: 'terminal.input', data: 'B' });
      await wait(
        async () => (await keyCount('B')) === 1 && JSON.stringify(await dimensions()) === '[61,22]',
        'next activity uses current Swift dimensions',
      );
      await pause(1250);
      assert.deepEqual(
        await dimensions(),
        [61, 22],
        'The next foreground read also keeps its own geometry',
      );
      send({ type: 'terminal.focus', focused: false });
      await wait(
        async () => JSON.stringify(await dimensions()) === JSON.stringify(nativeSize),
        'second return to native TUI',
      );
      assert.equal(await keyCount('C'), 1);
      assert.equal(await keyCount('A'), 1);
      assert.equal(await keyCount('B'), 1);
      assert(!messages.some((record) => record.type === 'terminal.error'));
      phoneWs = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/api/terminal?shell=1&pane=${pane.pane_id}&terminalId=${pane.terminal_id}&runtimeId=${snapshot.runtimeId}&cols=47&rows=18&retainControl=1`,
      );
      let phoneReady = false;
      phoneWs.on('message', (raw, binary) => {
        if (!binary) phoneReady ||= JSON.parse(String(raw)).type === 'terminal.ready';
      });
      await once(phoneWs, 'open');
      await wait(() => phoneReady, 'phone observer');
      for (const action of ['down', 'up'])
        phoneWs.send(
          JSON.stringify({ type: 'terminal.mouse', action, button: 'left', column: 2, row: 2 }),
        );
      await wait(
        async () => JSON.stringify(await dimensions()) === '[47,18]',
        'phone takes its own geometry after a tap',
      );
      await pause(1250);
      assert.deepEqual(
        await dimensions(),
        [47, 18],
        'Phone geometry must remain stable while it is in the foreground',
      );
      phoneWs.send(JSON.stringify({ type: 'terminal.focus', focused: false }));
      await wait(
        async () => JSON.stringify(await dimensions()) === JSON.stringify(nativeSize),
        'phone blur releases native geometry',
      );
    }
    const after = sourceFingerprint(root);
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'dimensions.json'),
      JSON.stringify(await records(), null, 2) + '\n',
    );
    const report = {
      ok: true,
      baseline,
      source: before,
      after,
      backendRevision: baseline ? 'a8d54c1' : before.revision,
      herdrVersion: execFileSync('herdr', ['--version'], { env, encoding: 'utf8' }).trim(),
      nativeSize,
      swiftSize: [47, 18],
      isolated: true,
      baselineLockReproduced: baseline,
      observerDoesNotResize: !baseline,
      foregroundReadingStable: !baseline,
      immediateBlurRelease: !baseline,
      nativeClientResize: true,
      repeatedInputExactlyOnce: !baseline,
      passiveResizeDoesNotClaim: !baseline,
      phoneRetainsAfterTap: !baseline,
      phoneReleasesOnBlur: !baseline,
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      baseline
        ? 'PASS reproduced persistent Swift size lock against a real native Herdr TUI.'
        : 'PASS foreground reading retains Swift geometry; blur restores Herdr geometry; input is not replayed.',
    );
  } finally {
    await fs.writeFile(path.join(output, 'tui-output.ansi'), tuiOutput);
    await fs.writeFile(
      path.join(output, 'last-observed-dimensions.json'),
      JSON.stringify(await records(), null, 2),
    );
    phoneWs?.terminate();
    ws?.terminate();
    transport?.close();
    server?.close();
    tui?.kill();
    try {
      execFileSync('herdr', ['server', 'stop'], { env, stdio: 'ignore' });
    } catch {}
    native.kill('SIGTERM');
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

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
const baseline = process.argv.includes('--baseline');
const baselineRevision = '71f437c';
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
    process.env.SWIFT_TERMINAL_INPUT_OUTPUT ||
      'artifacts/testing/terminal-input-performance/' + (baseline ? 'baseline' : 'native'),
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
  const nativeClosed = once(native, 'close');
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
      "import os,tty,termios,select,json,time\nold=termios.tcgetattr(0);received='';previous=None;seq=0\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[2J\\x1b[HNATIVE_READY\\r\\n'+b''.join(('BACKGROUND_ROW_'+str(i)+' '+('abcdefghij'*6)+'\\r\\n').encode() for i in range(32))+b'\\x1b[35;1HREV_0 ECHO_')\n while True:\n  size=list(os.get_terminal_size());value=os.read(0,1024) if select.select([0],[],[],.001)[0] else b''\n  if size!=previous or value:\n   with open(JOURNAL,'a') as f:f.write(json.dumps({'size':size,'input':value.hex(),'at':time.time()*1000})+'\\n')\n   previous=size\n  for byte in value:\n   seq+=1\n   if byte in (8,127):received=received[:-1]\n   elif 32<=byte<127:received+=chr(byte)\n   os.write(1,('\\x1b[35;1HREV_'+str(seq)+' ECHO_'+received+'\\x1b[K\\x1b[?25h').encode())\nfinally:\n termios.tcsetattr(0,termios.TCSANOW,old)\n".replace(
        'JOURNAL',
        JSON.stringify(journal),
      ),
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
    const instrumentation = String.raw`window.events=[];window.lastRenderedSeq=0;
const timestamp=()=>performance.timeOrigin+performance.now();
const nativeSend=WebSocket.prototype.send;
WebSocket.prototype.send=function(data){
  try{const m=JSON.parse(data);if(m.type==='terminal.input')events.push({kind:'input',at:timestamp(),data:m.data});}catch{}
  return nativeSend.call(this,data);
};
const originalSocket=StudioSocket.create;
StudioSocket.create=options=>originalSocket({...options,onBinary:bytes=>{
  events.push({kind:'arrival',at:timestamp(),bytes:bytes.length});return options.onBinary(bytes);
}});
let TerminalClass;
Object.defineProperty(window,'Terminal',{configurable:true,get:()=>TerminalClass,set:Base=>{
  TerminalClass=class extends Base{
    open(...args){
      super.open(...args);
      this.onRender(()=>{
        const buffer=this.buffer.active;let seq=-1;
        for(let y=0;y<this.rows;y++){
          const match=buffer.getLine(buffer.viewportY+y)?.translateToString(true).match(/REV_(\d+) ECHO_/);
          if(match)seq=Number(match[1]);
        }
        if(seq>=0){window.lastRenderedSeq=Math.max(window.lastRenderedSeq,seq);events.push({kind:'visibleRender',at:timestamp(),seq});}
      });
    }
    write(data,callback){
      const kind=this.element?'visible':'parser',start=timestamp();
      events.push({kind:kind+'Start',at:start,bytes:data.length});
      return super.write(data,()=>{events.push({kind:kind+'Done',at:timestamp(),duration:timestamp()-start});callback?.();});
    }
  };
}});
const originalRenderer=StudioTerminalRenderer.create;
StudioTerminalRenderer.create=options=>{
  const renderer=originalRenderer(options),render=renderer.render;
  renderer.render=options=>{const at=timestamp(),cells=render(options);events.push({kind:'project',at,duration:timestamp()-at,bytes:cells.length});return cells;};
  return renderer;
};
`;
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{display:block}#terminal{width:1700px;height:900px;flex:none;--bg:#161616;--text:#ddd}</style><section id="terminal" class="shell-terminal"></section>
      <script src="/ansi.js"></script><script src="/native-status.js"></script><script src="/core/socket.js"></script><script src="/chat/terminal-renderer.js"></script><script src="/chat/terminal-channel.js"></script><script src="/chat/shell-terminal.js"></script><script>${instrumentation}

      window.target=${JSON.stringify(target)};window.runtime=${JSON.stringify(snapshot.runtimeId)};
      window.surface=StudioShellTerminal.create({host:document.querySelector('#terminal'),appPath:p=>p,getChannelVersion:()=>1,socketUrl:()=>new URL('/api/terminal?flow=ack',location.href.replace('http:','ws:'))});surface.update(target,runtime,true);</script>`;
    server = http.createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      const name = new URL(req.url, 'http://fixture').pathname;
      if (
        !/^\/(?:vendor\/xterm\/[\w.-]+|core\/socket\.js|ansi\.js|native-status\.js|chat\/(?:shell-terminal|terminal-renderer|terminal-channel)\.js|style\.css)$/.test(
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
        let code = await fs.readFile(path.join(process.cwd(), 'public', name), 'utf8');
        if (baseline && ['/chat/shell-terminal.js', '/chat/terminal-renderer.js'].includes(name))
          code = execFileSync('git', ['show', baselineRevision + ':public' + name], {
            encoding: 'utf8',
          });
        res.end(code);
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
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.locator('#terminal')).toContainText('REV_0 ECHO_');
    assert.deepEqual(
      (await records()).at(-1).size,
      nativeSize,
      'Observation must not take control',
    );
    const input = page.locator('#terminal .xterm-helper-textarea');
    await input.focus();
    const latencies = [];
    for (const [index, key] of [
      ...'abcdefghijklmnopqrst',
      ...Array(20).fill('Backspace'),
    ].entries()) {
      await page.evaluate(() => {
        events.length = 0;
        window.sampleStart = performance.timeOrigin + performance.now();
      });
      if (key === 'Backspace') await page.keyboard.press(key);
      else await page.keyboard.type(key);
      await page.waitForFunction((seq) => window.lastRenderedSeq >= seq, index + 1);
      const rows = await page.evaluate(() => events.slice());
      const sent = rows.find((x) => x.kind === 'input'),
        received = rows.find((x) => x.kind === 'arrival' && x.at >= sent.at);
      const parser = rows.find((x) => x.kind === 'parserDone' && x.at >= sent.at),
        render = rows.find((x) => x.kind === 'visibleRender' && x.seq === index + 1);
      const nativeRow = (await records()).filter((x) => x.input)[index];
      assert(sent && received && parser && render && nativeRow);
      latencies.push({
        key,
        sendToPtyMs: nativeRow.at - sent.at,
        ptyToClientMs: received.at - nativeRow.at,
        clientToParserMs: parser.at - received.at,
        parserToVisibleMs: render.at - parser.at,
        sendToVisibleMs: render.at - sent.at,
        rendererCalls: rows.filter((x) => x.kind === 'project').length,
        projectMs: rows.filter((x) => x.kind === 'project').reduce((n, x) => n + x.duration, 0),
        events: rows,
      });
    }
    const controlledSize = (await records()).at(-1).size;
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    const after = sourceFingerprint(process.cwd());
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          baseline,
          baselineRevision,
          before,
          after,
          nativeSize,
          controlledSize,
          connections,
          latencies,
          evidence:
            'Isolated real Herdr/PTY, Firefox, local loopback; xterm render event, not physical key-to-photon. The baseline serves pinned pre-optimization source; the current run serves the actual implementation.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS input echo latency audit',
      baseline ? '0.15.85 baseline' : 'current implementation',
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
    await nativeClosed;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

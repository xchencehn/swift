'use strict';
// Exercise the shipped component against an isolated real Herdr and PTY.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http');
const { spawn, execFileSync } = require('node:child_process'),
  { once } = require('node:events');
const assert = require('node:assert/strict'),
  { firefox, expect } = require('@playwright/test');
const { HerdrClient } = require('../../lib/herdr-client'),
  { createTerminalTransport } = require('../../lib/terminal-transport');
const { touchDrag } = require('./terminal-touch-fixture');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const root = path.resolve(__dirname, '../..'),
    before = sourceFingerprint(root);
  const output = path.join(root, 'artifacts/terminal-native-interaction');
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp('/tmp/swift-terminal-interaction-'),
    session = 'fixture';
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home + '/config',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: session,
    HERDR_SOCKET_PATH: home + '/config/herdr/sessions/fixture/herdr.sock',
  };
  const native = spawn('herdr', ['--session', session, 'server'], { env, stdio: 'ignore' });
  const json = (args) => JSON.parse(execFileSync('herdr', args, { env, encoding: 'utf8' })).result;
  let server, transport, browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fs.access(env.HERDR_SOCKET_PATH);
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    const pane = json([
      'workspace',
      'create',
      '--cwd',
      home,
      '--label',
      'interaction-fixture',
      '--no-focus',
    ]).root_pane;
    const herdr = new HerdrClient({ session, socketPath: env.HERDR_SOCKET_PATH });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css">
      <style>body{display:block}#terminal{width:min(900px,100vw);height:520px;--bg:#161616;--text:#ddd} .shell-terminal-canvas{height:100%}</style>
      <div id="terminal"></div><script src="/core/socket.js"></script><script src="/core/connection-feedback.js"></script><script src="/chat/terminal-renderer.js"></script><script src="/chat/shell-terminal.js"></script>
      <script>window.surface=StudioShellTerminal.create({host:document.querySelector('#terminal'),appPath:p=>p,
        socketUrl:()=>new URL('/api/terminal?flow=ack',location.href.replace('http:','ws:'))});
      surface.update(${JSON.stringify({ paneId: pane.pane_id, terminalId: pane.terminal_id })},${JSON.stringify(snapshot.runtimeId)},true);</script>`;
    server = http.createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      const name = new URL(req.url, 'http://fixture').pathname;
      if (
        !/^\/(?:vendor\/xterm\/[\w.-]+|core\/(?:socket|connection-feedback)\.js|chat\/(?:shell-terminal|terminal-renderer)\.js|style\.css)$/.test(
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
        res.end(await fs.readFile(path.join(root, 'public', name)));
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('http://127.0.0.1:' + server.address().port);
    const terminal = page.locator('#terminal');
    await expect(terminal.locator('.shell-terminal-notice')).toHaveCount(0);
    await expect(terminal.locator('.shell-terminal-canvas')).toHaveAttribute('aria-busy', 'false');
    await terminal.locator('.xterm-helper-textarea').focus();
    // Output predates scroll: Herdr must serve real history rather than local xterm rows.
    await page.keyboard.type("seq -f 'HISTORY_%03g' 1 180");
    await page.keyboard.press('Enter');
    await expect(terminal).toContainText('HISTORY_180');
    await page.waitForTimeout(150);
    const screen = terminal.locator('.xterm-screen');
    await screen.hover({ position: { x: 240, y: 180 } });
    await page.mouse.wheel(0, -500);
    await expect(terminal).not.toContainText('HISTORY_180');
    await page.screenshot({ path: path.join(output, 'history-up.png') });
    await page.mouse.wheel(0, 4000);
    await expect(terminal).toContainText('HISTORY_180');
    await page.keyboard.press('PageUp');
    await expect(terminal).not.toContainText('HISTORY_180');
    await page.keyboard.press('PageDown');
    await expect(terminal).toContainText('HISTORY_180');
    // Native app enables SGR mouse mode and reports precisely what it receives.
    const program = path.join(home, 'mouse.py');
    await fs.writeFile(
      program,
      `import os,sys,termios,tty,re,json\nopen('dimensions.json','w').write(json.dumps(list(os.get_terminal_size())))\na=termios.tcgetattr(0)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[2J\\x1b[H\\x1b[?1002h\\x1b[?1006h\\x1b[?2004hMOUSE_READY')\n pending=b''\n while True:\n  pending+=os.read(0,1024)\n  for m in re.finditer(rb'\\x1b\\[<([0-9]+);([0-9]+);([0-9]+)([Mm])',pending):\n   open('mouse-events.txt','a').write(m.group(1).decode()+'\\n')\n   os.write(1,b'\\x1b[3;1H'+b'RECEIVED:'+m.group(0)[2:]+b'    ')\n  if b'\\x1b[200~'+ '中文\\rterminal'.encode()+b'\\x1b[201~' in pending: os.write(1,'\\x1b[5;1H中文粘贴 PASTE_OK'.encode())\n  if b'\\x03' in pending: break\n  pending=b''\nfinally:\n os.write(1,b'\\x1b[?1002l\\x1b[?1006l\\x1b[?2004l')\n termios.tcsetattr(0,termios.TCSANOW,a)\n`,
    );
    await page.keyboard.type('python3 ' + program);
    await page.keyboard.press('Enter');
    await expect(terminal).toContainText('MOUSE_READY');
    const box = await screen.boundingBox();
    const dimensions = JSON.parse(await fs.readFile(path.join(home, 'dimensions.json'), 'utf8'));
    // Use stable fractional positions; compare with authoritative runtime geometry.
    const [cols, rows] = dimensions;
    assert(cols > 0 && rows > 0);
    const col = 20,
      row = 8,
      x = box.x + ((col + 0.5) * box.width) / cols,
      y = box.y + ((row + 0.5) * box.height) / rows;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(terminal).toContainText('RECEIVED:<0;21;9M');
    await page.mouse.move(x + box.width / cols, y + box.height / rows);
    await expect(terminal).toContainText('RECEIVED:<32;22;10M');
    await page.mouse.up();
    await expect(terminal).toContainText('RECEIVED:<0;22;10m');
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -100);
    await expect(terminal).toContainText('RECEIVED:<64;21;9M');
    await page.mouse.wheel(0, 100);
    await expect(terminal).toContainText('RECEIVED:<65;21;9M');
    await page.keyboard.down('Control');
    await page.mouse.down();
    await expect(terminal).toContainText('RECEIVED:<16;21;9M');
    await page.mouse.up();
    await page.keyboard.up('Control');
    // Shift permits local selection, then copies on mouse release without a native press.
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 1, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 5);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('MOUSE');
    await page.evaluate(() => navigator.clipboard.writeText('中文\nterminal'));
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + 100, box.y + 70, { button: 'right' });
    await page.keyboard.up('Shift');
    await expect(terminal).toContainText('PASTE_OK');
    await page.keyboard.press('Control+c');
    await page.screenshot({ path: path.join(output, 'mouse.png') });
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto('http://127.0.0.1:' + server.address().port);
    const mobileTerminal = mobile.locator('#terminal'),
      mobileScreen = mobileTerminal.locator('.xterm-screen');
    await expect(mobileTerminal.locator('.shell-terminal-notice')).toHaveCount(0);
    await expect(mobileTerminal.locator('.shell-terminal-canvas')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await mobileTerminal.locator('.xterm-helper-textarea').focus();
    await mobile.keyboard.type("seq -f 'MOBILE_%03g' 1 180");
    await mobile.keyboard.press('Enter');
    await expect(mobileTerminal).toContainText('MOBILE_180');
    await touchDrag(mobileScreen, { dy: 180 });
    await expect(mobileTerminal).not.toContainText('MOBILE_180');
    const settled = await mobileTerminal.innerText();
    await mobile.waitForTimeout(200);
    assert.equal(await mobileTerminal.innerText(), settled);
    await mobile.screenshot({ path: path.join(output, 'mobile-history-up.png') });
    await touchDrag(mobileScreen, { dy: -180 });
    await expect(mobileTerminal).toContainText('MOBILE_180');
    await mobileTerminal.locator('.xterm-helper-textarea').focus();
    await mobile.keyboard.type('python3 ' + program);
    await mobile.keyboard.press('Enter');
    await expect(mobileTerminal).toContainText('MOUSE_READY');
    const events = async () =>
      (await fs.readFile(path.join(home, 'mouse-events.txt'), 'utf8')).trim().split('\n');
    const count = (await events()).length;
    await touchDrag(mobileScreen, { dy: 180 });
    await expect
      .poll(async () => (await events()).slice(count).filter((v) => v === '64').length)
      .toBeGreaterThan(3);
    const middle = (await events()).length;
    await touchDrag(mobileScreen, { dy: -180 });
    await expect
      .poll(async () => (await events()).slice(middle).filter((v) => v === '65').length)
      .toBeGreaterThan(3);
    const end = (await events()).length;
    await touchDrag(mobileScreen, { dx: 100 });
    await touchDrag(mobileScreen, { dy: 100, multi: true });
    assert.equal((await events()).length, end);
    await mobile.keyboard.press('Control+c');
    assert.deepEqual(errors, []);
    const after = sourceFingerprint(root);
    assert.equal(before.treeSha256, after.treeSha256);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          version: execFileSync('herdr', ['--version'], { env, encoding: 'utf8' }).trim(),
          isolated: true,
          mobileNativeHistoryTouch: true,
          mobileNativeAppTouch: true,
          mobileHorizontalAndPinchPreserved: true,
          nativeHistoryWheel: true,
          nativePageKeys: true,
          nativeMouseCoordinates: true,
          nativeDragRelease: true,
          nativeAppWheel: true,
          modifier: true,
          localSelection: true,
          nativeChineseMultilinePaste: true,
          dimensions,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS real Herdr scrollback, page keys, native application wheel, mouse press/drag/release and local selection',
    );
  } finally {
    await browser?.close();
    transport?.close();
    server?.close();
    try {
      execFileSync('herdr', ['server', 'stop'], { env, stdio: 'ignore' });
    } catch {}
    native.kill('SIGTERM');
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});

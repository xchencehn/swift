'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { startClient } = require('./desktop-harness');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-multi-window-'));
  const output = path.resolve('artifacts/testing/multi-window/browser');
  fs.mkdirSync(output, { recursive: true });
  const first = await createFixture(),
    second = await createFixture();
  const client = await startClient(directory);
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => {
    window.SWIFT_CHAT_PRESENTATION = 'structured';
  });
  const a = await context.newPage();
  const errors = [];
  context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
  a.on('pageerror', (error) => errors.push(error.message));
  try {
    await a.goto(client.bootstrap);
    const connect = async (page, address, name) =>
      page.evaluate(
        async (input) => {
          const result = await window.StudioDesktopConnections.api('connect', input);
          location.assign(result.path);
          return result.path;
        },
        { mode: 'direct', address, name },
      );
    const aPath = await connect(a, first.url, '服务器 A');
    await expect(a.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    await a.locator('#commandInput').fill('服务器 A 的独立草稿');
    const aNode = await a.locator('#chatLog').elementHandle();
    const b = await context.newPage();
    await b.goto(client.origin + '/connect');
    const bPath = await connect(b, second.url, '服务器 B');
    await expect(b.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    await b.locator('#commandInput').fill('服务器 B 的独立草稿');
    await expect(a.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    await expect(a.locator('#commandInput')).toHaveValue('服务器 A 的独立草稿');
    assert(await aNode.evaluate((node) => node.isConnected));
    await expect(a).toHaveTitle('Swift — 服务器 A');
    await expect(b).toHaveTitle('Swift — 服务器 B');
    await a.locator('#chatModeToggle').click();
    await expect(a.locator('#shellTerminal')).toBeVisible();
    await expect(b.locator('#chatLog')).toBeVisible();
    // Navigation between server paths stays in the same window and retains its mode.
    await a.goto(client.origin + bPath);
    await expect(a.locator('#shellTerminal')).toBeVisible();
    await expect(b.locator('#shellTerminal')).toBeHidden();
    await a.goto(client.origin + aPath);
    await expect(a.locator('#shellTerminal')).toBeVisible();
    await b.reload();
    await expect(b.locator('#chatLog')).toBeVisible();
    await a.screenshot({ path: path.join(output, 'window-a-terminal.png') });
    await b.screenshot({ path: path.join(output, 'window-b-chat.png') });
    await a.locator('#chatModeToggle').click();
    await expect(a.locator('#commandInput')).toHaveValue('服务器 A 的独立草稿');
    await expect(b.locator('#commandInput')).toHaveValue('服务器 B 的独立草稿');
    // Track actual open sockets, rather than relying only on a cached UI status.
    const live = await a.evaluate(async (base) => {
      const socket = new WebSocket(
        location.origin.replace('http:', 'ws:') + base + 'api/terminal?pane=pane-codex',
      );
      window.multiWindowSocket = socket;
      return new Promise((resolve) => {
        socket.onopen = () => resolve(true);
        socket.onerror = () => resolve(false);
      });
    }, aPath);
    assert.equal(live, true);
    const aId = aPath.split('/')[2],
      bId = bPath.split('/')[2];
    for (const id of [aId, bId, aId, bId])
      await b.evaluate((id) => window.StudioDesktopConnections.api('activate', { id }), id);
    assert.equal(await a.evaluate(() => window.multiWindowSocket.readyState), 1);
    await a.locator('#serverSwitch').click();
    await expect(a.locator('[aria-current=true][data-server-id]')).toHaveAttribute(
      'data-server-id',
      aId,
    );
    await b.locator('#serverSwitch').click();
    await expect(b.locator('[aria-current=true][data-server-id]')).toHaveAttribute(
      'data-server-id',
      bId,
    );
    await a.screenshot({ path: path.join(output, 'server-a.png') });
    await b.screenshot({ path: path.join(output, 'server-b.png') });
    const popupWait = context.waitForEvent('page');
    await a.getByRole('button', { name: '在新窗口打开 服务器 B', exact: true }).click();
    const popup = await popupWait;
    await expect(popup).toHaveURL(client.origin + bPath);
    await expect(popup).toHaveTitle('Swift — 服务器 B');
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    const shortcutWait = context.waitForEvent('page');
    await b.keyboard.press('Control+Shift+N');
    const chooser = await shortcutWait;
    await expect(chooser).toHaveURL(client.origin + '/connect');
    await chooser.close();
    await b.keyboard.press('Escape');
    // Send only into separate fixtures and verify the gateway never crosses targets.
    const beforeA = first.state.requests.filter((r) => r.route === 'POST /api/messages').length;
    const beforeB = second.state.requests.filter((r) => r.route === 'POST /api/messages').length;
    await a.locator('#sendButton').click();
    await expect
      .poll(() => first.state.requests.filter((r) => r.route === 'POST /api/messages').length)
      .toBe(beforeA + 1);
    assert.equal(
      second.state.requests.filter((r) => r.route === 'POST /api/messages').length,
      beforeB,
    );
    await expect(b.locator('#commandInput')).toHaveValue('服务器 B 的独立草稿');
    await b.locator('#sendButton').click();
    await expect
      .poll(() => second.state.requests.filter((r) => r.route === 'POST /api/messages').length)
      .toBe(beforeB + 1);
    assert.equal(
      first.state.requests.filter((r) => r.route === 'POST /api/messages').length,
      beforeA + 1,
    );
    await b.evaluate((id) => window.StudioDesktopConnections.api('remove', { id }), bId);
    assert.equal(await a.evaluate(() => window.multiWindowSocket.readyState), 1);
    const config = await a.request.get(client.origin + aPath + 'api/config');
    assert.equal(config.status(), 200);
    await b.close();
    await a.reload();
    await expect(a.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    // Removing a connection invalidates its old sockets and refuses subsequent traffic.
    await a.evaluate(async (id) => {
      window.removedSocket = new WebSocket(
        location.origin.replace('http:', 'ws:') +
          location.pathname +
          'api/terminal?pane=pane-codex',
      );
      await new Promise((resolve) => {
        window.removedSocket.onopen = resolve;
      });
      await window.StudioDesktopConnections.api('remove', { id });
    }, aId);
    await expect.poll(() => a.evaluate(() => window.removedSocket.readyState)).toBe(3);
    assert.equal((await a.request.get(client.origin + aPath + 'api/config')).status(), 409);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          separateServers: true,
          liveSocketsPreservedOnSwitch: true,
          independentDrafts: true,
          independentPresentation: true,
          presentationPreservedAcrossServers: true,
          routedFixtureMessages: true,
          popupAndShortcut: true,
          perWindowSelectionAndTitles: true,
          removalScopedToProfile: true,
          productionInput: false,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS multiple windows: independent servers, live sockets, drafts, selection, routing, titles, opening and removal',
    );
  } catch (error) {
    console.error('Page errors:', errors);
    console.error(
      'Fixture requests:',
      first.state.requests.slice(-10).map((r) => r.route),
    );
    throw error;
  } finally {
    await browser.close();
    client.close();
    await first.close();
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

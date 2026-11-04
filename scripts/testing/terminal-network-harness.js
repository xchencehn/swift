'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_TERMINAL_NETWORK_OUTPUT ||
    'artifacts/testing/terminal-network-stability/browser',
);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1520, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'narrow-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: Boolean(viewport.touch),
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('持续保留的结构化草稿');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        const host = page.locator('#shellTerminal'),
          canvas = host.locator('.shell-terminal-canvas'),
          input = host.locator('.xterm-helper-textarea');
        const notice = host.locator('.shell-terminal-notice');
        await expect(host).toContainText('OpenAI Codex');
        await expect(notice).toHaveCount(0);
        const dimensions = () =>
          canvas.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
        const initial = await dimensions(),
          count = fixture.state.shellConnections;
        await page.evaluate(() => {
          window.__terminalCanvas = document.querySelector('.shell-terminal-canvas .xterm');
          window.__visibleClears = 0;
          const write = Terminal.prototype.write;
          Terminal.prototype.write = function (data, ...args) {
            if (this.element && typeof data === 'string' && data.includes('\x1b[2J'))
              window.__visibleClears++;
            return write.call(this, data, ...args);
          };
        });
        const sameCanvas = () =>
          page.evaluate(
            () =>
              window.__terminalCanvas === document.querySelector('.shell-terminal-canvas .xterm'),
          );
        fixture.state.focusedPaneId = 'pane-claude';
        fixture.changed();
        await page.waitForTimeout(300);
        await expect(page.locator('#chatCurrentName')).toContainText('Codex');
        assert(await sameCanvas());
        fixture.state.sessions['pane-codex'].pane.runtimeId = 'fixture-reported-process';
        fixture.changed();
        await page.waitForTimeout(300);
        assert.equal(fixture.state.shellConnections, count);
        assert(await sameCanvas());
        await input.focus();
        await page.keyboard.type('ONCE');
        const sent = () =>
          (fixture.state.shellFrames || [])
            .filter((x) => x.type === 'terminal.input')
            .map((x) => x.data)
            .join('');
        await expect.poll(sent).toBe('ONCE');
        // The fixture now sends the same cells on recovery, so a full snapshot
        // must not clear the visible grid or recreate its terminal instance.
        fixture.state.nativeTerminalText =
          'OpenAI Codex · native terminal\r\n/model · /status · Shift+Left\r\n中文字体 · 工作会话 · https://example.com\r\n› ONCE';
        for (let n = 0; n < 2; n++) {
          fixture.disconnect(true);
          await page.waitForTimeout(350);
          await expect(notice).toHaveCount(0);
          assert.deepEqual(await dimensions(), initial);
          fixture.disconnect(false);
          await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected', {
            timeout: 7000,
          });
          await expect.poll(() => fixture.state.shellConnections).toBeGreaterThan(count + n);
          await expect(notice).toHaveCount(0);
          assert(await sameCanvas());
          assert.deepEqual(await dimensions(), initial);
        }
        fixture.disconnect(true);
        await page.waitForTimeout(16000);
        await expect(notice).toHaveCount(0);
        await expect(canvas).toHaveAttribute('aria-busy', 'true');
        assert.deepEqual(await dimensions(), initial);
        await input.focus();
        await page.keyboard.type('NOT_SENT');
        assert.equal(sent(), 'ONCE');
        await page.screenshot({ path: path.join(output, viewport.name + '-outage.png') });
        fixture.disconnect(false);
        await expect(canvas).toHaveAttribute('aria-busy', 'false', { timeout: 8000 });
        await expect(notice).toHaveCount(0);
        assert(await sameCanvas());
        assert.deepEqual(await dimensions(), initial);
        assert.equal(sent(), 'ONCE');
        const clears = await page.evaluate(() => window.__visibleClears);
        assert.equal(clears, 0, 'Identical recovery snapshots must not clear the visible terminal');
        await page.screenshot({ path: path.join(output, viewport.name + '-recovered.png') });
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await expect(page.locator('#commandInput')).toHaveValue('持续保留的结构化草稿');
        assert.deepEqual(errors, []);
        assert.deepEqual(fixture.state.unexpected, []);
        results.push({
          viewport,
          initial,
          heightDelta: 0,
          terminalRetained: true,
          transientQuiet: true,
          sustainedOutageDoesNotResize: true,
          passiveFocusDoesNotSwitch: true,
          agentMetadataDoesNotReconnect: true,
          inputNotReplayed: true,
          visibleClears: clears,
          productionInput: false,
        });
        console.log('PASS ' + viewport.name);
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(before, after);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

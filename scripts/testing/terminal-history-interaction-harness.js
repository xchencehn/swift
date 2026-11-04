'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_HISTORY_OUTPUT ||
      'artifacts/testing/terminal-input-performance/history',
  );
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.nativeTerminalGeometry = { cols: 120, rows: 200 };
      fixture.state.nativeTerminalText = '\x1b[HHEADER\r\nBODY\r\nPROMPT>';
      fixture.state.nativeTerminalHistory = 'STALE HISTORY\nHEADER\nBODY\nPROMPT>';
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        let renderer;
        Object.defineProperty(window, 'StudioTerminalRenderer', {
          configurable: true,
          get: () => renderer,
          set(value) {
            renderer = value;
            const create = value.create;
            renderer.create = (options) => {
              const instance = create(options),
                history = instance.history;
              instance.history = async (...args) => {
                window.historyPreparing = true;
                await new Promise((resolve) => {
                  window.releaseHistory = resolve;
                });
                return history(...args);
              };
              return instance;
            };
          },
        });
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        await page.waitForFunction(() => window.historyPreparing);
        fixture.shellFrame('\x1b[3;8HFAST_ECHO', 'pane-codex');
        await expect(page.locator('#shellTerminal')).toContainText('FAST_ECHO');
        await page.evaluate(() => window.releaseHistory());
        await expect(page.locator('#shellTerminal')).not.toContainText('STALE HISTORY');
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        assert.deepEqual(errors, []);
        results.push({ viewport, echoBeforeHistoryCompleted: true, staleHistoryRejected: true });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(sourceFingerprint(process.cwd()), before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, results }, null, 2) + '\n',
  );
  console.log('PASS terminal echo proceeds while history preparation is suspended: 4 viewports.');
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

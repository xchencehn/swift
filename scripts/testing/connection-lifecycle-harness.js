'use strict';
// Real Firefox pages and fixture WebSockets. Never connects to production terminals.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
async function main() {
  const output = path.resolve(
    process.env.SWIFT_LIFECYCLE_OUTPUT || 'artifacts/testing/reliability-account-release/lifecycle',
  );
  fs.mkdirSync(output, { recursive: true });
  const fixture = await createFixture();
  fixture.state.sync = true;
  const other = await createFixture();
  other.state.sync = true;
  const browser = await firefox.launch({ headless: true });
  const errors = [],
    timings = [],
    started = Date.now();
  const contexts = [],
    pages = [];
  let report = { ok: false };
  try {
    for (const viewport of [
      { width: 1360, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(fixture.url);
      await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await page.locator('#commandInput').fill(`独立窗口草稿-${viewport.width}`);
    }
    const page = pages[0];
    await page.locator('.herdr-tab-select[aria-selected="true"]').click();
    await expect(page.locator('.session-status-facts')).toContainText('网络连接');
    await expect(page.locator('.session-status-facts')).toContainText('数据同步');
    fixture.observationFailure();
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    await expect(page.locator('#commandInput')).toHaveValue('独立窗口草稿-1360');
    await page.keyboard.press('Escape');
    // Same windows survive repeated service restarts and normal close; no inputs are replayed.
    const cycles = Number(process.env.SWIFT_LIFECYCLE_CYCLES || 12);
    for (let i = 0; i < cycles; i++) {
      const at = Date.now();
      fixture.disconnect(true, i % 2 ? 1000 : 1012);
      for (const p of pages)
        await expect(p.locator('#appShell')).toHaveAttribute('data-connection', 'offline');
      await new Promise((resolve) => setTimeout(resolve, 100 + (i % 3) * 100));
      fixture.disconnect(false);
      for (const [n, p] of pages.entries()) {
        await expect(p.locator('#appShell')).toHaveAttribute('data-connection', 'connected', {
          timeout: 10000,
        });
        await expect(p.locator('#commandInput')).toHaveValue(`独立窗口草稿-${n ? 390 : 1360}`);
      }
      timings.push(Date.now() - at);
    }
    // Browser offline and resume signals are synthetic. The protected VM is never suspended.
    await contexts[0].setOffline(true);
    fixture.disconnect(true);
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'offline');
    fixture.disconnect(false);
    await contexts[0].setOffline(false);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected', {
      timeout: 10000,
    });
    await expect(page.locator('#commandInput')).toHaveValue('独立窗口草稿-1360');
    // Independent execution host cannot be affected by the first one's outage.
    const independent = await contexts[0].newPage();
    await independent.goto(other.url);
    await expect(independent.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    fixture.disconnect(true);
    await expect(independent.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    fixture.disconnect(false);
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected', {
      timeout: 10000,
    });
    await page.locator('.herdr-tab-select[aria-selected="true"]').click();
    await page.keyboard.press('Escape');
    await page.locator('#chatDeviceSettings').click();
    await page.locator('#settingsConnectionTab').click();
    await page.getByText('连接诊断', { exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出连接诊断', exact: true }).click();
    const file = path.join(output, 'connection-diagnostics.json');
    await (await download).saveAs(file);
    const diagnostics = JSON.parse(fs.readFileSync(file));
    assert(diagnostics.events.length <= 64);
    assert(diagnostics.current.received > 0);
    assert(!fs.readFileSync(file, 'utf8').includes('独立窗口草稿'));
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
      0,
    );
    assert.equal(fixture.state.frames.length, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'connection-details.png') });
    report = {
      ok: true,
      durationMs: Date.now() - started,
      cycles,
      reconnectMs: timings,
      samePages: true,
      independentViewports: true,
      observerFailureIsolated: true,
      independentExecutionHost: true,
      draftsPreserved: true,
      productionInput: false,
      inputReplays: 0,
      offlineAndResume: 'synthetic browser signals; not physical sleep or a phone',
      diagnostics: { bounded: true, containsContent: false },
      errors,
    };
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    await fixture.close();
    await other.close();
  }
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

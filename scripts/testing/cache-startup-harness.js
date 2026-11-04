'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const output = path.resolve(
  process.env.SWIFT_CACHE_STARTUP_OUTPUT || 'artifacts/testing/desktop-reconnect/cache-startup',
);
(async () => {
  const fixture = await createFixture();
  fixture.state.sync = true;
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const errors = [],
    results = {};
  fs.mkdirSync(output, { recursive: true });
  try {
    await context.addInitScript(() => {
      window.SWIFT_CHAT_PRESENTATION = 'structured';
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        const request = getAll.apply(this, args);
        if (this.name === 'sessions' && localStorage.getItem('swiftCacheStartupFault')) {
          request.addEventListener('success', () =>
            Object.defineProperty(request, 'result', {
              value: [undefined, null, {}, { key: 'invalid', messages: null }, ...request.result],
            }),
          );
        }
        return request;
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url);
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('异常缓存不能丢掉的草稿');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const replica = StudioReplica.create();
          await replica.load();
          return replica.keys().length;
        }),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() => localStorage.setItem('swiftCacheStartupFault', '1'));
    await page.reload();
    await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected', {
      timeout: 10000,
    });
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await expect(page.locator('#commandInput')).toHaveValue('异常缓存不能丢掉的草稿');
    const retained = await page.evaluate(async () => {
      const replica = StudioReplica.create();
      await replica.load();
      return { keys: replica.keys().length, invalid: Boolean(replica.get('invalid')) };
    });
    assert(retained.keys > 0 && !retained.invalid);
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
      0,
    );
    assert.deepEqual(errors, []);
    results.ok = true;
    results.validSessionsPreserved = retained.keys;
    results.draftPreserved = true;
    results.noResend = true;
    await page.screenshot({ path: path.join(output, 'cache-recovered.png') });
    console.log(
      'PASS cache startup: unreadable records skipped, connection ready, valid cache and draft preserved, zero sends',
    );
  } catch (error) {
    results.error = error.message;
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify({ ...results, errors }, null, 2),
    );
    await context.close();
    await browser.close();
    await fixture.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

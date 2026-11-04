'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_OWNERSHIP_BROWSER_OUTPUT ||
      'artifacts/testing/terminal-size-ownership/browser',
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
      const context = await browser.newContext({
        viewport,
        screen: viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const frames = () => fixture.state.shellFrames || [];
      const focus = () => frames().filter((frame) => frame.type === 'terminal.focus');
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#commandInput')).toBeEnabled();
        await page.locator('#commandInput').fill('保留结构化草稿');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        const terminal = page.locator('#shellTerminal'),
          input = terminal.locator('.xterm-helper-textarea');
        await expect(terminal).toContainText('OpenAI Codex');
        await input.focus();
        assert.equal(
          fixture.state.shellBindings.at(-1)?.retainControl,
          '1',
          'Every foreground terminal must retain its size while the user reads after real activity',
        );
        await expect.poll(() => focus().at(-1)?.focused).toBe(true);
        await page.keyboard.type('one');
        await expect
          .poll(() =>
            frames()
              .filter((frame) => frame.type === 'terminal.input')
              .map((frame) => frame.data)
              .join(''),
          )
          .toBe('one');
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expect.poll(() => focus().at(-1)?.focused).toBe(false);
        const released = focus().length;
        fixture.changed();
        await page.waitForTimeout(250);
        assert.equal(focus().length, released, 'Snapshot polling must not reclaim terminal focus');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => focus().at(-1)?.focused).toBe(true);
        await input.dispatchEvent('compositionstart');
        await expect.poll(() => focus().at(-1)?.composing).toBe(true);
        await input.dispatchEvent('compositionend');
        await expect.poll(() => focus().at(-1)?.composing).toBe(false);
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(() => focus().at(-1)?.focused).toBe(false);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => focus().at(-1)?.focused).toBe(false);
        await page.evaluate(() => {
          delete document.hidden;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(terminal).toContainText('OpenAI Codex');
        await input.focus();
        await expect.poll(() => focus().at(-1)?.focused).toBe(true);
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await expect(page.locator('#commandInput')).toHaveValue('保留结构化草稿');
        assert.equal(
          frames()
            .filter((frame) => frame.type === 'terminal.input')
            .map((frame) => frame.data)
            .join(''),
          'one',
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          focusReleased: true,
          visibilityReleased: true,
          noPollFocus: true,
          draftPreserved: true,
          compositionHeld: true,
          inputNotReplayed: true,
          events: 'Browser focus and synthetic blur, visibility and composition events',
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2) + '\n',
  );
  console.log(`PASS terminal activity lifecycle: ${results.length} viewports.`);
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/codex-interaction/shortcuts');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet-keyboard', width: 1024, height: 768, touch: true },
    ]) {
      const fixture = await createFixture(),
        session = fixture.state.sessions['pane-codex'];
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
        }),
        page = await context.newPage(),
        errors = [];
      const calls = () =>
        fixture.state.requests.filter((row) => row.route === 'POST /api/agent-settings');
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatModelAction')).toContainText(session.settings.model);
        const input = page.locator('#commandInput');
        await input.fill('保留文本选择与光标');
        for (const key of [
          'Shift+ArrowUp',
          'Shift+ArrowDown',
          'Shift+ArrowLeft',
          'Shift+ArrowRight',
        ])
          await input.press(key);
        assert.equal(calls().length, 0);
        await page.locator('#chatEffortAction').click();
        await expect(page.locator('.popover')).toBeVisible();
        const choice = page
          .locator('.popover [role="menuitem"]')
          .filter({ hasText: 'low' })
          .first();
        await choice.click();
        await expect.poll(() => session.settings.effort).toBe('low');
        await expect(input).toHaveValue('保留文本选择与光标');
        await page.locator('#chatModelAction').click();
        await expect(page.locator('.popover')).toBeVisible();
        const previous = calls().length;
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Escape');
        assert.equal(calls().length, previous);
        await page.locator('#chatModeToggle').click();
        const terminal = page.locator('#shellTerminal .xterm-helper-textarea');
        await expect(terminal).toBeAttached();
        await terminal.focus();
        const frames = (fixture.state.shellFrames || []).length;
        await terminal.press('Escape');
        await terminal.press('Shift+ArrowRight');
        await expect
          .poll(() =>
            (fixture.state.shellFrames || [])
              .slice(frames)
              .some((frame) => frame.type === 'terminal.input' && frame.data.includes('\x1b')),
          )
          .toBe(true);
        assert.equal(calls().length, previous);
        await page.locator('#chatModeToggle').click();
        await expect(input).toHaveValue('保留文本选择与光标');
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          textSelectionPreserved: true,
          visibleSettingControls: true,
          nativeTerminalOwnsKeys: true,
          overlayPriority: true,
          draftPreserved: true,
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
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, results }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

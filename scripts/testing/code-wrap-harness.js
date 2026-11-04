'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/mobile-terminal-input/code-wrap');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'small-phone', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const source =
        'codex resume 01a15a94-9a6e-7740-840a-2b3f9a91d979 --full-command-without-added-line-breaks\n' +
        '    const url = "https://example.com/' +
        'long_path_segment_'.repeat(16) +
        '";';
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'wrap-code',
        role: 'assistant',
        blocks: [
          {
            kind: 'text',
            text:
              '代码换行验收\n\n```javascript\n' + source + '\n```\n\n```text\nsecond block\n```',
          },
        ],
      });
      const context = await browser.newContext({
        viewport,
        hasTouch: Boolean(viewport.touch),
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(() => {
        window.__codeCopies = [];
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async (value) => {
            window.__codeCopies.push(value);
          },
        });
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const message = page.locator('.chat-msg').filter({ hasText: '代码换行验收' }),
          blocks = message.locator('pre');
        await expect(blocks).toHaveCount(2);
        const block = blocks.first(),
          code = block.locator('code'),
          toggle = block.locator('.code-wrap'),
          copy = block.locator('.code-copy');
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(toggle).toHaveText('自动换行');
        await expect(code).toHaveCSS('white-space', 'pre-wrap');
        const wrapped = await code.evaluate((node) => ({
          width: node.clientWidth,
          scroll: node.scrollWidth,
          height: node.getBoundingClientRect().height,
          text: node.textContent,
        }));
        assert(wrapped.scroll <= wrapped.width + 1);
        assert.equal(wrapped.text, source);
        const positions = await block
          .locator('.code-actions')
          .evaluate((node) =>
            [...node.children].map((item) => item.getBoundingClientRect().toJSON()),
          );
        assert(positions[0].right <= positions[1].left && positions[1].right <= viewport.width + 1);
        if (viewport.touch) assert(positions.every((item) => item.height >= 44));
        await copy.click();
        await expect.poll(() => page.evaluate(() => window.__codeCopies.at(-1))).toBe(source);
        await toggle.click();
        await expect(toggle).toHaveText('不换行');
        await expect(code).toHaveCSS('white-space', 'pre');
        const unwrapped = await code.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
          return { width: node.clientWidth, scroll: node.scrollWidth, left: node.scrollLeft };
        });
        assert(unwrapped.scroll > unwrapped.width && unwrapped.left > 0);
        await expect(toggle).toBeInViewport();
        await expect(copy).toBeInViewport();
        await expect(blocks.nth(1).locator('.code-wrap')).toHaveAttribute('aria-pressed', 'true');
        fixture.changed();
        await page.waitForTimeout(100);
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await copy.click();
        await expect.poll(() => page.evaluate(() => window.__codeCopies.at(-1))).toBe(source);
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect
          .poll(() => code.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
          .toBe(true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          defaultWrap: true,
          independentToggle: true,
          copyUnmodified: true,
          toolbarVisibleAfterHorizontalScroll: true,
          wrapped,
          unwrapped,
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
  console.log(
    'PASS code wrapping: default wrap, per-block toggle, fixed toolbar and unmodified copy.',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

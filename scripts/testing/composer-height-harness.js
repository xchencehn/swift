'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/composer-auto-height/browser');
const lines = (count) =>
  Array.from({ length: count }, (_, i) => `第 ${i + 1} 行中文内容`).join('\n');

async function run(browser, viewport) {
  const fixture = await createFixture();
  fixture.state.productionPresentation = true;
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const input = page.locator('#commandInput'),
    log = page.locator('#chatLog');
  const height = () => input.evaluate((el) => el.getBoundingClientRect().height);
  const geometry = () =>
    input.evaluate((el) => {
      const box = el.getBoundingClientRect(),
        card = el.closest('.chat-input').getBoundingClientRect();
      return {
        height: box.height,
        width: box.width,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
        start: el.selectionStart,
        end: el.selectionEnd,
        overflow: document.documentElement.scrollWidth - innerWidth,
        cardBottom: card.bottom,
        viewportHeight: innerHeight,
      };
    });
  const choosePane = async (id) => {
    if (
      (await page.locator('#chatDrawerToggle').isVisible()) &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarRecent').click();
    await page.locator(`#chatPickerList [data-pane-id="${id}"]`).click();
  };
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(log).toContainText('codex 浏览器验收样例');
    await expect(input).toBeEnabled();
    const initial = await height();
    assert.equal(initial, 56);
    const maximum = initial * 3;
    await input.fill('短消息');
    await expect.poll(height).toBe(initial);
    await input.fill(lines(3));
    await expect.poll(height).toBe(80);
    await input.fill(lines(5));
    await expect.poll(height).toBe(128);
    await input.fill(lines(20));
    await expect.poll(height).toBe(maximum);
    const capped = await geometry();
    assert(capped.scrollHeight > capped.clientHeight);
    assert.equal(capped.overflow, 0);
    assert(capped.cardBottom <= capped.viewportHeight);
    await input.press('Control+End');
    await expect.poll(() => input.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await input.press('Control+Home');
    await expect.poll(() => input.evaluate((el) => el.scrollTop)).toBe(0);
    await input.press('ArrowRight');
    await input.press('Shift+ArrowRight');
    const selection = await input.evaluate((el) => [el.selectionStart, el.selectionEnd]);
    // Resizing does not replace the value, focus or selection, including at the cap.
    await input.evaluate((el) => {
      el.style.width = '60%';
    });
    await expect.poll(height).toBe(maximum);
    assert.deepEqual(await input.evaluate((el) => [el.selectionStart, el.selectionEnd]), selection);
    await expect(input).toBeFocused();
    await input.evaluate((el) => {
      el.style.width = '';
    });
    await input.fill('自动折行的连续中文内容'.repeat(80));
    await expect.poll(height).toBe(maximum);
    await input.fill('');
    await expect.poll(height).toBe(initial);
    // A real newline and input insertion use the same path as typing or text paste.
    await input.fill(lines(2));
    await input.press('End');
    await input.press('Shift+Enter');
    await page.keyboard.insertText('粘贴或键入的新一行');
    await expect.poll(height).toBe(80);
    const messageCount = () =>
      fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length;
    assert.equal(messageCount(), 0);
    await input.dispatchEvent('compositionstart');
    await input.fill(lines(4));
    await expect.poll(height).toBe(104);
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
      bubbles: true,
    });
    assert.equal(messageCount(), 0);
    await expect(input).toHaveValue(lines(4));
    await input.dispatchEvent('compositionend');
    await page.evaluate(() => window.StudioDeviceFont.apply(20));
    await expect.poll(height).toBeGreaterThan(104);
    assert((await height()) <= maximum);
    await page.evaluate(() => window.StudioDeviceFont.apply(14));
    await expect.poll(height).toBe(104);
    // Reflow a bounded draft across real responsive widths, then restore the viewport.
    const wrapped = '自动折行的中文内容'.repeat(12);
    await input.fill(wrapped);
    await expect
      .poll(
        async () =>
          (await geometry()).scrollHeight <= (await height()) + 1 || (await height()) === maximum,
      )
      .toBe(true);
    const wide = await height();
    await page.setViewportSize({
      width: Math.max(320, Math.floor(viewport.width * 0.65)),
      height: viewport.height,
    });
    await expect.poll(height).toBeGreaterThanOrEqual(wide);
    assert((await height()) <= maximum);
    await page.setViewportSize(viewport);
    await expect.poll(height).toBe(wide);
    // Each session restores its own value and therefore its own height.
    await input.fill(lines(5));
    await choosePane('pane-claude');
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(initial);
    await input.fill('Claude 的短草稿');
    await choosePane('pane-codex');
    await expect(input).toHaveValue(lines(5));
    await expect.poll(height).toBe(128);
    await page.reload();
    await expect(input).toHaveValue(lines(5));
    await expect.poll(height).toBe(128);
    // A hidden composer is recalculated when returning from files or the terminal.
    if (viewport.touch)
      await log.evaluate((el) => {
        const box = el.getBoundingClientRect(),
          x = box.left + 150,
          y = box.top + 80;
        const touch = (at) => new Touch({ identifier: 9, target: el, clientX: at, clientY: y });
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)] }));
        el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(x - 100)] }));
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
      });
    else await page.locator('#chatFilesToggle').click();
    await expect(page.locator('#sessionFilesPage')).toBeVisible();
    if (viewport.touch) await page.evaluate(() => window.StudioNavigation.back());
    else await page.locator('#chatFilesToggle').click();
    await expect(input).toBeVisible();
    await expect.poll(height).toBe(128);
    await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
    await expect(input).toBeHidden();
    await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
    await expect(input).toBeVisible();
    await expect.poll(height).toBe(128);
    // The latest message stays visible when resizing; historical reading does not jump.
    await page.waitForTimeout(250); // The preceding touch navigation must finish before following resumes.
    await log.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const gap = () => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await input.fill(lines(20));
    await expect.poll(height).toBe(maximum);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await log.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(gap).toBeGreaterThan(200);
    // Wait for the wheel gesture to settle before comparing the same reading position.
    await page.waitForTimeout(250);
    const readingTop = await log.evaluate((el) => el.scrollTop);
    await input.fill('短草稿');
    await expect.poll(height).toBe(initial);
    await input.fill(lines(5));
    await expect.poll(height).toBe(128);
    assert(Math.abs((await log.evaluate((el) => el.scrollTop)) - readingTop) <= 2);
    // Failed sends retain the draft and height, a successful send shrinks once.
    await page.route('**/api/messages', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { message: '隔离夹具：暂时无法发送。' } })
        : route.continue(),
    );
    await page.locator('#sendButton').click();
    await expect(page.locator('#chatComposerError')).toBeVisible();
    await expect(input).toHaveValue(lines(5));
    await expect.poll(height).toBe(128);
    await page.unroute('**/api/messages');
    await page.locator('#sendButton').click();
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(initial);
    assert.equal(messageCount(), 1);
    await expect(page.locator('#chatComposerError')).toBeHidden();
    await input.fill(lines(20));
    await input.press('Control+End');
    await expect.poll(height).toBe(maximum);
    await page.screenshot({ path: path.join(output, viewport.name + '-expanded.png') });
    const expanded = await geometry();
    assert.equal(expanded.overflow, 0);
    await input.fill('短消息');
    await expect.poll(height).toBe(initial);
    await page.screenshot({ path: path.join(output, viewport.name + '-compact.png') });
    assert.deepEqual(errors, []);
    return {
      viewport,
      initial,
      maximum,
      capped,
      expanded,
      restoredDraft: true,
      failedSendPreserved: true,
      readingPositionPreserved: true,
      composition: 'synthetic events',
      automaticWrapping: true,
      fontAndWidthReflow: true,
    };
  } finally {
    await context.close();
    await fixture.close();
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    results = [],
    browser = await firefox.launch();
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ])
      results.push(await run(browser, viewport));
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
    `PASS composer auto height: ${results.length} viewports, maximum 3x, wrapping, IME, drafts, scroll and send recovery.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

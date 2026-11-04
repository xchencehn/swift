'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test'),
  { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
async function touch(page, selector, type, x = 30, y = 60) {
  await page.locator(selector).evaluate(
    (node, { type, x, y }) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
      });
      node.dispatchEvent(event);
    },
    { type, x, y },
  );
}
(async () => {
  const root = path.resolve(__dirname, '../..'),
    out = path.join(root, 'artifacts/testing/output-download/browser');
  fs.mkdirSync(out, { recursive: true });
  const before = sourceFingerprint(root),
    browser = await firefox.launch(),
    results = [];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  );
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 128, 80, 75, 3, 4]),
    Buffer.alloc(300 * 1024, 43),
  ]);
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.touch,

          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          acceptDownloads: true,
        });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        fixture.state.images = { output: { mime: 'image/png', bytes: png } };
        fixture.state.sessions['pane-codex'].messages = [
          {
            id: 'output',
            role: 'assistant',
            blocks: [
              {
                kind: 'text',
                text: '文件：[下载报告](</fixture/workdir/project/报告 空格.zip>)\n[相对材料](results.md)',
              },
              { kind: 'image', id: 'output', alt: '生成图' },
            ],
          },
        ];
        await page.route('**/api/doc-files/download?**', async (route) => {
          assert(route.request().headers()['x-agent-studio-token'] === 'fixture');
          await route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: bytes,
          });
        });
        await page.goto(fixture.url + '/?token=fixture&view=chat&pane=pane-codex');
        const image = page.locator('.chat-image img');
        await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
        await page.evaluate(() => {
          window.saved = [];
          window.nativeParts = [];
          window.StudioApp = {
            saveImage: (base64, name, mime) => window.saved.push({ base64, name, mime }),
            beginSaveFile: (id, name, mime) => {
              window.saveMeta = { id, name, mime };
              window.nativeParts = [];
              return true;
            },
            appendSaveFile: (id, part) => {
              window.nativeParts.push(part);
              return true;
            },
            finishSaveFile: (id) => {
              window.saved.push({ ...window.saveMeta, parts: window.nativeParts });
              setTimeout(
                () => window.dispatchEvent(new CustomEvent('swift.file.saved', { detail: { id } })),
                0,
              );
              return true;
            },
            abortSaveFile: () => {},
          };
        });
        await touch(page, '.chat-image img', 'touchstart');
        await touch(page, '.chat-image img', 'touchmove', 55, 60);
        await touch(page, '.chat-image img', 'touchend');
        await page.waitForTimeout(550);
        await expect(page.locator('.popover')).toHaveCount(0);
        await touch(page, '.chat-image img', 'touchstart');
        await expect(page.getByRole('menuitem', { name: '保存到本地', exact: true })).toBeVisible();
        await touch(page, '.chat-image img', 'touchend');
        await image.dispatchEvent('click');
        await expect(page.locator('.chat-image-viewer')).not.toBeVisible();
        await page.screenshot({ path: path.join(out, viewport.name + '-image-menu.png') });
        await page.getByRole('menuitem', { name: '保存到本地', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.saved.length)).toBe(1);
        const saved = await page.evaluate(() => window.saved[0]);
        assert.equal(saved.name, '生成图.png');
        assert.deepEqual(Buffer.from(saved.base64, 'base64'), png);
        await image.click();
        await expect(page.locator('.chat-image-viewer')).toBeVisible();
        await page.waitForTimeout(650);
        await page.evaluate(() => {
          const original = Date.now;
          Date.now = () => original() - 60000;
        });
        await page.locator('.chat-image-viewer img').click({ button: 'right' });
        await expect(page.locator('.chat-image-viewer .popover')).toBeVisible();
        await page.getByRole('menuitem', { name: '保存到本地', exact: true }).click();
        await page.getByRole('button', { name: '关闭图片', exact: true }).click();
        const file = page.locator('[data-download-url]').filter({ hasText: '下载报告' });
        await page.waitForTimeout(650);
        await file.click({ button: 'right' });
        await expect(page.getByRole('menuitem', { name: '下载文件', exact: true })).toBeVisible();
        await page.screenshot({ path: path.join(out, viewport.name + '-file-menu.png') });
        await page.getByRole('menuitem', { name: '下载文件', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.saved.length)).toBe(3);
        const native = await page.evaluate(() => window.saved[2]);
        assert.equal(native.name, '报告 空格.zip');
        assert(native.parts.length > 1);
        assert.deepEqual(
          Buffer.concat(native.parts.map((part) => Buffer.from(part, 'base64'))),
          bytes,
        );
        await page.evaluate(() => {
          window.StudioApp.saveImageResult = () => '相册保存失败，请重试。';
        });
        await image.click();
        await page.waitForTimeout(650);
        await page.locator('.chat-image-viewer img').click({ button: 'right' });
        await page.getByRole('menuitem', { name: '保存到本地', exact: true }).click();
        await expect(page.locator('.chat-image-viewer .operation-error')).toHaveText(
          '相册保存失败，请重试。',
        );
        await page.getByRole('button', { name: '关闭图片', exact: true }).click();
        await page.evaluate(() => {
          delete window.StudioApp;
        });
        await page.waitForTimeout(650);
        await file.click({ button: 'right' });
        const downloading = page.waitForEvent('download');
        await page.getByRole('menuitem', { name: '下载文件', exact: true }).click();
        const downloaded = await downloading;
        assert.equal(downloaded.suggestedFilename(), '报告 空格.zip');
        assert.deepEqual(fs.readFileSync(await downloaded.path()), bytes);
        const relative = page.getByRole('link', { name: '相对材料' });
        assert((await relative.getAttribute('data-download-url')).includes('results.md'));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          longPress: true,
          moveCancels: true,
          noPreviewAfterLongPress: true,
          previewMenu: true,
          clockRollbackSafe: true,
          imageBytes: true,
          nativeChunkedFileBytes: true,
          browserFileBytes: true,
          unicodeName: true,
          relativePath: true,
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(root);
  assert.equal(before.treeSha256, after.treeSha256);
  const report = { ok: true, before, after, results };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { createMediaFiles } = require('./fixtures/session-media');
const { Router } = require('../../lib/http/router');
const { json, securityHeaders, createHttp } = require('../../lib/http');
const { apiError } = require('../../lib/message-queue');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..'),
  output = path.join(root, 'artifacts/testing/session-media-files/browser');
const swipe = (page, selector, right) =>
  page.locator(selector).evaluate((node, right) => {
    const box = node.getBoundingClientRect(),
      x = box.left + 150,
      y = box.top + 80;
    const touch = (at) => new Touch({ identifier: 9, target: node, clientX: at, clientY: y });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)] }));
    node.dispatchEvent(
      new TouchEvent('touchmove', { bubbles: true, touches: [touch(x + (right ? 100 : -100))] }),
    );
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  }, right);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const source = sourceFingerprint(root),
    results = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-media-browser-')),
    work = path.join(directory, 'work');
  await fs.mkdir(work);
  const files = await createMediaFiles(work);
  const invalidMedia = path.join(work, '不支持的编码.mp4');
  await fs.writeFile(invalidMedia, 'invalid media fixture');
  const digest = async (file) =>
    crypto
      .createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  const originals = await Promise.all(files.map(digest));
  const router = new Router({
    json,
    sendError: (res, error) =>
      json(res, error.status || 500, { ok: false, code: error.code, message: error.message }),
  });
  const pane = {
    workspaceId: 'w',
    cwd: work,
    paneId: 'pane-codex',
    terminalId: 'terminal-codex',
    agent: { label: 'codex', session: { value: 'fixture' } },
  };
  require('../../lib/http/routes/doc-files').register(router, {
    currentRoot: () => ({
      data: { directory },
      sessionFiles: {
        appearances: async () => ({ written: files.map((path) => ({ path })), mentioned: [] }),
      },
    }),
    exactPane: async () => pane,
    paneTranscriptFile: () => 'fixture',
    herdr: { dashboard: async () => ({ workspaces: [{ workspaceId: 'w', cwd: work }] }) },
    json,
    apiError,
    securityHeaders,
  });
  const auth = createHttp({ tokens: ['fixture'], maxBodyBytes: 1000 });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (!auth.requireAuth(req, res, url)) return;
    if (!(await router.dispatch(req, res, url))) json(res, 404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const browser = await firefox.launch();
  try {
    const url = (route, file, extra = {}) =>
      endpoint +
      '/api/doc-files/' +
      route +
      '?' +
      new URLSearchParams({ pane: 'pane-codex', sessionId: 'fixture', path: file, ...extra });
    const headers = { 'x-agent-studio-token': 'fixture' };
    assert.equal((await fetch(url('preview', files[0]))).status, 401);
    assert.equal(
      (await fetch(url('preview', files[0], { sessionId: 'old' }), { headers })).status,
      409,
    );
    assert.equal((await fetch(url('preview', '/etc/passwd'), { headers })).status, 404);
    const alias = path.join(work, 'alias.pdf');
    await fs.symlink(
      files.find((file) => file.endsWith('.pdf')),
      alias,
    );
    assert.equal((await fetch(url('preview', alias), { headers })).status, 404);
    const pdf = files.find((file) => file.endsWith('.pdf'));
    const metadata = await (await fetch(url('preview', pdf), { headers })).json();
    assert.equal(metadata.pages, 2);
    assert.equal(
      (await fetch(url('page', pdf, { page: 3, version: metadata.version }), { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(url('page', pdf, { page: 1, version: 'old' }), { headers })).status,
      409,
    );
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.contentSecurityPolicy = securityHeaders()['content-security-policy'];
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      let fail = false,
        delay = false;
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/api/doc-files**', async (route) => {
        const target = new URL(route.request().url());
        if (fail && target.pathname.endsWith('/preview'))
          return route.fulfill({ status: 503, json: { message: '预览暂时不可用，请重试。' } });
        if (delay && target.pathname.endsWith('/raw'))
          await new Promise((resolve) => setTimeout(resolve, 400));
        // 浏览器存档身份来自隔离聊天 fixture；这里保持路由与真实文件服务的固定身份一致。
        target.searchParams.set('sessionId', 'fixture');
        try {
          const response = await route.fetch({ url: endpoint + target.pathname + target.search });
          await route.fulfill({ response });
        } catch {
          await route.abort().catch(() => {});
        }
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#commandInput')).toBeVisible();
        await page.locator('#commandInput').fill('预览期间保留会话草稿');
        if (viewport.touch) await swipe(page, '#chatLog', false);
        else await page.locator('#chatFilesToggle').click();
        const rows = page.locator('#sessionFilesList .doc-row');
        await expect(rows).toHaveCount(files.length);
        await page.locator('#docSearch').fill('xlsx');
        await expect(rows).toHaveCount(1);
        await expect(rows).toContainText('示例 文件.xlsx');
        await page.locator('#docSearch').fill('');
        await expect(rows).toHaveCount(files.length);
        await page.screenshot({ path: path.join(output, `${viewport.name}-list.png`) });
        const open = (file) =>
          page.evaluate(
            (file) =>
              window.dispatchEvent(
                new CustomEvent('swift.file.open', {
                  detail: { paneId: 'pane-codex', path: file },
                }),
              ),
            file,
          );
        for (const file of files.filter((file) => /\.(docx?|pptx?|xlsx?|pdf)$/.test(file))) {
          await open(file);
          await expect(page.locator('.doc-page')).toBeVisible();
          assert(await page.locator('.doc-page').evaluate((image) => image.naturalWidth > 100));
          await expect(page.locator('.file-preview-page')).toHaveValue('1');
          await page.getByRole('button', { name: '下一页', exact: true }).click();
          await expect(page.locator('.file-preview-page')).toHaveValue('2');
          await expect(page.locator('.doc-page')).toBeVisible();
          await page.getByRole('button', { name: '放大', exact: true }).click();
          assert(
            await page
              .locator('.file-preview-body')
              .evaluate((node) => node.scrollWidth > node.clientWidth),
          );
          await page.getByRole('button', { name: '适应宽度', exact: true }).click();
          await page.getByRole('button', { name: '文字', exact: true }).click();
          await expect(page.locator('.file-preview-text')).toBeVisible();
          await expect(page.locator('.file-preview-text')).toContainText(
            /Page two|slide 2|Details/,
          );
          await page.getByRole('button', { name: '页面', exact: true }).click();
          await expect(page.locator('.doc-page')).toBeVisible();
          await page.screenshot({
            path: path.join(output, `${viewport.name}-${path.extname(file).slice(1)}.png`),
          });
          const pending = page.waitForEvent('download');
          await page.getByRole('button', { name: '下载原文件' }).click();
          const saved = await pending;
          assert.equal(saved.suggestedFilename(), path.basename(file));
          assert.equal(await digest(await saved.path()), await digest(file));
          await page.locator('#chatFilesListBack').click();
          await expect(rows).toHaveCount(files.length);
        }
        for (const [ext, selector] of [
          ['svg', '.doc-image'],
          ['webm', '.doc-video'],
          ['wav', '.doc-audio'],
        ]) {
          await rows
            .filter({
              has: page.locator('strong', {
                hasText: path.basename(files.find((file) => file.endsWith('.' + ext))),
              }),
            })
            .click();
          const media = page.locator(selector);
          await expect(media).toBeVisible();
          if (ext === 'svg')
            assert(await media.evaluate((image) => image.complete && image.naturalWidth === 640));
          else {
            await expect
              .poll(() => media.evaluate((node) => node.readyState))
              .toBeGreaterThanOrEqual(1);
            assert.equal(await media.evaluate((node) => node.autoplay), false);
            await media.evaluate(async (node) => {
              window.fixtureMedia = node;
              node.muted = true;
              await node.play();
            });
            await expect.poll(() => media.evaluate((node) => node.currentTime)).toBeGreaterThan(0);
          }
          await page.screenshot({ path: path.join(output, `${viewport.name}-${ext}.png`) });
          await page.locator('#chatFilesListBack').click();
          if (ext !== 'svg')
            assert(
              await page.evaluate(
                () => window.fixtureMedia.paused && !window.fixtureMedia.getAttribute('src'),
              ),
            );
        }
        fail = true;
        await open(pdf);
        await expect(page.locator('#docReadError')).toContainText('预览暂时不可用');
        await expect(page.locator('#docReadError [data-save-file]')).toBeVisible();
        fail = false;
        await page.locator('#docReadError').getByRole('button', { name: '重试' }).click();
        await expect(page.locator('.doc-page')).toBeVisible();
        await page.locator('#chatFilesListBack').click();
        await open(invalidMedia);
        await expect(page.locator('.file-preview-status').first()).toContainText(
          '当前设备无法播放',
        );
        await expect(page.locator('[data-save-file]')).toBeVisible();
        await page.locator('#chatFilesListBack').click();
        delay = true;
        await open(files.find((file) => file.endsWith('.webm')));
        await open(pdf);
        await expect(page.locator('.doc-page')).toBeVisible();
        await expect(page.locator('.doc-video')).toHaveCount(0);
        const geometry = await page.locator('#projectView').evaluate((node) => ({
          width: node.clientWidth,
          overflow: document.documentElement.scrollWidth - innerWidth,
        }));
        assert(geometry.width > 250);
        assert.equal(geometry.overflow, 0);
        await page.locator('#chatFilesListBack').click();
        if (viewport.touch) await swipe(page, '#sessionFilesList', true);
        else await page.locator('#chatFilesToggle').click();
        await expect(page.locator('#commandInput')).toHaveValue('预览期间保留会话草稿');
        assert.deepEqual(errors, []);
        results.push({ viewport: viewport.name, formats: 10, originalsPreserved: true, geometry });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    assert.deepEqual(await Promise.all(files.map(digest)), originals);
    assert.deepEqual(sourceFingerprint(root), source);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ source, results }, null, 2) + '\n',
    );
    console.log(JSON.stringify({ ok: true, viewports: results.length, formats: 10, output }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

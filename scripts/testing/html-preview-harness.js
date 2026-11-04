'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/testing/html-preview/browser');
const file = '/fixture/workdir/reports/网页 对比.html';
const documentText = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTML 交互报告</title><style>body{margin:0;padding:24px;font:16px/1.6 sans-serif;background:#f6f3ed;color:#242a31}h1{font-size:28px}button{padding:12px}section{margin-top:24px}pre{white-space:pre-wrap}</style>
<h1>HTML 交互报告</h1><p>页面应直接显示正文、样式与交互。</p><button id="increment" onclick="document.querySelector('output').textContent=++count">切换示例</button> <output>0</output>
<section><details><summary>展开源码</summary><pre>const result = input + 1;</pre></details></section>
<a id="next" href="next.htm">下一份报告</a> · <a href="#end">页内锚点</a><p id="end">报告结束</p>
<script>let count=0; window.isolation={}; for(const key of ['parent','storage','cookie']) {try{if(key==='parent')parent.document.body.dataset.report='bad';if(key==='storage')localStorage.setItem('report','bad');if(key==='cookie')document.cookie;isolation[key]=false}catch{isolation[key]=true}}
fetch('/api/html-preview-probe',{method:'POST'}).catch(()=>{});
parent.postMessage({type:'link',href:'/fixture/workdir/forged.md'},'*');</script></html>`;
(async () => {
  await fs.mkdir(output, { recursive: true });
  const baseline = process.argv.includes('--baseline');
  const actualPath = process.env.SWIFT_HTML_FIXTURE;
  const actual = actualPath ? await fs.readFile(actualPath, 'utf8') : null;
  const before = sourceFingerprint(root),
    results = [];
  const browser = await firefox.launch();
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture(
        process.env.SWIFT_HTML_PUBLIC ? { publicDirectory: process.env.SWIFT_HTML_PUBLIC } : {},
      );
      fixture.state.contentSecurityPolicy =
        require('../../lib/http').securityHeaders()['content-security-policy'];
      fixture.state.productionPresentation = true;
      fixture.state.sessions['pane-codex'].messages.push({
        id: 'html-report',
        role: 'assistant',
        blocks: [{ kind: 'text', text: `已完成：[打开 HTML 对比页](<${file}>)。` }],
      });
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      // Desktop has a JS-only StudioApp authentication helper, not the Java bridge.
      await context.addInitScript(() => {
        window.StudioApp = { authenticationRequired() {} };
      });
      const page = await context.newPage();
      const view = page.locator('.workspace-file-view:not([hidden])');
      page.setDefaultTimeout(8000);
      const requests = [],
        errors = [];
      let useActual = baseline && actual,
        delay = 0,
        fail = false,
        truncated = false;
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/api/workspace-files/content?**', async (route) => {
        const wanted = new URL(route.request().url()).searchParams.get('path');
        requests.push(wanted);
        if (!/\.(html?|md)$/.test(wanted)) return route.continue();
        assert.equal(route.request().headers()['x-agent-studio-token'], 'fixture');
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (fail) return route.fulfill({ status: 404, json: { message: '文件已删除或移动。' } });
        const text = wanted.endsWith('next.htm')
          ? '<h1>第二份报告</h1>'
          : useActual
            ? actual
            : documentText;
        await route.fulfill({
          json: {
            ok: true,
            path: wanted,
            kind: 'html',
            title: wanted.split('/').pop(),
            text,
            truncated,
          },
        });
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const link = page.getByRole('link', { name: '打开 HTML 对比页' });
        await expect(link).toBeVisible();
        await page.locator('#commandInput').fill('保留聊天草稿');
        await link.click();
        if (baseline) {
          await expect(view.locator('.code-view')).toBeVisible();
          await page.screenshot({ path: path.join(output, `${viewport.name}-before.png`) });
          results.push({ viewport: viewport.name, sourceInsteadOfPage: true });
          continue;
        }
        const frame = page.frameLocator('.workspace-file-view:not([hidden]) .html-document-frame');
        await expect(frame.locator('h1')).toHaveText('HTML 交互报告');
        await expect(view.locator('.html-document-status')).toBeHidden();
        await frame.locator('#increment').click();
        await expect(frame.locator('output')).toHaveText('1');
        assert.deepEqual(await frame.locator('body').evaluate(() => window.isolation), {
          parent: true,
          storage: true,
          cookie: true,
        });
        assert(!fixture.state.requests.some((r) => r.route.includes('html-preview-probe')));
        assert(!requests.some((r) => r.includes('forged')));
        await frame.locator('summary').click();
        await expect(frame.locator('details')).toHaveAttribute('open', '');
        await view.getByRole('button', { name: '源码', exact: true }).click();
        await expect(view.locator('.html-document-source')).toContainText('<h1>HTML 交互报告</h1>');
        await view.getByRole('button', { name: '预览', exact: true }).click();
        await expect(frame.locator('output')).toHaveText('1');
        await frame.locator('#next').click();
        await expect(frame.locator('h1')).toHaveText('第二份报告');
        await page.getByRole('tab', { name: file.split('/').pop(), exact: true }).click();
        await expect(frame.locator('h1')).toHaveText('HTML 交互报告');
        if (actual) {
          useActual = true;
          await page.getByRole('button', { name: '返回会话', exact: true }).click();
          await page.evaluate(
            (path) =>
              window.dispatchEvent(
                new CustomEvent('swift.file.open', { detail: { paneId: 'pane-codex', path } }),
              ),
            file,
          );
          await expect(frame.locator('h1')).toContainText('分布式张量');
          await frame.locator('#tab-2').click();
          await expect(frame.locator('#panel-2')).toBeVisible();
          await frame.locator('#slot').fill('64');
          await frame.locator('#slot').dispatchEvent('input');
          await expect(frame.locator('#mapping-math')).toContainText('owner = 2');
        }
        const geometry = await view.locator('.html-document-frame').evaluate((el) => ({
          width: el.clientWidth,
          height: el.clientHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
        }));
        assert(geometry.width > 250 && geometry.height > 300);
        assert.equal(geometry.overflow, 0);
        await page.screenshot({ path: path.join(output, `${viewport.name}-preview.png`) });

        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        await expect(view.locator('.html-document-frame')).toBeHidden();
        // Closing during a slow read must not resurrect a report.
        delay = 300;
        await page.evaluate(
          (path) =>
            window.dispatchEvent(
              new CustomEvent('swift.file.open', { detail: { paneId: 'pane-codex', path } }),
            ),
          file,
        );
        await page.evaluate(() => window.StudioNavigation.back());
        await page.waitForTimeout(500);
        await expect(view.locator('.html-document-frame')).toBeHidden();
        delay = 0;
        useActual = false;
        fail = true;
        await page.evaluate(
          (path) =>
            window.dispatchEvent(
              new CustomEvent('swift.file.open', { detail: { paneId: 'pane-codex', path } }),
            ),
          file,
        );
        await page.locator('.workspace-file-reload').click();
        await expect(view).toContainText('文件已删除或移动');
        fail = false;
        await view.getByRole('button', { name: '重试', exact: true }).click();
        await expect(frame.locator('h1')).toHaveText('HTML 交互报告');
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        truncated = true;
        await page.evaluate(
          (path) =>
            window.dispatchEvent(
              new CustomEvent('swift.file.open', { detail: { paneId: 'pane-codex', path } }),
            ),
          file,
        );
        await page.locator('.workspace-file-reload').click();
        await expect(view).toContainText('HTML 内容不完整');
        await expect(view.locator('.html-document-frame')).toHaveCount(0);
        truncated = false;
        // Legacy Android bridge gets a scriptless, readable fallback.
        await page.evaluate(() => {
          window.StudioApp = { closeChat() {} };
        });
        await page.evaluate(
          (path) =>
            window.dispatchEvent(
              new CustomEvent('swift.file.open', { detail: { paneId: 'pane-codex', path } }),
            ),
          file,
        );
        await page.locator('.workspace-file-reload').click();
        await expect(frame.locator('h1')).toHaveText('HTML 交互报告');
        await expect(view.locator('.html-document-frame')).toHaveAttribute('sandbox', '');
        await frame.locator('#increment').click();
        await expect(frame.locator('output')).toHaveText('0');
        await expect(view.locator('.html-document-status')).toContainText('静态预览');
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        await page.evaluate(() => {
          delete window.StudioApp;
        });
        await page.evaluate(() => window.StudioNavigation.back());
        await expect(page.locator('#commandInput')).toHaveValue('保留聊天草稿');
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          ok: true,
          geometry,
          inlineScripts: true,
          actualReport: Boolean(actual),
          isolated: true,
          sourceToggle: true,
          readingStack: true,
          staticAndroid: true,
          lateReadDiscarded: true,
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
  await fs.writeFile(
    path.join(output, baseline ? 'baseline.json' : 'report.json'),
    JSON.stringify({ ok: true, before, after, actualPath, results }, null, 2),
  );
  console.log(`PASS HTML preview: ${results.length} viewports${actual ? ', user report' : ''}`);
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

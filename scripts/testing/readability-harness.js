'use strict';
// Render the real reading surfaces with isolated data; never connect to Herdr.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(process.env.SWIFT_READABILITY_OUTPUT || 'artifacts/readability');
const capture = process.argv.includes('--capture');
const prose =
  '阅读长时间的技术讨论时，我们需要在结论、推导和验证结果之间来回查阅。清楚的段落结构可以帮助定位信息，而稳定的行长让视线更容易回到下一行。Swift 同时呈现中文说明、English terms 和代码，因此不同内容需要各自合适的排版。';
const markdown =
  '# 会话阅读与文件组织\n\n' +
  prose +
  '\n\n' +
  '## 验证与下一步\n\n' +
  prose +
  '\n\n' +
  '- 保留窗口自己的阅读位置。\n- 使用 `sourceFingerprint` 核对源码与产物。\n\n' +
  '### 实现示例\n\n```js\nconst message = "中文与 English 混排";\nfunction describe(value) {\n  return `${value}: ready`;\n}\n```\n\n' +
  '#### 结果说明\n\n' +
  prose +
  '\n\n' +
  '[查看源文件](../../src/kernel.cpp)\n\n' +
  (prose + '\n\n').repeat(6);

async function measure(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const s = getComputedStyle(node),
        r = node.getBoundingClientRect();
      return {
        font: s.fontFamily,
        size: parseFloat(s.fontSize),
        line: parseFloat(s.lineHeight),
        width: r.width,
        height: r.height,
        padding: s.padding,
        color: s.color,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      };
    });
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const source = sourceFingerprint(process.cwd());
  const browser = await firefox.launch(),
    results = [];
  try {
    const widths = capture ? [1440, 1920] : [1920, 1440, 1024, 390, 320];
    for (const width of widths) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.sessions['pane-codex'].messages = [
        {
          id: 'reading-user',
          role: 'user',
          ts: '2026-01-01T00:00:00Z',
          blocks: [{ kind: 'text', text: '请说明这次修改的结论、实现与验证结果。' }],
        },
        {
          id: 'reading-answer',
          role: 'assistant',
          ts: '2026-01-01T00:01:00Z',
          blocks: [{ kind: 'text', text: markdown }],
        },
      ];
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width < 761,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10000);
      await context.route('**/api/workspace-files/content*', async (route) => {
        const response = await route.fetch(),
          data = await response.json();
        if (data.kind === 'markdown') data.text = markdown;
        await route.fulfill({ response, json: data });
      });
      await context.route('**/api/workspace-files/list*', (route) =>
        route.fulfill({
          json: {
            root: '/fixture/workdir',
            path: '/fixture/workdir',
            revision: '1',
            truncated: false,
            entries: [
              { name: 'README.md', type: 'file' },
              { name: 'example.js', type: 'file' },
            ],
          },
        }),
      );
      try {
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(page.locator('#chatLog')).toContainText('会话阅读与文件组织');
        await page.locator('#commandInput').fill('阅读验证保留的草稿');
        for (const theme of ['default', 'light']) {
          await page.evaluate((theme) => StudioDeviceTheme.apply(theme), theme);
          await page.locator('#chatLog').evaluate((node) => {
            node.scrollTop = 0;
          });
          await page.evaluate(() => document.fonts.ready);
          const prefix = `${width}-${theme}`;
          const row = {
            width,
            theme,
            user: await measure(page, '[data-message-id="reading-user"]'),
            body: await measure(page, '[data-message-id="reading-answer"] .chat-md p'),
            inline: await measure(page, '[data-message-id="reading-answer"] .chat-md li code'),
            code: await measure(page, '[data-message-id="reading-answer"] pre code'),
          };
          await page.screenshot({ path: path.join(output, `${prefix}-chat.png`) });
          if (width > 760) {
            row.sidebar = await measure(page, '.chat-sidebar .session-name');
            row.sidebarRow = await measure(page, '.chat-sidebar .session-item');
          }
          await page.locator('#chatFilesToggle').evaluate((node) => node.click());
          await expect(page.locator('.doc-row')).toHaveCount(2);
          row.fileTitle = await measure(page, '.doc-row strong');
          row.fileSummary = await measure(page, '.doc-row-summary');
          await page.screenshot({ path: path.join(output, `${prefix}-files.png`) });
          await page.locator('.doc-row').first().click();
          await expect(page.locator('.workspace-markdown-reader')).toBeVisible();
          row.document = await measure(page, '.workspace-markdown-reader .project-doc-body p');
          await page.screenshot({ path: path.join(output, `${prefix}-markdown.png`) });
          assert(
            row.document.scrollWidth <= row.document.clientWidth + 1,
            `${prefix}: document overflow`,
          );
          if (!capture) {
            assert.equal(row.user.size, row.body.size, `${prefix}: user reading role diverged`);
            assert.equal(row.body.size, row.document.size, `${prefix}: reading roles diverged`);
            assert(row.body.size >= 16, `${prefix}: small reading text`);
            assert(row.body.width / row.body.size <= 40.1, `${prefix}: unbounded chat measure`);
            assert(
              row.document.width / row.document.size <= 40.1,
              `${prefix}: unbounded document measure`,
            );
            assert(row.inline.size >= row.body.size * 0.85, `${prefix}: inline code shrank`);
            assert(row.body.line >= row.body.size * 1.5, `${prefix}: reading leading`);
          }
          await page.evaluate(() => StudioNavigation.back());
          await expect(page.locator('#sessionFilesList')).toBeVisible();
          await page.evaluate(() => StudioNavigation.back());
          await expect(page.locator('#chatLog')).toBeVisible();
          await expect(page.locator('#commandInput')).toHaveValue('阅读验证保留的草稿');
          results.push(row);
        }
        if (!capture) {
          // Exercise text enlargement without changing terminal font preferences.
          await page.evaluate(() =>
            document.documentElement.style.setProperty('--device-font-scale', '2'),
          );
          const body = await measure(page, '[data-message-id="reading-answer"] .chat-md p');
          assert.equal(body.size, 32);
          assert(body.scrollWidth <= body.clientWidth + 1);
          if (width > 760) {
            const row = await measure(page, '.chat-sidebar .session-item');
            const name = await measure(page, '.chat-sidebar .session-name');
            assert(row.height >= name.line + 8, 'navigation clips enlarged text');
          }
          await page.addStyleTag({
            content:
              '.chat-md {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}.chat-md p{margin-bottom:2em!important}',
          });
          const spaced = await measure(page, '[data-message-id="reading-answer"] .chat-md p');
          assert(spaced.scrollWidth <= spaced.clientWidth + 1, 'spacing override causes overflow');
          await page.locator('#chatLog').evaluate((node) => {
            node.scrollTop = 0;
          });
          await page.screenshot({ path: path.join(output, `${width}-enlarged.png`) });
        }
        assert.deepEqual(errors, []);
        assert(
          !fixture.state.requests.some((r) => /^POST .*\/(messages|input)/.test(r.route)),
          'unexpected send',
        );
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    assert.deepEqual(sourceFingerprint(process.cwd()), source, 'source changed during capture');
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ source, capture, results }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, output, cases: results.length }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

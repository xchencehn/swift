'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(process.env.SWIFT_DESIGN_OUTPUT || 'artifacts/design-system');
(async () => {
  const before = sourceFingerprint(process.cwd()),
    results = [],
    browser = await firefox.launch();
  await fs.mkdir(output, { recursive: true });
  try {
    for (const width of [1440, 1024, 390, 320]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.sessions['pane-codex'].messages[0].ts = '2025-12-31T23:59:00Z';
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 1440,
        serviceWorkers: 'block',
        timezoneId: 'Asia/Shanghai',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(7000);
      let files = [
        { name: 'README.md', type: 'file' },
        { name: 'example.js', type: 'file' },
      ];
      await context.route('**/api/workspace-files/list*', (route) =>
        route.fulfill({
          json: {
            root: '/fixture/workdir',
            path: '/fixture/workdir',
            entries: files,
            revision: String(files.length),
            truncated: false,
          },
        }),
      );
      await context.addInitScript(() => {
        window.copyMode = 'success';
        window.copyFallback = true;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: () =>
              window.copyMode === 'success'
                ? Promise.resolve()
                : Promise.reject(new Error('fixture clipboard denied')),
          },
        });
        document.execCommand = () => window.copyFallback;
      });
      const sidebar = async () => {
        if (
          width <= 760 &&
          !(await page.locator('#chatSidebar').evaluate((n) => n.classList.contains('open')))
        )
          await page.locator('#chatDrawerToggle').click();
      };
      const closeSidebar = async () => {
        if (
          width < 1440 &&
          (await page.locator('#chatSidebar').evaluate((n) => n.classList.contains('open')))
        )
          await page
            .locator('#chatPickerScrim')
            .click({ position: { x: width - 5, y: 300 }, force: true });
      };
      try {
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('保留这份草稿');
        const copy = page.locator('.chat-meta-button[title="复制这条消息"]').first();
        await copy.scrollIntoViewIfNeeded();
        const initialBox = await copy.boundingBox();
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'done');
        assert.equal((await copy.boundingBox()).width, initialBox.width);
        await page.evaluate(() => {
          window.savedClipboard = navigator.clipboard;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        });
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'done');
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: window.savedClipboard,
          });
          window.copyMode = 'failure';
        });
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'done');
        await page.evaluate(() => {
          window.copyFallback = false;
        });
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'error');
        await expect(page.locator('.chat-meta .copy-feedback').first()).toContainText('复制失败');
        await expect(page.locator('#chatComposerError')).toBeHidden();
        await page.evaluate(() => {
          window.copyMode = 'success';
        });
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'done');
        const stamp = page.locator('button.chat-meta-time').first();
        await stamp.click();
        await expect(stamp.locator('time')).toHaveAttribute('datetime', '2025-12-31T23:59:00.000Z');
        await expect(stamp).toHaveAttribute('aria-label', /2026.*01.*01.*GMT\+08/);
        await expect(page.locator('.chat-meta-date').first()).toBeVisible();
        await stamp.press('Enter');
        await expect(page.locator('.chat-meta-date').first()).toBeHidden();
        const tool = page.locator('#chatLog details.chat-tool-row').first();
        if (await tool.count()) {
          if (!(await tool.evaluate((n) => n.open))) await tool.locator('summary').click();
          const button = tool.locator('.tool-section-head button').first();
          await button.click();
          await expect(button).toHaveAttribute('data-copy-state', 'done');
        }
        await expect(page.locator('#chatModelAction')).toHaveAttribute('aria-label', /^模型：.+/);
        await expect(page.locator('#chatEffortAction')).toHaveAttribute(
          'aria-label',
          /^推理强度：.+/,
        );
        const sizes = await page.evaluate(() =>
          Object.fromEntries(
            ['chatStatusDetailsAction', 'attachButton', 'sendButton'].map((id) => {
              const el = document.getElementById(id),
                r = el?.getBoundingClientRect();
              return [id, r && { width: r.width, height: r.height }];
            }),
          ),
        );
        if (width < 1440)
          for (const [id, size] of Object.entries(sizes))
            assert(
              size?.width >= 44 && size.height >= 44,
              `${width}/${id}: ${JSON.stringify(size)}`,
            );
        await page
          .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
          .click();
        await expect(page.locator('.session-status-actions button')).toHaveText([
          'ESC',
          '刷新',
          '回到底部',
        ]);
        await expect(page.locator('.session-status-content')).toContainText('/fixture/project');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: path.join(output, `${width}-chat.png`) });
        await sidebar();
        if (width === 1440) {
          const nav = await page
            .locator('.sidebar-modes')
            .evaluate((n) => ({ available: n.clientWidth, content: n.scrollWidth }));
          assert(nav.content <= nav.available + 1, JSON.stringify(nav));
          await page.locator('#chatResizer').focus();
          await page.keyboard.press('ArrowLeft');
          await expect(page.locator('#chatResizer')).toHaveAttribute('aria-valuenow', '304');
          for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
          await expect(page.locator('#sidebarNavigationMore')).toBeVisible();
          await page.locator('#sidebarNavigationMore').click();
          await expect(page.locator('#sidebarFiles')).toBeInViewport();
          await page.locator('#chatResizer').press('Home');
          await expect(page.locator('#chatResizer')).toHaveAttribute('aria-valuenow', '320');
        }
        await page.locator('#sidebarFiles').click();
        await page.locator('.workspace-tree-row').first().waitFor();
        await page.locator('#chatSearchToggle').click();
        await page.locator('#chatPickerSearch').fill('missing-fixture');
        await expect(page.locator('.workspace-tree-note')).toContainText(
          '已加载的文件中没有匹配项',
        );
        await page.screenshot({ path: path.join(output, `${width}-filter-empty.png`) });
        await page.getByRole('button', { name: '清除筛选', exact: true }).click();
        await expect(page.locator('.workspace-tree-row')).toHaveCount(2);
        files = [];
        await page.locator('.workspace-tree-refresh').click();
        await expect(page.locator('.workspace-tree-note')).toContainText('此目录为空');
        await page.locator('#sidebarWorkspaces').click();
        await closeSidebar();
        await page.evaluate(() =>
          window.StudioServerSwitcher.mount({
            api: async () => ({
              active: 'fixture',
              profiles: [
                { id: 'fixture', name: '测试服务器名称很长仍应显示当前身份', mode: 'remote' },
              ],
            }),
            manage() {},
          }),
        );
        await sidebar();
        await expect(page.locator('#serverSwitch')).toContainText(
          '测试服务器名称很长仍应显示当前身份',
        );
        await expect(page.locator('#serverSwitch')).toHaveAttribute(
          'aria-label',
          /当前服务器：测试服务器/,
        );
        await page.locator('#chatDeviceSettings').click();
        for (const theme of await page
          .locator('input[name=deviceTheme]')
          .evaluateAll((ns) => ns.map((n) => n.value))) {
          // Use the public theme API; unknown themes are not silently counted as coverage.
          const themes = await page
            .locator('input[name=deviceTheme]')
            .evaluateAll((ns) => ns.map((n) => n.value));
          if (!themes.includes(theme)) continue;
          await page.evaluate((t) => window.StudioDeviceTheme.apply(t, false), theme);
          await page.screenshot({ path: path.join(output, `${width}-${theme}.png`) });
        }
        await page.locator('#settingsBack').click();
        await closeSidebar();
        await page.addStyleTag({ content: ':root { --device-font-scale: 1.5 !important; }' });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(page.locator('#commandInput')).toHaveValue('保留这份草稿');
        assert(
          (await page.locator('#commandInput').boundingBox()).width > 150,
          'Composer must keep its flexible text column',
        );
        await page.screenshot({ path: path.join(output, `${width}-large-reduced.png`) });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        assert(overflow <= 1, `${width}: overflow ${overflow}`);
        assert.deepEqual(errors, []);
        results.push({
          width,
          sizes,
          overflow,
          clipboardSuccessFallbackFailure: true,
          dateAndTimezone: true,
          filterStates: true,
          keyboardResize: width === 1440,
          currentServer: true,
        });
        console.log(`PASS design system ${width}`);
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${width}-failure.png`) }).catch(() => {});
        throw error;
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(after.treeSha256, before.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ before, after, results, productionInput: false }, null, 2),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

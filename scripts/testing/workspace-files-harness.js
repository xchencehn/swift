'use strict';
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { Router } = require('../../lib/http/router'),
  { json, securityHeaders, createHttp } = require('../../lib/http');
const { apiError } = require('../../lib/message-queue');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..'),
  output = path.resolve(
    root,
    process.env.SWIFT_WORKSPACE_FILES_OUTPUT || 'artifacts/testing/harness-files/browser',
  );
(async () => {
  await fs.mkdir(output, { recursive: true });
  const source = sourceFingerprint(root),
    results = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-files-browser-'));
  await fs.mkdir(path.join(directory, 'knowledge'));
  await fs.mkdir(path.join(directory, 'empty'));
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      fs.writeFile(path.join(directory, `scroll-${index}.txt`), 'Scroll fixture'),
    ),
  );
  await fs.mkdir(path.join(directory, 'unopened'));
  await fs.writeFile(
    path.join(directory, 'knowledge/guide.md'),
    '# 文件浏览\n\n可以阅读 **Markdown**，并[打开代码](../example.js)、[完整文件](../large.txt)与[空文件](../empty.txt)。\n\n' +
      '段落。\n\n'.repeat(50) +
      '## 获取任务\n\n' +
      '段落。\n\n'.repeat(50) +
      '### 检查结果\n\n' +
      '段落。\n\n'.repeat(50) +
      '## 后续步骤\n\n继续验证。\n',
  );
  await fs.writeFile(
    path.join(directory, 'large.txt'),
    '中文完整文件。'.repeat(30000) + '\n完整文件结尾',
  );
  await fs.writeFile(path.join(directory, 'empty.txt'), '');
  await fs.writeFile(path.join(directory, 'example.js'), 'const value = 42;\nconsole.log(value);');
  await fs.writeFile(
    path.join(directory, 'report.html'),
    '<h1>隔离报告</h1><button onclick="this.textContent=\'完成\'">运行示例</button>',
  );
  await fs.writeFile(path.join(directory, 'auth.json'), 'fixture-private');
  const router = new Router({
    json,
    sendError: (res, error) =>
      json(res, error.status || 500, { ok: false, code: error.code, message: error.message }),
  });
  let currentDirectory = directory;
  const auth = createHttp({ tokens: ['fixture'], maxBodyBytes: 1000 });
  require('../../lib/http/routes/workspace-files').register(router, {
    currentRoot: () => ({ data: { directory: currentDirectory } }),
    json,
    readJson: auth.readJson,
    apiError,
    securityHeaders,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (!auth.requireAuth(req, res, url)) return;
    if (!(await router.dispatch(req, res, url))) json(res, 404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const browser = await firefox.launch();
  try {
    assert.equal((await fetch(endpoint + '/api/workspace-files/list')).status, 401);
    assert.equal(
      (
        await fetch(endpoint + '/api/workspace-files/list?root=/stale', {
          headers: { 'x-agent-studio-token': 'fixture' },
        })
      ).status,
      409,
    );
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ].filter(
      (item) =>
        !process.env.SWIFT_WORKSPACE_FILES_VIEWPORT ||
        item.name === process.env.SWIFT_WORKSPACE_FILES_VIEWPORT,
    )) {
      const fixture = await createFixture();
      fixture.state.rootDirectory = directory;
      fixture.state.workspaces[0].cwd = directory;
      for (const session of Object.values(fixture.state.sessions)) session.pane.cwd = directory;
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [],
        requests = [];
      let fail = false,
        hold = false,
        saveDelay = 0;
      async function currentFileVisible() {
        const geometry = await page.locator('.workspace-file-tabs').evaluate((list) => {
          const active = list.querySelector('.selected'),
            item = active.getBoundingClientRect(),
            box = list.getBoundingClientRect();
          const name = document.querySelector('.workspace-path-name').getBoundingClientRect(),
            path = document.querySelector('.workspace-file-path').getBoundingClientRect();
          return {
            tabLeft: item.left - box.left,
            tabRight: box.right - item.right,
            nameLeft: name.left - path.left,
            nameRight: path.right - name.right,
          };
        });
        assert(geometry.tabLeft >= -1 && geometry.tabRight >= -1, JSON.stringify(geometry));
        assert(geometry.nameLeft >= -1 && geometry.nameRight >= -1, JSON.stringify(geometry));
      }
      const codeAssets = [];
      const pendingResources = new Map();
      page.on('request', (request) =>
        pendingResources.set(request, {
          path: new URL(request.url()).pathname,
          type: request.resourceType(),
        }),
      );
      page.on('requestfinished', (request) => pendingResources.delete(request));
      page.on('requestfailed', (request) => pendingResources.delete(request));
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.includes('/vendor/code-editor/')) codeAssets.push(url.pathname);
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/api/workspace-files/**', async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.pathname + url.search);
        if (fail && url.pathname.endsWith('/list'))
          return route.fulfill({ status: 503, json: { message: '测试目录暂时不可用。' } });
        if (hold && url.pathname.endsWith('/content'))
          await new Promise((resolve) => setTimeout(resolve, 350));
        try {
          const response = await route.fetch({ url: endpoint + url.pathname + url.search });
          if (saveDelay && route.request().method() === 'POST')
            await new Promise((resolve) => setTimeout(resolve, saveDelay));
          await route.fulfill({ response });
        } catch (error) {
          if (!page.isClosed()) await route.abort().catch(() => {});
        }
      });
      await context.route(/\/api\/doc-files(?:\?|\/search\?)/, (route) =>
        route.fulfill({
          json: {
            files: [
              {
                path: path.join(directory, 'knowledge/guide.md'),
                kind: 'markdown',
                title: '文件浏览',
                summary: '共用文件页',
              },
            ],
          },
        }),
      );
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#commandInput')).toBeVisible();
        await page.locator('#commandInput').fill('文件阅读期间保留草稿');
        await page.locator('#chatFilesToggle').dispatchEvent('click');
        await page.locator('#sessionFilesList .doc-row').click();
        const sharedView = page.locator('.workspace-file-view:not([hidden])');
        await expect(sharedView.locator('h1')).toHaveText('文件浏览');
        await expect(page.locator('#projectView')).toBeEmpty();
        await sharedView.evaluate((node) => {
          window.sessionFileView = node;
        });
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        await expect(page.locator('#sessionFilesPage')).toBeVisible();
        await page.locator('#sessionFilesList .doc-row').click();
        assert(
          await sharedView.evaluate((node) => window.sessionFileView === node),
          '会话文件和files页共用同一文件实例',
        );
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        await page.locator('#chatFilesToggle').dispatchEvent('click');
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        assert(
          !fixture.state.requests.some((entry) => entry.route === 'GET /api/doc-files/content'),
        );
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        const row = (name) =>
          page.locator('.workspace-tree-row').filter({
            has: page.locator('.workspace-tree-name', {
              hasText: new RegExp('^' + name.replace('.', '\\.') + '$'),
            }),
          });
        await expect(row('knowledge')).toBeVisible();
        await expect(row('auth.json')).toBeDisabled();
        assert(!requests.some((url) => url.includes(encodeURIComponent(directory + '/unopened'))));
        await row('knowledge').click();
        await expect(row('guide.md')).toBeVisible();
        const sidebarSwipes = await require('./sidebar-files-swipe-cases').run(page, {
          expect,
          viewport,
          output,
        });
        await page.screenshot({ path: path.join(output, `${viewport.name}-tree.png`) });
        await row('guide.md').click();
        await expect(page.locator('#workspaceFilesPage')).toBeVisible();
        if (viewport.width <= 760)
          await expect(page.locator('#chatSidebar')).toHaveCSS('visibility', 'hidden');
        await expect(page.locator('.workspace-file-view:not([hidden]) h1')).toHaveText('文件浏览');
        await currentFileVisible();
        const selection = await page.evaluate(() =>
          [
            document.querySelector('.sidebar-modes [aria-selected="true"]'),
            document.querySelector('.workspace-file-tab.selected'),
          ].map((el) => {
            const style = getComputedStyle(el);
            return {
              height: el.getBoundingClientRect().height,
              radius: style.borderRadius,
              background: style.backgroundColor,
            };
          }),
        );
        assert.deepEqual(
          selection[0],
          selection[1],
          'Sidebar and file tabs share the selected shape',
        );
        const header = await page.evaluate(() => {
          const left = document.querySelector('.chat-sidebar-top').getBoundingClientRect();
          const right = document.querySelector('.workspace-files-header').getBoundingClientRect();
          const root = document.querySelector('.workspace-tree-header').getBoundingClientRect();
          const path = document.querySelector('.workspace-file-toolbar').getBoundingClientRect();
          return {
            leftBottom: left.bottom,
            rightBottom: right.bottom,
            height: right.height,
            rootTop: root.top,
            rootBottom: root.bottom,
            pathTop: path.top,
            pathBottom: path.bottom,
          };
        });
        assert(Math.abs(header.leftBottom - header.rightBottom) < 1, JSON.stringify(header));
        if (viewport.width > 760) {
          assert(Math.abs(header.rootTop - header.pathTop) < 1, JSON.stringify(header));
          assert(Math.abs(header.rootBottom - header.pathBottom) < 1, JSON.stringify(header));
        }
        if (viewport.width > 760) {
          await expect(page.locator('.workspace-files-sidebar')).toBeHidden();
          await page.locator('#chatSidebarCollapse').click();
          await expect(page.locator('.workspace-files-sidebar')).toBeFocused();
          await page.locator('.workspace-files-sidebar').click();
          await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
          await expect(page.locator('.workspace-files-sidebar')).toBeHidden();
          await page.locator('#sidebarFiles').click();
        } else await expect(page.locator('.workspace-files-sidebar')).toBeVisible();
        await page.screenshot({ path: path.join(output, `${viewport.name}-markdown.png`) });
        await page.getByRole('button', { name: 'knowledge', exact: true }).click();
        await expect(row('guide.md')).toBeVisible();
        if (viewport.width <= 760) {
          await page.evaluate(() => window.StudioNavigation.back());
          await expect(page.locator('#workspaceFilesPage')).toBeVisible();
          await expect(page.locator('#chatSidebar')).toHaveCSS('visibility', 'hidden');
        }
        assert.equal(codeAssets.length, 0, 'Markdown预览和聊天首屏不加载代码编辑器');
        await page.locator('.workspace-file-source').click();
        await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText(
          '# 文件浏览',
        );
        await page.locator('.workspace-file-source').click();
        const editing = await require('./file-edit-cases').run(page, {
          expect,
          viewport,
          output,
          directory,
          delaySave: (value) => {
            saveDelay = value;
          },
        });
        await page.getByRole('link', { name: '打开代码' }).click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(2);
        await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText(
          'const value = 42;',
        );
        await currentFileVisible();
        await page.getByRole('tab', { name: 'guide.md', exact: true }).click();
        await page
          .locator('.workspace-file-view:not([hidden]) .workspace-markdown-reader')
          .evaluate((node) => {
            node.scrollTop = 350;
          });
        await page.getByRole('tab', { name: 'example.js', exact: true }).click();
        await page.getByRole('tab', { name: 'guide.md', exact: true }).click();
        assert(
          (await page
            .locator('.workspace-file-view:not([hidden]) .workspace-markdown-reader')
            .evaluate((node) => node.scrollTop)) >= 340,
        );
        const geometry = await page.locator('#workspaceFilesPage').evaluate((node) => ({
          width: node.clientWidth,
          height: node.clientHeight,
          overflow: document.documentElement.scrollWidth - innerWidth,
        }));
        assert(geometry.width > 250 && geometry.height > 500);
        assert.equal(geometry.overflow, 0);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Escape');
        await expect(page.locator('#workspaceFilesPage')).toBeHidden();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        await expect(row('guide.md')).toBeVisible();
        await row('empty').click();
        await expect(page.locator('.workspace-tree-body')).toContainText('此目录为空。');
        fail = true;
        await page.getByRole('button', { name: '刷新目录', exact: true }).click();
        await expect(page.locator('.workspace-tree-body')).toContainText('测试目录暂时不可用。');
        await expect(row('guide.md')).toBeVisible();
        fail = false;
        await page.getByRole('button', { name: '刷新目录', exact: true }).click();
        await expect(page.locator('.workspace-tree-body')).not.toContainText(
          '测试目录暂时不可用。',
        );
        await row('report.html').click();
        const frame = page.frameLocator('.workspace-file-view:not([hidden]) .html-document-frame');
        await expect(frame.locator('h1')).toHaveText('隔离报告');
        await frame.locator('button').click();
        await expect(frame.locator('button')).toHaveText('完成');
        await currentFileVisible();
        await page.screenshot({ path: path.join(output, `${viewport.name}-html.png`) });
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        await row('example.js').click();
        await page.getByRole('button', { name: '关闭 example.js', exact: true }).click();
        await currentFileVisible();
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        hold = true;
        await row('example.js').click();
        await page.getByRole('button', { name: '关闭 example.js', exact: true }).click();
        await page.waitForTimeout(500);
        await expect(page.getByRole('tab', { name: 'example.js', exact: true })).toHaveCount(0);
        hold = false;
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        await row('knowledge').focus();
        await page.keyboard.press('ArrowLeft');
        await expect(row('knowledge')).toHaveAttribute('aria-expanded', 'false');
        await page.keyboard.press('ArrowRight');
        await expect(row('guide.md')).toBeVisible();
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        if (await page.locator('#chatDrawerToggle').isVisible())
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarFiles').click();
        await expect(row('guide.md')).toBeVisible();
        await row('guide.md').click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(2);
        await expect(page.locator('.workspace-file-view:not([hidden]) h1')).toHaveText('文件浏览');
        if (editing.readingWidth)
          assert.equal(
            await page
              .locator('#workspaceFilesPage')
              .evaluate((node) => node.style.getPropertyValue('--workspace-markdown-width')),
            editing.readingWidth,
          );
        if (editing.outlineWidth)
          assert.equal(
            await page
              .locator('#workspaceFilesPage')
              .evaluate((node) => node.style.getPropertyValue('--workspace-outline-width')),
            editing.outlineWidth,
          );
        if (!viewport.touch) {
          await page.getByRole('button', { name: '返回会话', exact: true }).click();
          await page.locator('#chatSidebarCollapse').click();
          await page.waitForTimeout(200);
          const before = requests.length;
          await page.waitForTimeout(2800);
          assert.equal(requests.length, before, '收起侧栏后不得继续轮询目录');
          await page.locator('#chatDrawerToggle').click();
          await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
          await page.locator('#sidebarFiles').click();
          await expect(row('guide.md')).toBeVisible();
        }
        // Returning to chat must not strand the user when all file slots are occupied.
        async function openFromTree(name) {
          if (await page.locator('#workspaceFilesPage').isVisible())
            await page.getByRole('button', { name: '返回会话', exact: true }).click();
          if (await page.locator('#chatDrawerToggle').isVisible())
            await page.locator('#chatDrawerToggle').click();
          await page.locator('#sidebarFiles').click();
          await row(name).click();
        }
        for (let index = 0; index < 10; index++) await openFromTree(`scroll-${index}.txt`);
        await expect(page.locator('.workspace-file-tab')).toHaveCount(12);
        const opened = await page
          .getByRole('tab')
          .filter({ hasText: /scroll-|guide.md|report.html/ })
          .allTextContents();
        await openFromTree('scroll-10.txt');
        await expect(page.locator('#workspaceFilesPage')).toBeVisible();
        await expect(page.locator('#workspaceFilesPage > .workspace-file-notice')).toContainText(
          '已打开 12 个文件',
        );
        await expect(page.locator('.workspace-file-tab')).toHaveCount(12);
        await expect(page.getByRole('tab', { name: 'scroll-10.txt', exact: true })).toHaveCount(0);
        assert(
          !requests.some(
            (url) =>
              url.includes('/content?') &&
              new URL('http://fixture' + url).searchParams.get('path') ===
                directory + '/scroll-10.txt',
          ),
        );
        await currentFileVisible();
        await page.screenshot({ path: path.join(output, `${viewport.name}-tab-limit.png`) });
        await openFromTree('guide.md');
        await expect(page.getByRole('tab', { name: 'guide.md', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(page.locator('.workspace-file-tab')).toHaveCount(12);
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        await openFromTree('scroll-10.txt');
        await expect(page.locator('#workspaceFilesPage')).toBeVisible();
        await expect(page.locator('#workspaceFilesPage > .workspace-file-notice')).toContainText(
          '已打开 12 个文件',
        );
        assert.deepEqual(
          await page
            .getByRole('tab')
            .filter({ hasText: /scroll-|guide.md|report.html/ })
            .allTextContents(),
          opened,
        );
        await currentFileVisible();
        await page.getByRole('button', { name: '关闭 guide.md', exact: true }).click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(11);
        await expect(page.locator('#workspaceFilesPage > .workspace-file-notice')).toBeEmpty();
        await openFromTree('scroll-10.txt');
        await expect(page.getByRole('tab', { name: 'scroll-10.txt', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(page.locator('.workspace-file-tab')).toHaveCount(12);
        await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText(
          'Scroll fixture',
        );
        const strip = page.locator('.workspace-file-tabs');
        const beforeWheel = await strip.evaluate((node) => node.scrollLeft);
        if (beforeWheel > 0) {
          await strip.hover();
          await page.mouse.wheel(0, -300);
          await expect
            .poll(() => strip.evaluate((node) => node.scrollLeft))
            .toBeLessThan(beforeWheel);
          await expect(
            page.getByRole('tab', { name: 'scroll-10.txt', exact: true }),
          ).toHaveAttribute('aria-selected', 'true');
        }
        // The toolbar menu must remain usable when the active file is outside the scrolled strip.
        await strip.evaluate((node) => {
          node.scrollLeft = 0;
        });
        const toolbarMenu = page.locator('.workspace-file-menu-toggle');
        await toolbarMenu.click();
        const toolbarPopup = page.locator('.workspace-file-menu');
        await expect(toolbarPopup).toBeVisible();
        await page.screenshot({ path: path.join(output, `${viewport.name}-toolbar-menu.png`) });
        const toolbarBox = await toolbarPopup.boundingBox();
        assert(
          toolbarBox.x >= 8 &&
            toolbarBox.y >= 8 &&
            toolbarBox.x + toolbarBox.width <= viewport.width - 7 &&
            toolbarBox.y + toolbarBox.height <= viewport.height - 7,
          JSON.stringify(toolbarBox),
        );
        const triggerBox = await toolbarMenu.boundingBox();
        assert(
          Math.abs(toolbarBox.y - (triggerBox.y + triggerBox.height)) < 1,
          'Toolbar menu opens at its visible button',
        );
        await page.keyboard.press('Escape');
        await expect(toolbarMenu).toBeFocused();
        await toolbarMenu.press('Enter');
        await expect(toolbarPopup).toBeVisible();
        await toolbarPopup.getByRole('menuitem', { name: '复制相对路径', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'scroll-10.txt', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await page
          .getByRole('tab', { name: 'scroll-10.txt', exact: true })
          .evaluate((node) => node.focus({ preventScroll: true }));
        await strip.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await page.keyboard.press('Shift+F10');
        await expect(toolbarPopup).toBeVisible();
        const offscreenAnchorMenu = await toolbarPopup.boundingBox();
        assert(
          offscreenAnchorMenu.x >= 8 &&
            offscreenAnchorMenu.x + offscreenAnchorMenu.width <= viewport.width - 7,
          JSON.stringify(offscreenAnchorMenu),
        );
        await page.keyboard.press('Escape');
        // Menus target the clicked file without activating it or re-reading other files.
        const tab = (name) => page.getByRole('tab', { name, exact: true });
        const menu = page.locator('.workspace-file-menu');
        const action = (name) => menu.getByRole('menuitem', { name, exact: true });
        async function openMenu(name) {
          await tab(name).scrollIntoViewIfNeeded();
          await tab(name).click({ button: 'right' });
          await expect(menu).toBeVisible();
        }
        await openMenu('scroll-0.txt');
        await expect(tab('scroll-10.txt')).toHaveAttribute('aria-selected', 'true');
        await expect(action('关闭左侧标签页')).toBeEnabled();
        await page.screenshot({ path: path.join(output, `${viewport.name}-tab-menu.png`) });
        const menuBox = await menu.boundingBox();
        assert(
          menuBox.x >= 0 &&
            menuBox.y >= 0 &&
            menuBox.x + menuBox.width <= viewport.width &&
            menuBox.y + menuBox.height <= viewport.height,
        );
        await page.keyboard.press('Escape');
        await expect(tab('scroll-0.txt')).toBeFocused();
        await expect(page.locator('#workspaceFilesPage')).toBeVisible();
        await page.keyboard.press('Shift+F10');
        await expect(menu).toBeVisible();
        await action('关闭其他标签页').click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
        await expect(tab('scroll-0.txt')).toHaveAttribute('aria-selected', 'true');
        await page.locator('.workspace-file-menu-toggle').click();
        for (const label of ['关闭其他标签页', '关闭左侧标签页', '关闭右侧标签页'])
          await expect(action(label)).toBeDisabled();
        await action('关闭标签页').click();
        await expect(page.locator('#workspaceFilesPage')).toBeHidden();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        for (const name of ['guide.md', 'example.js', 'report.html']) await openFromTree(name);
        await tab('guide.md').click();
        await page
          .locator('.workspace-file-view:not([hidden]) .workspace-markdown-reader')
          .evaluate((node) => {
            node.scrollTop = 350;
          });
        await openMenu('example.js');
        await action('关闭右侧标签页').click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(2);
        await expect(tab('guide.md')).toHaveAttribute('aria-selected', 'true');
        assert(
          (await page
            .locator('.workspace-file-view:not([hidden]) .workspace-markdown-reader')
            .evaluate((node) => node.scrollTop)) >= 340,
        );
        await openMenu('example.js');
        await action('关闭左侧标签页').click();
        await expect(tab('example.js')).toHaveAttribute('aria-selected', 'true');
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (value) => {
                window.copiedFilePath = value;
              },
            },
          });
        });
        await openMenu('example.js');
        await action('复制完整路径').click();
        assert.equal(await page.evaluate(() => window.copiedFilePath), directory + '/example.js');
        await openMenu('example.js');
        await action('复制相对路径').click();
        assert.equal(await page.evaluate(() => window.copiedFilePath), 'example.js');
        await openMenu('example.js');
        await action('在文件目录中定位').click();
        await expect(row('example.js')).toBeFocused();
        if (viewport.width <= 760) await page.evaluate(() => window.StudioNavigation.back());
        const reads = requests.filter((url) => url.includes('/content?')).length;
        await openMenu('example.js');
        await action('刷新文件').click();
        await expect
          .poll(() => requests.filter((url) => url.includes('/content?')).length)
          .toBe(reads + 1);
        await expect(page.locator('.workspace-file-view:not([hidden])')).toContainText(
          'const value = 42;',
        );
        const downloadEvent = page.waitForEvent('download');
        await openMenu('example.js');
        await action('保存原文件').click();
        const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), 'example.js');
        assert.equal(
          await fs.readFile(await download.path(), 'utf8'),
          'const value = 42;\nconsole.log(value);',
        );
        await openFromTree('report.html');
        await tab('report.html').click({ button: 'middle' });
        await expect(tab('report.html')).toHaveCount(0);
        await expect(tab('example.js')).toHaveAttribute('aria-selected', 'true');
        for (const name of ['guide.md', 'report.html', 'scroll-0.txt']) await openFromTree(name);
        await tab('guide.md').click();
        await openMenu('report.html');
        await action('关闭左侧标签页').click();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(2);
        await expect(tab('report.html')).toHaveAttribute('aria-selected', 'true');
        hold = true;
        await openFromTree('guide.md');
        await page.locator('.workspace-file-menu-toggle').click();
        await action('关闭全部标签页').click();
        await page.waitForTimeout(500);
        hold = false;
        await expect(page.locator('#workspaceFilesPage')).toBeHidden();
        await expect(page.locator('.workspace-file-tab')).toHaveCount(0);
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        await openFromTree('example.js');
        await expect(page.locator('.workspace-file-tab')).toHaveCount(1);
        await page.getByRole('button', { name: '返回会话', exact: true }).click();
        await expect(page.locator('#commandInput')).toHaveValue('文件阅读期间保留草稿');
        assert.deepEqual(errors, []);
        assert(
          !fixture.state.requests.some(
            (item) => item.route === 'POST /api/messages' || /POST.*herdr/.test(item.route),
          ),
        );
        results.push({
          viewport: viewport.name,
          geometry,
          header,
          sidebarSwipes,
          editing,
          codeAssets: codeAssets.length,
          requests: requests.length,
          errors,
        });
      } catch (error) {
        console.error({ errors, pendingResources: [...pendingResources.values()] });
        await fs.writeFile(
          path.join(output, `${viewport.name}-failure.json`),
          JSON.stringify(
            {
              errors,
              pendingResources: [...pendingResources.values()],
              page: await page.evaluate(() => ({
                readyState: document.readyState,
                path: location.pathname,
                globals: ['StudioCore', 'StudioWorkspaceFiles', 'StudioFileCodeEditor'].map(
                  (key) => [key, Boolean(window[key])],
                ),
                visibleChat: !document.querySelector('#chatView')?.hidden,
                scripts: [...document.scripts]
                  .map((node) => node.getAttribute('src'))
                  .filter(Boolean),
              })),
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: path.join(output, `${viewport.name}-failure.png`) });
        throw error;
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    const after = sourceFingerprint(root);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ source, after, results }, null, 2) + '\n',
    );
    assert.deepEqual(after, source);
    console.log(JSON.stringify({ ok: true, output, results }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

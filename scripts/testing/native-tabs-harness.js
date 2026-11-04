'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness'),
  { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(process.env.SWIFT_NATIVE_TABS_OUTPUT || 'artifacts/native-tabs');
const tabGeometry = (page) =>
  page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
    };
    const head = document.querySelector('.chat-main > .chat-head'),
      sidebar = document.querySelector('.chat-sidebar-top');
    const controls = [
      ...document.querySelectorAll(
        '.chat-sidebar-top button, .chat-head > button, .herdr-tab-select, .herdr-tab-close, .herdr-tab-add',
      ),
    ].filter(
      (el) => el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden',
    );
    return {
      centers: controls.map((el) => ({
        name: el.id || el.className,
        center: (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2,
      })),
      divider: [getComputedStyle(head).boxShadow, getComputedStyle(sidebar).boxShadow],
      sidebarOuter: rect(sidebar.parentElement),
      widths: [...document.querySelectorAll('.herdr-tab')].map(
        (el) => el.getBoundingClientRect().width,
      ),
      tabHeights: [...document.querySelectorAll('.herdr-tab-select')].map(
        (el) => el.getBoundingClientRect().height,
      ),
      head: rect(document.querySelector('.chat-main > .chat-head')),
      main: rect(document.querySelector('.chat-main')),
      sidebar: rect(document.querySelector('.chat-sidebar-top')),
    };
  });
function assertTabGeometry(geometry) {
  assert(
    geometry.divider[0] === geometry.divider[1] && geometry.divider[0] !== 'none',
    'Both columns must use the same divider',
  );
  assert(
    Math.abs(geometry.sidebar.left - geometry.sidebarOuter.left) < 0.1 &&
      Math.abs(geometry.sidebar.right + 1 - geometry.head.left) < 0.1,
    'Sidebar divider must span its padding and meet the main header',
  );
  for (const control of geometry.centers)
    assert(
      Math.abs(control.center - (geometry.head.top + geometry.head.bottom) / 2) < 0.1,
      'Header control must be vertically centered: ' + control.name,
    );
  assert(
    geometry.widths.every((width) => width > 0 && width <= 180.1),
    'Names use natural width with the file-tab long-name cap',
  );
  assert(
    Math.abs(geometry.head.top - geometry.main.top) < 0.1,
    'Header must meet the top of the main area without a gap',
  );
  assert(
    Math.abs(geometry.head.top - geometry.sidebar.top) < 0.1,
    'Header and sidebar navigation must align at the top',
  );
  assert(
    Math.abs(geometry.head.bottom - geometry.sidebar.bottom) < 0.1,
    'Header and sidebar navigation must align at the bottom',
  );
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'tablet-portrait', width: 768, height: 1024, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'phone-landscape', width: 844, height: 390, touch: true },
    ]) {
      const fixture = await createFixture(),
        state = fixture.state,
        context = await browser.newContext({
          viewport,
          hasTouch: !!viewport.touch,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        }),
        page = await context.newPage(),
        errors = [];
      state.productionPresentation = true;
      let created = 0;
      for (const [index, session] of Object.values(state.sessions).entries())
        Object.assign(session.pane, { tabId: 'tab-' + index, tab: '原生 ' + index });
      state.tabs = Object.values(state.sessions).map((s, index) => ({
        tab_id: s.pane.tabId,
        workspace_id: s.pane.workspaceId,
        label: '原生 ' + index,
        agent_status: index ? 'blocked' : 'working',
      }));
      state.herdrHandler = async (method, params) => {
        if (method === 'tab.rename') {
          state.tabs.find((t) => t.tab_id === params.tab_id).label = params.label;
          return {};
        }
        if (method === 'tab.move') {
          const i = state.tabs.findIndex((t) => t.tab_id === params.tab_id);
          const [tab] = state.tabs.splice(i, 1);
          state.tabs.splice(params.insert_index, 0, tab);
          return {};
        }
        if (method === 'tab.close') {
          state.tabs = state.tabs.filter((t) => t.tab_id !== params.tab_id);
          for (const [id, s] of Object.entries(state.sessions))
            if (s.pane.tabId === params.tab_id) delete state.sessions[id];
          return {};
        }
        if (method === 'tab.create') {
          const id = 'new-' + ++created,
            session = structuredClone(state.sessions['pane-codex']);
          session.pane = {
            ...session.pane,
            paneId: id,
            terminalId: id + '-terminal',
            tabId: id + '-tab',
            workspaceId: params.workspace_id,
            agent: null,
          };
          session.messages = [];
          state.sessions[id] = session;
          state.tabs.push({
            tab_id: session.pane.tabId,
            workspace_id: params.workspace_id,
            label: params.label,
            agent_status: 'idle',
          });
          return {
            tab: { tab_id: session.pane.tabId },
            root_pane: { pane_id: id, terminal_id: session.pane.terminalId },
          };
        }
        if (method === 'agent.start') {
          const session = state.sessions[params.pane_id];
          session.pane.agent = {
            ...structuredClone(state.sessions['pane-codex'].pane.agent),
            id: params.name,
            name: params.name,
            session: { value: 'thread-' + params.pane_id },
          };
          session.messages = [
            {
              id: 'created-codex',
              role: 'assistant',
              blocks: [{ kind: 'text', text: '默认创建的新 Codex 会话' }],
            },
          ];
          return { agent: session.pane.agent };
        }
        return {};
      };
      page.setDefaultTimeout(6000);
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const bar = page.locator('.herdr-tabs'),
          tabs = bar.getByRole('tab'),
          wide = !viewport.name.startsWith('phone');
        if (!wide) {
          await expect(bar).toBeHidden();
          await expect(page.locator('#chatCurrentName')).toBeVisible();
          await page.locator('#commandInput').fill('手机保留输入');
          await expect(page.locator('#commandInput')).toHaveValue('手机保留输入');
        } else {
          await expect(bar).toBeVisible();
          await expect(tabs).toHaveText(['原生 0', '原生 1']);
          await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
          assert(
            await bar.evaluate((el) =>
              el.closest('.chat-head').parentElement.classList.contains('chat-main'),
            ),
          );
          const initialGeometry = await tabGeometry(page);
          assertTabGeometry(initialGeometry);
          await fs.writeFile(
            path.join(output, viewport.name + '-alignment.json'),
            JSON.stringify(initialGeometry, null, 2),
          );
          assert(
            initialGeometry.widths.every((width) => width < 180),
            'Short names must not reserve the long-name cap',
          );
          const selection = await page.evaluate(() =>
            [
              document.querySelector('.sidebar-modes [aria-selected="true"]'),
              document.querySelector('.herdr-tab.selected'),
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
            'Sidebar and native tabs use the file-tab selection shape',
          );
          state.tabs[1].label = '长一些的会话名称';
          fixture.changed();
          await expect(tabs.nth(1)).toHaveText('长一些的会话名称');
          const namedGeometry = await tabGeometry(page);
          assert(
            namedGeometry.widths[1] > namedGeometry.widths[0],
            'Different name lengths produce different widths',
          );
          await page.screenshot({ path: path.join(output, viewport.name + '-content-width.png') });
          state.tabs[1].label = '原生 1';
          fixture.changed();
          await expect(tabs.nth(1)).toHaveText('原生 1');
          assert(
            initialGeometry.tabHeights.every((height) => height === (viewport.touch ? 44 : 26)),
            'Desktop tabs are compact; touch targets retain their height',
          );
          const wheel = await page.locator('.herdr-tab-list').evaluate((el) => {
            const overflow = el.scrollWidth > el.clientWidth + 1,
              before = el.scrollLeft;
            const allowed = el.dispatchEvent(
              new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
            );
            return { overflow, allowed, moved: el.scrollLeft > before };
          });
          assert.equal(
            wheel.allowed,
            !wheel.overflow,
            'Only a strip with actual overflow consumes the wheel',
          );
          if (wheel.overflow) assert(wheel.moved, 'Overflow wheel must scroll the strip');
          await tabs.nth(1).hover();
          const paint = await page.locator('.herdr-tab').evaluateAll((nodes) =>
            nodes.map((el) => {
              const shape = getComputedStyle(el),
                label = getComputedStyle(el.querySelector('.herdr-tab-label'));
              return {
                background: shape.backgroundColor,
                border: shape.borderTopWidth,
                color: label.color,
                weight: label.fontWeight,
              };
            }),
          );
          assert.deepEqual(
            { ...paint[0], weight: paint[1].weight },
            paint[1],
            'Selected and hovered tabs must share their neutral effect and text color',
          );
          assert(
            Number(paint[0].weight) > Number(paint[1].weight),
            'Only selected text must be bolder',
          );
          assert.deepEqual(
            (await tabGeometry(page)).widths,
            initialGeometry.widths,
            'Hover must not resize tabs',
          );
          await page.screenshot({ path: path.join(output, viewport.name + '-normal.png') });
          const first = await tabs.nth(0).elementHandle();
          fixture.changed();
          await expect.poll(() => first.evaluate((el) => el.isConnected)).toBe(true);
          await page.locator('#commandInput').fill('Tab A 草稿');
          await tabs.nth(1).click();
          await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
          await expect.poll(() => state.focusedPaneId).toBe('pane-claude');
          await tabs.nth(0).click();
          await expect(page.locator('#commandInput')).toHaveValue('Tab A 草稿');
          await page.locator('#commandInput').fill('');
          // Cached navigation stays usable while the live transport reconnects.
          fixture.disconnect(true);
          await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'offline');
          await expect(tabs.nth(1)).toBeEnabled();
          const offlineFocus = state.focusedPaneId;
          await tabs.nth(1).click();
          await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
          await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
          await expect(bar.getByRole('button', { name: '新建 Tab', exact: true })).toBeDisabled();
          await expect(page.locator('.herdr-tab-close').first()).toBeDisabled();
          await tabs.nth(1).focus();
          await page.keyboard.press('Home');
          await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
          assert.equal(
            state.focusedPaneId,
            offlineFocus,
            'Offline navigation must not change native focus',
          );
          fixture.disconnect(false);
          await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'connected', {
            timeout: 10000,
          });
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toBeVisible();
          await expect(bar).toBeVisible();
          await page.locator('#chatModeToggle').click();
          await tabs.nth(0).focus();
          await page.keyboard.press('ArrowRight');
          await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
          await page.keyboard.press('Home');
          await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
          await expect.poll(() => state.focusedPaneId).toBe('pane-codex');
          await page.waitForTimeout(150);
          state.focusedPaneId = 'pane-claude';
          state.tabs[1].label = 'Herdr 外部重命名';
          fixture.changed();
          await expect(tabs.nth(1)).toHaveText('Herdr 外部重命名');
          await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
          await tabs.nth(0).click();
          await expect(page.getByRole('region', { name: '会话状态', exact: true })).toBeVisible();
          assert.equal(
            state.focusedPaneId,
            'pane-claude',
            'Opening current-tab status is local and does not take native focus',
          );
          await page.keyboard.press('Escape');
          await tabs.nth(1).click({ button: 'right' });
          await page.getByRole('menuitem', { name: '重命名 Tab', exact: true }).click();
          await page.getByRole('textbox', { name: '名称', exact: true }).fill('改名后的原生 Tab');
          await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
          await expect(tabs.nth(1)).toHaveText('改名后的原生 Tab');
          await tabs.nth(1).click({ button: 'right' });
          await page.getByRole('menuitem', { name: '移动 Tab', exact: true }).click();
          await page.getByRole('menuitem', { name: '移到首位', exact: true }).click();
          await expect(tabs).toHaveText(['改名后的原生 Tab', '原生 0']);
          if (!viewport.touch) {
            await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
            await page.locator('.herdr-tab').nth(0).dragTo(page.locator('.herdr-tab').nth(1));
            await expect(tabs).toHaveText(['原生 0', '改名后的原生 Tab']);
          }
          await bar
            .getByRole('button', { name: '新建 Tab', exact: true })
            .click({ button: 'right' });
          await page.getByRole('menuitem', { name: '新建 Tab', exact: true }).click();
          await expect(page.getByRole('textbox', { name: 'Tab 名称', exact: true })).toHaveValue(
            'Codex',
          );
          await expect(page.getByRole('combobox', { name: '类型', exact: true })).toHaveValue(
            'codex',
          );
          await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
          assert(
            !state.herdrCalls.some((c) => c.method === 'tab.create' || c.method === 'agent.start'),
          );
          await bar.getByRole('button', { name: '新建 Tab', exact: true }).click();
          await expect(page.getByRole('combobox', { name: '类型', exact: true })).toHaveValue(
            'codex',
          );
          await expect(page.getByRole('textbox', { name: 'Tab 名称', exact: true })).toHaveValue(
            'Codex',
          );
          await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
          await expect(bar.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expect(page.locator('#chatLog')).toContainText('默认创建的新 Codex 会话');
          const start = state.herdrCalls.find((c) => c.method === 'agent.start');
          assert.equal(start.params.pane_id, 'new-1');
          assert.equal(start.params.kind, 'codex');
          assert.equal(state.sessions['new-1'].pane.terminalId, 'new-1-terminal');
          await bar.getByRole('button', { name: '关闭 Tab Codex', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
          await expect(bar.getByRole('tab', { name: 'Codex', exact: true })).toHaveCount(0);
          await bar.getByRole('button', { name: '新建 Tab', exact: true }).click();
          await page.getByRole('combobox', { name: '类型', exact: true }).selectOption('shell');
          await expect(page.getByRole('textbox', { name: 'Tab 名称', exact: true })).toHaveValue(
            'Shell',
          );
          await page.getByRole('textbox', { name: 'Tab 名称', exact: true }).fill('新建 Shell');
          await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
          await expect(bar.getByRole('tab', { name: '新建 Shell', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expect(page.locator('#shellTerminal')).toBeVisible();
          assert.equal(state.herdrCalls.filter((c) => c.method === 'agent.start').length, 1);
          const create = state.herdrCalls.find((c) => c.method === 'tab.create');
          assert.equal(create.params.workspace_id, 'workspace-fixture');
          assert(!Object.hasOwn(create.params, 'cwd'));
          assert.equal(create.params.focus, false);
          await bar.getByRole('button', { name: '关闭 Tab 新建 Shell', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
          await expect(bar.getByRole('tab', { name: '新建 Shell', exact: true })).toHaveCount(0);
          state.workspaces.push({
            workspaceId: 'empty-workspace',
            label: '空工作区',
            cwd: '/fixture/empty',
          });
          fixture.changed();
          await page.locator('#sidebarWorkspaces').click();
          await page.getByText('还没有会话', { exact: true }).click();
          await expect(tabs).toHaveCount(0);
          await expect(bar.getByRole('button', { name: '新建 Tab', exact: true })).toBeEnabled();
          await expect(page.locator('#chatModeToggle')).toBeHidden();
          await page.locator('#sidebarRecent').click();
          await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
          await expect(tabs).toHaveCount(2);
          await expect(page.locator('#chatLog')).toBeVisible();
          // Long labels and many native tabs must stay inside the header.
          state.tabs[0].label = '很长的原生标签页名称用于验证截断'.repeat(8);
          for (let i = 0; i < 30; i++)
            state.tabs.push({
              tab_id: 'empty-' + i,
              workspace_id: 'workspace-fixture',
              label: '额外 Tab ' + i,
              agent_status: 'idle',
            });
          fixture.changed();
          await expect(tabs).toHaveCount(32);
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
            .toBe(0);
          assert(
            await page.locator('.herdr-tab-list').evaluate((el) => el.scrollWidth > el.clientWidth),
            'Long lists must scroll within the header',
          );
          const fullGeometry = await tabGeometry(page);
          assertTabGeometry(fullGeometry);
          assert(
            Math.abs(fullGeometry.widths[0] - 180) < 0.1,
            'Long names stop at the file-tab cap',
          );
          assert(
            fullGeometry.widths.some((width) => width < 180),
            'Short names keep their natural width even in a full strip',
          );
          for (let i = 30; i < 50; i++)
            state.tabs.push({
              tab_id: 'empty-' + i,
              workspace_id: 'workspace-fixture',
              label: '额外 Tab ' + i,
              agent_status: 'idle',
            });
          fixture.changed();
          await expect(tabs).toHaveCount(52);
          const overflowGeometry = await tabGeometry(page);
          assertTabGeometry(overflowGeometry);
          assert.deepEqual(
            overflowGeometry.widths.slice(0, 32),
            fullGeometry.widths,
            'Adding tabs must not shrink existing labels',
          );
          assert.deepEqual(
            overflowGeometry.head,
            fullGeometry.head,
            'Overflow must not change header height',
          );
          const strip = page.locator('.herdr-tab-list');
          await strip.evaluate((el) => {
            el.scrollLeft = 0;
          });
          await page.locator('#commandInput').fill('滚轮浏览保留草稿');
          const selectedId = await bar
            .locator('[role="tab"][aria-selected="true"]')
            .getAttribute('id');
          const focused = state.focusedPaneId,
            callCount = state.herdrCalls.length;
          const reading = await page.locator('#chatLog').evaluate((el) => {
            el.scrollTop = 0;
            return el.scrollTop;
          });
          const stripBox = await strip.boundingBox();
          await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
          await page.mouse.wheel(0, 240);
          await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(240);
          await page.screenshot({ path: path.join(output, viewport.name + '-wheel.png') });
          await page.mouse.wheel(0, -120);
          await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(120);
          await page.mouse.wheel(80, 0);
          await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(200);
          const wheelModes = await strip.evaluate((el) => {
            const emit = (options) => {
              el.scrollLeft = 0;
              const accepted = el.dispatchEvent(
                new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options }),
              );
              return { accepted, left: el.scrollLeft };
            };
            const style = getComputedStyle(el),
              line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
            return {
              line: emit({ deltaY: 3, deltaMode: 1 }),
              linePixels: line * 3,
              page: emit({ deltaY: 1, deltaMode: 2 }),
              pagePixels: el.clientWidth,
              diagonal: emit({ deltaX: 60, deltaY: 20 }),
              shift: emit({ deltaY: 100, shiftKey: true }),
              zoom: emit({ deltaY: 100, ctrlKey: true }),
              end: emit({ deltaY: 1e6 }),
              max: el.scrollWidth - el.clientWidth,
            };
          });
          assert(
            !wheelModes.line.accepted && Math.abs(wheelModes.line.left - wheelModes.linePixels) < 1,
          );
          assert(!wheelModes.page.accepted && wheelModes.page.left === wheelModes.pagePixels);
          assert.equal(wheelModes.diagonal.left, 60);
          assert.equal(wheelModes.shift.left, 100);
          assert(wheelModes.zoom.accepted);
          assert.equal(wheelModes.zoom.left, 0);
          assert.equal(wheelModes.end.left, wheelModes.max);
          assert.equal(
            await bar.locator('[role="tab"][aria-selected="true"]').getAttribute('id'),
            selectedId,
          );
          assert.equal(state.focusedPaneId, focused);
          assert.equal(state.herdrCalls.length, callCount);
          await expect(page.locator('#commandInput')).toHaveValue('滚轮浏览保留草稿');
          assert.equal(await page.locator('#chatLog').evaluate((el) => el.scrollTop), reading);
          await fs.writeFile(
            path.join(output, viewport.name + '-wheel.json'),
            JSON.stringify({ ok: true, selectedId, focused, wheelModes }, null, 2),
          );
          await bar.dispatchEvent('wheel', {
            deltaX: 120,
            deltaY: 0,
            bubbles: true,
            cancelable: true,
          });
          await expect(page.locator('#chatView')).not.toHaveClass(/files-open/);
          const scrolled = await page.locator('.herdr-tab-list').evaluate((el) => {
            el.scrollLeft = el.scrollWidth;
            return el.scrollLeft;
          });
          const refreshed = page.waitForResponse(
            (r) => new URL(r.url()).pathname === '/api/snapshot',
          );
          fixture.changed();
          await refreshed;
          await page.waitForTimeout(100);
          assert.equal(
            await page.locator('.herdr-tab-list').evaluate((el) => el.scrollLeft),
            scrolled,
            'Snapshot refresh must not pull the tab strip back while reading',
          );
          // Let programmatic scroll settle before opening a menu (menus close on scroll).
          await tabs.nth(0).scrollIntoViewIfNeeded();
          await page.waitForTimeout(100);
          // Stale modal cannot act on a replacement runtime.
          await tabs.nth(0).click({ button: 'right' });
          await page.getByRole('menuitem', { name: '重命名 Tab', exact: true }).click();
          state.runtimeId = 'replacement-runtime';
          await page.getByRole('textbox', { name: '名称', exact: true }).fill('不能改名');
          const count = state.herdrCalls.filter((c) => c.method === 'tab.rename').length;
          await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
          await expect(page.locator('.herdr-operation-notice').first()).toContainText(
            '运行实例已经改变',
          );
          assert.equal(state.herdrCalls.filter((c) => c.method === 'tab.rename').length, count);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        results.push({ viewport, ok: true, tabs: wide, errors });
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, viewport.name + '-failure.png') })
          .catch(() => {});
        console.error(JSON.stringify({ viewport: viewport.name, calls: state.herdrCalls }));
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
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, results }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

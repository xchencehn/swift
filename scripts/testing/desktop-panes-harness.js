'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');

function model(fixture) {
  const state = fixture.state;
  let root = {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'pane-codex' },
      second: { type: 'pane', pane_id: 'pane-claude' },
    },
    serial = 0,
    zoomed = false;
  state.tabs = [{ tab_id: 'shared-tab', workspace_id: 'workspace-fixture', label: '开发' }];
  for (const session of Object.values(state.sessions))
    Object.assign(session.pane, { tabId: 'shared-tab', tab: '开发', tabTitle: '开发' });
  function sync() {
    const layout = {
      tab_id: 'shared-tab',
      workspace_id: 'workspace-fixture',
      focused_pane_id: state.focusedPaneId,
      zoomed,
      area: { x: 0, y: 0, width: 100, height: 100 },
      panes: [],
      splits: [],
    };
    const visit = (node, rect) => {
      if (node.type === 'pane') {
        layout.panes.push({ pane_id: node.pane_id, rect });
        return;
      }
      layout.splits.push({ direction: node.direction, ratio: node.ratio, rect });
      const horizontal = node.direction === 'right',
        axis = horizontal ? 'x' : 'y',
        size = horizontal ? 'width' : 'height';
      visit(node.first, { ...rect, [size]: rect[size] * node.ratio - 0.5 });
      visit(node.second, {
        ...rect,
        [axis]: rect[axis] + rect[size] * node.ratio,
        [size]: rect[size] * (1 - node.ratio),
      });
    };
    visit(root, layout.area);
    state.layouts = [layout];
    fixture.changed();
  }
  const replace = (node, id, callback) =>
    node.type === 'pane'
      ? node.pane_id === id
        ? callback(node)
        : node
      : {
          ...node,
          first: replace(node.first, id, callback),
          second: replace(node.second, id, callback),
        };
  function close(id) {
    const remove = (node) => {
      if (node.type === 'pane') return node.pane_id === id ? null : node;
      const first = remove(node.first),
        second = remove(node.second);
      return first && second ? { ...node, first, second } : first || second;
    };
    root = remove(root);
    delete state.sessions[id];
    if (state.focusedPaneId === id) state.focusedPaneId = Object.keys(state.sessions)[0];
    zoomed = false;
    sync();
  }
  state.herdrHandler = async (method, params) => {
    if (method === 'layout.export') return { layout: { root } };
    if (method === 'pane.split') {
      const id = `pane-created-${++serial}`,
        session = structuredClone(state.sessions['pane-claude']);
      Object.assign(session.pane, {
        paneId: id,
        terminalId: `terminal-${id}`,
        label: id,
        title: id,
      });
      session.pane.agent.session.value = `thread-${id}`;
      session.messages = [
        {
          id: `native-${id}`,
          role: 'assistant',
          blocks: [{ kind: 'text', text: `原生会话 ${id}` }],
        },
      ];
      session.queue = [];
      if (state.createShell) {
        session.pane.agent = null;
        session.messages = [];
      }
      state.sessions[id] = session;
      root = replace(root, params.target_pane_id, (leaf) => ({
        type: 'split',
        direction: params.direction,
        ratio: 0.5,
        first: leaf,
        second: { type: 'pane', pane_id: id },
      }));
      sync();
      return { pane: { pane_id: id, terminal_id: session.pane.terminalId } };
    }
    if (method === 'layout.set_split_ratio') {
      let node = root;
      for (const second of params.path) node = second ? node.second : node.first;
      node.ratio = params.ratio;
      sync();
      return {};
    }
    if (method === 'pane.zoom') {
      zoomed = !zoomed;
      state.focusedPaneId = params.pane_id;
      sync();
      return {};
    }
    if (method === 'pane.close') {
      close(params.pane_id);
      return {};
    }
    if (method === 'agent.start') {
      const session = state.sessions[params.pane_id];
      session.pane.agent = structuredClone(state.sessions['pane-claude'].pane.agent);
      session.pane.agent.name = params.name;
      session.pane.agent.session.value = `thread-${params.pane_id}`;
      session.messages = [
        {
          id: `started-${params.pane_id}`,
          role: 'assistant',
          blocks: [{ kind: 'text', text: 'Shell 启动后的 Agent 会话' }],
        },
      ];
      sync();
      return {};
    }
    return {};
  };
  sync();
  return {
    sync,
    close,
    focus(id) {
      state.focusedPaneId = id;
      sync();
    },
    root: () => root,
    vertical() {
      root.direction = 'down';
      sync();
    },
    rename(label) {
      state.tabs[0].label = label;
      for (const s of Object.values(state.sessions)) s.pane.tabTitle = s.pane.tab = label;
      sync();
    },
  };
}

async function run(browser, output) {
  const fixture = await createFixture(),
    native = model(fixture),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const frame = (id) => page.frameLocator(`.herdr-sibling-pane[data-pane-id="${id}"] > iframe`);
  const wrapper = (id) => page.locator(`.herdr-sibling-pane[data-pane-id="${id}"]`);
  const calls = (method) => (fixture.state.herdrCalls || []).filter((c) => c.method === method);
  try {
    await page.goto(fixture.url + '/?token=fixture');
    await expect(frame('pane-codex').locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await expect(frame('pane-claude').locator('#chatLog')).toContainText('claude 浏览器验收样例');
    await expect(page.locator('.herdr-sibling-pane')).toHaveCount(2);
    await expect(page.locator('.herdr-tabs')).toBeVisible();
    await expect(page.locator('.herdr-tabs [role=tab]')).toHaveCount(1);
    const bodyA = await frame('pane-codex').locator('.chat-msg').first().elementHandle(),
      bodyB = await frame('pane-claude').locator('.chat-msg').first().elementHandle();
    await frame('pane-codex')
      .locator('#chatLog')
      .dispatchEvent('contextmenu', { clientX: 90, clientY: 100, cancelable: true, bubbles: true });
    await expect(frame('pane-codex').locator('.context-menu')).toBeVisible();
    await frame('pane-claude')
      .locator('#chatLog')
      .dispatchEvent('contextmenu', { clientX: 90, clientY: 100, cancelable: true, bubbles: true });
    await expect(frame('pane-claude').locator('.context-menu')).toBeVisible();
    await expect(frame('pane-codex').locator('.context-menu')).toHaveCount(0);
    await frame('pane-claude').getByRole('menuitem', { name: '设置', exact: true }).click();
    await expect(page.locator('#settingsPage')).toBeVisible();
    await expect(frame('pane-claude').locator('.context-menu')).toHaveCount(0);
    await page.getByRole('button', { name: '返回会话', exact: true }).click();
    assert(await bodyA.evaluate((node) => node.isConnected));
    assert(await bodyB.evaluate((node) => node.isConnected));
    await frame('pane-codex').locator('#commandInput').fill('/status');
    await frame('pane-codex').locator('#commandInput').press('Enter');
    await expect(frame('pane-codex').locator('.native-command-panel')).toContainText(
      'Session: thread-codex',
    );
    assert(!fixture.state.requests.some((row) => row.route === 'POST /api/messages'));
    await frame('pane-codex').getByRole('button', { name: '结束命令交互', exact: true }).click();
    await frame('pane-codex').locator('#commandInput').fill('草稿 A');
    await frame('pane-claude').locator('#commandInput').fill('草稿 B');
    await expect(wrapper('pane-claude')).toHaveClass(/active/);
    await expect.poll(() => fixture.state.focusedPaneId).toBe('pane-claude');
    await frame('pane-codex').locator('#commandInput').fill('草稿 A 更新');
    await expect(wrapper('pane-codex')).toHaveClass(/active/);
    await expect.poll(() => fixture.state.focusedPaneId).toBe('pane-codex');
    assert(await bodyA.evaluate((node) => node.isConnected));
    assert(await bodyB.evaluate((node) => node.isConnected));
    const readingTop = await frame('pane-codex')
      .locator('#chatLog')
      .evaluate((el) => {
        el.scrollTop = 80;
        return el.scrollTop;
      });
    const views = fixture.state.requests.filter((r) => r.route === 'POST /api/panes/view').length;
    native.focus('pane-claude');
    await expect(wrapper('pane-claude')).toHaveClass(/active/);
    assert.equal(
      fixture.state.requests.filter((r) => r.route === 'POST /api/panes/view').length,
      views,
      'native focus must not echo a focus write',
    );
    assert.equal(
      await frame('pane-codex')
        .locator('#chatLog')
        .evaluate((el) => el.scrollTop),
      readingTop,
    );
    await expect(frame('pane-codex').locator('#commandInput')).toHaveValue('草稿 A 更新');
    await expect(frame('pane-claude').locator('#commandInput')).toHaveValue('草稿 B');
    await frame('pane-codex')
      .locator('#chatLog')
      .evaluate((el) => {
        el.tabIndex = 0;
        el.focus();
      });
    await expect.poll(() => fixture.state.focusedPaneId).toBe('pane-codex');
    assert(
      await frame('pane-codex')
        .locator('#chatLog')
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3),
      'entering an existing split Pane must open at bottom',
    );
    native.focus('pane-claude');
    await expect(wrapper('pane-claude')).toHaveClass(/active/);
    const beforeScrollViews = fixture.state.requests.filter(
      (r) => r.route === 'POST /api/panes/view',
    ).length;
    await frame('pane-codex').locator('#chatLog').press('PageUp');
    await frame('pane-codex').locator('#chatLog').hover();
    await page.mouse.wheel(0, -24);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(wrapper('pane-claude')).toHaveClass(/active/);
    assert.equal(
      fixture.state.requests.filter((r) => r.route === 'POST /api/panes/view').length,
      beforeScrollViews,
      'reading gestures must not focus the native pane',
    );
    // A page cannot forge another registered pane's selection.
    await page.evaluate(() =>
      window.postMessage(
        {
          type: 'swift.pane.activate',
          paneId: 'pane-codex',
          terminalId: 'terminal-codex',
          runtimeId: 'fixture-runtime',
          sessionId: 'thread-codex',
        },
        location.origin,
      ),
    );
    await frame('pane-codex')
      .locator('body')
      .evaluate(() =>
        parent.postMessage(
          {
            type: 'swift.pane.activate',
            paneId: 'pane-codex',
            terminalId: 'wrong-terminal',
            runtimeId: 'fixture-runtime',
            sessionId: 'thread-codex',
          },
          location.origin,
        ),
      );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(wrapper('pane-claude')).toHaveClass(/active/);
    await page.locator('#sidebarWorkspaces').click();
    await expect(page.locator('.herdr-tab-row[data-tab-id="shared-tab"]')).toContainText('开发');
    await expect(page.locator('.herdr-tab-pane')).toHaveCount(2);
    native.rename('实时改名');
    await expect(page.locator('.herdr-tab-row')).toContainText('实时改名');
    // A drag previews geometry immediately but sends only one native write on release.
    let separator = page.getByRole('separator', { name: '调整原生分屏比例' });
    let box = await separator.boundingBox();
    const widthBefore = (await wrapper('pane-codex').boundingBox()).width;
    await page.mouse.move(box.x + 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 52, box.y + 30);
    assert((await wrapper('pane-codex').boundingBox()).width > widthBefore + 20);
    assert.equal(calls('layout.set_split_ratio').length, 0);
    await page.mouse.up();
    await expect.poll(() => calls('layout.set_split_ratio').length).toBe(1);
    assert(native.root().ratio > 0.5);
    assert(await bodyA.evaluate((node) => node.isConnected));
    await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
    separator = page.getByRole('separator', { name: '调整原生分屏比例' });
    box = await separator.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 32, box.y + 30);
    await separator.dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.up();
    await expect(page.locator('body')).not.toHaveClass(/herdr-resizing-pane/);
    assert.equal(calls('layout.set_split_ratio').length, 1);
    // Swift split commands change the native model, then arrive through its snapshot.
    await frame('pane-claude').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-claude').locator('.popover-item').filter({ hasText: '向下分屏' }).click();
    await expect.poll(() => calls('pane.split').length).toBe(1);
    assert.equal(calls('pane.split')[0].params.target_pane_id, 'pane-claude');
    assert.equal(calls('pane.split')[0].params.focus, false);
    await expect(frame('pane-created-1').locator('#chatLog')).toContainText(
      '原生会话 pane-created-1',
    );
    await expect(page.locator('.herdr-sibling-pane')).toHaveCount(3);
    assert(await bodyB.evaluate((node) => node.isConnected));
    const nested = page.getByRole('separator', { name: '调整原生分屏比例' }).nth(1);
    await nested.focus();
    await nested.press('ArrowDown');
    await expect.poll(() => calls('layout.set_split_ratio').length).toBe(2);
    assert.deepEqual(calls('layout.set_split_ratio')[1].params.path, [true]);
    await page.screenshot({ path: path.join(output, 'desktop-three-panes.png') });
    await frame('pane-created-1').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-created-1')
      .locator('.popover-item')
      .filter({ hasText: '放大／还原 Pane' })
      .click();
    await expect(wrapper('pane-codex')).toBeHidden();
    await expect(wrapper('pane-claude')).toBeHidden();
    assert(await bodyA.evaluate((node) => node.isConnected));
    assert(await bodyB.evaluate((node) => node.isConnected));
    await frame('pane-created-1').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-created-1')
      .locator('.popover-item')
      .filter({ hasText: '放大／还原 Pane' })
      .click();
    await expect(wrapper('pane-codex')).toBeVisible();
    await frame('pane-created-1').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-created-1').locator('.popover-item').filter({ hasText: '关闭 Pane' }).click();
    await frame('pane-created-1').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(wrapper('pane-created-1')).toHaveCount(0);
    assert(await bodyA.evaluate((node) => node.isConnected));
    fixture.state.createShell = true;
    await frame('pane-claude').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-claude').locator('.popover-item').filter({ hasText: '向右分屏' }).click();
    await expect(frame('pane-created-2').locator('#shellTerminal')).toBeVisible();
    await expect(frame('pane-created-2').locator('#commandInput')).toBeHidden();
    await frame('pane-created-2').locator('#chatCurrentName').click({ button: 'right' });
    await frame('pane-created-2').locator('.popover-item').filter({ hasText: '更多操作' }).click();
    await frame('pane-created-2')
      .locator('.popover-item')
      .filter({ hasText: '启动 Agent' })
      .click();
    await frame('pane-created-2').locator('#chatDialog input').fill('claude');
    await frame('pane-created-2').locator('#chatDialogConfirm').click();
    await frame('pane-created-2').locator('#chatDialog input').fill('fixture-agent');
    await frame('pane-created-2').locator('#chatDialogConfirm').click();
    await expect(frame('pane-created-2').locator('#chatLog')).toContainText(
      'Shell 启动后的 Agent 会话',
    );
    assert.equal(calls('agent.start')[0].params.pane_id, 'pane-created-2');
    native.close('pane-created-2');
    await expect(wrapper('pane-created-2')).toHaveCount(0);
    native.vertical();
    await expect(page.getByRole('separator', { name: '调整原生分屏比例' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    );
    const a = await wrapper('pane-codex').boundingBox(),
      b = await wrapper('pane-claude').boundingBox();
    assert(b.y >= a.y + a.height - 1);
    await page.screenshot({ path: path.join(output, 'desktop-stacked-panes.png') });
    await page.reload();
    await expect(frame('pane-codex').locator('#commandInput')).toHaveValue('草稿 A 更新');
    await expect(frame('pane-claude').locator('#commandInput')).toHaveValue('草稿 B');
    await frame('pane-claude').locator('#chatFilesToggle').click();
    await expect(page.locator('#sessionFilesPage')).toBeVisible();
    assert(
      fixture.state.requests.some(
        (r) => r.route === 'GET /api/doc-files' && r.query.pane === 'pane-claude',
      ),
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('#sessionFilesPage')).toBeHidden();
    await frame('pane-claude').locator('#commandInput').fill('定向消息 B');
    await frame('pane-claude').locator('#sendButton').click();
    await expect
      .poll(() => fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length)
      .toBe(1);
    assert.equal(
      fixture.state.requests.find((r) => r.route === 'POST /api/messages').body.paneId,
      'pane-claude',
    );
    await expect(frame('pane-codex').locator('#commandInput')).toHaveValue('草稿 A 更新');
    fixture.disconnect(true);
    await expect(frame('pane-codex').locator('#appShell')).toHaveAttribute(
      'data-connection',
      'offline',
    );
    await expect(frame('pane-codex').locator('#sendButton')).toBeDisabled();
    fixture.disconnect(false);
    await expect(frame('pane-codex').locator('#appShell')).toHaveAttribute(
      'data-connection',
      'connected',
      { timeout: 12000 },
    );
    await expect(frame('pane-codex').locator('#commandInput')).toHaveValue('草稿 A 更新');
    native.close('pane-claude');
    await expect(page.locator('.herdr-sibling-pane')).toHaveCount(0);
    await expect(page.locator('#commandInput')).toHaveValue('草稿 A 更新');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'desktop-pane-sync.json'),
      JSON.stringify(
        {
          ok: true,
          persistentViews: true,
          independentDrafts: true,
          nativeFocusWithoutEcho: true,
          readingDoesNotFocusNative: true,
          horizontalVerticalNested: true,
          dragPreviewAndCancellation: true,
          zoomPreservesViews: true,
          accurateMessageTarget: true,
          reconnectPreservesDrafts: true,
          forgedMessagesRejected: true,
          shellStartsAgent: true,
          filesFollowSelectedPane: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await fixture.close();
  }
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    const fixture = await createFixture();
    model(fixture);
    const context = await browser.newContext({
        viewport,
        hasTouch: true,
        isMobile: viewport.width < 760,
        serviceWorkers: 'block',
      }),
      page = await context.newPage();
    try {
      await page.goto(fixture.url + '/?token=fixture');
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(page.locator('.herdr-sibling-pane')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Pane 操作', exact: true })).toBeHidden();
      assert.equal((fixture.state.herdrCalls || []).length, 0);
    } finally {
      await context.close();
      await fixture.close();
    }
  }
  return { desktopTabPaneSync: true, touchTabletAndPhoneSinglePane: true };
}
module.exports = { run, model };

'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(process.env.SWIFT_CONTEXT_OUTPUT || 'artifacts/context-creation');

async function run(browser, viewport) {
  const fixture = await createFixture(),
    state = fixture.state;
  state.productionPresentation = true;
  state.workspaces.push(
    { workspaceId: 'other', label: '另一个 Space', cwd: '/fixture/other' },
    { workspaceId: 'unknown', label: '目录由原生继承' },
  );
  Object.assign(state.sessions['pane-claude'].pane, {
    workspaceId: 'other',
    workspace: '另一个 Space',
    cwd: '/fixture/other/child',
  });
  state.tabs = Object.values(state.sessions).map((s) => ({
    tab_id: s.pane.tabId,
    workspace_id: s.pane.workspaceId,
    label: s.pane.title,
  }));
  const directories = new Map([
    ['workspace-fixture', '/fixture/project'],
    ['other', '/fixture/other'],
    ['unknown', '/fixture/native-directory'],
  ]);
  let serial = 0,
    failStart = false,
    replaceBeforeStart = false;
  state.herdrHandler = async (method, params) => {
    if (method === 'workspace.rename')
      state.workspaces.find((w) => w.workspaceId === params.workspace_id).label = params.label;
    if (method === 'tab.create') {
      const id = 'new-' + ++serial,
        session = structuredClone(state.sessions['pane-codex']);
      session.pane = {
        ...session.pane,
        paneId: id,
        terminalId: id + '-terminal',
        tabId: id + '-tab',
        workspaceId: params.workspace_id,
        workspace: state.workspaces.find((w) => w.workspaceId === params.workspace_id).label,
        cwd: directories.get(params.workspace_id),
        agent: null,
      };
      session.messages = [];
      state.sessions[id] = session;
      state.tabs.push({
        tab_id: session.pane.tabId,
        workspace_id: params.workspace_id,
        label: params.label,
      });
      if (replaceBeforeStart) state.runtimeId = 'replacement-runtime';
      return { root_pane: { pane_id: id, terminal_id: session.pane.terminalId } };
    }
    if (method === 'agent.start') {
      if (failStart) throw new Error('fixture Codex 启动失败');
      const session = state.sessions[params.pane_id];
      session.pane.agent = {
        id: params.name,
        name: params.name,
        label: 'codex',
        status: 'idle',
        session: { value: 'thread-' + params.pane_id },
      };
      session.messages = [
        { id: 'fresh', role: 'assistant', blocks: [{ kind: 'text', text: '全新 Codex 会话' }] },
      ];
      return { agent: session.pane.agent };
    }
    return {};
  };
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [],
    reads = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/api/herdr/action')) requests.push(request.postDataJSON());
  });
  page.setDefaultTimeout(8000);
  const menu = page.locator('.context-menu'),
    item = (name) => menu.getByRole('menuitem', { name, exact: true });
  const calls = (method) => (state.herdrCalls || []).filter((c) => c.method === method);
  const settled = () => expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
  const spaces = async () => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarWorkspaces').click();
  };
  const open = async (target) => {
    await settled();
    await target.click({ button: 'right' });
    await expect(menu).toBeVisible();
  };
  const capture = async (name) => {
    const box = await menu.boundingBox();
    assert(
      box.x >= 7 &&
        box.y >= 7 &&
        box.x + box.width <= viewport.width - 7 &&
        box.y + box.height <= viewport.height - 7,
    );
    await page.screenshot({ path: path.join(output, viewport.name + '-' + name + '.png') });
    return box;
  };
  try {
    await page.route('**/api/fs/list*', async (route) => {
      const requested =
        new URL(route.request().url()).searchParams.get('path') || '/fixture/workdir';
      reads.push(requested);
      await route.fulfill({
        json: {
          path: requested,
          crumbs: [],
          entries: [{ name: 'chosen', path: '/fixture/chosen', hidden: false }],
        },
      });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('原会话草稿');
    await spaces();
    const row = page.locator('#chatPickerList [data-pane-id="pane-claude"]');
    await open(row);
    await item('重命名 Tab').hover();
    await expect(row).toHaveClass(/context-menu-target/);
    state.sessions['pane-claude'].pane.label = '菜单目标刷新后仍保留';
    state.sessions['pane-claude'].pane.agent.name = 'refreshed-fixture';
    fixture.changed();
    await fixture.synced();
    await expect(row).toHaveAttribute('title', /refreshed-fixture/);
    await expect(row).toHaveClass(/context-menu-target/);
    await page.keyboard.press('Tab');
    assert(await menu.evaluate((el) => el.contains(document.activeElement)));
    const focusedBefore = state.focusedPaneId;
    await page.locator('#sidebarRecent').click();
    await expect(menu).not.toBeVisible();
    await expect(row).not.toHaveClass(/context-menu-target/);
    assert.equal(state.focusedPaneId, focusedBefore);
    await expect(page.locator('#sidebarWorkspaces')).toHaveAttribute('aria-selected', 'true');
    await open(row);
    const labels = await menu.getByRole('menuitem').allTextContents();
    assert.equal(labels.indexOf('新建 Codex'), labels.indexOf('新建 Tab') - 1);
    assert.equal(labels.indexOf('新建 Tab'), labels.indexOf('重命名 Tab') - 1);
    assert(!labels.some((label) => /Pane|分屏|交换|放大|还原|Tab 操作/.test(label)));
    const paneGeometry = await capture('tab-menu');
    assert.equal(
      state.focusedPaneId,
      'pane-codex',
      'Opening another Space menu must not select its Pane',
    );
    await item('新建 Tab').click();
    const type = page.getByRole('combobox', { name: '类型', exact: true });
    const tabName = page.getByRole('textbox', { name: 'Tab 名称', exact: true });
    await expect(type).toHaveValue('codex');
    await expect(tabName).toHaveValue('Codex');
    assert.deepEqual(await type.locator('option').allTextContents(), ['Codex', 'Shell']);
    await page.locator('#chatDialogCancel').click();
    assert.equal(calls('tab.create').length, 0);
    assert.equal(calls('agent.start').length, 0);
    await open(row);
    await item('新建 Tab').click();
    await type.selectOption('shell');
    await expect(tabName).toHaveValue('Shell');
    await type.selectOption('codex');
    await expect(tabName).toHaveValue('Codex');
    await tabName.fill('保留自定义名称');
    await type.selectOption('shell');
    await expect(tabName).toHaveValue('保留自定义名称');
    await type.selectOption('codex');
    await expect(tabName).toHaveValue('保留自定义名称');
    await tabName.fill('');
    await type.selectOption('shell');
    await expect(tabName).toHaveValue('Shell');
    await type.selectOption('codex');
    await expect(tabName).toHaveValue('Codex');
    await tabName.fill('   ');
    await page.locator('#chatDialogConfirm').click();
    await expect(page.locator('#chatDialogError')).toBeVisible();
    assert.equal(calls('tab.create').length, 0);
    await tabName.fill('Codex');
    await expect(page.locator('#chatDialogError')).toBeHidden();
    await tabName.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      isComposing: true,
    });
    await expect(page.locator('#chatDialog')).toBeVisible();
    assert.equal(calls('tab.create').length, 0);
    await expect(page.locator('#chatDialogConfirm')).toHaveText('创建');
    await page.screenshot({ path: path.join(output, viewport.name + '-new-tab-default.png') });
    await page.locator('#chatDialogConfirm').evaluate((button) => {
      button.click();
      button.click();
    });
    await expect.poll(() => calls('tab.create').length).toBe(1);
    await expect(page.locator('.context-menu-target')).toHaveCount(0);
    assert.deepEqual(calls('tab.create')[0].params, {
      workspace_id: 'other',
      label: 'Codex',
      focus: false,
    });
    await expect(page.locator('#chatDialog')).not.toBeVisible();
    await expect.poll(() => state.focusedPaneId).toBe('new-1');
    await expect(page.locator('#chatLog')).toContainText('全新 Codex 会话');
    assert.equal(calls('agent.start').length, 1);
    const defaultStart = requests.find((r) => r.action === 'agent.start');
    assert.deepEqual(defaultStart.expected, {
      runtimeId: 'fixture-runtime',
      paneId: 'new-1',
      terminalId: 'new-1-terminal',
      sessionId: '',
    });
    assert.deepEqual(Object.keys(defaultStart.params).sort(), ['kind', 'name', 'pane_id']);
    assert.equal(defaultStart.params.kind, 'codex');
    assert.equal(reads.length, 0);
    // Top Tabs and sidebar rows share the same type selector, including touch.
    await spaces();
    if (viewport.width > 760) await open(page.locator('.herdr-tabs [role="tab"]').first());
    else await open(page.locator('#chatPickerList [data-pane-id="new-1"]'));
    if (viewport.width > 760) {
      await item('新建 Tab').hover();
      await expect(page.locator('.herdr-tab.context-menu-target')).toHaveCount(1);
    }
    await item('新建 Tab').click();
    await expect(type).toHaveValue('codex');
    await expect(tabName).toHaveValue('Codex');
    await type.selectOption('shell');
    await expect(tabName).toHaveValue('Shell');
    await page.screenshot({ path: path.join(output, viewport.name + '-new-tab-shell.png') });
    await page.locator('#chatDialogConfirm').click();
    await expect.poll(() => calls('tab.create').length).toBe(2);
    assert.deepEqual(calls('tab.create')[1].params, {
      workspace_id: 'other',
      label: 'Shell',
      focus: false,
    });
    await expect.poll(() => state.focusedPaneId).toBe('new-2');
    await expect(page.locator('#shellTerminal')).toBeVisible();
    assert.equal(calls('agent.start').length, 1);
    await spaces();
    await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect(page.locator('#commandInput')).toHaveValue('原会话草稿');
    await spaces();
    const other = page.locator('[data-workspace-id="other"]');
    await open(other); // The entire directory row, including its blank area.
    await expect(item('新建 Space')).toBeVisible();
    await expect(item('重命名 Space')).toBeVisible();
    await item('重命名 Space').hover();
    await expect(other).toHaveClass(/context-menu-target/);
    const spaceGeometry = await capture('space-menu');
    await item('重命名 Space').click();
    await expect(page.locator('#chatDialogTitle')).toHaveText('重命名 Space');
    await page
      .getByRole('textbox', { name: 'Space 名称（不修改目录名）', exact: true })
      .fill('只改 Space 显示名');
    await page.locator('#chatDialogConfirm').click();
    await settled();
    await expect(other.locator('.chat-tree-name')).toHaveText('只改 Space 显示名');
    assert.deepEqual(calls('workspace.rename')[0].params, {
      workspace_id: 'other',
      label: '只改 Space 显示名',
    });
    assert.equal(state.workspaces.find((w) => w.workspaceId === 'other').cwd, '/fixture/other');
    assert.equal(reads.length, 0);
    await open(other);
    await item('重命名 Space').click();
    await page.locator('#chatDialogCancel').click();
    assert.equal(calls('workspace.rename').length, 1);
    // Keyboard entry on a directory uses the same menu.
    await other.locator('button').focus();
    await page.keyboard.press('Shift+F10');
    await expect(item('新建 Space')).toBeVisible();
    await item('新建 Space').click();
    await expect(page.locator('#chatDialogTitle')).toHaveText('选择已有启动目录');
    await page.locator('#chatDialogCancel').click();
    assert.equal(calls('workspace.create').length, 0);
    await open(other);
    await item('新建 Space').click();
    await page.locator('.chat-dir').filter({ hasText: 'chosen' }).click();
    await expect(page.locator('.chat-path')).toHaveText('/fixture/chosen');
    await page.locator('#chatDialogConfirm').click();
    await expect.poll(() => calls('workspace.create').length).toBe(1);
    assert.deepEqual(calls('workspace.create')[0].params, {
      label: 'chosen',
      cwd: '/fixture/chosen',
      focus: false,
    });
    // Keep the existing named creation workflow on Space menus, even without a public cwd.
    await open(page.locator('[data-workspace-id="unknown"]'));
    await item('新建 Tab').click();
    await type.selectOption('shell');
    await page.getByRole('textbox', { name: 'Tab 名称', exact: true }).fill('命名 Tab');
    await page.locator('#chatDialogConfirm').click();
    await expect.poll(() => calls('tab.create').length).toBe(3);
    assert.deepEqual(calls('tab.create')[2].params, {
      workspace_id: 'unknown',
      label: '命名 Tab',
      focus: false,
    });
    await expect.poll(() => state.focusedPaneId).toBe('new-3');
    await spaces();
    await open(page.locator('#chatPickerList [data-pane-id="new-3"]'));
    await item('新建 Tab').click();
    await expect(type).toHaveValue('codex');
    await expect(tabName).toHaveValue('Codex');
    await page.locator('#chatDialogConfirm').click();
    await expect.poll(() => calls('tab.create').length).toBe(4);
    assert.deepEqual(calls('tab.create')[3].params, {
      workspace_id: 'unknown',
      label: 'Codex',
      focus: false,
    });
    await expect.poll(() => state.focusedPaneId).toBe('new-4');
    assert.equal(calls('agent.start').length, 2);
    assert.equal(state.sessions['new-4'].pane.cwd, '/fixture/native-directory');
    // Codex creation is one locked operation, in the clicked row's Space.
    await spaces();
    await open(row);
    let releaseStart,
      starting = false;
    const startGate = new Promise((resolve) => (releaseStart = resolve));
    await page.route('**/api/herdr/action', async (route) => {
      if (route.request().postDataJSON().action === 'agent.start') {
        starting = true;
        await startGate;
      }
      await route.continue();
    });
    const codexItem = await item('新建 Codex').elementHandle();
    await codexItem.evaluate((button) => {
      button.click();
      button.click();
    });
    await expect.poll(() => starting).toBe(true);
    await expect(page.locator('body')).toHaveClass(/herdr-operation-pending/);
    await expect(page.locator('.herdr-operation-notice').first()).toContainText('正在新建 Codex');
    await expect(page.locator('#chatDialog')).not.toBeVisible();
    assert.equal(calls('tab.create').length, 5);
    // Navigation remains available while the native launch is pending. Its
    // eventual response must not take focus back from the user's new choice.
    await spaces();
    await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect.poll(() => state.focusedPaneId).toBe('pane-codex');
    releaseStart();
    await settled();
    await page.unroute('**/api/herdr/action');
    assert.equal(state.focusedPaneId, 'pane-codex');
    await expect(page.locator('#commandInput')).toHaveValue('原会话草稿');
    await spaces();
    await page.locator('#chatPickerList [data-pane-id="new-5"]').click();
    await expect.poll(() => state.focusedPaneId).toBe('new-5');
    await expect(page.locator('#chatLog')).toContainText('全新 Codex 会话');
    assert.deepEqual(calls('tab.create')[4].params, {
      workspace_id: 'other',
      label: 'Codex',
      focus: false,
    });
    const firstStart = calls('agent.start')[2];
    assert.equal(firstStart.params.pane_id, 'new-5');
    assert.equal(firstStart.params.kind, 'codex');
    assert.deepEqual(Object.keys(firstStart.params).sort(), ['kind', 'name', 'pane_id']);
    assert.match(firstStart.params.name, /^[a-z][a-z0-9_-]{0,31}$/);
    const startRequest = requests.find(
      (r) => r.action === 'agent.start' && r.params.pane_id === 'new-5',
    );
    assert.deepEqual(startRequest.expected, {
      runtimeId: 'fixture-runtime',
      paneId: 'new-5',
      terminalId: 'new-5-terminal',
      sessionId: '',
    });
    assert.equal(state.sessions['new-5'].pane.cwd, '/fixture/other');
    await page.screenshot({ path: path.join(output, viewport.name + '-new-codex.png') });
    // The Tab menu has the same action. A failed launch retains its new Shell.
    failStart = true;
    await spaces();
    if (viewport.width > 760) await open(page.locator('.herdr-tabs [role="tab"]').first());
    else await open(page.locator('#chatPickerList [data-pane-id="new-5"]'));
    await item('新建 Codex').click();
    await settled();
    await expect.poll(() => state.focusedPaneId).toBe('new-6');
    await expect(page.locator('#shellTerminal')).toBeVisible();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText(
      '新 Tab 已创建，Codex 启动结果未确认',
    );
    assert.equal(calls('tab.create').length, 6);
    assert.equal(calls('agent.start').length, 4);
    assert.notEqual(calls('agent.start')[3].params.name, firstStart.params.name);
    assert.equal(state.sessions['new-6'].pane.agent, null);
    // Clear a launch warning only after this exact terminal gains Codex.
    const creationRequests = () =>
      requests.filter((r) => r.action === 'tab.create' || r.action === 'agent.start').length;
    const recoveryWrites = creationRequests(),
      failedPane = state.sessions['new-6'].pane;
    const recoveredAgent = (id) => ({
      id,
      name: id,
      label: 'codex',
      status: 'idle',
      session: { value: 'thread-' + id },
    });
    state.sessions['new-2'].pane.agent = recoveredAgent('external-other-tab');
    fixture.changed();
    await fixture.synced();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText(
      '新 Tab 已创建，Codex 启动结果未确认',
    );
    failedPane.terminalId = 'replacement-terminal';
    failedPane.agent = recoveredAgent('external-replacement-terminal');
    fixture.changed();
    await fixture.synced();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText(
      '新 Tab 已创建，Codex 启动结果未确认',
    );
    failedPane.terminalId = 'new-6-terminal';
    state.runtimeId = 'replacement-runtime';
    fixture.changed();
    await fixture.synced();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText(
      '新 Tab 已创建，Codex 启动结果未确认',
    );
    failedPane.agent = null;
    state.runtimeId = 'fixture-runtime';
    fixture.changed();
    await fixture.synced();
    failedPane.agent = recoveredAgent('external-recovered-tab');
    state.sessions['new-6'].messages = [
      {
        id: 'external-recovery',
        role: 'assistant',
        blocks: [{ kind: 'text', text: '手动启动后的 Codex 会话' }],
      },
    ];
    fixture.changed();
    await fixture.synced();
    await expect(page.locator('.herdr-operation-notice').first()).toBeHidden();
    assert.equal(
      creationRequests(),
      recoveryWrites,
      'Snapshot recovery must not repeat creation or launch',
    );
    assert.equal(calls('tab.create').length, 6);
    assert.equal(calls('agent.start').length, 4);
    failStart = false;
    await spaces();
    await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect(page.locator('#commandInput')).toHaveValue('原会话草稿');
    assert.equal(state.sessions['pane-codex'].pane.agent.session.value, 'thread-codex');
    assert(!calls('pane.close').length && !calls('tab.close').length);
    // Replacing the runtime between creation and launch cannot start in it.
    replaceBeforeStart = true;
    await spaces();
    await open(row);
    await item('新建 Codex').click();
    await settled();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText('运行实例已经改变');
    assert.equal(calls('tab.create').length, 7);
    assert.equal(calls('agent.start').length, 4);
    replaceBeforeStart = false;
    state.runtimeId = 'fixture-runtime';
    fixture.changed();
    await fixture.synced();
    // A type dialog kept open across a runtime replacement cannot create in it.
    await spaces();
    await open(row);
    await item('新建 Tab').click();
    state.runtimeId = 'replacement-runtime';
    await page.locator('#chatDialogConfirm').click();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText('运行实例已经改变');
    assert.equal(calls('tab.create').length, 7);
    assert.equal(calls('agent.start').length, 4);
    state.runtimeId = 'fixture-runtime';
    fixture.changed();
    await fixture.synced();
    // A menu kept open across a runtime replacement must never mutate the replacement.
    await spaces();
    await open(row);
    state.runtimeId = 'replacement-runtime';
    fixture.changed();
    await fixture.synced();
    await item('新建 Tab').click();
    await expect(page.locator('.herdr-operation-notice').first()).toContainText('运行实例已经改变');
    await expect(page.locator('#chatDialog')).not.toBeVisible();
    assert.equal(calls('tab.create').length, 7);
    assert(requests.every((r) => r.expected.runtimeId === 'fixture-runtime'));
    await context.setOffline(true);
    fixture.disconnect(true);
    await expect(page.locator('#sendButton')).toBeDisabled();
    await open(other);
    await expect(item('新建 Space')).toBeDisabled();
    await expect(item('重命名 Space')).toBeDisabled();
    await page.keyboard.press('Escape');
    await open(row);
    await expect(item('新建 Tab')).toBeDisabled();
    await expect(item('新建 Codex')).toBeDisabled();
    assert.deepEqual(errors, []);
    return {
      viewport,
      paneGeometry,
      spaceGeometry,
      contextTargetRetained: true,
      refreshedTargetRetained: true,
      outsideDismissOnly: true,
      menuFocusContained: true,
      defaultCodexCreation: true,
      explicitShellCreation: true,
      automaticTypeName: true,
      customNamePreserved: true,
      blankNameRejected: true,
      compositionDoesNotSubmit: true,
      duplicateConfirmCreatesOnce: true,
      targetSpacePreserved: true,
      shellRow: true,
      draftPreserved: true,
      spaceRenameOnly: true,
      spaceCreation: true,
      keyboardMenu: true,
      cancelCreatesNothing: true,
      missingDirectoryInheritsNatively: true,
      staleRejected: true,
      offlineDisabled: true,
      freshCodexInTargetSpace: true,
      startBoundToCreatedTerminal: true,
      duplicateClickCreatesOnce: true,
      failedStartKeepsTab: true,
      externalCodexClearsMatchingWarning: true,
      warningBoundToRuntimeAndTerminal: true,
      recoveryDoesNotReplay: true,
      runtimeChangeBeforeStartRejected: true,
    };
  } finally {
    await context.close();
    await fixture.close();
  }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900, touch: false },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'small-phone', width: 320, height: 640, touch: true },
    ])
      results.push(await run(browser, viewport));
    await require('./context-menu-harness').run(browser, output);
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  const report = {
    ok: true,
    browser: 'firefox',
    touch: 'emulated contextmenu',
    before,
    after,
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

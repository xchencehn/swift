'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { SpaceActions } = require('../../lib/space-actions');
const output = path.resolve('artifacts/testing/agent-session-restart/browser');
async function run(browser, viewport) {
  const fixture = await createFixture(),
    state = fixture.state;
  state.productionPresentation = true;
  state.sessions['pane-codex'].pane.agent.label = 'codex';
  state.sessions['pane-claude'].pane.agent.label = 'claude';
  for (const [id, name] of [
    ['other-codex', '另一个 Codex'],
    ['fresh-codex', '尚未建档的 Codex'],
  ]) {
    const session = structuredClone(state.sessions['pane-codex']);
    Object.assign(session.pane, {
      paneId: id,
      terminalId: 'term-' + id,
      tabId: 'tab-' + id,
      tab: name,
      label: name,
    });
    session.pane.agent.name = id;
    session.pane.agent.session = id === 'fresh-codex' ? null : { value: 'session-' + id };
    state.sessions[id] = session;
  }
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [],
    posts = [],
    restarts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  let release,
    loseReply = true,
    previewMode = '',
    previewFailure = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new SpaceActions({
    herdr: {
      dashboard: async () => ({
        runtimeId: 'fixture-runtime',
        workspaces: state.workspaces,
        panes: Object.values(state.sessions).map((s) => s.pane),
      }),
    },
    exactPane: async (id) => ({
      ...structuredClone(state.sessions[id].pane),
      runtimeId: 'process-' + id,
    }),
    operate: (_id, work) => work(),
    restart: {
      restart: async (pane, { validate }) => {
        await validate();
        restarts.push(pane.paneId);
        await gate;
        return { message: '已恢复原会话，Goal 已继续运行。' };
      },
    },
  });
  const menu = page.locator('.context-menu'),
    dialog = page.locator('#chatDialog');
  const confirm = page.locator('#chatDialogConfirm'),
    cancel = page.locator('#chatDialogCancel');
  const openMenu = async (id = 'other-codex') => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarRecent').click();
    const row = page.locator(`#chatPickerList [data-pane-id="${id}"]`);
    if (viewport.touch) await row.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
    else await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
  };
  const open = async (id) => {
    await openMenu(id);
    await menu.getByRole('menuitem', { name: '重启会话', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const capture = async (name) => {
    const box = await dialog.boundingBox();
    assert(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `${viewport.name}-${name}.png`) });
  };
  try {
    await page.route('**/api/spaces/actions*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      try {
        if (req.method() === 'POST') {
          const body = req.postDataJSON();
          posts.push(body);
          const job = await controller.start(body, {});
          if (loseReply) {
            loseReply = false;
            return route.abort();
          }
          return route.fulfill({ status: 202, json: { ok: true, job } });
        }
        if (url.searchParams.has('requestId'))
          return route.fulfill({
            json: { ok: true, job: controller.get(url.searchParams.get('requestId')) },
          });
        if (previewFailure)
          return route.fulfill({
            status: 503,
            json: { message: '预览连接暂时中断，请稍后重试。' },
          });
        const preview = await controller.preview(
          url.searchParams.get('workspaceId'),
          url.searchParams.get('paneId'),
        );
        if (previewMode === 'session') preview.targets[0].sessionId = 'replaced';
        if (previewMode === 'terminal') preview.targets[0].terminalId = 'replaced';
        if (previewMode === 'runtime') preview.runtimeId = 'replaced';
        if (previewMode === 'unavailable') preview.targets[0].available = false;
        return route.fulfill({ json: { ok: true, ...preview } });
      } catch (error) {
        return route.fulfill({ status: error.status || 500, json: { message: error.message } });
      }
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('保留当前会话草稿');
    await open();
    await expect(dialog).toContainText('仅重启 另一个 Codex');
    await expect(dialog).toContainText('先退出当前 Codex，再 resume 原会话');
    await expect(confirm).toBeEnabled();
    assert.equal(posts.length, 0);
    await capture('confirm');
    await confirm.click();
    await expect(dialog).toContainText('正在退出并恢复原会话');
    assert.equal(posts.length, 1);
    assert.deepEqual(
      posts[0].targets.map((t) => t.paneId),
      ['other-codex'],
    );
    assert.equal(state.focusedPaneId, 'pane-codex');
    await cancel.click();
    await open('pane-codex');
    await expect(dialog).toContainText('其他操作仍在进行');
    await expect(confirm).toBeHidden();
    await cancel.click();
    await open();
    await expect(dialog).toContainText('正在退出并恢复原会话');
    await expect(confirm).toBeHidden();
    assert.equal(posts.length, 1);
    release();
    await expect(dialog).toContainText('原会话已恢复');
    await capture('result');
    await cancel.click();
    for (const mode of ['session', 'terminal', 'runtime', 'unavailable']) {
      previewMode = mode;
      await open();
      await expect(dialog).toContainText('暂时无法重启此会话');
      await expect(confirm).toBeHidden();
      await cancel.click();
    }
    previewMode = '';
    previewFailure = true;
    await open();
    await expect(dialog).toContainText('预览连接暂时中断');
    await expect(confirm).toBeHidden();
    await cancel.click();
    previewFailure = false;
    await open('fresh-codex');
    await expect(dialog).toContainText('尚未建立会话记录');
    await expect(confirm).toBeHidden();
    await capture('unavailable');
    await cancel.click();
    await openMenu('pane-claude');
    await expect(menu.getByRole('menuitem', { name: '重启会话', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await open();
    await expect(confirm).toBeEnabled();
    await cancel.click(); // Cancellation must not restart.
    assert.equal(posts.length, 1);
    assert.deepEqual(restarts, ['other-codex']);
    if (viewport.width < 761)
      await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect(page.locator('#commandInput')).toHaveValue('保留当前会话草稿');
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      nonSelectedTargetOnly: true,
      menuDirect: true,
      lostReplyNoReplay: true,
      reopenProgress: true,
      otherOperationBlocked: true,
      staleIdentityRejected: true,
      unavailableAndFreshRejected: true,
      draftsPreserved: true,
      errors,
    };
  } finally {
    release();
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
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  const report = {
    ok: true,
    before,
    after,
    browser: 'firefox',
    touch: 'emulated contextmenu',
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

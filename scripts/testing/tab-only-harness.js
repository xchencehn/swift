'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const output = path.resolve('artifacts/tab-only');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'phone-small', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture(),
        state = fixture.state;
      state.productionPresentation = true;
      state.sessions['pane-codex'].pane.agent.label = 'codex';
      state.sessions['pane-claude'].pane.agent.label = 'claude';
      state.workspaces.push({ workspaceId: 'other', label: '另一个 Space' });
      state.tabs = Object.values(state.sessions).map((s, i) => ({
        tab_id: s.pane.tabId,
        workspace_id: s.pane.workspaceId,
        label: '会话 ' + i,
      }));
      let serial = 0;
      state.herdrHandler = async (method, params) => {
        if (method === 'pane.move') {
          const session = state.sessions[params.pane_id],
            pane = session.pane;
          const id = 'moved-' + ++serial,
            tabId = id + '-tab';
          delete state.sessions[params.pane_id];
          state.sessions[id] = session;
          if (state.focusedPaneId === params.pane_id) state.focusedPaneId = id;
          Object.assign(pane, { paneId: id, tabId, workspaceId: params.destination.workspace_id });
          state.tabs.push({
            tab_id: tabId,
            workspace_id: pane.workspaceId,
            label: params.destination.label,
          });
          return { move_result: { pane: { pane_id: id, terminal_id: pane.terminalId } } };
        }
        if (method === 'tab.move') {
          const [tab] = state.tabs.splice(
            state.tabs.findIndex((t) => t.tab_id === params.tab_id),
            1,
          );
          const target = state.tabs.filter((t) => t.workspace_id === tab.workspace_id)[
            params.insert_index
          ];
          state.tabs.splice(target ? state.tabs.indexOf(target) : state.tabs.length, 0, tab);
        }
        if (method === 'tab.rename')
          state.tabs.find((t) => t.tab_id === params.tab_id).label = params.label;
        return {};
      };
      const context = await browser.newContext({
        viewport,
        hasTouch: !!viewport.touch,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(8000);
      page.on('pageerror', (e) => errors.push(e.message));
      const menu = page.locator('.context-menu'),
        item = (name) => menu.getByRole('menuitem', { name, exact: true });
      const showNavigation = async () => {
        if (
          viewport.width <= 760 &&
          !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
        )
          await page.locator('#chatDrawerToggle').click();
      };
      const openRow = async (id) => {
        await showNavigation();
        await page
          .locator('#chatPickerList [data-pane-id="' + id + '"]')
          .click({ button: 'right' });
        await expect(menu).toBeVisible();
      };
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('当前会话草稿');
        await openRow('pane-codex');
        const labels = await menu.getByRole('menuitem').allTextContents();
        assert.equal(labels[0], '重启会话');
        assert(labels.indexOf('新建 Codex') < labels.indexOf('新建 Tab'));
        assert(labels.indexOf('新建 Tab') < labels.indexOf('重命名 Tab'));
        assert.equal(labels.at(-1), '关闭 Tab');
        assert(!labels.some((label) => /Pane|分屏|交换|放大|还原|Tab 操作/.test(label)));
        const box = await menu.boundingBox();
        assert(
          box.x >= 7 &&
            box.y >= 7 &&
            box.x + box.width <= viewport.width - 7 &&
            box.y + box.height <= viewport.height - 7,
        );
        await page.screenshot({ path: path.join(output, viewport.name + '-menu.png') });
        await item('重命名 Tab').click();
        await page.getByRole('textbox', { name: '名称', exact: true }).fill('统一的 Tab 名称');
        await page.locator('#chatDialogConfirm').click();
        await expect.poll(() => state.tabs[0].label).toBe('统一的 Tab 名称');
        await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
        await openRow('pane-codex');
        await item('移动 Tab').click();
        await item('移到 另一个 Space').click();
        await expect
          .poll(
            () =>
              Object.values(state.sessions).find((s) => s.pane.terminalId === 'term-codex')?.pane
                .workspaceId,
          )
          .toBe('other');
        await expect(page.locator('#commandInput')).toHaveValue('当前会话草稿');
        const codex = Object.values(state.sessions).find(
          (s) => s.pane.agent?.label === 'codex',
        ).pane;
        // Recreate an old native split after a draft exists, then observe its migration.
        const claude = state.sessions['pane-claude'].pane;
        const idsBefore = [codex, claude].map((p) => [p.terminalId, p.agent.session.value]);
        claude.tabId = codex.tabId;
        claude.workspaceId = codex.workspaceId;
        fixture.changed();
        await expect
          .poll(() => (state.herdrCalls || []).filter((c) => c.method === 'pane.move').length)
          .toBe(2);
        await expect
          .poll(() => new Set(Object.values(state.sessions).map((s) => s.pane.tabId)).size)
          .toBe(2);
        await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
        assert.deepEqual(
          Object.values(state.sessions)
            .map((s) => [s.pane.terminalId, s.pane.agent.session.value])
            .sort(),
          idsBefore.sort(),
        );
        await expect(
          page.locator('.herdr-pane-frame, .herdr-split-resizer, .herdr-tab-pane'),
        ).toHaveCount(0);
        await expect(page.locator('.chat-conversation')).toBeVisible();
        await expect(page.locator('#commandInput')).toHaveValue('当前会话草稿');
        await showNavigation();
        await page.locator('#sidebarWorkspaces').click();
        await expect(page.locator('#chatPickerList .session-item')).toHaveCount(2);
        assert(!(await page.locator('#chatPickerList').innerText()).includes('panes'));
        await openRow(codex.paneId);
        await item('重命名 Tab').click();
        state.runtimeId = 'replacement';
        await page.getByRole('textbox', { name: '名称', exact: true }).fill('过期操作');
        await page.locator('#chatDialogConfirm').click();
        await expect(page.locator('.herdr-operation-notice').first()).toContainText(
          '运行实例已经改变',
        );
        assert.equal((state.herdrCalls || []).filter((c) => c.method === 'tab.rename').length, 1);
        await context.setOffline(true);
        fixture.disconnect(true);
        await expect(page.locator('#sendButton')).toBeDisabled();
        await openRow(codex.paneId);
        await expect(item('关闭 Tab')).toBeDisabled();
        await page.keyboard.press('Escape');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
        results.push({
          viewport,
          labels,
          oldSplitConverted: true,
          identitiesPreserved: true,
          draftPreserved: true,
          staleRejected: true,
          offline: true,
        });
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, viewport.name + '-failure.png') })
          .catch(() => {});
        throw error;
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, viewports: results.length }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

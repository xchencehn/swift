'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');

async function run(browser, output) {
  const results = [];
  for (const viewport of [
    { width: 1440, height: 1000, touch: false },
    { width: 1024, height: 768, touch: true },
    { width: 390, height: 844, touch: true },
  ]) {
    const fixture = await createFixture(),
      context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() =>
      window.addEventListener(
        'contextmenu',
        (event) => (window.contextDefaultPrevented = event.defaultPrevented),
      ),
    );
    const menu = page.locator('.context-menu');
    try {
      await page.goto(fixture.url + '/?token=fixture');
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await page.locator('#commandInput').fill('右键操作保留草稿');
      const message = await page.locator('.chat-msg').first().elementHandle();
      if (viewport.touch) {
        const selection = await message.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          const before = selection.toString();
          const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 90,
            clientY: 150,
          });
          node.dispatchEvent(event);
          return { before, after: selection.toString(), prevented: event.defaultPrevented };
        });
        assert(selection.before.length > 0);
        assert.equal(selection.after, selection.before);
        assert.equal(selection.prevented, false);
        await expect(menu).toHaveCount(0);
        for (const selector of ['#chatLog', '#chatStatus']) {
          await page.locator(selector).dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 80,
            clientY: 160,
          });
          await expect(menu).toHaveCount(0);
          assert.equal(await page.evaluate(() => window.contextDefaultPrevented), false);
        }
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.locator('#chatCurrentName').dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 35,
        });
        await expect(menu).toBeVisible();
        await menu.getByRole('menuitem', { name: '会话工具', exact: true }).click();
        await expect(
          menu.getByRole('menuitem', { name: '复制 Agent ID', exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: path.join(output, `${viewport.width}-context-menu.png`) });
        await page.keyboard.press('Escape');
        if (viewport.width < 761) await page.locator('#chatDrawerToggle').click();
        await page
          .locator('#chatPickerList [data-pane-id="pane-codex"]')
          .first()
          .click({ button: 'right' });
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
        await page.locator('#chatPickerList').dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 170,
        });
        await expect(menu).toHaveCount(0);
        assert.equal(await page.evaluate(() => window.contextDefaultPrevented), false);
        await expect(page.locator('#commandInput')).toHaveValue('右键操作保留草稿');
        assert(await message.evaluate((el) => el.isConnected));
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          blankMenu: false,
          agentNameMenu: true,
          nativeSelectionPreserved: true,
          selectionText: selection.before,
          preservedDraft: true,
        });
        continue;
      }
      const open = async (x = viewport.width - 15, y = viewport.height - 15) => {
        await page.locator('#chatLog').evaluate(
          (el, point) =>
            el.dispatchEvent(
              new MouseEvent('contextmenu', {
                clientX: point.x,
                clientY: point.y,
                cancelable: true,
                bubbles: true,
              }),
            ),
          { x, y },
        );
        await expect(menu).toBeVisible();
        assert(await page.evaluate(() => window.contextDefaultPrevented));
      };
      await open();
      await expect(menu.getByRole('menuitem', { name: '向右分屏', exact: true })).toHaveCount(0);
      const box = await menu.boundingBox();
      assert(
        box.x >= 7 &&
          box.y >= 7 &&
          box.x + box.width <= viewport.width - 7 &&
          box.y + box.height <= viewport.height - 7,
      );
      await page.screenshot({ path: path.join(output, `${viewport.width}-context-menu.png`) });
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await page.locator('#chatLog').evaluate((el) => {
        el.tabIndex = 0;
        el.focus();
      });
      await page.keyboard.press('Shift+F10');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await page.locator('#commandInput').dispatchEvent('contextmenu', {
        clientX: 200,
        clientY: 400,
        cancelable: true,
        bubbles: true,
      });
      assert.equal(await page.evaluate(() => window.contextDefaultPrevented), false);
      await expect(menu).toHaveCount(0);
      await open(100, 180);
      await page.locator('#chatLog').dispatchEvent('scroll');
      await expect(menu).toHaveCount(0);
      await open(100, 180);
      await page.evaluate(() => dispatchEvent(new Event('blur')));
      await expect(menu).toHaveCount(0);
      await open(100, 180);
      await menu.getByRole('menuitem', { name: '设置', exact: true }).click();
      await expect(page.locator('#settingsPage')).toBeVisible();
      await page.locator('#settingsPage').dispatchEvent('contextmenu', {
        clientX: 250,
        clientY: 250,
        cancelable: true,
        bubbles: true,
      });
      await expect(menu.getByRole('menuitem', { name: '向右分屏', exact: true })).toHaveCount(0);
      await menu.getByRole('menuitem', { name: '返回会话', exact: true }).click();
      await expect(page.locator('#settingsPage')).toBeHidden();
      await expect(page.locator('#commandInput')).toHaveValue('右键操作保留草稿');
      assert(await message.evaluate((el) => el.isConnected));
      if (viewport.width < 761) await page.locator('#chatDrawerToggle').click();
      const tabCalls = () =>
        fixture.state.herdrCalls?.filter((c) => c.method === 'tab.create') || [];
      const directories = [];
      await page.route('**/api/fs/list*', async (route) => {
        const requested =
          new URL(route.request().url()).searchParams.get('path') || '/fixture/workdir';
        directories.push(requested);
        await route.fulfill({
          json: {
            path: requested,
            crumbs: [],
            entries: [{ name: '选择的目录', path: '/fixture/chosen', hidden: false }],
          },
        });
      });
      fixture.state.workspaces.push(
        { workspaceId: 'workspace-other', label: '另一个 Space', cwd: '/fixture/other' },
        { workspaceId: 'workspace-no-cwd', label: '目录未知的 Space' },
      );
      fixture.changed();
      await page.locator('#sidebarWorkspaces').click();
      const newTab = async (target) => {
        await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
        await target.click({ button: 'right' });
        await menu.getByRole('menuitem', { name: '新建 Tab', exact: true }).click();
        await expect(page.locator('#chatDialogTitle')).toHaveText('新建 Tab');
        await page.getByRole('combobox', { name: '类型', exact: true }).selectOption('shell');
        await page.locator('#chatDialogBody input').fill('上下文 Tab');
      };
      const other = page.locator('[data-workspace-id="workspace-other"] .chat-tree-toggle');
      await expect(other).toBeVisible();
      await newTab(other);
      await page.locator('#chatDialogConfirm').click();
      await expect.poll(() => tabCalls().length).toBe(1);
      assert.equal(tabCalls()[0].params.workspace_id, 'workspace-other');
      assert(!Object.hasOwn(tabCalls()[0].params, 'cwd'));
      assert.equal(directories.length, 0);
      await expect(page.locator('#chatDialog')).not.toBeVisible();
      await newTab(other);
      await page.locator('#chatDialogCancel').click();
      assert.equal(tabCalls().length, 1);
      await newTab(page.locator('[data-workspace-id="workspace-no-cwd"] .chat-tree-toggle'));
      await page.locator('#chatDialogConfirm').click();
      await expect.poll(() => tabCalls().length).toBe(2);
      assert.equal(tabCalls()[1].params.workspace_id, 'workspace-no-cwd');
      assert(!Object.hasOwn(tabCalls()[1].params, 'cwd'));
      assert.equal(directories.length, 0);
      const workspaceCalls = () =>
        fixture.state.herdrCalls?.filter((c) => c.method === 'workspace.create') || [];
      const blank = async () => {
        await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
        await page.locator('#chatPickerList').dispatchEvent('contextmenu', {
          clientX: 180,
          clientY: 500,
          cancelable: true,
          bubbles: true,
        });
        await expect(menu.getByRole('menuitem', { name: '新建 Tab', exact: true })).toHaveCount(0);
        await menu.getByRole('menuitem', { name: '新建 Space', exact: true }).click();
        await expect(page.locator('#chatDialogTitle')).toHaveText('选择已有启动目录');
        await expect(page.locator('.chat-path')).toHaveText('/fixture/workdir');
      };
      await blank();
      await page.locator('#chatDialogCancel').click();
      assert.equal(workspaceCalls().length, 0);
      await blank();
      await page.locator('.chat-dir').filter({ hasText: '选择的目录' }).click();
      await expect(page.locator('.chat-path')).toHaveText('/fixture/chosen');
      await page.screenshot({ path: path.join(output, 'space-directory.png') });
      await page.locator('#chatDialogConfirm').click();
      await expect.poll(() => workspaceCalls().length).toBe(1);
      assert.deepEqual(workspaceCalls()[0].params, {
        cwd: '/fixture/chosen',
        label: 'chosen',
        focus: false,
      });
      assert.equal(tabCalls().length, 2);
      assert.deepEqual(directories, ['/fixture/workdir', '/fixture/workdir', '/fixture/chosen']);
      await other.click({ button: 'right' });
      await expect(menu.getByRole('menuitem', { name: '新建 Space', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await blank();
      fixture.state.runtimeId = 'replacement-runtime';
      await page.locator('#chatDialogConfirm').click();
      await expect(page.locator('.herdr-operation-notice').first()).toContainText(
        '运行实例已经改变',
      );
      assert.equal(workspaceCalls().length, 1);
      await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click({ button: 'right' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: '重命名 Tab', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      if (viewport.width < 761)
        await page.locator('#chatPickerScrim').click({ position: { x: 380, y: 100 } });
      await context.setOffline(true);
      fixture.disconnect(true);
      await expect(page.locator('#sendButton')).toBeDisabled();
      await open(100, 180);
      await expect(menu.getByRole('menuitem', { name: '重命名 Tab', exact: true })).toBeDisabled();
      await expect(menu.getByRole('menuitem', { name: '设置', exact: true })).toBeEnabled();
      assert.deepEqual(errors, []);
      results.push({
        viewport,
        blankMenu: true,
        keyboard: true,
        edgePlacement: true,
        preservedDraft: true,
        nativeEditing: true,
        offline: true,
        spaceTabInheritsDirectory: true,
        blankCreatesDirectorySpace: true,
        cancelCreatesNothing: true,
        missingDirectoryInheritsNatively: true,
        staleCreationRejected: true,
      });
    } finally {
      await page.close();
      await context.close();
      await fixture.close();
    }
  }
  fs.writeFileSync(
    path.join(output, 'context-menu.json'),
    JSON.stringify({ ok: true, results }, null, 2) + '\n',
  );
  return { contextMenus: true, viewports: results.length };
}
module.exports = { run };

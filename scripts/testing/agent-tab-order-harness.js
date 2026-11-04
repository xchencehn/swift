'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness'),
  { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/agent-tab-order/browser');
const baseline = process.argv.includes('--baseline');

(async () => {
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  await fs.mkdir(output, { recursive: true });
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'phone-small', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture(),
        state = fixture.state,
        errors = [];
      const context = await browser.newContext({
        viewport,
        hasTouch: !!viewport.touch,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      state.productionPresentation = true;
      Object.assign(state.sessions['pane-codex'].pane, {
        tabId: 'tab-0',
        tab: '编译检查',
        tabNumber: 1,
      });
      Object.assign(state.sessions['pane-claude'].pane, {
        tabId: 'tab-1',
        tab: '模型检查',
        tabNumber: 2,
      });
      function add(id, tabId, label, workspaceId = 'workspace-fixture', shell = false) {
        const session = structuredClone(state.sessions['pane-codex']);
        Object.assign(session.pane, {
          paneId: id,
          terminalId: 'terminal-' + id,
          tabId,
          tab: label,
          workspaceId,
          workspace: workspaceId === 'workspace-fixture' ? '浏览器验收' : '另一个 Space',
          tabNumber: 3,
        });
        if (shell) {
          session.pane.agent = null;
          session.messages = [];
        } else session.pane.agent.session.value = 'thread-' + id;
        state.sessions[id] = session;
      }
      add('pane-review', 'tab-2', '模型复核');
      add('pane-shell', 'tab-shell', 'Shell', undefined, true);
      add('pane-split', 'tab-split', '编译复核');
      add('pane-other-space', 'tab-other', '独立任务', 'space-other');
      state.workspaces.unshift({ workspaceId: 'space-other', label: '另一个 Space', number: 99 });
      state.tabs = [
        { tab_id: 'tab-other', workspace_id: 'space-other', label: '独立任务' },
        ...[
          ['tab-2', '模型复核'],
          ['tab-shell', 'Shell'],
          ['tab-0', '编译检查'],
          ['tab-split', '编译复核'],
          ['tab-1', '模型检查'],
          ['tab-empty', '空标签'],
        ].map(([tab_id, label]) => ({ tab_id, workspace_id: 'workspace-fixture', label })),
      ];
      state.herdrHandler = async (method, params) => {
        if (method === 'tab.move') {
          const [tab] = state.tabs.splice(
            state.tabs.findIndex((t) => t.tab_id === params.tab_id),
            1,
          );
          const members = state.tabs.filter((t) => t.workspace_id === tab.workspace_id);
          const target = members[params.insert_index];
          state.tabs.splice(target ? state.tabs.indexOf(target) : state.tabs.length, 0, tab);
        }
        return {};
      };
      const rows = page.locator('#chatPickerList [data-pane-id]');
      const ids = () => rows.evaluateAll((nodes) => nodes.map((n) => n.dataset.paneId));
      const expected = [
        'pane-other-space',
        'pane-review',
        'pane-codex',
        'pane-split',
        'pane-claude',
      ];
      async function check(order) {
        await expect.poll(ids).toEqual(order);
      }
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('排序不丢失草稿');
        const reading = await page.locator('#chatLog').evaluate((el) => {
          el.scrollTop = 0;
          return el.scrollTop;
        });
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        if (baseline) {
          results.push({ viewport, actual: await ids(), expected });
          await page.screenshot({ path: path.join(output, viewport.name + '-before.png') });
          continue;
        }
        await check(expected);
        const tabs = page.locator('.herdr-tab');
        if (viewport.width > 760)
          await expect(tabs.locator('[role="tab"]')).toHaveText([
            '模型复核',
            'Shell',
            '编译检查',
            '编译复核',
            '模型检查',
            '空标签',
          ]);
        // External native reordering must also update phones without a top Tab bar.
        const review = state.tabs.splice(1, 1)[0];
        state.tabs.push(review);
        fixture.changed();
        await check(['pane-other-space', 'pane-codex', 'pane-split', 'pane-claude', 'pane-review']);
        await page.locator('#chatSearchToggle').click();
        await page.locator('#chatPickerSearch').fill('模型');
        await check(['pane-claude', 'pane-review']);
        await page.locator('#chatSearchToggle').click();
        if (viewport.width > 760) {
          await page.locator('.herdr-tab[data-tab-id="tab-2"]').click({ button: 'right' });
          await page.getByRole('menuitem', { name: '移动 Tab', exact: true }).click();
          await page.getByRole('menuitem', { name: '移到首位', exact: true }).click();
          await check(expected);
          if (!viewport.touch) {
            await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
            await page
              .locator('.herdr-tab[data-tab-id="tab-2"]')
              .dragTo(page.locator('.herdr-tab[data-tab-id="tab-1"]'));
            await check([
              'pane-other-space',
              'pane-codex',
              'pane-split',
              'pane-claude',
              'pane-review',
            ]);
          }
        }
        // A newer Pane can arrive before its Tab metadata. Keep it visible and stable.
        add('pane-unlisted', 'tab-unlisted', '新会话');
        fixture.changed();
        await expect(rows.last()).toHaveAttribute('data-pane-id', 'pane-unlisted');
        assert.equal(state.focusedPaneId, 'pane-codex');
        await expect(page.locator('#commandInput')).toHaveValue('排序不丢失草稿');
        assert.equal(await page.locator('#chatLog').evaluate((el) => el.scrollTop), reading);
        await expect(page.locator('#chatPickerList [data-pane-id="pane-codex"]')).toHaveClass(
          /active/,
        );
        const finalOrder = await ids();
        await page.screenshot({ path: path.join(output, viewport.name + '-agents.png') });
        await page.locator('#sidebarWorkspaces').click();
        assert((await ids()).indexOf('pane-codex') < (await ids()).indexOf('pane-claude'));
        await page.locator('#sidebarRecent').click();
        await check(finalOrder);
        await page.reload();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await check(finalOrder);
        await expect(page.locator('#commandInput')).toHaveValue('排序不丢失草稿');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          initialOrder: expected,
          finalOrder,
          focusedPaneId: state.focusedPaneId,
          errors,
          ok: true,
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
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, baseline ? 'baseline.json' : 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(
    JSON.stringify({ ok: true, baseline, viewports: results.map((r) => r.viewport.name) }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

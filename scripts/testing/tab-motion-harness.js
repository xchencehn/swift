'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness'),
  { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_TAB_MOTION_OUTPUT || 'artifacts/testing/tab-drag-motion/browser',
);
const labels = [
  '查看 Wiki 待办事项',
  '4 core review',
  '审查 agent 优化',
  '审查 agent 性能优化',
  'jira 工单',
  'mojo multi core 合入',
];

(async () => {
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  await fs.mkdir(output, { recursive: true });
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const fixture = await createFixture(),
        state = fixture.state,
        errors = [];
      state.productionPresentation = true;
      state.tabs = labels.map((label, i) => ({
        tab_id: 'tab-' + i,
        workspace_id: 'workspace-fixture',
        label,
      }));
      Object.values(state.sessions).forEach((s, i) =>
        Object.assign(s.pane, { tabId: 'tab-' + i, tab: labels[i] }),
      );
      let rejectMove = false,
        delayMove = 0;
      state.herdrHandler = async (method, params) => {
        if (method !== 'tab.move') return {};
        if (rejectMove) throw new Error('fixture move rejected');
        if (delayMove) await new Promise((resolve) => setTimeout(resolve, delayMove));
        const [tab] = state.tabs.splice(
          state.tabs.findIndex((t) => t.tab_id === params.tab_id),
          1,
        );
        state.tabs.splice(params.insert_index, 0, tab);
        return {};
      };
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() =>
        addEventListener(
          'pointerdown',
          (e) => {
            window.lastMousePointerId = e.pointerId;
          },
          true,
        ),
      );
      const tabs = page.locator('.herdr-tab'),
        list = page.locator('.herdr-tab-list');
      const moves = () => (state.herdrCalls || []).filter((c) => c.method === 'tab.move');
      const ids = () => tabs.evaluateAll((ns) => ns.map((n) => n.dataset.tabId));
      const measure = () =>
        tabs.evaluateAll((ns) =>
          ns.map((n) => ({
            id: n.dataset.tabId,
            x: n.getBoundingClientRect().x,
            width: n.getBoundingClientRect().width,
            transform: getComputedStyle(n).transform,
            transition: getComputedStyle(n).transitionDuration,
            held: n.classList.contains('tab-drag-held'),
          })),
        );
      async function drag(from, to, fraction = 1) {
        const a = await tabs.nth(from).boundingBox(),
          b = await tabs.nth(to).boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + a.width / 2 + (b.x - a.x) * fraction, a.y + a.height / 2, {
          steps: 8,
        });
        await expect(list).toHaveClass(/tab-drag-active/);
      }
      async function settled() {
        await expect(list).not.toHaveClass(/tab-drag-active/);
        assert((await measure()).every((n) => n.transform === 'none'));
        await expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
      }
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(tabs).toHaveCount(6);
        await page.locator('#commandInput').fill('拖动保留草稿');
        const original = await ids(),
          geometry = await measure();
        const node = await tabs.nth(0).elementHandle();
        await page.screenshot({ path: path.join(output, reducedMotion + '-before.png') });
        await drag(0, 3, 0.92);
        await page.waitForTimeout(220);
        const moving = await measure();
        assert(
          Math.abs(moving[0].x - geometry[0].x - (geometry[3].x - geometry[0].x) * 0.92) < 2,
          'Held tab follows the pointer',
        );
        for (const index of [1, 2, 3])
          assert(
            Math.abs(moving[index].x - (geometry[index].x - geometry[0].width)) < 2,
            'Neighbours make room',
          );
        assert.equal(moving[0].transition, '0s');
        assert.equal(moving[1].transition, reducedMotion === 'reduce' ? '0s' : '0.18s');
        assert.equal(moves().length, 0);
        assert.deepEqual(await ids(), original);
        assert.equal(state.focusedPaneId, 'pane-codex');
        fixture.changed();
        await page.waitForTimeout(150);
        assert(await node.evaluate((n) => n.isConnected));
        await page.screenshot({ path: path.join(output, reducedMotion + '-drag.png') });
        // Capture actual frames while the neighbours reverse their displacement.
        await page.evaluate(() => {
          window.motionFrames = [];
          const until = performance.now() + 350;
          function sample(time) {
            window.motionFrames.push({
              time,
              x: document.querySelectorAll('.herdr-tab')[1].getBoundingClientRect().x,
            });
            if (time < until) requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
        const first = geometry[0];
        await page.mouse.move(first.x + first.width / 2 + 15, 16, { steps: 1 });
        await page.waitForTimeout(400);
        const frames = await page.evaluate(() => window.motionFrames);
        if (reducedMotion === 'no-preference')
          assert(
            frames.some((f) => f.x > geometry[0].x + 3 && f.x < geometry[1].x - 3),
            'Intermediate frames show a continuous transition',
          );
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await settled();
        assert.equal(moves().length, 0);
        await expect(page.locator('#commandInput')).toHaveValue('拖动保留草稿');
        // A slow native response must hold the preview without resubmitting or switching panes.
        delayMove = 250;
        await drag(0, 3);
        await page.mouse.up();
        await settled();
        delayMove = 0;
        assert.deepEqual(await ids(), ['tab-1', 'tab-2', 'tab-3', 'tab-0', 'tab-4', 'tab-5']);
        assert.equal(moves().length, 1);
        assert.equal(state.focusedPaneId, 'pane-codex');
        await expect(page.locator('#commandInput')).toHaveValue('拖动保留草稿');
        await drag(3, 0);
        await page.mouse.up();
        await settled();
        assert.deepEqual(await ids(), original);
        assert.equal(moves().length, 2);
        await page.screenshot({ path: path.join(output, reducedMotion + '-settled.png') });
        rejectMove = true;
        await drag(0, 2);
        await page.mouse.up();
        await settled();
        rejectMove = false;
        assert.deepEqual(await ids(), original);
        assert.equal(moves().length, 3);
        await expect(page.locator('.herdr-operation-notice').first()).toContainText(
          'fixture move rejected',
        );
        const count = moves().length;
        await drag(0, 1, 0.15);
        await page.mouse.up();
        await settled();
        assert.equal(moves().length, count);
        await drag(0, 2);
        await page.mouse.move(600, 250);
        await page.mouse.up();
        await settled();
        assert.equal(moves().length, count);

        for (const cancel of ['blur', 'pointercancel', 'resize', 'topology', 'runtime']) {
          await drag(0, 2);
          if (cancel === 'blur') await page.evaluate(() => dispatchEvent(new Event('blur')));
          if (cancel === 'pointercancel')
            await page.evaluate(() =>
              dispatchEvent(
                new PointerEvent('pointercancel', { pointerId: window.lastMousePointerId }),
              ),
            );
          if (cancel === 'resize') await page.setViewportSize({ width: 1420, height: 900 });
          if (cancel === 'topology') {
            state.tabs.push({
              tab_id: 'external',
              workspace_id: 'workspace-fixture',
              label: '原生新增',
            });
            fixture.changed();
          }
          if (cancel === 'runtime') {
            state.runtimeId = 'replacement-runtime';
            fixture.changed();
          }
          // Check actual cleanup before releasing the pointer.
          await expect(list).not.toHaveClass(/tab-drag-active/);
          await page.mouse.up();
          await settled();
          assert.equal(moves().length, count);
        }
        // A long strip scrolls as the pointer approaches either edge.
        for (let i = 0; i < 12; i++)
          state.tabs.push({
            tab_id: 'extra-' + i,
            workspace_id: 'workspace-fixture',
            label: '额外 Tab ' + i,
          });
        fixture.changed();
        await expect(tabs).toHaveCount(19);
        await list.evaluate((el) => {
          el.scrollLeft = 0;
        });
        await drag(0, 2);
        const box = await list.boundingBox();
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
        await page.waitForTimeout(600);
        const scrollRight = await list.evaluate((el) => el.scrollLeft);
        assert(scrollRight > 150);
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.waitForTimeout(450);
        assert((await list.evaluate((el) => el.scrollLeft)) < scrollRight - 100);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await settled();
        assert.equal(moves().length, count);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
        results.push({
          reducedMotion,
          ok: true,
          moves: count,
          geometry,
          moving,
          frames,
          scrollRight,
          errors,
        });
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, reducedMotion + '-failure.png') })
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
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, modes: results.map((r) => r.reducedMotion) }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

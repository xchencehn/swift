'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.join(root, 'artifacts/testing/sidebar-navigation-sync/final');
const ids = ['sidebarWorkspaces', 'sidebarRecent', 'sidebarHistory', 'sidebarFiles'];
const modes = ['workspace', 'recent', 'history', 'files'];
(async () => {
  const before = sourceFingerprint(root),
    results = [],
    browser = await firefox.launch();
  await fs.mkdir(output, { recursive: true });
  try {
    for (const width of [1440, 1024, 390, 320])
      for (const scale of [1, 1.5]) {
        const fixture = await createFixture({});
        fixture.state.productionPresentation = true;
        const context = await browser.newContext({
            viewport: { width, height: 900 },
            hasTouch: width !== 1440,
            serviceWorkers: 'block',
          }),
          page = await context.newPage();
        page.setDefaultTimeout(7000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const checks = [];
        const geometry = () =>
          page.locator('.sidebar-modes').evaluate((row) => {
            const item = row.querySelector('[aria-selected="true"]'),
              r = item.getBoundingClientRect(),
              box = row.getBoundingClientRect();
            return {
              selected: item.id,
              left: r.left - box.left,
              right: box.right - r.right,
              scrollLeft: row.scrollLeft,
              viewportWidth: row.clientWidth,
              itemWidth: r.width,
              mode: document.querySelector('#chatPickerList').dataset.mode,
              treeVisible: !document.querySelector('#workspaceFilesTree').hidden,
              mainScrollLeft: document.querySelector('.main-panel').scrollLeft,
              sidebarLeft: document.querySelector('#chatSidebar').getBoundingClientRect().left,
              gliders: row.querySelectorAll('.tab-glider').length,
            };
          });
        const check = async (index, label) => {
          console.log(width, scale, label);
          await expect(page.locator('#' + ids[index])).toHaveAttribute('aria-selected', 'true');
          await expect
            .poll(() =>
              page
                .locator('#chatSidebar')
                .evaluate((el) => Math.round(el.getBoundingClientRect().left)),
            )
            .toBe(0);
          const data = await geometry();
          assert(
            data.left >= -1 && data.right >= -1,
            `${width}/${scale}/${label}: clipped ${JSON.stringify(data)}`,
          );
          assert.equal(data.mainScrollLeft, 0, label);
          if (index === 3) await expect(page.locator('#workspaceFilesTree')).toBeVisible();
          else {
            await expect(page.locator('#chatPickerList')).toBeVisible();
            assert.equal(data.mode, modes[index], label);
          }
          checks.push({ label, ...data });
        };
        const open = async () => {
          if (width <= 760) await page.locator('#chatDrawerToggle').click();
          else if (
            await page
              .locator('#chatView')
              .evaluate((el) => el.classList.contains('sidebar-collapsed'))
          )
            await page.locator('#chatDrawerToggle').click();
          await expect
            .poll(() =>
              page
                .locator('#chatSidebar')
                .evaluate((el) => Math.round(el.getBoundingClientRect().left)),
            )
            .toBe(0);
        };
        const close = async () => {
          if (width <= 760)
            await page
              .locator('#chatPickerScrim')
              .click({ position: { x: width - 3, y: 400 }, force: true });
          else await page.locator('#chatSidebarCollapse').click();
        };
        const swipe = async (
          selector,
          direction,
          { short = false, cancel = false, ghost = false, hold = false } = {},
        ) => {
          const data = await page.locator(selector).evaluate(
            async (el, { direction, short, cancel, ghost, hold }) => {
              const row = document.querySelector('.sidebar-modes'),
                box = el.getBoundingClientRect(),
                list = document.querySelector('#chatSidebar').getBoundingClientRect(),
                x = box.left + box.width / 2,
                y = box.top + Math.min(box.height / 2, 70),
                dx = list.width * (short ? 0.2 : 0.65) * direction;
              const before = row.scrollLeft;
              const emit = (type, at) =>
                el.dispatchEvent(
                  Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
                    touches: ['touchend', 'touchcancel'].includes(type)
                      ? []
                      : [{ identifier: 7, target: el, clientX: at, clientY: y }],
                  }),
                );
              emit('touchstart', x);
              for (let n = 1; n <= 5; n++) {
                emit('touchmove', x + (dx * n) / 5);
                await new Promise((r) => setTimeout(r, 22));
              }
              const middle = {
                glider: !!row.querySelector('.tab-glider'),
                rowMoved: row.scrollLeft - before,
                transform: document.querySelector('#chatPickerList').style.transform,
              };
              window.finishNavigationSwipe = () => {
                emit(cancel ? 'touchcancel' : 'touchend', x + dx);
                if (ghost)
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              };
              await new Promise((r) => setTimeout(r, 110));
              if (!hold) window.finishNavigationSwipe();
              return middle;
            },
            { direction, short, cancel, ghost, hold },
          );
          if (!hold) await expect(page.locator('.tab-glider,.page-dragging')).toHaveCount(0);
          return data;
        };
        try {
          await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
          await expect(page.locator('#commandInput')).toBeVisible();
          await page.locator('#commandInput').fill('导航切换保留草稿');
          await open();
          await page.evaluate(
            (s) => document.documentElement.style.setProperty('--device-font-scale', s),
            scale,
          );
          // Reproduce the user's stale strip offset without altering content selection.
          await page.locator('.sidebar-modes').evaluate((el) => (el.scrollLeft = el.scrollWidth));
          await close();
          await open();
          await page.screenshot({
            path: path.join(output, `${width}-${scale}-reopened.png`),
            animations: 'disabled',
          });
          await check(0, 'reopen spaces');
          if (width === 1440) {
            await page.locator('#chatResizer').focus();
            for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowLeft');
            await check(0, 'narrow saved width');
            await page.locator('#chatResizer').press('Home');
          }
          for (const motion of ['no-preference', 'reduce']) {
            await page.emulateMedia({ reducedMotion: motion });
            for (let index = 1; index < 4; index++) {
              await page.locator('#' + ids[index]).click();
              await check(index, `${motion} click ${modes[index]}`);
            }
            await page.locator('#sidebarWorkspaces').click();
            await check(0, 'click spaces');
            if (await page.locator('#sidebarNavigationMore').isVisible()) {
              await page.locator('#sidebarNavigationMore').click();
              await check(3, 'overflow arrow selects files');
              await page.locator('#sidebarNavigationMore').click();
              await check(0, 'overflow arrow selects spaces');
            }
            const middle = await swipe('#sidebarWorkspaces', -1, { ghost: true });
            await check(1, `${motion} swipe header with trailing click`);
            if (motion === 'no-preference') {
              assert(middle.glider, 'Keep selection glider');
              assert.equal(middle.rowMoved, 0, 'Do not scroll header under the finger');
            }
            if (motion === 'no-preference') {
              await swipe('#sidebarRecent', -1, { short: true });
              await check(1, 'short gesture restores agent');
              await swipe('#sidebarRecent', -1, { cancel: true });
              await check(1, 'touchcancel restores agent');
            }
            await swipe('#chatPickerList', -1);
            await check(2, 'content swipe selects archive');
            await swipe('#chatPickerList', -1);
            await check(3, 'content swipe selects files');
            await close();
            await open();
            await check(0, `${motion} reopen from files`);
            await page.locator('#sidebarWorkspaces').focus();
            await page.keyboard.press('ArrowRight');
            await check(1, 'keyboard agent');
            await page.keyboard.press('ArrowLeft');
            await check(0, 'keyboard spaces');
            await swipe('#sidebarWorkspaces', -1);
            await page.locator('#sidebarRecent').focus();
            await page.keyboard.press('ArrowLeft');
            await check(0, 'keyboard after consumed swipe');
          }
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await swipe('#sidebarWorkspaces', -1, { hold: true });
          await page.screenshot({ path: path.join(output, `${width}-${scale}-dragging.png`) });
          await page.evaluate(() => window.finishNavigationSwipe());
          await swipe('#sidebarRecent', 1);
          await check(0, 'rapid reversal');
          await close();
          if (width <= 760) {
            await swipe('#chatLog', 1);
            await check(0, 'drag drawer open');
            await close();
          }
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toBeVisible();
          await open();
          await swipe('#sidebarWorkspaces', -1);
          await check(1, 'sidebar swipe while terminal shown');
          await close();
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#commandInput')).toHaveValue('导航切换保留草稿');
          await open();
          await check(0, 'return from terminal');
          await page.locator('#sidebarFiles').click();
          await page.setViewportSize({ width: Math.max(320, width - 40), height: 800 });
          await check(3, 'resize preserves selected label');
          await page.screenshot({ path: path.join(output, `${width}-${scale}-files.png`) });
          assert.deepEqual(errors, []);
          assert(!fixture.state.requests.some((x) => x.route === 'POST /api/messages'));
          results.push({ width, scale, checks, errors });
        } catch (error) {
          await page.screenshot({ path: path.join(output, `${width}-${scale}-failure.png`) });
          await fs.writeFile(
            path.join(output, 'failure.json'),
            JSON.stringify({ width, scale, checks, current: await geometry(), errors }, null, 2),
          );
          throw error;
        } finally {
          await context.close();
          await fixture.close();
        }
      }
    const after = sourceFingerprint(root);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ ok: true, before, after, results }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, combinations: results.length }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run(page, { expect, viewport, output }) {
  const modes = ['sidebarWorkspaces', 'sidebarRecent', 'sidebarHistory', 'sidebarFiles'];
  const selected = (id) => expect(page.locator('#' + id)).toHaveAttribute('aria-selected', 'true');
  const surface = () => page.locator('#workspaceFilesTree:visible, #chatPickerList:visible');
  const draft = await page.locator('#commandInput').inputValue();
  const treeBody = page.locator('.workspace-tree-body');
  const checks = {};
  async function gesture(right, { short = false, edge = false, finish = true } = {}) {
    const result = await surface().evaluate(
      async (el, { right, short, edge, finish }) => {
        const box = el.getBoundingClientRect(),
          x = box.left + box.width * (right ? 0.15 : 0.85),
          y = box.top + 85;
        const target = document.elementFromPoint(x, y) || el;
        const emit = (type, at) =>
          target.dispatchEvent(
            Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
              touches:
                type === 'touchend' ? [] : [{ identifier: 9, target, clientX: at, clientY: y }],
            }),
          );
        const dx = box.width * (short ? 0.23 : edge ? 0.85 : 0.65) * (right ? 1 : -1);
        emit('touchstart', x);
        for (let step = 1; step <= 8; step++) {
          emit('touchmove', x + (dx * step) / 8);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 110));
        window.__filesSwipeEnd = () => emit('touchend', x + dx);
        if (finish) window.__filesSwipeEnd();
        return {
          connected: target.isConnected,
          width: box.width,
          animated: !matchMedia('(prefers-reduced-motion: reduce)').matches,
        };
      },
      { right, short, edge, finish },
    );
    if (result.animated)
      assert(result.connected, 'The original touch target must stay in the document');
    if (finish) await expect(page.locator('.tab-glider')).toHaveCount(0);
    return result;
  }
  async function visibleLabel() {
    const box = await page.locator('#sidebarFiles').evaluate((el) => {
      const item = el.getBoundingClientRect(),
        parent = el.parentElement.getBoundingClientRect();
      return { left: item.left - parent.left, right: parent.right - item.right };
    });
    assert(
      box.left >= -1 && box.right >= -1,
      'Selected files label must be visible: ' + JSON.stringify(box),
    );
  }
  for (const motion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion: motion });
    await page.locator('#sidebarWorkspaces').click();
    for (let index = 1; index < modes.length; index++) {
      await gesture(false);
      await selected(modes[index]);
    }
    await expect(page.locator('#workspaceFilesTree')).toBeVisible();
    await visibleLabel();
    await expect(page.locator('[data-tree-path$="/knowledge"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await treeBody.evaluate((el) => {
      el.scrollTop = 120;
      el.dispatchEvent(new Event('scroll'));
    });
    const top = await treeBody.evaluate((el) => el.scrollTop);
    assert(top > 0, 'Fixture must actually scroll');
    await gesture(true);
    await selected('sidebarHistory');
    if (motion === 'no-preference') {
      await gesture(false, { finish: false });
      await expect(page.locator('.tab-glider')).toHaveCount(1);
      const geometry = await page.locator('#workspaceFilesTree').evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        transform: el.style.transform,
        duplicateIds: document.querySelectorAll('#workspaceFilesTree').length,
      }));
      assert(
        geometry.width > 100 && geometry.transform.includes('translateX'),
        JSON.stringify(geometry),
      );
      assert.equal(geometry.duplicateIds, 1);
      await page.screenshot({ path: path.join(output, viewport.name + '-files-swipe.png') });
      await page.evaluate(() => window.__filesSwipeEnd());
      await expect(page.locator('.tab-glider')).toHaveCount(0);
      await selected('sidebarFiles');
      await gesture(true, { short: true });
      await selected('sidebarFiles');
    } else {
      await gesture(false);
      await selected('sidebarFiles');
    }
    await expect.poll(() => treeBody.evaluate((el) => el.scrollTop)).toBe(top);
    await visibleLabel();
    await surface().evaluate((el) => {
      const target = el.querySelector('.workspace-tree-row') || el;
      const emit = (type, dy) =>
        target.dispatchEvent(
          Object.assign(new Event(type, { bubbles: true }), {
            touches: type === 'touchend' ? [] : [{ clientX: 90, clientY: 160 + dy, target }],
          }),
        );
      emit('touchstart', 0);
      emit('touchmove', 100);
      emit('touchend', 100);
    });
    await selected('sidebarFiles');
    const bounds = await treeBody.boundingBox(),
      beforeWheel = await treeBody.evaluate((el) => el.scrollTop);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 80);
    await expect.poll(() => treeBody.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeWheel);
    await selected('sidebarFiles');
    await gesture(false, { edge: true });
    await expect
      .poll(() =>
        page
          .locator('#chatView')
          .evaluate(
            (el) =>
              el.classList.contains('sidebar-collapsed') ||
              (!document.querySelector('#chatSidebar').classList.contains('open') &&
                innerWidth <= 760),
          ),
      )
      .toBe(true);
    await expect(page.locator('.page-dragging, .tab-gliding')).toHaveCount(0);
    await page.locator('#chatDrawerToggle').click();
    await selected('sidebarWorkspaces');
    await page.locator('#sidebarFiles').click();
    await selected('sidebarFiles');
    await expect.poll(() => treeBody.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(top);
    for (let index = modes.length - 2; index >= 0; index--) {
      await gesture(true);
      await selected(modes[index]);
    }
    await gesture(true);
    await selected('sidebarWorkspaces');
    checks[motion] = true;
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#sidebarHistory').click();
  await surface().dispatchEvent('wheel', { deltaX: 100, deltaY: 0 });
  await selected('sidebarFiles');
  await visibleLabel();
  await page.waitForTimeout(450);
  await treeBody.dispatchEvent('wheel', { deltaX: -100, deltaY: 0 });
  await selected('sidebarHistory');
  await page.locator('#sidebarFiles').click();
  await expect(page.locator('#commandInput')).toHaveValue(draft);
  await expect(page.locator('[data-tree-path$="/knowledge"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  checks.wheel = true;
  checks.treeState = true;
  checks.draft = true;
  await fs.writeFile(
    path.join(output, viewport.name + '-sidebar-swipes.json'),
    JSON.stringify(checks, null, 2) + '\n',
  );
  return checks;
}
module.exports = { run };

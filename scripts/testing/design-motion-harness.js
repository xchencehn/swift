'use strict';
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
(async () => {
  const fixture = await createFixture(),
    browser = await firefox.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(fixture.url + '/?token=fixture&view=chat');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarRecent').click();
    await page.locator('#chatPickerList').evaluate(async (el) => {
      const target = el.firstElementChild || el,
        rect = el.getBoundingClientRect(),
        y = rect.top + 50;
      const touch = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
      target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(250)] }));
      target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(70)] }));
      target.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [] }));
    });
    await expect(page.locator('#sidebarRecent')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.tab-glider')).toHaveCount(0);
    const checks = [];
    for (const reduced of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion: reduced });
      checks.push(
        await page.evaluate(async (reduced) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const host = document.createElement('div');
          host.style.cssText =
            'position:fixed;top:100px;left:0;width:300px;height:300px;background:var(--bg)';
          const row = document.createElement('div');
          row.innerHTML = '<button>A</button><button>B</button><button>C</button>';
          const list = document.createElement('div');
          list.style.cssText = 'width:300px;height:200px';
          list.textContent = 'original';
          host.append(row, list);
          document.body.append(host);
          let selected = 0,
            late;
          const select = (index) => {
            selected = index;
            list.textContent = 'page ' + index;
            return index === 1
              ? new Promise((r) => {
                  late = r;
                })
              : undefined;
          };
          const options = {
            list,
            tabs: [...row.children],
            from: 0,
            to: 1,
            offset: -20,
            at: 10,
            downAt: 0,
            select,
          };
          const first = StudioTabDrag.start(options);
          first.end(200);
          await Promise.resolve(); // Roll back before paint while history is still pending.
          if (selected !== 0) throw new Error('Rollback waited for history');
          const second = StudioTabDrag.start({ ...options, from: 0, to: 2, offset: -250 });
          second.end(200);
          late?.();
          await wait(350);
          if (selected !== 2 || row.querySelector('.tab-glider') || list.style.transform)
            throw new Error('Stale tab settlement overwrote current selection');
          const sidebar = document.createElement('div'),
            scrim = document.createElement('div');
          sidebar.style.cssText = 'width:300px;height:200px';
          host.append(sidebar, scrim);
          let open = false;
          const setOpen = (_, value) => {
            open = value;
            sidebar.dataset.open = String(value);
          };
          const opening = StudioPageDrag.start({
            kind: 'open-sidebar',
            dx: 210,
            at: 20,
            downAt: 0,
            sidebar,
            scrim,
            setOpen,
          });
          opening.end(200);
          await wait(25);
          const closing = StudioPageDrag.start({
            kind: 'close-sidebar',
            dx: -220,
            at: 30,
            downAt: 0,
            sidebar,
            scrim,
            setOpen,
          });
          closing.end(200);
          await wait(350);
          if (open || sidebar.style.transform || sidebar.style.transition)
            throw new Error('Stale page settlement or inline transform');
          const cancelled = StudioPageDrag.start({
            kind: 'open-sidebar',
            dx: 200,
            at: 20,
            downAt: 0,
            sidebar,
            scrim,
            setOpen,
          });
          cancelled.cancel();
          if (open || sidebar.style.transform) throw new Error('Cancelled page committed');
          if (reduced === 'reduce') {
            const immediate = StudioTabDrag.start(options);
            immediate.end(200);
            if (row.querySelector('.tab-glider'))
              throw new Error('Reduced motion still waits for a timer');
            late?.();
          }
          host.remove();
          return {
            reduced,
            delayedHistory: true,
            reversal: true,
            cancel: true,
            staleCallbacks: false,
          };
        }, reduced),
      );
    }
    assert.deepEqual(errors, []);
    const out = path.resolve(process.env.SWIFT_DESIGN_OUTPUT || 'artifacts/design-system');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, 'motion.json'),
      JSON.stringify({ checks, touchCancelRestoredSelection: true, errors }, null, 2),
    );
    console.log(
      'PASS motion: touch cancellation, rapid reversal, delayed history, cleanup and reduced motion',
    );
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

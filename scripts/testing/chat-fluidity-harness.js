'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline');
const output = path.resolve('artifacts/testing/chat-fluidity', baseline ? 'before' : 'browser');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [],
    sources = sourceFingerprint(process.cwd());
  try {
    for (const width of [1440, 1024, 390, 320]) {
      const fixture = await createFixture();
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width <= 1024,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [],
        result = { width };
      page.on('pageerror', (e) => errors.push(e.message));
      const select = async (name) => {
        if (
          width <= 760 &&
          !(await page.locator('#chatSidebar').evaluate((e) => e.classList.contains('open')))
        )
          await page.locator('#chatDrawerToggle').click();
        await page.locator(`#chatPickerList [data-pane-id="pane-${name}"]`).first().click();
        await expect(page.locator('#chatLog')).toHaveAttribute('data-pane-id', 'pane-' + name);
        await expect(page.locator('#chatLog')).toContainText(name + ' 浏览器验收样例');
      };
      try {
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        const log = page.locator('#chatLog');
        await expect(log).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('阅读位置与草稿一起保留');
        await log.evaluate((el) => {
          el.scrollTop = 340;
          el.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(220);
        const position = () =>
          log.evaluate((el) => {
            const top = el.getBoundingClientRect().top;
            const node = [...el.querySelectorAll('.chat-msg')].find(
              (n) => n.getBoundingClientRect().bottom > top + 2,
            );
            return {
              id: node.dataset.messageId,
              offset: node.getBoundingClientRect().top - top,
              top: el.scrollTop,
            };
          });
        const before = await position();
        await select('claude');
        await select('codex');
        const after = await position();
        result.returnPosition = { before, after };
        if (!baseline) {
          assert.equal(after.id, before.id);
          assert(Math.abs(after.offset - before.offset) <= 2);
        }
        await expect(page.locator('#commandInput')).toHaveValue('阅读位置与草稿一起保留');
        // Same stable anchor after a message above it is replaced with taller content.
        await log.evaluate((el) => {
          el.scrollTop = 340;
          el.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(220);
        const anchor = await position();
        fixture.state.sessions['pane-codex'].messages[0].blocks = [
          { kind: 'text', text: '上方内容增长\n\n'.repeat(16) },
        ];
        fixture.changed();
        await expect(log).toContainText('上方内容增长');
        await page.waitForTimeout(250);
        const grown = await position();
        result.growth = { before: anchor, after: grown };
        if (!baseline) {
          assert.equal(grown.id, anchor.id);
          assert(Math.abs(grown.offset - anchor.offset) <= 2);
        }
        // Native scrolling and automatic following are exercised on an isolated real DOM.
        result.gestures = await page.evaluate(async () => {
          const log = document.createElement('div');
          log.style.cssText =
            'position:fixed;top:0;left:0;width:240px;height:200px;overflow:auto;background:var(--bg)';
          log.innerHTML = '<div style="height:800px"></div>';
          document.body.append(log);
          const scroll = window.StudioChatScroll.create(log),
            content = log.firstChild,
            values = {};
          const frame = () =>
            new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          for (const [name, options] of [
            ['horizontal', { deltaX: 60, deltaY: 1 }],
            ['zoom', { deltaY: 40, ctrlKey: true }],
            ['vertical', { deltaY: -60 }],
          ]) {
            scroll.enterLatest();
            await frame();
            log.dispatchEvent(new WheelEvent('wheel', options));
            const before = scroll.capture();
            content.style.height = content.offsetHeight + 80 + 'px';
            scroll.restore(before);
            await frame();
            values[name] = log.scrollHeight - log.scrollTop - log.clientHeight;
          }
          scroll.enterLatest();
          await frame();
          const button = document.createElement('button');
          button.style.cssText = 'position:absolute;top:0';
          log.append(button);
          scroll.enterLatest();
          button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
          values.buttonFollowing = scroll.atBottom();
          scroll.enterLatest();
          await frame();
          const details = document.createElement('details');
          details.style.cssText = 'position:absolute;top:0';
          details.innerHTML = '<summary>详情</summary><div>更多内容</div>';
          log.append(details);
          details.querySelector('summary').click();
          values.disclosureFollowing = scroll.atBottom();
          scroll.enterLatest();
          await frame();
          log.remove();
          return values;
        });
        if (!baseline) {
          assert(result.gestures.horizontal <= 2);
          assert(result.gestures.zoom <= 2);
          assert(result.gestures.vertical >= 70);
          assert(result.gestures.buttonFollowing);
          assert.equal(result.gestures.disclosureFollowing, false);
        }
        if (!baseline) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          result.motion = await page.evaluate(async () => {
            const log = document.createElement('div');
            log.style.cssText =
              'position:fixed;top:0;left:0;width:240px;height:200px;overflow:auto';
            log.innerHTML = '<div style="height:800px"></div>';
            document.body.append(log);
            const scroll = window.StudioChatScroll.create(log),
              content = log.firstChild;
            const next = () => new Promise((r) => requestAnimationFrame(r));
            scroll.enterLatest();
            await next();
            await next();
            const before = scroll.capture();
            content.style.height = '880px';
            scroll.restore(before);
            const gaps = [];
            for (let i = 0; i < 28; i++) {
              await next();
              gaps.push(log.scrollHeight - log.scrollTop - log.clientHeight);
            }
            const more = scroll.capture();
            content.style.height = '960px';
            scroll.restore(more);
            await next();
            log.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
            const stopped = log.scrollTop;
            for (let i = 0; i < 8; i++) await next();
            const after = log.scrollTop;
            scroll.enterLatest();
            log.remove();
            return { gaps, stopped, after };
          });
          assert(
            result.motion.gaps.some((g) => g > 1 && g < 80),
            'follow must have intermediate frames',
          );
          assert(result.motion.gaps.at(-1) <= 1);
          assert.equal(result.motion.after, result.motion.stopped, 'gesture cancels animation');
          await page.emulateMedia({ reducedMotion: 'reduce' });
        }
        await page.screenshot({ path: path.join(output, width + '.png') });
        assert.deepEqual(errors, []);
        result.ok = true;
      } catch (error) {
        result.error = error.stack;
        await page.screenshot({ path: path.join(output, width + '-failure.png') });
      } finally {
        results.push(result);
        console.log(JSON.stringify(result));
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ sources, results }, null, 2),
  );
  assert(
    results.every((r) => r.ok),
    'See ' + output,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

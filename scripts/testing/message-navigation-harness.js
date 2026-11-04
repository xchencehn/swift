'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const output = path.resolve(
  process.env.SWIFT_MESSAGE_NAVIGATION_OUTPUT ||
    'artifacts/tasks/203-message-navigation-dots/refinement/browser',
);
async function performanceComparison(browser) {
  const baseline = '66e6a81',
    result = [];
  const source = (name) =>
    require('node:child_process').execFileSync('git', ['show', `${baseline}:${name}`], {
      encoding: 'utf8',
    });
  for (const count of [50, 500])
    for (const mode of ['baseline', 'candidate']) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.syncIndexed = true;
      fixture.state.unified = true;
      const session = fixture.state.sessions['pane-codex'];
      session.messages = Array.from({ length: count * 2 }, (_, i) => ({
        id: 'perf-' + i,
        role: i % 2 ? 'assistant' : 'user',
        blocks: [{ kind: 'text', text: `消息 ${i}：` + '滚动期间保留内容和草稿。'.repeat(10) }],
      }));
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
      });
      try {
        if (mode === 'baseline') {
          await page.route('**/style.css*', (route) =>
            route.fulfill({ body: source('public/style.css'), contentType: 'text/css' }),
          );
          const candidate = await fs.readFile('public/chat/message-navigation.js', 'utf8');
          await page.route('**/assets/startup.js*', async (route) => {
            const response = await route.fetch(),
              bundle = await response.text();
            assert(
              bundle.includes(candidate),
              'Baseline replacement must find the navigation in the actual startup bundle',
            );
            await route.fulfill({
              response,
              body: bundle.replace(candidate, source('public/chat/message-navigation.js')),
            });
          });
        }
        await page.route('**/api/transcript?*', async (route) => {
          if (!new URL(route.request().url()).searchParams.has('navigation'))
            return route.continue();
          const response = await route.fetch(),
            value = await response.json();
          value.navigation = session.messages
            .filter((m) => m.role === 'user')
            .map((m) => ({ id: m.id, text: m.blocks[0].text }));
          await route.fulfill({ response, json: value });
        });
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const nav = page.getByRole('navigation', { name: '用户消息导航', exact: true });
        await expect(nav).toBeVisible();
        await nav.hover();
        await expect(nav.locator('.message-navigation-mark')).toHaveCount(count);
        assert.equal(
          await nav.locator('.message-navigation-earlier').count(),
          mode === 'baseline' ? 2 : 0,
          'Benchmark must load the requested implementation',
        );
        await page.mouse.move(20, 20);
        await page.locator('#commandInput').fill('性能检查保留草稿');
        const stats = await page.evaluate(async () => {
          const log = document.querySelector('#chatLog'),
            nativeFrame = requestAnimationFrame.bind(window),
            work = [],
            intervals = [];
          window.requestAnimationFrame = (fn) =>
            nativeFrame((time) => {
              const start = performance.now();
              fn(time);
              if (fn.name === 'active' || fn.name === 'paintWheel') {
                document.querySelector('.message-navigation-marks').getBoundingClientRect();
                work.push(performance.now() - start);
              }
            });
          let previous = performance.now();
          for (let i = 0; i < 100; i++) {
            log.scrollTop += i < 50 ? -24 : 24;
            await new Promise(nativeFrame);
            const now = performance.now();
            if (i > 5) intervals.push(now - previous);
            previous = now;
          }
          await new Promise(nativeFrame);
          window.requestAnimationFrame = nativeFrame;
          const summary = (values) => {
            values.sort((a, b) => a - b);
            return {
              samples: values.length,
              p50: values[Math.floor(values.length * 0.5)] || 0,
              p95: values[Math.floor(values.length * 0.95)] || 0,
              max: values.at(-1) || 0,
            };
          };
          return {
            workMs: summary(work),
            frameMs: summary(intervals),
            draft: document.querySelector('#commandInput').value,
          };
        });
        assert.equal(stats.draft, '性能检查保留草稿');
        assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
        result.push({ mode, count, ...stats });
      } finally {
        await page.close();
        await fixture.close();
      }
    }
  await fs.writeFile(
    path.join(output, 'performance.json'),
    JSON.stringify({ baseline, result }, null, 2),
  );
  console.log(JSON.stringify(result));
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch();
  const results = [];
  try {
    if (process.argv.includes('--performance')) await performanceComparison(browser);
    else
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 320, height: 640 },
      ]) {
        const fixture = await createFixture();
        fixture.state.productionPresentation = true;
        fixture.state.syncIndexed = true;
        fixture.state.unified = true;
        const session = fixture.state.sessions['pane-codex'];
        session.messages = Array.from({ length: 100 }, (_, i) => ({
          id: 'nav-' + i,
          role: i % 2 ? 'assistant' : 'user',
          blocks: [
            { kind: 'text', text: (i % 2 ? '回复' : '用户问题') + i + ' 中文与长文本 '.repeat(20) },
          ],
        }));
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width < 1000,
          serviceWorkers: 'block',
          reducedMotion: 'no-preference',
        });
        await context.addInitScript(() => {
          window.navigationHaptics = [];
          Object.defineProperty(navigator, 'vibrate', {
            configurable: true,
            value: (ms) => {
              window.navigationHaptics.push(ms);
              return true;
            },
          });
          window.navigationTouches = 0;
          document.addEventListener(
            'pointerdown',
            (e) => {
              if (e.pointerType === 'touch' && e.target.closest('.message-navigation-mark'))
                window.navigationTouches++;
            },
            true,
          );
        });
        let delayTarget = false,
          releaseTarget,
          targetPending = false;
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
          const interceptTranscript = async (route) => {
            const u = new URL(route.request().url());
            if (
              u.searchParams.get('pane') !== 'pane-codex' ||
              (!u.searchParams.has('navigation') && !u.searchParams.has('around'))
            )
              return route.continue();
            const response = await route.fetch(),
              value = await response.json();
            if (u.searchParams.has('navigation')) {
              const users = session.messages
                .filter((m) => m.role === 'user')
                .map((m) => ({ id: m.id, text: m.blocks[0].text.slice(0, 640) }));
              value.navigation = u.searchParams.has('before')
                ? users.slice(0, 10)
                : users.slice(10);
              value.hasMore = !u.searchParams.has('before');
            } else {
              if (delayTarget) {
                targetPending = true;
                await new Promise((resolve) => {
                  releaseTarget = resolve;
                });
              }
              value.messages = session.messages.slice(0, 20);
              value.hasMore = false;
            }
            await route.fulfill({ response, json: value });
            if (u.searchParams.has('around')) targetPending = false;
          };
          await page.route('**/api/transcript?*', interceptTranscript);
          await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
          const nav = page.getByRole('navigation', { name: '用户消息导航', exact: true });
          await expect(nav).toBeVisible();
          await expect
            .poll(() => nav.locator('.message-navigation-mark').count())
            .toBeGreaterThan(0);
          await page.locator('#commandInput').fill('导航期间保留草稿');
          await nav.hover();
          await expect(nav.locator('.message-navigation-mark')).toHaveCount(40);
          await nav.locator('.message-navigation-marks').evaluate((el) => {
            el.scrollTop = 0;
          });
          await nav.locator('.message-navigation-marks').hover();
          await page.mouse.wheel(0, -100);
          await expect(nav.locator('.message-navigation-mark')).toHaveCount(50);
          assert.equal(
            await nav.locator('.message-navigation-earlier').count(),
            0,
            'Navigation has no arrow buttons',
          );
          const mark = nav.locator('[aria-label*="用户问题40"]');
          await mark.focus();
          const preview = nav.locator('.message-navigation-preview');
          await expect(preview).toContainText('用户问题');
          await page.keyboard.press('Enter');
          await expect(page.locator('.message-navigation-target')).toBeVisible();
          await expect(nav.locator('[aria-current]')).toHaveCount(1);
          const distance = await page
            .locator('.message-navigation-target')
            .evaluate(
              (n) =>
                n.getBoundingClientRect().top -
                document.querySelector('#chatLog').getBoundingClientRect().top,
            );
          assert(Math.abs(distance - 16) < 4, 'Target aligns in transcript: ' + distance);
          await expect(page.locator('#commandInput')).toHaveValue('导航期间保留草稿');
          await mark.focus();
          await page.keyboard.press('ArrowDown');
          await expect(nav.locator('[aria-label*="用户问题42"]')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(preview).toBeHidden();
          await page.screenshot({ path: path.join(output, viewport.width + '-navigation.png') });
          const marks = nav.locator('.message-navigation-marks');
          const activate = async (button) =>
            viewport.width < 1000 ? button.tap() : button.click();
          await activate(nav.locator('[aria-label*="用户问题44"]'));
          await expect(page.locator('.message-navigation-target')).toHaveAttribute(
            'data-message-id',
            'nav-44',
          );
          await expect(nav.locator('[aria-current]')).toHaveCount(1);
          await expect(preview).toBeHidden();
          await page.keyboard.press('Home');
          await expect(nav.locator('.message-navigation-mark').first()).toBeFocused();
          await page.keyboard.press('End');
          await expect(nav.locator('.message-navigation-mark').last()).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(preview).toBeHidden();
          await page.locator('#commandInput').click();
          const chatBefore = await page.locator('#chatLog').evaluate((el) => el.scrollTop);
          // Overflow is an ordinary scrollable list: scrolling never chooses or jumps to a message.
          await marks.evaluate((el) => {
            el.scrollTop = 0;
          });
          await expect.poll(() => marks.evaluate((el) => el.scrollTop)).toBe(0);
          await marks.hover();
          await page.mouse.wheel(0, 100);
          await expect.poll(() => marks.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
          assert.equal(
            await page.locator('#chatLog').evaluate((el) => el.scrollTop),
            chatBefore,
            'Scrolling the dots preserves the transcript position',
          );
          assert.equal(
            await nav.locator('.message-navigation-trigger, .message-navigation-wheel').count(),
            0,
            'The wheel and central line are removed',
          );
          assert.equal(
            await page.evaluate(() => window.navigationHaptics.length),
            0,
            'Ordinary dot navigation does not vibrate',
          );
          const geometry = await nav.locator('.message-navigation-mark').evaluateAll((list) =>
            list.map((el) => {
              const dot = getComputedStyle(el, '::after'),
                box = el.getBoundingClientRect();
              return {
                current: el.hasAttribute('aria-current'),
                color: getComputedStyle(el).color,
                width: parseFloat(dot.width),
                height: parseFloat(dot.height),
                opacity: parseFloat(dot.opacity),
                radius: dot.borderRadius,
                transform: dot.transform,
                targetWidth: box.width,
                targetHeight: box.height,
              };
            }),
          );
          const gutter = await page.locator('#chatLog').evaluate((el) => {
            const box = el.getBoundingClientRect(),
              style = getComputedStyle(el);
            return {
              contentRight: box.right - parseFloat(style.paddingRight),
              navigationLeft: document.querySelector('.message-navigation').getBoundingClientRect()
                .left,
            };
          });
          assert(
            gutter.contentRight <= gutter.navigationLeft,
            'Message content stays clear of the dot buttons',
          );
          assert(
            geometry.every(
              (dot) =>
                dot.width === dot.height &&
                dot.width <= 8 &&
                dot.radius === '50%' &&
                dot.transform === 'none',
            ),
            'Every message has a small circular dot',
          );
          assert(
            geometry
              .filter((dot) => dot.current)
              .every((dot) => dot.width === 6 && dot.opacity === 0.7),
            'The current dot keeps its size with a dimmer color',
          );
          assert(
            geometry
              .filter((dot) => !dot.current)
              .every((dot) => dot.width === 4 && dot.opacity === 0.55),
            'Other dots are smaller and darker',
          );
          const currentColor = await nav
            .locator('[aria-current]')
            .evaluate((el) => getComputedStyle(el).getPropertyValue('--text').trim());
          const referenceColor = await page.evaluate((color) => {
            const n = document.createElement('i');
            n.style.color = color;
            document.body.append(n);
            const value = getComputedStyle(n).color;
            n.remove();
            return value;
          }, currentColor);
          assert.equal(
            geometry.find((dot) => dot.current)?.color,
            referenceColor,
            'Current dot color stays unchanged',
          );
          if (viewport.width < 1000) {
            assert(
              geometry.every((dot) => dot.targetWidth >= 44 && dot.targetHeight >= 44),
              'Touch targets stay large around the small dots',
            );
            assert(
              (await page.evaluate(() => window.navigationTouches)) > 0,
              'Mobile activation uses real browser touch input',
            );
          }
          await nav.locator('[aria-label*="用户问题46"]').focus();
          await expect(preview).toBeVisible();
          const bounds = await preview.boundingBox();
          assert(
            bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
            'Preview stays in the viewport',
          );
          await page.screenshot({ path: path.join(output, viewport.width + '-dots-preview.png') });
          await preview.click();
          await expect(page.locator('.message-navigation-target')).toHaveAttribute(
            'data-message-id',
            'nav-46',
          );
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await activate(nav.locator('[aria-label*="用户问题48"]'));
          await expect(page.locator('.message-navigation-target')).toHaveAttribute(
            'data-message-id',
            'nav-48',
          );
          assert.equal(
            await page
              .locator('.message-navigation-target')
              .evaluate((el) => el.getAnimations().length),
            0,
          );
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.locator('#commandInput').click();
          await expect(preview).toBeHidden();
          await page.screenshot({ path: path.join(output, viewport.width + '-dots-dark.png') });
          await page.evaluate(() => window.StudioDeviceTheme.apply('light', false));
          await page.screenshot({ path: path.join(output, viewport.width + '-dots-light.png') });
          await page.evaluate(() => window.StudioDeviceTheme.apply('default', false));
          // The index outline exposes a message outside the tail window; clicking loads that window.
          await nav.hover();
          await expect(nav.locator('.message-navigation-mark')).toHaveCount(50);
          await nav.locator('.message-navigation-mark').first().click();
          await expect(page.locator('.message-navigation-target')).toHaveAttribute(
            'data-message-id',
            'nav-0',
          );
          await expect(page.locator('#commandInput')).toHaveValue('导航期间保留草稿');
          await nav.locator('.message-navigation-mark').last().click();
          await expect(page.locator('#chatLog')).toContainText('用户问题98');
          // Earlier reading can legitimately cache all history. Start an independent window
          // to prove a delayed, genuinely unloaded target cannot replace the latest view.
          const pendingContext = await browser.newContext({ viewport, serviceWorkers: 'block' });
          try {
            const pendingPage = await pendingContext.newPage();
            pendingPage.on('pageerror', (e) => errors.push(e.message));
            await pendingPage.route('**/api/transcript?*', interceptTranscript);
            await pendingPage.goto(fixture.url + '/?token=fixture&pane=pane-codex');
            const pendingNav = pendingPage.getByRole('navigation', {
              name: '用户消息导航',
              exact: true,
            });
            await pendingNav.hover();
            await expect(pendingNav.locator('.message-navigation-mark')).toHaveCount(40);
            await pendingNav.locator('.message-navigation-marks').evaluate((el) => {
              el.scrollTop = 0;
            });
            await pendingNav.locator('.message-navigation-marks').hover();
            await pendingPage.mouse.wheel(0, -100);
            await expect(pendingNav.locator('.message-navigation-mark')).toHaveCount(50);
            await expect(pendingPage.locator('#chatLog [data-message-id="nav-0"]')).toHaveCount(0);
            delayTarget = true;
            await pendingNav.locator('.message-navigation-mark').first().click();
            await expect.poll(() => targetPending).toBe(true);
            await pendingNav.locator('.message-navigation-mark').last().click();
            releaseTarget();
            await expect.poll(() => targetPending).toBe(false);
            await expect(pendingPage.locator('#chatLog')).toContainText('用户问题98');
            await expect(pendingPage.locator('#chatLog [data-message-id="nav-0"]')).toHaveCount(0);
          } finally {
            releaseTarget?.();
            delayTarget = false;
            await pendingContext.close();
          }
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toBeVisible();
          await expect(nav).toBeHidden();
          await page.locator('#chatModeToggle').click();
          await expect(nav).toBeVisible();
          assert(
            !fixture.state.requests.some((r) => r.route === 'POST /api/messages'),
            'Navigation never submits input',
          );
          assert.deepEqual(errors, []);
          results.push({
            viewport,
            passed: true,
            distance,
            geometry: geometry[0],
            oneDotPerUserMessage: geometry.length === 50,
            activation: viewport.width < 1000 ? 'touch' : 'mouse',
            listScrollPreservesTranscript: true,
            reducedMotion: true,
            previewClick: true,
            hapticCalls: await page.evaluate(() => window.navigationHaptics.length),
          });
        } finally {
          await context.close();
          await fixture.close();
        }
      }
  } finally {
    await browser.close();
  }
  if (results.length) {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
    console.log('User-message navigation passed:', results.length, 'viewports');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

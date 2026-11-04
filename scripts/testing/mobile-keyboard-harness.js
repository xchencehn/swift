'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_MOBILE_KEYBOARD_OUTPUT ||
    path.join(
      'artifacts/tasks/',
      process.argv.includes('--bottom-anchor-only')
        ? '116-terminal-bottom-anchor/browser'
        : '112-mobile-keyboard-viewport/browser',
    ),
);
const scenes = [
  { name: 'phone', width: 390, height: 844, keyboard: 430 },
  { name: 'small-phone', width: 320, height: 740, keyboard: 380 },
  { name: 'tablet', width: 1024, height: 768, keyboard: 430 },
  { name: 'landscape', width: 844, height: 390, keyboard: 220 },
  { name: 'small-landscape', width: 740, height: 320, keyboard: 200 },
];
const nativeScreen =
  '\x1b[2J\x1b[H' +
  Array.from({ length: 80 }, (_, i) => `\x1b[${i + 1};1HNative output ${i + 1}`).join('') +
  '\x1b[81;1HWorking\x1b[82;1HKEYBOARD_PROMPT>\x1b[83;1HSTATUS_BOTTOM\x1b[82;17H\x1b[?25h';
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const scene of scenes.filter(
      (scene) =>
        !process.argv.some((arg) => arg.startsWith('--scene=')) ||
        process.argv.includes('--scene=' + scene.name),
    )) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.nativeTerminalText = nativeScreen;
      fixture.state.nativeTerminalGeometry = { cols: 80, rows: 200 };
      const context = await browser.newContext({
        viewport: scene,
        screen: scene,
        hasTouch: true,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(() => {
        // A visual-only resize and pan cannot be produced by setViewportSize.
        // Replay those platform signals without claiming physical keyboard input.
        const viewport = new EventTarget();
        viewport.height = innerHeight;
        viewport.offsetTop = 0;
        Object.defineProperty(window, 'visualViewport', { value: viewport });
        window.fixtureViewport = (height, top = 0) => {
          viewport.height = height;
          viewport.offsetTop = top;
          viewport.dispatchEvent(new Event('resize'));
          viewport.dispatchEvent(new Event('scroll'));
        };
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(8000);
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const command = page.locator('#commandInput');
        await command.fill('独立聊天草稿');
        await page.locator('#chatModeToggle').click();
        const host = page.locator('#shellTerminal'),
          rows = host.locator('.xterm-rows');
        const input = host.locator('.xterm-helper-textarea');
        await expect(rows).toContainText('KEYBOARD_PROMPT>');
        await expect(rows).toContainText('STATUS_BOTTOM');
        if (scene.width <= 390 && scene.height > scene.width) {
          await host.locator('.xterm-screen').tap({ position: { x: 12, y: 12 } });
          const terminalInput = await host
            .locator('.xterm-helper-textarea')
            .evaluate((node) => ({ readOnly: node.readOnly, inputMode: node.inputMode }));
          assert.equal(terminalInput.readOnly, false);
          assert.notEqual(terminalInput.inputMode, 'none');
        }
        await input.focus();
        const connectionCount = fixture.state.shellConnections;
        const setViewport = async (height, top = 0) => {
          await page.evaluate(({ height, top }) => window.fixtureViewport(height, top), {
            height,
            top,
          });
          await expect(page.locator('.app-shell')).toHaveCSS('height', height + 'px');
        };
        const measurements = [];
        for (const [height, top] of [
          [scene.keyboard, 0],
          [scene.keyboard - 20, 30],
          [scene.keyboard, 0],
          [scene.height, 0],
        ]) {
          await setViewport(height, top);
          await expect(rows).toContainText('KEYBOARD_PROMPT>');
          await expect(rows).toContainText('STATUS_BOTTOM');
          const geometry = await host.evaluate((node) => {
            const box = (selector) => node.querySelector(selector).getBoundingClientRect().toJSON();
            return {
              shell: document.querySelector('.app-shell').getBoundingClientRect().toJSON(),
              canvas: box('.shell-terminal-canvas'),
              screen: box('.xterm-screen'),
              cursor: box('.xterm-rows .xterm-cursor'),
              keys: box('.shell-terminal-keys'),
              input: box('.xterm-helper-textarea'),
              windowScrollY: scrollY,
              overflow: document.documentElement.scrollWidth - innerWidth,
            };
          });
          assert(
            geometry.shell.top >= top - 1 && geometry.keys.bottom <= top + height + 1,
            JSON.stringify(geometry),
          );
          assert(
            geometry.canvas.height >= 16 && geometry.screen.bottom <= geometry.keys.top + 1,
            JSON.stringify(geometry),
          );
          if (scene.width <= 390 && scene.height > scene.width) {
            assert(
              geometry.canvas.top - geometry.shell.top <= 52,
              'Phone terminal must begin close to the header',
            );
            assert(
              scene.width - geometry.screen.right <= geometry.screen.left + 4,
              'Terminal side gaps must be balanced',
            );
          }
          assert(
            geometry.cursor.top >= geometry.canvas.top - 1 &&
              geometry.cursor.bottom <= geometry.canvas.bottom + 1,
            JSON.stringify(geometry),
          );
          assert.equal(geometry.overflow, 0);
          assert.equal(fixture.state.shellConnections, connectionCount);
          await expect(input).toBeFocused();
          measurements.push({ height, top, geometry });
          if (height === scene.keyboard - 20)
            await page.screenshot({
              path: path.join(output, scene.name + '-terminal-keyboard.png'),
            });
        }
        if (scene.width <= 390 && scene.height > scene.width) {
          await page.evaluate((height) => {
            Object.defineProperty(window, 'innerHeight', {
              configurable: true,
              writable: true,
              value: height,
            });
            window.fixtureViewport(height);
            window.dispatchEvent(new Event('resize'));
          }, scene.keyboard);
          await expect(page.locator('.app-shell')).toHaveCSS('height', scene.keyboard + 'px');
          const restoreLayout = (height) =>
            page.evaluate((value) => {
              window.innerHeight = value;
              window.dispatchEvent(new Event('resize'));
            }, height);
          await restoreLayout(scene.height);
          await expect(page.locator('.app-shell')).toHaveCSS('height', scene.height + 'px');
          const beforeJitter = await host.locator('.shell-terminal-keys').boundingBox();
          await restoreLayout(scene.height - 24);
          await expect(page.locator('.app-shell')).toHaveCSS('height', scene.height + 'px');
          const afterJitter = await host.locator('.shell-terminal-keys').boundingBox();
          assert(
            Math.abs(beforeJitter.y - afterJitter.y) <= 1,
            'Closing the keyboard must not move terminal controls again',
          );
          await restoreLayout(scene.height);
          await page.screenshot({
            path: path.join(output, scene.name + '-terminal-restored-stable.png'),
          });
          await page.evaluate((height) => {
            delete window.innerHeight;
            window.fixtureViewport(height);
            window.dispatchEvent(new Event('resize'));
          }, scene.height);
          await input.click();
        }
        assert(
          !(fixture.state.shellFrames || []).some((frame) => frame.type === 'terminal.input'),
          'Viewport changes and focus must never write native input',
        );
        await expect(input).toHaveValue('');
        // Native activity can grow and shrink without changing the CSS viewport.
        // Its prompt/status must remain in the last visible terminal rows.
        for (const height of [scene.height, scene.keyboard]) {
          await setViewport(height);
          const visibleRows = await page.locator('.xterm-rows > div').count();
          assert(visibleRows >= 2);
          for (const [step, end] of [
            visibleRows,
            Math.max(2, visibleRows - 4),
            visibleRows,
          ].entries()) {
            const frame =
              '\x1b[2J\x1b[H' +
              Array.from({ length: end - 2 }, (_, y) => `\x1b[${y + 1};1HActivity ${y + 1}`).join(
                '',
              ) +
              `\x1b[${end - 1};1HPROMPT_${height}_${step}\x1b[${end};1HSTATUS_${height}_${step}\x1b[${end - 1};1H\x1b[?25h`;
            fixture.shellFrame(frame, 'pane-codex', {
              full: true,
              geometry: { cols: 80, rows: 200 },
            });
            await expect
              .poll(() => page.locator('.xterm-rows > div').last().innerText())
              .toContain(`STATUS_${height}_${step}`);
            await expect(page.locator('.xterm-rows > div').nth(visibleRows - 2)).toContainText(
              `PROMPT_${height}_${step}`,
            );
            const screenBottom = await host
              .locator('.xterm-screen')
              .evaluate((node) => node.getBoundingClientRect().bottom);
            const lastBottom = await page
              .locator('.xterm-rows > div')
              .last()
              .evaluate((node) => node.getBoundingClientRect().bottom);
            assert(
              Math.abs(screenBottom - lastBottom) <= 2,
              'Native status must occupy the bottom display row',
            );
            if (step === 1)
              await page.screenshot({
                path: path.join(
                  output,
                  scene.name +
                    (height === scene.keyboard
                      ? '-bottom-anchor-keyboard.png'
                      : '-bottom-anchor-idle.png'),
                ),
              });
          }
        }
        if (process.argv.includes('--bottom-anchor-only')) {
          results.push({
            scene: scene.name,
            bottomAnchorAcrossActivityAndKeyboard: true,
            eventSource:
              'Synthetic visualViewport resize in isolated Firefox; no physical keyboard',
            productionInput: false,
          });
          console.log('PASS ' + scene.name + ' bottom anchor');
          continue;
        }
        await page.locator('#chatModeToggle').click();
        await expect(command).toHaveValue('独立聊天草稿');
        await command.focus();
        await page
          .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
          .click();
        await page.locator('#chatLatestAction').click();
        await command.focus();
        for (const [height, top] of [
          [scene.keyboard, 0],
          [scene.keyboard - 20, 30],
          [scene.height, 0],
        ]) {
          await setViewport(height, top);
          await expect
            .poll(() =>
              page
                .locator('#chatLog')
                .evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight),
            )
            .toBeLessThanOrEqual(1);
          const form = await page.locator('#chatInput').boundingBox();
          assert(form.y + form.height <= top + height + 1);
        }
        await command.fill('多行聊天草稿\n'.repeat(12));
        await setViewport(scene.keyboard);
        const form = await page.locator('#chatInput').boundingBox();
        assert(form.y + form.height <= scene.keyboard + 1);
        await page.screenshot({ path: path.join(output, scene.name + '-chat-keyboard.png') });
        // Reading history is a deliberate gesture; keyboard events must preserve it.
        await page.locator('#chatLog').evaluate((log) => {
          log.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
          log.scrollTop = 0;
        });
        await page.waitForTimeout(220);
        await setViewport(scene.keyboard - 20, 30);
        assert.equal(await page.locator('#chatLog').evaluate((log) => log.scrollTop), 0);
        await setViewport(scene.height);
        assert.equal(await page.locator('#chatLog').evaluate((log) => log.scrollTop), 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(fixture.state.unexpected, []);
        assert(!fixture.state.requests.some((request) => request.route === 'POST /api/messages'));
        results.push({
          scene: scene.name,
          measurements,
          completeNativeBottom: true,
          retainedConnection: true,
          chatDraftPreserved: true,
          chatLatestFollows: true,
          historyPreserved: true,
          eventSource:
            'Synthetic visualViewport resize/pan in isolated Firefox; no physical keyboard',
          productionInput: false,
        });
        console.log('PASS ' + scene.name);
      } catch (error) {
        await page.screenshot({ path: path.join(output, scene.name + '-failure.png') });
        await fs.writeFile(
          path.join(output, scene.name + '-failure.json'),
          JSON.stringify(
            await page.evaluate(() => ({
              height: visualViewport.height,
              top: visualViewport.offsetTop,
              boxes: Object.fromEntries(
                [
                  '.chat-head',
                  '#chatInput',
                  '#commandInput',
                  '#chatControls',
                  '#shellTerminal',
                  '.shell-terminal-canvas',
                  '.xterm-screen',
                  '.shell-terminal-keys',
                ].map((selector) => [
                  selector,
                  document.querySelector(selector)?.getBoundingClientRect().toJSON(),
                ]),
              ),
            })),
            null,
            2,
          ),
        );
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
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2) + '\n',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

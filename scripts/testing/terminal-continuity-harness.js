'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_CONTINUITY_OUTPUT ||
      'artifacts/testing/terminal-continuity/' + (baseline ? 'baseline' : 'browser'),
  );
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        screen: viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (baseline)
        await page.route('**/assets/startup.js*', async (route) => {
          const response = await route.fetch();
          let bundle = await response.text();
          for (const name of [
            'public/chat/shell-terminal.js',
            'public/chat/terminal-renderer.js',
          ]) {
            const current = await fs.readFile(name, 'utf8');
            assert(bundle.includes(current));
            bundle = bundle.replace(
              current,
              execFileSync('git', ['show', '66f5430:' + name], { encoding: 'utf8' }),
            );
          }
          await route.fulfill({ response, body: bundle });
        });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.evaluate(() => {
          window.terminalRenderCount = 0;
          const create = StudioTerminalRenderer.create;
          StudioTerminalRenderer.create = (options) => {
            const renderer = create(options),
              render = renderer.render;
            renderer.render = (options) => {
              window.terminalRenderCount++;
              return render(options);
            };
            return renderer;
          };
        });
        await page.locator('#commandInput').fill('结构化草稿继续保留');
        if (!baseline) {
          await page.evaluate(() => {
            const button = document.querySelector('#chatModeToggle');
            button.click();
            button.click();
          });
          await page.waitForFunction(() => typeof window.Terminal === 'function');
        }
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#shellTerminal')).toContainText('OpenAI Codex');
        await page.evaluate(() => document.fonts.ready);
        fixture.shellFrame('\x1b[2J\x1b[HCONTINUITY_MARKER 中文\x1b[3;5H\x1b[?25h', 'pane-codex', {
          full: true,
        });
        await expect(page.locator('#shellTerminal')).toContainText('CONTINUITY_MARKER');
        await page.evaluate(() => {
          window.continuityScreen = document.querySelector('#shellTerminal .xterm-screen');
        });
        const switches = [],
          initialConnections = fixture.state.shellConnections;
        for (let i = 0; i < 5; i++) {
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#commandInput')).toHaveValue('结构化草稿继续保留');
          const sample = await page.evaluate(
            () =>
              new Promise((resolve, reject) => {
                const start = performance.now(),
                  timer = setTimeout(() => reject(new Error('No terminal content')), 10000);
                document.querySelector('#chatModeToggle').click();
                const immediate = document.querySelector('#shellTerminal .xterm-screen');
                const retainedImmediately =
                  immediate === window.continuityScreen &&
                  immediate?.textContent.includes('CONTINUITY_MARKER');
                const sample = () => {
                  const screen = document.querySelector('#shellTerminal .xterm-screen');
                  if (screen?.textContent.trim()) {
                    clearTimeout(timer);
                    resolve({
                      retainedImmediately,
                      timeToContentAnimationFrameMs: performance.now() - start,
                    });
                  } else requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
              }),
          );
          switches.push(sample);
        }
        if (baseline) assert(switches.every((sample) => !sample.retainedImmediately));
        else {
          assert(
            switches.every((sample) => sample.retainedImmediately),
            'Returning must show the retained terminal before any network response',
          );
          assert.equal(
            fixture.state.shellConnections,
            initialConnections,
            'Mode changes must reuse the connection',
          );
          assert(
            fixture.state.shellFrames.some(
              (frame) => frame.type === 'terminal.focus' && frame.focused === false,
            ),
          );
          // Observe while detached; update the same native buffer, then show its latest state.
          await page.locator('#chatModeToggle').click();
          fixture.shellFrame('\x1b[4;1HHIDDEN_UPDATE', 'pane-codex');
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toContainText('HIDDEN_UPDATE');
          assert(
            await page.evaluate(
              () =>
                document.querySelector('#shellTerminal .xterm-screen') === window.continuityScreen,
            ),
          );
        }
        const terminal = page.locator('#shellTerminal'),
          input = terminal.locator('.xterm-helper-textarea');
        await input.focus();
        await page.keyboard.type('once');
        await expect
          .poll(() =>
            (fixture.state.shellFrames || [])
              .filter((frame) => frame.type === 'terminal.input')
              .map((frame) => frame.data)
              .join(''),
          )
          .toBe('once');
        // A burst must consume all ANSI state while painting a completed state.
        await page.evaluate(() => {
          window.terminalRenderCount = 0;
        });
        const started = Date.now();
        for (let i = 0; i < 100; i++)
          fixture.shellFrame(
            `\x1b[?2026h\x1b[2J\x1b[HSTABLE_BURST\x1b[3;1HBURST_${i}_DONE\x1b[4;5H\x1b[?2026l`,
            'pane-codex',
            { full: i % 7 === 0 },
          );
        await expect(terminal).toContainText('BURST_99_DONE');
        const burstToContentMs = Date.now() - started;
        const burstRenderCount = await page.evaluate(() => window.terminalRenderCount);
        if (!baseline)
          assert(
            burstRenderCount < 50,
            'A 100-frame burst must not enqueue one visible redraw per frame',
          );
        if (!baseline) {
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator('#sidebarRecent').click();
          await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
          await expect(terminal).toContainText('Claude Code');
          assert(
            !(await page.evaluate(
              () =>
                document.querySelector('#shellTerminal .xterm-screen') === window.continuityScreen,
            )),
          );
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
          await expect(terminal).toContainText('BURST_99_DONE');
          assert(
            await page.evaluate(
              () =>
                document.querySelector('#shellTerminal .xterm-screen') === window.continuityScreen,
            ),
          );
          assert.equal(
            fixture.state.shellConnections,
            initialConnections + (fixture.state.terminalChannelVersion >= 1 ? 0 : 1),
            'Revisiting a Tab must reuse the existing channel',
          );
          await page.evaluate(() => window.dispatchEvent(new Event('blur')));
          await expect
            .poll(
              () =>
                fixture.state.shellFrames.filter((frame) => frame.type === 'terminal.focus').at(-1)
                  ?.focused,
            )
            .toBe(false);
          const connections = fixture.state.shellConnections;
          await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.evaluate(() => {
            delete document.hidden;
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await expect(terminal).toContainText('BURST_99_DONE');
          assert.equal(fixture.state.shellConnections, connections);
        }
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          baseline,
          switches,
          initialConnections,
          finalConnections: fixture.state.shellConnections,
          burstToContentMs,
          burstRenderCount,
          inputExactlyOnce: true,
        });
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
    JSON.stringify(
      {
        ok: true,
        before,
        after,
        results,
        evidence:
          'Isolated Firefox synthetic echo and redraw fixture. Timings measure DOM availability and do not claim physical paint or production latency.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS terminal ${baseline ? 'baseline reproduces rebuilds' : 'retained views, native release, byte ordering and switch continuity'}: ${results.length} viewports.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

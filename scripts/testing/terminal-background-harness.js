'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { createNativeTerminalFixture } = require('./herdr-windows-fixture');
const { openTerminalState } = require('../../lib/herdr-terminal-state');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const binary = process.env.SWIFT_WINDOWS_RUNTIME_BIN;
  if (!binary || !path.isAbsolute(binary))
    throw Error('Supply the isolated candidate using SWIFT_WINDOWS_RUNTIME_BIN');
  const before = sourceFingerprint(process.cwd()),
    baseline = process.argv.includes('--baseline');
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_BACKGROUND_OUTPUT || 'artifacts/terminal-background',
    baseline ? 'baseline' : 'candidate',
  );
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const runtime = await createNativeTerminalFixture(binary, { messageBackground: true });
      const fixture = await createFixture({ terminalRuntime: runtime });
      fixture.state.terminalPreview = true;
      const context = await browser.newContext({
        viewport,
        screen: viewport,
        hasTouch: viewport.width < 500,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let observer;
      try {
        const pane =
          Object.values(fixture.state.sessions).find((session) => session.provider === 'codex')
            ?.pane || Object.values(fixture.state.sessions)[0].pane;
        await page.goto(fixture.url + '/?token=fixture&pane=' + encodeURIComponent(pane.paneId));
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('NATIVE_WINDOWS_codex');
        observer = openTerminalState({
          socketPath: runtime.herdr.socketPath,
          terminalId: pane.terminalId,
        });
        await observer.ready;
        const measure = (host, nativeCols) => {
          const rows = [...host.querySelector('.xterm-rows').children];
          const index = rows.findIndex((row) => row.textContent.includes('用户消息整行背景'));
          if (index < 1) return null;
          const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
          const blank = rows[index - 1],
            text = document.createTreeWalker(blank, NodeFilter.SHOW_TEXT).nextNode();
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          // Observation preserves native geometry; the browser may have spare
          // columns beyond it. Only cells supplied by the runtime carry color.
          const nativeContentWidth =
            range.getBoundingClientRect().width * Math.min(nativeCols, blank.textContent.length);
          return {
            screenWidth: screen.width,
            nativeContentWidth,
            rows: rows.slice(index - 1, index + 2).map((row) => ({
              text: row.textContent,
              width: row.getBoundingClientRect().width,
              fills: [...row.children]
                .filter(
                  (span) =>
                    !['transparent', 'rgba(0, 0, 0, 0)'].includes(
                      getComputedStyle(span).backgroundColor,
                    ),
                )
                .map((span) => ({
                  color: getComputedStyle(span).backgroundColor,
                  width: span.getBoundingClientRect().width,
                })),
            })),
          };
        };
        for (const theme of ['dark', 'light']) {
          await page.evaluate((value) => StudioDeviceTheme.apply(value), theme);
          await page.evaluate(() => document.fonts.ready);
          await expect
            .poll(async () => {
              const metrics = await terminal.evaluate(measure, observer.state.cols);
              return (
                !!metrics &&
                (baseline ||
                  metrics.rows.every(
                    (row) =>
                      Math.abs(
                        row.fills.reduce((sum, fill) => sum + fill.width, 0) -
                          metrics.nativeContentWidth,
                      ) < 2,
                  ))
              );
            })
            .toBe(true);
          const metrics = await terminal.evaluate(measure, observer.state.cols),
            state = observer.state;
          const nativeRows = state.content.slice(3, 6).map((row) => ({
            cells: row.cells.length,
            backgrounds: [...new Set(row.cells.map((cell) => cell[3]))],
          }));
          if (baseline)
            assert(
              nativeRows.some((row) => row.backgrounds.includes(-1)),
              'baseline must reproduce missing erased backgrounds',
            );
          else
            assert(
              nativeRows.every((row) => row.backgrounds.length === 1 && row.backgrounds[0] === 8),
            );
          await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}.png`) });
          await terminal
            .locator('.xterm-rows')
            .screenshot({ path: path.join(output, `${viewport.width}-${theme}-terminal.png`) });
          results.push({ viewport, theme, nativeRows, ...metrics });
        }
        assert(
          !runtime.actions.some((frame) => ['terminal.input', 'terminal.key'].includes(frame.type)),
          'observation and resize cannot send text',
        );
        assert.deepEqual(errors, []);
      } finally {
        observer?.close();
        await context.close();
        await fixture.close();
        await runtime.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(sourceFingerprint(process.cwd()), before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        baseline,
        before,
        results,
        realPty: true,
        stateFormat: 'cells-v1',
        productionInput: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS real PTY message backgrounds: desktop/mobile, dark/light, complete blank and text rows.',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_TERMINAL_TALL_OUTPUT ||
    'artifacts/testing/statusbar-order/terminal-viewport/browser',
);
const nativeLines = Array.from({ length: 68 }, (_, i) => `NATIVE ROW ${i + 1}`);
nativeLines[65] = 'Working 0s';
nativeLines[66] = 'PHONE_PROMPT>';
nativeLines[67] = 'PHONE_STATUS_BOTTOM';
const frame = (lines) =>
  lines.map((line, i) => `\x1b[${i + 1};1H${line}`).join('') +
  `\x1b[${lines.length - 1};14H\x1b[?25h`;
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd());
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'screenshot-phone', width: 420, height: 933, scale: 3 },
      { name: 'narrow-phone', width: 320, height: 740, scale: 1 },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      fixture.state.nativeTerminalText = frame(nativeLines);
      fixture.state.nativeTerminalGeometry = { cols: 96, rows: 200 };
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const history = [
        ...Array.from({ length: 100 }, (_, i) => `EARLIER HISTORY ${i}`),
        ...nativeLines,
      ].join('\n');
      fixture.state.nativeHistoryRead = async () => {
        await gate;
        return fixture.state.nativeTerminalHistory ?? history;
      };
      const context = await browser.newContext({
        viewport,
        screen: viewport,
        hasTouch: true,
        deviceScaleFactor: viewport.scale,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(() => {
        const viewport = new EventTarget();
        viewport.height = innerHeight;
        viewport.offsetTop = 0;
        Object.defineProperty(window, 'visualViewport', { value: viewport });
        window.fixtureViewport = (height) => {
          viewport.height = height;
          viewport.dispatchEvent(new Event('resize'));
        };
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const requests = () =>
        (fixture.state.shellFrames || []).filter(
          (item) => item.type === 'terminal.history.request',
        );
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#chatModeToggle').click();
        const rows = page.locator('.xterm-rows > div'),
          host = page.locator('#shellTerminal');
        await expect(rows.last()).toContainText('PHONE_STATUS_BOTTOM');
        const originalRows = await rows.count();
        let currentLines = [...nativeLines];
        if (originalRows <= nativeLines.length) {
          currentLines = nativeLines.slice(-40);
          fixture.state.nativeTerminalText = frame(currentLines);
          fixture.state.nativeTerminalHistory = [
            ...Array.from({ length: 100 }, (_, i) => `EARLIER HISTORY ${i}`),
            ...nativeLines.slice(-40),
          ].join('\n');
          fixture.shellFrame(frame(nativeLines.slice(-40)), 'pane-codex', { full: true });
        }
        await expect.poll(() => requests().length).toBe(1);
        const beforeFill = await rows.allInnerTexts();
        assert.equal(beforeFill[0].trim(), '');
        const input = host.getByRole('textbox', { name: '终端输入', exact: true });
        await input.fill('只读历史等待期间继续编辑');
        await expect(input).toBeEnabled();
        release();
        await expect(rows.first()).toContainText('EARLIER HISTORY');
        await expect(rows.last()).toContainText('PHONE_STATUS_BOTTOM');
        for (let step = 1; step <= 4; step++) {
          currentLines[0] = `NATIVE HEADER ${step}`;
          fixture.shellFrame(frame(currentLines), 'pane-codex', { full: true });
          await expect(rows.first()).toContainText('EARLIER HISTORY');
          assert.equal(
            requests().length,
            1,
            'Changing native header must not clear verified history',
          );
        }
        const geometry = await host.evaluate((node) => {
          const box = (selector) => node.querySelector(selector).getBoundingClientRect().toJSON();
          const first = node.querySelector('.xterm-rows > div span')?.firstChild;
          const range = document.createRange();
          if (first) {
            range.setStart(first, 0);
            range.setEnd(first, 1);
          }
          return {
            host: node.getBoundingClientRect().toJSON(),
            viewRows: node.querySelectorAll('.xterm-rows > div').length,
            cellWidth: first ? range.getBoundingClientRect().width : null,
            cellHeight: box('.xterm-rows > div').height,
            canvas: box('.shell-terminal-canvas'),
            screen: box('.xterm-screen'),
            firstRow: box('.xterm-rows > div'),
            keys: box('.shell-terminal-keys'),
            fontSize: getComputedStyle(node.querySelector('.xterm-rows')).fontSize,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        geometry.captureCols = 96;
        geometry.captureRows = 200;
        geometry.nativeContentRows = currentLines.length;
        geometry.historyRowsFilled = beforeFill.findIndex((line) => line.trim());
        assert(geometry.canvas.height - geometry.screen.height < geometry.cellHeight + 1);
        assert.equal(geometry.pageOverflow, 0);
        assert(Math.abs(geometry.firstRow.top - geometry.canvas.top) <= 1);
        assert(geometry.screen.bottom <= geometry.keys.top + 1);
        assert(geometry.keys.bottom <= viewport.height + 1);
        await page.screenshot({ path: path.join(output, viewport.name + '-filled.png') });
        const scrolling = [];
        for (let step = 1; step <= 12; step++) {
          currentLines = [
            ...currentLines.slice(1, -3),
            `NEW OUTPUT ${step}`,
            `Working ${step}s`,
            'PHONE_PROMPT>',
            'PHONE_STATUS_BOTTOM',
          ];
          fixture.shellFrame(frame(currentLines), 'pane-codex', { full: true });
          await expect(rows.nth((await rows.count()) - 4)).toContainText(`NEW OUTPUT ${step}`);
          const top = await rows
            .first()
            .evaluate((node) => ({ text: node.innerText, top: node.getBoundingClientRect().top }));
          assert(top.text.trim(), 'Verified continuous output must not flash empty top rows');
          assert(Math.abs(top.top - geometry.firstRow.top) <= 1);
          scrolling.push(top);
        }
        assert.equal(
          requests().length,
          1,
          'A unique body overlap extends verified history without repeated reads',
        );
        for (const height of [430, viewport.height]) {
          await page.evaluate((height) => window.fixtureViewport(height), height);
          await expect(page.locator('.app-shell')).toHaveCSS('height', height + 'px');
          await expect(rows.last()).toContainText('PHONE_STATUS_BOTTOM');
        }
        assert.equal(requests().length, 1, 'Keyboard viewport changes reuse verified history');
        const short = ['NEW SHORT SESSION', 'SHORT_PROMPT>', 'SHORT_STATUS'];
        fixture.state.nativeTerminalHistory = short.join('\n');
        fixture.shellFrame(frame(short), 'pane-codex', { full: true });
        await expect.poll(() => requests().length).toBe(2);
        await expect(rows.last()).toContainText('SHORT_STATUS');
        await expect
          .poll(async () => (await rows.allInnerTexts()).filter((line) => line.trim()).length)
          .toBe(3);
        await expect(input).toHaveValue('只读历史等待期间继续编辑');
        assert(
          !(fixture.state.shellFrames || []).some(
            (item) =>
              item.type === 'terminal.input' ||
              item.type === 'terminal.mouse' ||
              item.type === 'terminal.scroll',
          ),
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          geometry,
          initialLeadingBlankRows: beforeFill.findIndex((line) => line.trim()),
          historyReadRequests: requests().length,
          continuousScroll: scrolling,
          fillsExistingHistory: true,
          shortSessionDoesNotInventHistory: true,
          keyboardPreservesBottom: true,
          draftEditableDuringRead: true,
          nativeInput: false,
          eventSource: 'Isolated Firefox viewport, not physical phone input',
        });
      } finally {
        release();
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
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, results }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

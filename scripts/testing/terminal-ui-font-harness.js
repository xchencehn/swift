'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
async function measure(host) {
  const rows = host.querySelector('.xterm-rows'),
    screen = host.querySelector('.xterm-screen');
  const box = screen.getBoundingClientRect(),
    bars = [];
  for (const row of [...rows.children].slice(0, 6)) {
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const index = node.textContent.indexOf('│');
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      bars.push(range.getBoundingClientRect().x);
      break;
    }
  }
  const style = getComputedStyle(rows),
    cursor = rows.querySelector('.xterm-cursor')?.getBoundingClientRect();
  return {
    font: style.fontFamily,
    fontSize: parseFloat(style.fontSize),
    rowHeight: rows.firstElementChild.getBoundingClientRect().height,
    screen: { x: box.x, y: box.y, right: box.right, width: box.width },
    bars,
    cursorX: cursor?.x,
    bodyWidth: document.documentElement.scrollWidth,
    viewport: innerWidth,
    fontLoaded: document.fonts.check('14px "Cascadia Mono"'),
    asciiWidths: [...rows.children].slice(0, 3).flatMap((row) => {
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT),
        widths = [];
      let node;
      while ((node = walk.nextNode()))
        for (let i = 0; i < node.length; i++) {
          if (!/[A-Za-z.]/.test(node.textContent[i])) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          widths.push(range.getBoundingClientRect().width);
        }
      return widths;
    }),
    fitted: [...rows.querySelectorAll('[data-ui-glyph-fit]')].map((el) => ({
      outer: el.getBoundingClientRect().width,
      inner: el.firstElementChild.getBoundingClientRect().width,
      text: el.textContent,
    })),
  };
}
(async () => {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve('artifacts/terminal-ui-font');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900, terminalScale: 1 },
      { name: 'tablet', width: 1024, height: 768, touch: true, terminalScale: 1 },
      { name: 'mobile', width: 390, height: 844, touch: true, terminalScale: 11.5 / 14 },
      { name: 'small-mobile', width: 320, height: 740, touch: true, terminalScale: 11.5 / 14 },
      { name: 'phone-landscape', width: 844, height: 390, touch: true, terminalScale: 11.5 / 14 },
      { name: 'narrow-desktop', width: 390, height: 740, terminalScale: 1 },
    ]) {
      const fixture = await createFixture();
      fixture.state.terminalPreview = true;
      const column = viewport.width < 500 ? 12 : 30;
      fixture.state.nativeTerminalText =
        ['iiiiiiii', 'WWWWWWWW', 'README.md', '中文字体', 'Il1O0MW', '\x1b[1mBold\x1b[0m']
          .map((text, i) => `\x1b[${i + 1};1H${text}\x1b[${i + 1};${column}H│ col ${column}`)
          .join('') +
        '\x1b[8;1H› cursor\x1b[10;1Hhttps://asc.gitcode.com/api/SIMD-API/basic_api/sync_control/inter_core_sync/SyncAll.html\x1b[8;5H';
      const context = await browser.newContext({
        viewport,
        screen: { width: viewport.width, height: viewport.height },
        hasTouch: !!viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('README.md');
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.evaluate(() => document.fonts.ready);
        const connections = fixture.state.shellConnections;
        for (const size of [14, 20]) {
          await page.evaluate((value) => StudioDeviceFont.apply(value), size);
          await page.waitForTimeout(150);
          fixture.shellFrame(fixture.state.nativeTerminalText, 'pane-codex', { full: true });
          await page.waitForTimeout(150);
          const metrics = await terminal.evaluate(measure),
            expectedSize = size * viewport.terminalScale;
          assert(metrics.font.startsWith('"Cascadia Mono"') && metrics.fontLoaded);
          assert(
            Math.abs(metrics.fontSize - expectedSize) < 0.01,
            JSON.stringify({
              viewport: viewport.name,
              size,
              expectedSize,
              fontSize: metrics.fontSize,
            }),
          );
          assert.equal(
            metrics.bars.length,
            6,
            JSON.stringify({
              viewport: viewport.name,
              size,
              rowHeight: metrics.rowHeight,
              bars: metrics.bars,
            }),
          );
          assert(
            Math.max(...metrics.bars) - Math.min(...metrics.bars) < 1,
            'Different glyph widths must retain the same column',
          );
          const cellWidth = (metrics.bars[0] - metrics.screen.x) / (column - 1);
          assert(
            cellWidth / metrics.fontSize > 0.5 && cellWidth / metrics.fontSize < 0.8,
            'Terminal advance must stay compact',
          );
          assert(
            Math.abs(metrics.cursorX - (metrics.screen.x + 4 * cellWidth)) < 1,
            'Cursor must remain on column five',
          );
          await fs.writeFile(
            path.join(output, `${viewport.name}-${size}-metrics.json`),
            JSON.stringify(metrics, null, 2) + '\n',
          );
          assert.equal(metrics.fitted.length, 0, 'Monospaced fonts must not compress glyphs');
          assert(metrics.asciiWidths.length > 20);
          assert(
            Math.max(...metrics.asciiWidths) - Math.min(...metrics.asciiWidths) < 0.15,
            'ASCII letters must have equal natural advances',
          );
          assert(
            metrics.fitted.every((el) => el.inner <= el.outer + 1),
            'Wide glyphs must fit in their cells',
          );
          assert(metrics.bodyWidth <= viewport.width && metrics.screen.right <= viewport.width + 1);
          const start = fixture.state.shellFrames.length;
          await page.mouse.click(
            metrics.screen.x + 4.5 * cellWidth,
            metrics.screen.y + metrics.rowHeight / 2,
          );
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .slice(start)
                .some((frame) => frame.type === 'terminal.mouse' && frame.action === 'down'),
            )
            .toBe(true);
          const down = fixture.state.shellFrames
            .slice(start)
            .find((frame) => frame.type === 'terminal.mouse' && frame.action === 'down');
          assert.equal(down.column, 4);
          assert.equal(down.row, 0);
          await page.screenshot({ path: path.join(output, `${viewport.name}-${size}.png`) });
          results.push({
            viewport: viewport.name,
            size,
            ...metrics,
            mouse: { column: down.column, row: down.row },
          });
        }
        for (const size of [7, 16.5, 24, 0]) {
          await page.evaluate((value) => StudioTerminalFont.apply(value), size);
          const expected = ((size || 14 * viewport.terminalScale) * 20) / 14;
          await expect
            .poll(
              async () => Math.abs((await terminal.evaluate(measure)).fontSize - expected) < 0.01,
            )
            .toBe(true);
        }
        assert.equal(
          fixture.state.shellConnections,
          connections,
          'Font scaling must retain the terminal connection',
        );
        assert.equal(
          fixture.state.shellFrames.filter((frame) => frame.type === 'terminal.input').length,
          0,
        );
        assert.deepEqual(errors, []);
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
    JSON.stringify({ ok: true, before, after, results, productionInput: false }, null, 2) + '\n',
  );
  console.log(
    'PASS terminal font: six viewports, scaling, natural equal ASCII advances, columns, cursor and mouse coordinates.',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

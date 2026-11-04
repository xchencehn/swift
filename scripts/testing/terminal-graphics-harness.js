'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline');
(async () => {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve(
      process.env.SWIFT_TERMINAL_GRAPHICS_OUTPUT || 'artifacts/testing/terminal-home-rendering',
      baseline ? 'baseline' : 'browser',
    );
  await fs.mkdir(output, { recursive: true });
  const logo = (await fs.readFile('test/fixtures/terminal-home-logo.txt', 'utf8'))
    .trimEnd()
    .split('\n');
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const actions = [],
        cols = 120,
        rows = 64,
        lines = Array(rows).fill('');
      lines[0] = 'OpenAI Codex';
      logo.forEach((line, y) => {
        lines[24 + y] = line;
      });
      lines[45] = '⣿'.repeat(8);
      lines[46] = '⣿'.repeat(8);
      lines[47] = '⠁⠂⠄⠈⠐⠠⡀⢀';
      lines[60] = '> Ask Codex to do anything';
      lines[62] = 'GPT-6-Astra high · weekly 41% left';
      lines[63] = '? for shortcuts';
      const runtime = {
        bind(state) {
          state.terminalChannelVersion = 2;
        },
        attach({ ws, url }) {
          const pane = fixture.state.sessions[url.searchParams.get('pane')].pane;
          ws.send(
            JSON.stringify({
              type: 'terminal.ready',
              transport: 'shell',
              terminalId: pane.terminalId,
              paneId: pane.paneId,
              stateFormat: 'cells-v1',
            }),
          );
          const row = (line) => ({
            soft_wrapped: false,
            wrap_continuation: false,
            cells: Array.from({ length: cols }, (_, x) => [line[x] || ' ', 1, -1, -1, 0, -1, null]),
          });
          ws.send(
            Buffer.from(
              JSON.stringify({
                type: 'terminal_state',
                version: 1,
                terminal_id: pane.terminalId,
                boot_id: 'graphics',
                revision: 1,
                base_revision: null,
                cols,
                rows,
                first_row: 0,
                total_rows: rows,
                cursor: [2, 60, true],
                alternate_screen: false,
                mouse_tracking: false,
                mouse_sgr: false,
                mouse_pixels: false,
                bracketed_paste: false,
                changes: lines.map((line, y) => [y, row(line)]),
              }) + '\n',
            ),
          );
          ws.on('message', (raw) => actions.push(JSON.parse(String(raw))));
        },
      };
      const fixture = await createFixture({ terminalRuntime: runtime });
      fixture.state.terminalPreview = true;
      const context = await browser.newContext({
          viewport,
          screen: viewport,
          hasTouch: viewport.width < 500,
          serviceWorkers: 'block',
        }),
        page = await context.newPage();
      try {
        if (baseline)
          for (const file of [
            'vendor/xterm/xterm.js',
            'vendor/xterm/xterm.css',
            'chat/terminal-state-renderer.js',
          ]) {
            const body = execFileSync('git', ['show', 'HEAD:public/' + file]);
            await page.route('**/' + file + '*', (route) =>
              route.fulfill({
                body,
                contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
              }),
            );
          }
        if (baseline) {
          const current = await fs.readFile('public/chat/terminal-state-renderer.js', 'utf8');
          const previous = execFileSync(
            'git',
            ['show', 'HEAD:public/chat/terminal-state-renderer.js'],
            { encoding: 'utf8' },
          );
          await page.route('**/assets/startup.js*', async (route) => {
            const response = await route.fetch();
            const body = await response.text();
            assert(body.includes(current));
            await route.fulfill({ response, body: body.replace(current, previous) });
          });
        }
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('Ask Codex');
        await page.evaluate(() => document.fonts.ready);
        const metrics = await terminal.evaluate((host) => {
          const rows = host.querySelector('.xterm-rows'),
            glyphs = [...rows.querySelectorAll('.xterm-braille')],
            full = glyphs.filter((el) => /^⣿+$/.test(el.textContent));
          return {
            text: rows.textContent,
            rows: rows.children.length,
            glyphs: glyphs.reduce((n, el) => n + el.textContent.length, 0),
            spans: glyphs.length,
            fullCells: full.flatMap((el) => {
              const r = el.getBoundingClientRect(),
                style = getComputedStyle(el, '::after');
              return Array.from(el.textContent, (_, i) => ({
                x: r.x + (i * r.width) / el.textContent.length,
                y: r.y,
                width: r.width / el.textContent.length,
                height: r.height,
                mask: style.backgroundImage,
              }));
            }),
            rowHeight: rows.firstElementChild.getBoundingClientRect().height,
            weight: getComputedStyle(rows).fontWeight,
          };
        });
        if (!baseline) {
          assert(
            metrics.text.includes('GPT-6-Astra high') && metrics.text.includes('? for shortcuts'),
            'complete native footer must remain visible',
          );
          assert(metrics.glyphs > 100);
          assert.equal(metrics.weight, '400');
          assert(
            metrics.fullCells.every(
              (c) => c.mask.startsWith('url(') && c.height === metrics.rowHeight,
            ),
          );
          const last = metrics.fullCells.at(-1),
            above = metrics.fullCells.at(-9);
          assert(
            Math.abs(last.y - above.y - last.height) < 0.1,
            'adjacent dot grids must meet without a line-height gap',
          );
          assert(Math.abs(last.x - above.x) < 0.1, 'dot columns must align between lines');
        }
        if (baseline && viewport.width > 500)
          assert(
            !metrics.text.includes('GPT-6-Astra high'),
            'baseline must reproduce the missing footer',
          );
        assert(
          !actions.some((a) => ['terminal.input', 'terminal.key'].includes(a.type)),
          'observation cannot send input',
        );
        await page.screenshot({ path: path.join(output, `${viewport.width}.png`) });
        await terminal
          .locator('.xterm-rows')
          .screenshot({ path: path.join(output, `${viewport.width}-terminal.png`) });
        results.push({ viewport, ...metrics, productionInput: false });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(sourceFingerprint(process.cwd()), before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, baseline, before, results }, null, 2) + '\n',
  );
  console.log(
    (baseline ? 'BASELINE recorded: ' : 'PASS native cells: ') +
      ' contiguous Braille grids, complete status/hint rows, normal weight and observation without input.',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

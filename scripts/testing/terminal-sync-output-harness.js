'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline');
const output = path.resolve(
  process.env.SWIFT_TERMINAL_SYNC_OUTPUT || 'artifacts/testing/terminal-sync-output',
  baseline ? 'baseline' : 'candidate',
);
const frame = (revision) =>
  Buffer.from(
    '\x1b[?2026h\x1b[?7l' +
      Array.from(
        { length: 180 },
        (_, y) =>
          `\x1b[${y + 1};1HROW_${String(y).padStart(3, '0')} ` + '中文'.repeat(12) + 'a'.repeat(40),
      ).join('') +
      `\x1b[175;1HSTABLE_ANCHOR 中文\x1b[K\x1b[178;1HLATEST_${revision}\x1b[K\x1b[179;5H\x1b[?25h\x1b[?2026l`,
  );
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'narrow', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      if (baseline)
        await page.route('**/assets/startup.js*', async (route) => {
          const response = await route.fetch(),
            bundle = await response.text();
          const current = await fs.readFile('public/chat/terminal-renderer.js', 'utf8');
          assert(bundle.includes(current));
          await route.fulfill({
            response,
            body: bundle.replace(
              current,
              execFileSync('git', ['show', '2e1d522:public/chat/terminal-renderer.js'], {
                encoding: 'utf8',
              }),
            ),
          });
        });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('保留终端抖动回归草稿');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        const host = page.locator('#shellTerminal');
        await expect(host).toContainText('OpenAI Codex');
        fixture.shellFrame(frame(0), 'pane-codex', {
          full: true,
          geometry: { cols: 100, rows: 200 },
        });
        await expect(host).toContainText('STABLE_ANCHOR');
        await page.waitForTimeout(120);
        await page.evaluate(() => {
          window.syncProbe = {
            samples: 0,
            missing: 0,
            positions: [],
            writes: 0,
            bytes: 0,
            sentAt: {},
            seenAt: {},
          };
          const write = Terminal.prototype.write;
          Terminal.prototype.write = function (data, ...rest) {
            if (this.element) {
              syncProbe.writes++;
              syncProbe.bytes += new TextEncoder().encode(data).length;
            }
            return write.call(this, data, ...rest);
          };
          const sample = () => {
            const p = syncProbe,
              rows = [...document.querySelectorAll('#shellTerminal .xterm-rows > div')];
            const anchor = rows.find((row) => row.textContent.includes('STABLE_ANCHOR'));
            p.samples++;
            if (!anchor) p.missing++;
            else p.positions.push(anchor.getBoundingClientRect().top);
            const latest = rows
              .map((row) => row.textContent)
              .join('\n')
              .match(/LATEST_(\d+)/);
            if (latest && p.seenAt[latest[1]] === undefined)
              p.seenAt[latest[1]] = performance.now();
            p.frame = requestAnimationFrame(sample);
          };
          syncProbe.frame = requestAnimationFrame(sample);
        });
        for (let revision = 1; revision <= 12; revision++) {
          const bytes = frame(revision),
            cuts = [0, 16384, bytes.length - 3, bytes.length];
          for (let i = 0; i < cuts.length - 1; i++) {
            if (i === cuts.length - 2)
              await page.evaluate((revision) => {
                syncProbe.sentAt[revision] = performance.now();
              }, revision);
            fixture.shellFrame(bytes.subarray(cuts[i], cuts[i + 1]), 'pane-codex', {
              full: i === 0,
            });
            if (i < cuts.length - 2) {
              await page.waitForTimeout(45);
              if (revision === 1 && i === 0)
                await page.screenshot({ path: path.join(output, viewport.name + '-partial.png') });
            }
          }
          await expect(host).toContainText('LATEST_' + revision);
          await expect
            .poll(() =>
              page.evaluate((revision) => syncProbe.seenAt[revision] !== undefined, revision),
            )
            .toBe(true);
        }
        const metrics = await page.evaluate(() => {
          cancelAnimationFrame(syncProbe.frame);
          const { frame, positions, sentAt, seenAt, ...rest } = syncProbe;
          const values = Object.entries(sentAt)
            .map(([revision, at]) => Math.max(0, seenAt[revision] - at))
            .sort((a, b) => a - b);
          return {
            ...rest,
            movement: Math.max(...positions) - Math.min(...positions),
            completionMs: {
              samples: values.length,
              p50: values[Math.floor(values.length * 0.5)],
              p95: values.at(-1),
              max: values.at(-1),
            },
          };
        });
        if (baseline)
          assert(
            metrics.missing > 0 || metrics.movement > 1,
            'The baseline must expose incomplete screens',
          );
        else {
          assert.equal(metrics.missing, 0);
          assert.equal(metrics.movement, 0);
        }
        await page.screenshot({ path: path.join(output, viewport.name + '-complete.png') });
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await expect(page.locator('#commandInput')).toHaveValue('保留终端抖动回归草稿');
        assert.equal(
          (fixture.state.shellFrames || []).filter((m) => m.type === 'terminal.input').length,
          0,
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          frameBytes: frame(0).length,
          ...metrics,
          nativeInput: 0,
        });
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
    `PASS ${baseline ? 'reproduced partial synchronized repaints' : 'atomic synchronized repaints'}: ${results.length} viewports.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

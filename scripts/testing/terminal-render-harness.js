'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const output = path.resolve(
    'artifacts/testing/transcript-terminal-consistency',
    baseline ? 'render-baseline' : 'render',
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
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#commandInput')).toBeEnabled();
        await page.locator('#commandInput').fill('保留终端切换草稿');
        const toggle = page.getByRole('button', { name: '切换到终端模式', exact: true }),
          box = await toggle.boundingBox();
        const icon = await toggle.locator('svg').elementHandle();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        fixture.changed();
        await fixture.synced();
        await page.waitForTimeout(180);
        assert(
          await icon.evaluate((node) => node.isConnected),
          'Polling must retain the pressed mode icon',
        );
        await page.mouse.up();
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('OpenAI Codex');
        await page.evaluate(() => {
          window.renderProbe = { resets: 0, blanks: 0, samples: 0, markers: 0 };
          const reset = Terminal.prototype.reset;
          Terminal.prototype.reset = function (...args) {
            window.renderProbe.resets++;
            return reset.apply(this, args);
          };
          const sample = () => {
            const text = document.querySelector('#shellTerminal .xterm-rows')?.textContent || '';
            window.renderProbe.samples++;
            if (!text.trim()) window.renderProbe.blanks++;
            window.renderProbe.frame = requestAnimationFrame(sample);
          };
          window.renderProbe.frame = requestAnimationFrame(sample);
        });
        // A full marker and its bytes are separate WebSocket messages. A slow
        // network must keep the previous screen visible between them.
        for (let index = 0; index < 8; index++) {
          fixture.shellFrame('', 'pane-codex', { full: true, markerOnly: true });
          await page.waitForTimeout(65);
          if (index === 1)
            await page.screenshot({
              path: path.join(output, viewport.name + '-awaiting-frame.png'),
            });
          fixture.shellFrame(
            `\x1b[?2026h\x1b[2J\x1b[HSTABLE SCREEN ${index}\r\n中文完整帧 · 终端持续显示\r\n\x1b[?2026l`,
            'pane-codex',
          );
          await expect(terminal).toContainText('STABLE SCREEN ' + index);
        }
        const metrics = await page.evaluate(() => {
          cancelAnimationFrame(window.renderProbe.frame);
          const { frame, ...result } = window.renderProbe;
          return result;
        });
        if (baseline) {
          assert(metrics.resets >= 8);
          assert(metrics.blanks > 0);
        } else {
          assert.equal(metrics.resets, 0);
          assert.equal(metrics.blanks, 0);
        }
        const connections = fixture.state.shellConnections;
        for (let index = 0; index < 8; index++) fixture.changed();
        await page.waitForTimeout(300);
        assert.equal(
          fixture.state.shellConnections,
          connections,
          'Polling must retain the terminal instance',
        );
        await page.screenshot({ path: path.join(output, viewport.name + '-complete.png') });
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await expect(page.locator('#commandInput')).toHaveValue('保留终端切换草稿');
        assert.deepEqual(errors, []);
        assert.equal(
          (fixture.state.shellFrames || []).filter((message) => message.type === 'terminal.input')
            .length,
          0,
        );
        results.push({
          viewport,
          ...metrics,
          connections,
          pollingPreservesInstance: true,
          draftPreserved: true,
          noInput: true,
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
    JSON.stringify({ ok: true, baseline, before, after, results }, null, 2) + '\n',
  );
  console.log(
    `PASS ${baseline ? 'reproduced blank frames' : 'no blank frames or resets'}: ${results.length} viewports.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

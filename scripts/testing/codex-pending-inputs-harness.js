'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/codex-pending-messages/browser');
const title = 'Messages to be submitted after next tool call';
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.width <= 1024,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => {
        errors.push(e.message);
        console.error(e.message);
      });
      let frame;
      const screen = new TerminalScreen({
        cols: 180,
        rows: 45,
        onScreen: (value) => {
          frame = value;
        },
      });
      const publish = async (
        pending,
        activity = '• Compacting context (2m 51s • esc to interrupt)',
      ) => {
        await screen.feed(
          '\x1b[H\x1b[2J' +
            activity +
            '\r\n  └ Making room to continue.\r\n\r\n' +
            pending +
            '\r\n\r\n› \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\nGPT-6-Astra xhigh · ~/workdir/compete · Ready',
          { full: true },
        );
        fixture.nativeScreen(frame, 'pane-codex');
      };
      const pending = `• ${title} (press esc to interrupt and send immediately)\r\n  ↳ 你对精度的要求是和任务书对齐的吗？\r\n  ↳ 这个算子的讨论帖有没有相关信息？${'请核对。'.repeat(15)}`;
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await page.locator('#commandInput').fill('仍在编辑的下一条草稿');
        await publish(pending);
        const box = page.locator('#chatPendingInputs');
        await expect(box).toContainText(title);
        await expect(box.locator('.chat-pending-message')).toHaveCount(2);
        await expect(page.locator('#chatExecutionState')).toHaveText('Compacting context');
        await expect(page.locator('#chatLog')).not.toContainText('你对精度');
        const geometry = await page.evaluate(() => {
          const rect = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
          return {
            status: rect('chatControls'),
            pending: rect('chatPendingInputs'),
            input: rect('chatInput'),
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        assert(
          geometry.status.bottom <= geometry.pending.top + 1 &&
            geometry.pending.bottom <= geometry.input.top + 1,
          JSON.stringify(geometry),
        );
        assert(
          geometry.pending.left >= 0 &&
            geometry.pending.right <= viewport.width &&
            geometry.input.bottom <= viewport.height &&
            geometry.overflow === 0,
          JSON.stringify(geometry),
        );
        await page.screenshot({ path: path.join(output, viewport.width + '-dark.png') });
        await page.evaluate(() => {
          window.pendingNode = document.querySelector('.chat-pending-message');
        });
        await publish(pending, '• Compacting context (2m 52s • esc to interrupt)');
        await expect(page.locator('#chatExecutionElapsed')).toContainText('2m 52s');
        assert(
          await page.evaluate(
            () => window.pendingNode === document.querySelector('.chat-pending-message'),
          ),
        );
        await page.evaluate(() => window.StudioDeviceTheme.apply('light', false));
        await page.addStyleTag({ content: ':root {--device-font-scale:1.5 !important}' });
        await page.screenshot({ path: path.join(output, viewport.width + '-light-large.png') });
        fixture.nativeEnded();
        await expect(box).toBeHidden();
        fixture.nativeFull();
        await publish(pending);
        await expect(box).toBeVisible();
        await publish('');
        await expect(box).toBeHidden();
        await publish('• Messages to be submitted at end of turn\r\n  ↳ 本轮结束后发送');
        await expect(box).toContainText('Messages to be submitted at end of turn');
        await page.reload();
        await expect(box).toContainText('Messages to be submitted at end of turn');
        await expect(page.locator('#commandInput')).toHaveValue('仍在编辑的下一条草稿');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(box).toBeHidden();
        assert.equal(
          fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
          0,
        );
        assert(!fixture.state.frames.some((f) => f.includes('terminal.input')));
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          geometry,
          stableNodes: true,
          clearedAndStaleHidden: true,
          restoredAndSessionIsolated: true,
          noNativeInput: true,
        });
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, viewport.width + '-failure.png') })
          .catch(() => {});
        throw error;
      } finally {
        screen.close();
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
  console.log(
    'PASS pending messages: four widths, queue transitions, draft, session isolation and no native input.',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

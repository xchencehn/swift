'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict'),
  { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { ConversationStore } = require('../../lib/conversation-store');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const line = (entry) => JSON.stringify(entry) + '\n';
const text = (role, value) => ({
  type: 'response_item',
  timestamp: '2026-10-24T08:48:58Z',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }],
  },
});

(async () => {
  const output = path.resolve('artifacts/testing/context-compacted/browser');
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      for (const sync of [false, true]) {
        const name = viewport.name + (sync ? '-sync' : '-poll');
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-compaction-')),
          file = path.join(home, 'rollout-fixture.jsonl');
        const store = new ConversationStore(),
          fixture = await createFixture();
        fixture.state.sync = sync;
        fixture.state.productionPresentation = true;
        const session = fixture.state.sessions['pane-codex'];
        const entries = [
          { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
          text('user', '继续原来的任务'),
          text('assistant', '压缩前的正常消息'),
          {
            type: 'compacted',
            timestamp: '2026-10-24T08:48:58.287Z',
            payload: { message: 'INTERNAL SUMMARY', replacement_history: [] },
          },
        ];
        await fs.writeFile(file, entries.map(line).join(''));
        const refresh = async () => {
          session.messages = (await store.read(file, 'codex')).conversation;
          fixture.changed();
          if (sync) await fixture.synced();
        };
        await refresh();
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const marker = page.locator('.chat-msg[data-kind="compacted"]');
        try {
          await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
          await expect(marker).toHaveCount(1);
          await expect(marker).toContainText('Context compacted');
          await expect(marker).not.toContainText('·');
          await page.locator('#commandInput').fill('仍未发送的中文草稿');
          const markerId = await marker.getAttribute('data-message-id');
          const completed = {
            type: 'event_msg',
            timestamp: '2026-10-24T08:48:58.312Z',
            payload: {
              type: 'item_completed',
              thread_id: 'fixture-thread',
              turn_id: 'first',
              item: { type: 'ContextCompaction', id: 'fixture-compaction' },
              started_at_ms: 1792831600594,
              completed_at_ms: 1792831743594,
            },
          };
          await fs.appendFile(file, line(completed));
          await refresh();
          await expect(marker).toHaveCount(1);
          await expect(marker).toContainText('Context compacted · 2m 23s');
          assert.equal(await marker.getAttribute('data-message-id'), markerId);
          await fs.appendFile(file, line(completed) + line(text('assistant', '压缩后的正常消息')));
          await refresh();
          await expect(marker).toHaveCount(1);
          await expect(page.locator('#chatLog')).toContainText('压缩后的正常消息');
          await expect(page.locator('#chatLog')).toContainText('压缩前的正常消息');
          await expect(page.locator('#chatLog')).not.toContainText('INTERNAL SUMMARY');
          const order = await page.locator('#chatLog .chat-msg').allTextContents();
          assert(
            order.findIndex((t) => t.includes('压缩前的正常消息')) <
              order.findIndex((t) => t.includes('Context compacted')),
          );
          assert(
            order.findIndex((t) => t.includes('Context compacted')) <
              order.findIndex((t) => t.includes('压缩后的正常消息')),
          );
          await page.reload();
          await expect(marker).toContainText('Context compacted · 2m 23s');
          await expect(page.locator('#commandInput')).toHaveValue('仍未发送的中文草稿');
          const geometry = await marker.locator('.chat-block').evaluate((el) => {
            const r = el.getBoundingClientRect(),
              style = getComputedStyle(el);
            return {
              left: r.left,
              right: r.right,
              width: innerWidth,
              color: style.color,
              fontFamily: style.fontFamily,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert(!geometry.overflow && geometry.left >= -1 && geometry.right <= geometry.width + 1);
          assert(geometry.fontFamily.includes('monospace'));
          await page.screenshot({ path: path.join(output, name + '.png') });
          // A rolled-back turn removes its own compaction record as well.
          await fs.appendFile(
            file,
            line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } }) +
              line(text('user', '这轮将会回退')) +
              line({
                ...completed,
                payload: {
                  ...completed.payload,
                  turn_id: 'second',
                  item: { type: 'ContextCompaction', id: 'rollback' },
                },
              }),
          );
          await refresh();
          await expect(marker).toHaveCount(2);
          await fs.appendFile(
            file,
            line({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }),
          );
          await refresh();
          await expect(marker).toHaveCount(1);
          await expect(page.locator('#chatLog')).not.toContainText('这轮将会回退');
          await expect(page.locator('#commandInput')).toHaveValue('仍未发送的中文草稿');
          assert.equal(
            fixture.state.requests.filter((r) => r.route.startsWith('POST /api/messages')).length,
            0,
          );
          assert.equal(
            fixture.state.frames.filter((frame) => frame.includes('terminal.input')).length,
            0,
          );
          assert.deepEqual(errors, []);
          results.push({
            viewport,
            sync,
            orderedNativeMarker: true,
            durationUpdatedOnce: true,
            stableId: true,
            noPrivateSummary: true,
            normalMessagesPreserved: true,
            reloadAndDraft: true,
            rollback: true,
            noNativeInput: true,
            geometry,
          });
        } catch (error) {
          await page.screenshot({ path: path.join(output, name + '-failure.png') }).catch(() => {});
          throw error;
        } finally {
          await context.close();
          await fixture.close();
          await fs.rm(home, { recursive: true, force: true });
        }
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
    `PASS native compaction history, duration, sync, drafts and rollback: ${results.length} browser scenarios.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

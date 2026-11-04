#!/usr/bin/env node
'use strict';
// Real app, MessageQueue and RewindInteraction; native operations are isolated fixture methods.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { MessageQueue } = require('../../lib/message-queue');
const { RewindInteraction } = require('../../lib/rewind-interaction');
const C = require('../../lib/conversation-state');
const { digest } = require('../../lib/codex-rewind-history');
const output = path.resolve(__dirname, '../../artifacts/message-rewind-recovery/browser');
const normalDraft = '编辑之前的普通中文草稿';
const editedText = '确认主会话恢复后显式发送的历史编辑';
const rejection = '尚未确认原生会话，内容未发送。Swift 会自动重新检查，请稍后再发送。';
const viewports = [
  { name: 'desktop', width: 1920, height: 1080, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'mobile-small', width: 320, height: 740, touch: true },
];
async function run() {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch({ headless: true }),
    results = [];
  try {
    for (const viewport of viewports)
      for (const scenario of ['preflight', 'lost-preflight', 'legacy-restart', 'send-uncertain']) {
        const fixture = await createFixture(),
          directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-rewind-recovery-browser-'));
        fixture.state.unified = true;
        const session = fixture.state.sessions['pane-codex'],
          pane = session.pane;
        pane.runtimeId = 'fixture-codex-process';
        pane.agent.label = 'codex';
        const sourceText = '需要编辑的历史中文原文';
        session.messages.push({
          id: 'recovery-original-user',
          role: 'user',
          sourceText,
          blocks: [{ kind: 'text', text: sourceText }],
        });
        let history = {
          complete: true,
          revision: 'fixture-original-history',
          targets: session.messages
            .filter((m) => m.role === 'user')
            .map((m, i) => ({
              messageId: m.id,
              turnId: 'fixture-turn-' + i,
              sourceRecordId: 'fixture-source-' + i,
              sourceText:
                m.sourceText ||
                m.blocks
                  .filter((b) => b.kind === 'text')
                  .map((b) => b.text)
                  .join('\n'),
              supported: true,
              visibleIndex: i,
            })),
        };
        let nativeMode = scenario === 'send-uncertain' ? 'main' : 'unknown',
          observedMode = nativeMode,
          observedBinding = C.binding(pane),
          sideRevision = 0;
        const nativeCalls = [],
          posts = [],
          prepares = [],
          observations = [],
          errors = [];
        let beforeWrites = 0,
          receiptReads = 0;
        const binding = C.binding(pane),
          queueFile = path.join(directory, 'queue.json');
        const deps = {
          target: async () => structuredClone(pane),
          readHistory: async () => structuredClone(history),
          scope: () => '/fixture/workdir',
          beforeWrite: async () => {
            beforeWrites++;
            if (nativeMode !== 'main')
              throw Object.assign(new Error(rejection), {
                code: 'SIDE_UNKNOWN',
                deliveryUncertain: false,
                retryable: true,
              });
          },
          native: {
            async select({ target, verify }) {
              await verify();
              nativeCalls.push('select');
              return { messageId: target.messageId, turnId: target.turnId };
            },
            async confirm({ target, verify }) {
              await verify();
              nativeCalls.push('confirm');
              history = { ...history, targets: history.targets.slice(0, target.visibleIndex) };
              history.revision = digest(history.targets);
              session.messages = session.messages.slice(
                0,
                session.messages.findIndex((m) => m.id === target.messageId),
              );
            },
            async replace({ verify }) {
              await verify();
              nativeCalls.push('replace');
            },
            async send({ text, verify }) {
              await verify();
              nativeCalls.push('send');
              if (scenario === 'send-uncertain')
                throw Object.assign(new Error('原生发送结果待确认'), { code: 'FIXTURE_ACK_LOST' });
              session.messages.push({
                id: 'recovery-sent-user',
                role: 'user',
                sourceText: text,
                blocks: [{ kind: 'text', text }],
              });
              return { nativeUserMessageId: 'fixture-accepted-user' };
            },
            async read() {
              return { mode: 'main', input: '' };
            },
            async cancel() {
              nativeCalls.push('cancel');
            },
          },
        };
        let controller = new RewindInteraction(deps),
          clockOffset = 0;
        const queueOptions = {
          file: queueFile,
          now: () => Date.now() + clockOffset,
          getNativePane: async () => structuredClone(pane),
          readMessages: async () => structuredClone(session.messages),
          sendNative: (item, progress) => controller.submit(item, progress),
        };
        let queue = new MessageQueue(queueOptions);
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
        const result = {
          viewport,
          scenario,
          ok: false,
          realApp: true,
          realQueue: true,
          realRewindController: true,
          nativeIsFixture: true,
        };
        let page;
        try {
          await context.addInitScript(() =>
            Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }),
          );
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === fixture.url
              ? route.continue()
              : route.abort(),
          );
          page = await context.newPage();
          page.setDefaultTimeout(7000);
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('**/api/agents/side?*', (route) => {
            observations.push(sideRevision);
            return route.fulfill({
              json: {
                supported: true,
                mode: observedMode,
                hasSide: false,
                canClose: false,
                binding: observedBinding,
                revision: 'recovery-side-' + sideRevision,
              },
            });
          });
          await page.route('**/api/agents/rewind', async (route) => {
            const body = route.request().postDataJSON();
            prepares.push(body);
            try {
              return await route.fulfill({ json: await controller.prepare(body) });
            } catch (error) {
              return route.fulfill({
                status: error.status || 500,
                json: {
                  ok: false,
                  code: error.code,
                  message: error.message,
                  deliveryUncertain: false,
                  retryable: false,
                },
              });
            }
          });
          await page.route('**/api/messages', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const body = route.request().postDataJSON();
            posts.push(body);
            if (scenario === 'legacy-restart' && posts.length === 2) clockOffset = -60000;
            let message = await queue.submitNative(body);
            if (scenario === 'legacy-restart' && posts.length === 1) {
              // Persist the exact 0.15.21 preflight shape, then replace both server objects.
              const legacy = queue.items.find((item) => item.id === body.id);
              delete legacy.rewindProgress.nativeStarted;
              legacy.retryable = false;
              queue.persist([legacy], { notify: false });
              message = structuredClone(legacy);
              controller = new RewindInteraction(deps);
              queue = new MessageQueue(queueOptions);
              assert.equal(controller.preparations.size, 0);
            }
            session.queue = queue.list(pane.paneId);
            if (scenario === 'lost-preflight' && posts.length === 1) return route.abort('failed');
            return route.fulfill({ status: 202, json: { ok: true, message } });
          });
          await page.route('**/api/messages?*', (route) => {
            receiptReads++;
            const url = new URL(route.request().url()),
              id = url.searchParams.get('id');
            return route.fulfill({
              json: {
                ok: true,
                messages: queue.list(pane.paneId).filter((item) => !id || item.id === id),
              },
            });
          });
          await page.goto(`${fixture.url}/?token=fixture&view=chat`);
          const input = page.locator('#commandInput'),
            error = page.locator('#chatComposerError'),
            bar = page.locator('.chat-message-edit'),
            send = page.locator('#sendButton');
          const bubble = page.locator('.chat-msg[data-message-id="recovery-original-user"]');
          await expect(bubble).toBeVisible();
          await input.fill(normalDraft);
          await page.locator('#attachInput').setInputFiles({
            name: '原草稿附件.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('original attachment'),
          });
          await expect(page.locator('#attachmentList')).not.toContainText('上传中');
          await bubble.scrollIntoViewIfNeeded();
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const point = await bubble.evaluate((el) => {
            const b = el.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + 5 };
          });
          await page.mouse.click(point.x, point.y, { button: 'right' });
          await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
          await expect(input).toHaveValue(sourceText);
          await input.fill(editedText);
          await send.click();
          if (scenario === 'send-uncertain') {
            await expect(page.locator('.chat-message-edit-label')).toHaveText(
              '编辑消息的发送结果待确认',
            );
            await expect(send).toBeDisabled();
            const before = posts.length;
            nativeMode = 'main';
            observedMode = 'main';
            sideRevision++;
            fixture.changed();
            await expect.poll(() => observations.includes(sideRevision)).toBe(true);
            await expect(error).toHaveText('原生发送结果待确认');
            await expect(
              page.getByRole('button', { name: '取消编辑历史消息', exact: true }),
            ).toBeDisabled();
            assert.equal(posts.length, before);
            assert.deepEqual(nativeCalls, ['select', 'confirm', 'replace', 'send']);
            assert.equal(posts.length, 1);
            assert.equal(queue.items[0].deliveryUncertain, true);
            result.uncertainNeverReplays = true;
          } else {
            await expect(page.locator('.chat-message-edit-label')).toHaveText('正在编辑历史消息');
            await expect(error).toHaveText(rejection);
            assert.deepEqual(nativeCalls, []);
            assert.equal(posts.length, 1);
            if (scenario === 'legacy-restart') {
              await expect(error).toHaveAttribute('data-source', 'operation');
              assert.equal(queue.items[0].retryable, false);
              await send.click();
              await expect.poll(() => posts.length).toBe(2);
              await expect(page.locator('.chat-message-edit-label')).toHaveText('正在编辑历史消息');
              await expect(error).toHaveText(rejection);
              assert.deepEqual(nativeCalls, []);
              assert.equal(controller.preparations.size, 1);
              result.legacyServerRestartRestoresVerifiedPreparation = true;
            }
            await expect(error).toHaveAttribute('data-source', 'session-check');
            assert.equal(queue.items[0].retryable, true);
            assert.equal(queue.items[0].rewindProgress.nativeStarted, false);
            const rejectedPosts = scenario === 'legacy-restart' ? 2 : 1;
            for (let i = 0; i < 2; i++) {
              sideRevision++;
              fixture.changed();
              await expect.poll(() => observations.includes(sideRevision)).toBe(true);
              await expect(error).toHaveText(rejection);
              assert.equal(posts.length, rejectedPosts);
            }
            nativeMode = 'main';
            observedMode = 'main';
            observedBinding = 'different-native-binding';
            sideRevision++;
            fixture.changed();
            await expect.poll(() => observations.includes(sideRevision)).toBe(true);
            await expect(page.locator('#chatSideToggle')).toBeEnabled();
            await expect(error).toHaveText(rejection);
            observedBinding = binding;
            sideRevision++;
            fixture.changed();
            await expect.poll(() => observations.includes(sideRevision)).toBe(true);
            await expect(error).toBeHidden();
            await expect(input).toHaveValue(editedText);
            await expect(send).toBeEnabled();
            assert.equal(posts.length, rejectedPosts);
            assert.deepEqual(nativeCalls, []);
            await page.screenshot({
              path: path.join(output, `${viewport.name}-${scenario}-recovered.png`),
              fullPage: true,
            });
            await send.click();
            await expect(bar).toBeHidden();
            await expect(input).toHaveValue(normalDraft);
            await expect(page.locator('#attachmentList')).toContainText('原草稿附件.txt');
            await expect(error).toBeHidden();
            assert.equal(posts.length, rejectedPosts + 1);
            for (const retry of posts.slice(1)) {
              assert.equal(retry.id, posts[0].id);
              assert.deepEqual(retry.rewind, posts[0].rewind);
              assert.equal(retry.retry, true);
            }
            assert.deepEqual(nativeCalls, ['select', 'confirm', 'replace', 'send']);
            assert.equal(beforeWrites, rejectedPosts + 1);
            assert.equal(queue.items[0].status, 'dispatched');
            if (scenario === 'lost-preflight') assert(receiptReads > 0);
            result.explicitRetryActuallySendsOnce = true;
            result.sameBindingRecoveryNoAutomaticSend = true;
          }
          assert.deepEqual(errors, []);
          assert(!fixture.state.frames.some((frame) => frame.includes('terminal.input')));
          result.geometry = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
          }));
          assert.equal(result.geometry.overflow, 0);
          result.wire = { posts, prepares, receiptReads, beforeWrites, nativeCalls };
          result.ok = true;
          await page.screenshot({
            path: path.join(output, `${viewport.name}-${scenario}-final.png`),
            fullPage: true,
          });
        } catch (error) {
          result.error = error.stack;
          result.wire = { posts, prepares, receiptReads, beforeWrites, nativeCalls };
          await page
            ?.screenshot({
              path: path.join(output, `${viewport.name}-${scenario}-failure.png`),
              fullPage: true,
            })
            .catch(() => {});
        } finally {
          await context.close();
          await fixture.close();
          await fs.rm(directory, { recursive: true, force: true });
        }
        results.push(result);
        console.log(
          `${result.ok ? 'PASS' : 'FAIL'} ${viewport.name} ${scenario}${result.error ? ': ' + result.error : ''}`,
        );
      }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2) + '\n',
  );
  assert(
    results.every((result) => result.ok),
    'rewind recovery browser failures',
  );
}
run().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

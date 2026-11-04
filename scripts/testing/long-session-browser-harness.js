'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { AsyncConversationStore } = require('../../lib/async-conversation-store');
const Conversation = require('../../lib/conversation-state');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_LONG_SESSION_BROWSER_OUTPUT ||
    'artifacts/testing/long-session-performance/browser',
);
const journal = path.resolve(
  process.env.SWIFT_LONG_SESSION_JOURNAL ||
    'artifacts/testing/long-session-performance/benchmark/eight-hour-session.jsonl',
);
const baseline = process.argv.includes('--baseline');
const oldRoot = path.resolve('artifacts/testing/long-session-performance/baseline-source');
const Store = baseline
  ? require(path.join(oldRoot, 'lib/async-conversation-store')).AsyncConversationStore
  : AsyncConversationStore;
const store = new Store({ indexFile: path.join(output, 'index.sqlite') });
const fingerprint = sourceFingerprint(process.cwd());
async function liveWindow(browser) {
  const fixture = await createFixture();
  fixture.state.unified = true;
  fixture.state.sync = true;
  fixture.state.syncIndexed = true;
  const session = fixture.state.sessions['pane-codex'];
  const message = (i) => ({
    id: `live-${i}`,
    role: i % 2 ? 'assistant' : 'user',
    ts: '2026-10-28T08:00:00Z',
    blocks: [{ kind: 'text', text: `持续输出第 ${i} 条消息。` }],
  });
  session.messages = Array.from({ length: 30 }, (_, i) => message(i));
  const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    }),
    page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('持续输出第 29 条消息。');
    await page.locator('#commandInput').fill('持续输出时保留草稿');
    const append = async (count) => {
      const start = session.messages.length;
      session.messages.push(...Array.from({ length: count }, (_, i) => message(start + i)));
      fixture.changed();
      await expect(page.locator('#chatLog .chat-msg').last()).toHaveAttribute(
        'data-message-id',
        `live-${session.messages.length - 1}`,
      );
    };
    for (let round = 0; round < 18; round++) {
      await append(15);
      assert((await page.locator('#chatLog .chat-msg').count()) <= 200);
    }
    assert.equal(await page.locator('#chatLog .chat-msg').count(), 200);
    const reading = await page.locator('#chatLog').evaluate((log) => {
      log.scrollTop = log.scrollHeight / 2;
      log.dispatchEvent(new Event('scroll'));
      return log.scrollTop;
    });
    await append(5);
    assert.equal(await page.locator('#chatLog .chat-msg').count(), 205);
    assert(
      Math.abs((await page.locator('#chatLog').evaluate((log) => log.scrollTop)) - reading) < 3,
    );
    await page.locator('#chatLog').evaluate((log) => {
      log.scrollTop = 0;
      log.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => page.locator('#chatLog .chat-msg').count()).toBeGreaterThan(205);
    await page.locator('#chatLog').evaluate((log) => {
      log.scrollTop = log.scrollHeight;
      log.dispatchEvent(new Event('scroll'));
    });
    await append(15);
    assert.equal(await page.locator('#chatLog .chat-msg').count(), 200);
    await expect(page.locator('#commandInput')).toHaveValue('持续输出时保留草稿');
    assert.deepEqual(errors, []);
    assert.equal(
      fixture.state.requests.filter((request) => request.route === 'POST /api/messages').length,
      0,
    );
    return {
      ok: true,
      nativeMessages: session.messages.length,
      attachedMessages: 200,
      historyReadingPreserved: true,
      olderPagesAvailable: true,
      draftPreserved: true,
      messagePosts: 0,
    };
  } catch (error) {
    fs.writeFileSync(
      path.join(output, 'live-window-failure.json'),
      JSON.stringify(
        {
          error: error.message,
          requests: fixture.state.requests
            .filter((request) => request.route === 'GET /api/transcript')
            .slice(-12),
          client: await page.evaluate(() => ({
            first: document.querySelector('#chatLog .chat-msg')?.dataset.messageId,
            last: [...document.querySelectorAll('#chatLog .chat-msg')].at(-1)?.dataset.messageId,
            count: document.querySelectorAll('#chatLog .chat-msg').length,
            errors: [...document.querySelectorAll('.app-error,.chat-error')].map(
              (node) => node.textContent,
            ),
          })),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await context.close();
    await fixture.close();
  }
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert(fs.existsSync(journal), 'Run the synthetic long-session benchmark first.');
  const browser = await firefox.launch(),
    reports = [];
  let live;
  try {
    for (const viewport of process.argv.includes('--live-only')
      ? []
      : [...viewports, { name: 'small-mobile', width: 320, height: 740, touch: true }]) {
      const fixture = await createFixture();
      fixture.state.unified = true;
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.longSessionTiming = { longestTask: 0, last: performance.now() };
        setInterval(() => {
          const t = performance.now();
          window.longSessionTiming.longestTask = Math.max(
            window.longSessionTiming.longestTask,
            t - window.longSessionTiming.last - 16,
          );
          window.longSessionTiming.last = t;
        }, 16);
      });
      if (baseline) {
        const { createFrontendAssets } = require(path.join(oldRoot, 'lib/frontend-assets'));
        const bundle = createFrontendAssets(path.join(oldRoot, 'public')).startup().data;
        await page.route('**/assets/startup.js*', (route) =>
          route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle }),
        );
      }
      await page.route('**/api/transcript?*', async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('pane') !== 'pane-codex') return route.continue();
        // The HTTP fixture owns identity/state; its tiny example transcript
        // does not contain the real synthetic journal's history anchors.
        const template = new URL(url);
        for (const key of ['before', 'from', 'revision', 'historyEpoch'])
          template.searchParams.delete(key);
        const response = await route.fetch({ url: template.toString() }),
          base = await response.json(),
          start = performance.now();
        const options = {
          limit: Number(url.searchParams.get('limit')) || 60,
          from: url.searchParams.get('from'),
          before: url.searchParams.get('before'),
          revision: url.searchParams.get('revision'),
          historyEpoch: url.searchParams.get('historyEpoch'),
          windowless: url.searchParams.get('window') === '0',
        };
        let display;
        if (baseline) {
          const full = await store.read(journal, 'codex');
          display = options.windowless
            ? { windowless: true, historyRevision: Conversation.historyVersion(full.conversation) }
            : Conversation.historyWindow(full.conversation, options);
        } else display = await store.page(journal, 'codex', options);
        const { receipts, status, goal, turnIds, turnId, ...body } = display;
        requests.push({
          ms: performance.now() - start,
          bytes: Buffer.byteLength(JSON.stringify(body)),
          windowless: options.windowless,
        });
        await route.fulfill({ response, body: JSON.stringify({ ...base, ...body }) });
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('新增正文。', { timeout: 20000 });
        const initial = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          const log = document.querySelector('#chatLog'),
            last = [...log.querySelectorAll('.chat-msg')].at(-1),
            rect = last.getBoundingClientRect(),
            view = log.getBoundingClientRect();
          return {
            timeToLatestAnimationFrameMs: performance.now(),
            nodes: log.querySelectorAll('*').length,
            tools: log.querySelectorAll('.chat-tool-row').length,
            closedDetailsChildren: log.querySelectorAll('.chat-tool-row:not([open]) .tool-body > *')
              .length,
            latestVisible: rect.bottom > view.top && rect.top < view.bottom,
            longestTimerDelayMs: window.longSessionTiming.longestTask,
          };
        });
        assert(
          initial.latestVisible,
          'Entry must present the latest content, not a placeholder history height',
        );
        if (!baseline) {
          assert.equal(initial.closedDetailsChildren, 0);
          assert(initial.nodes < 5000, 'The first page must have bounded DOM work');
        }
        await page.locator('#commandInput').fill('长会话草稿保持');
        const latestTool = page.locator('.chat-tool-row').last();
        await latestTool.locator('summary').click();
        await expect(latestTool.locator('.tool-body pre').first()).toBeVisible();
        const firstNode = await page.locator('#chatLog .chat-msg').first().elementHandle();
        const beforeCount = await page.locator('#chatLog .chat-msg').count();
        await page.locator('#chatLog').evaluate((log) => {
          log.scrollTop = 0;
          log.dispatchEvent(new Event('scroll'));
        });
        await expect
          .poll(() => page.locator('#chatLog .chat-msg').count(), { timeout: 20000 })
          .toBeGreaterThan(beforeCount);
        assert(
          await firstNode.evaluate((node) => node.isConnected),
          'Paging must preserve existing message nodes',
        );
        const scroll = await page.locator('#chatLog').evaluate(async (log) => {
          const frames = [],
            span = log.scrollHeight - log.clientHeight;
          for (let i = 0; i < 30; i++) {
            const start = performance.now();
            log.scrollTop = (span * i) / 29;
            await new Promise(requestAnimationFrame);
            frames.push(performance.now() - start);
          }
          frames.sort((a, b) => a - b);
          return {
            p95FrameMs: frames[Math.floor(frames.length * 0.95)],
            maxFrameMs: frames.at(-1),
          };
        });
        await expect(page.locator('#commandInput')).toHaveValue('长会话草稿保持');
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        assert.equal(
          fixture.state.requests.filter((request) => request.route === 'POST /api/messages').length,
          0,
        );
        assert.deepEqual(errors, []);
        reports.push({ viewport: viewport.name, initial, scroll, requests });
        console.log(JSON.stringify(reports.at(-1)));
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    if (!baseline) live = await liveWindow(browser);
  } finally {
    await browser.close();
    await store.close();
  }
  assert.deepEqual(sourceFingerprint(process.cwd()), fingerprint);
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, baseline, source: fingerprint, reports, liveWindow: live }, null, 2),
  );
}
main().catch(async (error) => {
  console.error(error);
  await store.close();
  process.exitCode = 1;
});

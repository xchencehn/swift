#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const output = path.resolve('artifacts/testing/side-session-unification/browser');
  await fs.mkdir(output, { recursive: true });
  const fingerprint = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport,
          hasTouch: !!viewport.touch,
          reducedMotion: 'reduce',
        }),
        page = await context.newPage();
      const errors = [],
        writes = [],
        forks = [];
      let sequence = 0,
        releaseSide = null,
        heldSide = false;
      page.on('pageerror', (e) => errors.push(e.message));
      const sideId = '01900000-0000-7000-8000-000000000182';
      let state = {
        supported: true,
        structured: true,
        mode: 'main',
        hasSide: false,
        canClose: false,
        binding: 'fixture-binding',
        paneId: 'pane-codex',
        revision: '0',
        sideId: null,
      };
      const messages = [
        { id: 'side-user', role: 'user', blocks: [{ kind: 'text', text: '临时会话的问题' }] },
        {
          id: 'side-assistant',
          role: 'assistant',
          blocks: [
            {
              kind: 'text',
              text:
                '临时会话的真实结构化回答\n\n' +
                Array.from(
                  { length: 60 },
                  (_, index) => `临时阅读段落 ${index + 1}。用于核验切换后的阅读位置保持。`,
                ).join('\n\n'),
            },
          ],
        },
      ];
      const update = (mode) => {
        state = {
          ...state,
          mode,
          hasSide: true,
          sideId,
          canClose: mode === 'side',
          revision: String(++sequence),
        };
      };
      await context.route('**/api/agents/side*', async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('transcript') === '1') {
          const body = { sideId, messages: JSON.parse(JSON.stringify(messages)), hasMore: false };
          if (heldSide) {
            heldSide = false;
            await new Promise((resolve) => {
              releaseSide = resolve;
            });
            if (viewport.name === 'small-mobile')
              return route.fulfill({
                status: 503,
                json: { ok: false, message: '迟到的临时读取错误' },
              });
            body.messages.push({
              id: 'stale-side-only',
              role: 'assistant',
              blocks: [{ kind: 'text', text: '不应出现在主会话的迟到临时正文' }],
            });
          }
          return route.fulfill({ json: body });
        }
        let submitted = false;
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (body.action === 'send') {
            assert.equal(body.sideId, sideId);
            assert.equal(state.mode, 'side');
            submitted = true;
            messages.push({
              id: 'sent-' + sequence,
              role: 'user',
              blocks: [{ kind: 'text', text: body.text }],
            });
            update('side');
          } else if (body.action === 'close')
            state = {
              ...state,
              mode: 'main',
              hasSide: false,
              sideId: null,
              revision: String(++sequence),
            };
          else update(body.action === 'main' ? 'main' : 'side');
        }
        if (
          route.request().method() === 'POST' &&
          ['main', 'side'].includes(route.request().postDataJSON().action)
        )
          await new Promise((resolve) => setTimeout(resolve, 150));
        return route.fulfill({ json: { ...state, submitted } });
      });
      await context.route('**/api/agents/fork*', async (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          forks.push(body);
          assert.equal(body.sideId, sideId);
        }
        return route.fulfill({
          json: {
            ok: true,
            job: { status: 'succeeded', phase: 'complete', sessionId: 'independent-side-fork' },
          },
        });
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('主会话草稿');
        await expect(page.locator('#chatSideToggle')).toBeEnabled();
        await page.locator('#chatSideToggle').click();
        await expect(page.locator('#chatLog')).toContainText('临时会话的真实结构化回答');
        await expect(page.locator('#shellTerminal')).toBeHidden();
        await expect(page.locator('#chatModeToggle')).toBeVisible();
        await expect(page.locator('#commandInput')).toHaveValue('');
        await page.locator('#commandInput').fill('临时草稿');
        const sideReading = await page.locator('#chatLog').evaluate((log) => {
          log.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
          log.scrollTop = 260;
          return log.scrollTop;
        });
        assert(sideReading > 0);
        await page.waitForTimeout(220);
        const cachedSwitch = await page.locator('[data-side="main"]').evaluate((button) => {
          const start = performance.now();
          button.click();
          return {
            milliseconds: performance.now() - start,
            draft: document.querySelector('#commandInput').value,
          };
        });
        assert.equal(
          cachedSwitch.draft,
          '主会话草稿',
          'Cached switching must precede the delayed native reply',
        );
        await expect(page.locator('#commandInput')).toHaveValue('主会话草稿');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('[data-side="side"]').click();
        await expect(page.locator('#commandInput')).toHaveValue('临时草稿');
        await expect(page.locator('#chatLog')).toContainText('临时会话的真实结构化回答');
        await expect
          .poll(() => page.locator('#chatLog').evaluate((log) => log.scrollTop))
          .toBeCloseTo(sideReading, 0);
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#chatLog')).toContainText('临时会话的真实结构化回答');
        await page.locator('#commandInput').fill('中文多行临时消息\n第二行');
        await page.locator('#sendButton').click();
        await expect(page.locator('#commandInput')).toHaveValue('');
        await expect(page.locator('#chatLog')).toContainText('第二行');
        assert.equal(writes.filter((b) => b.action === 'send').length, 1);
        await page.locator('[data-side="fork"]').click();
        await expect.poll(() => forks.length).toBe(1);
        await expect(page.locator('[data-side="side"]')).toHaveAttribute('aria-pressed', 'true');
        heldSide = true;
        await expect.poll(() => !!releaseSide, { timeout: 12000 }).toBe(true);
        await page.locator('[data-side="main"]').click();
        releaseSide();
        releaseSide = null;
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatLog')).not.toContainText('不应出现在主会话的迟到临时正文');
        await expect(page.locator('#chatComposerError')).not.toContainText('迟到的临时读取错误');
        await page.locator('[data-side="side"]').click();
        if (viewport.name === 'desktop') {
          const second = await context.newPage();
          try {
            await second.goto(fixture.url + '/?token=fixture&pane=pane-codex');
            await expect(second.locator('#chatLog')).toContainText('临时会话的真实结构化回答');
            await second.locator('#commandInput').fill('另一个窗口的临时草稿');
            await second.locator('#chatModeToggle').click();
            await expect(second.locator('#shellTerminal')).toBeVisible();
            await page.bringToFront();
            await expect(page.locator('#shellTerminal')).toBeHidden();
            await expect(page.locator('#commandInput')).toHaveValue('');
          } finally {
            await second.close();
          }
        }
        const geometry = await page.locator('#chatSideThread').evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          scroll: document.documentElement.scrollWidth,
          viewport: innerWidth,
        }));
        assert(geometry.scroll <= geometry.viewport + 1);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        results.push({
          viewport,
          geometry,
          cachedSwitch,
          sideReading,
          lateSideResponseDiscarded: true,
          independentWindows: viewport.name === 'desktop',
          controlledReplyDelayMs: 150,
          writes: writes.length,
          sends: 1,
          forks: forks.length,
          errors,
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ fingerprint, results }, null, 2),
  );
  console.log('Side chat, terminal, drafts, switching and fork passed in four viewports');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

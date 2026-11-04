'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { NativeDraft } = require('../../lib/native-draft');
const { AgentQuestions } = require('../../lib/agent-questions');
const { stripAnsi } = require('../../public/ansi');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const captures = require('../../test/fixtures/codex-rate-limit.json');
const output = path.resolve('artifacts/testing/codex-rate-limit-prompt/browser');
async function run(browser, viewport) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = true;
  fixture.state.unified = true;
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let raw = stripAnsi(captures.find((c) => c.columns === (viewport.touch ? 45 : 140)).ansi);
  const composer = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol high · /fixture';
  let frame, release;
  const submitted = [],
    keys = [],
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const terminal = new TerminalScreen({
    cols: viewport.touch ? 45 : 140,
    rows: 45,
    onScreen: (value) => {
      frame = value;
    },
  });
  const publishScreen = async () => {
    await terminal.feed('\x1b[H\x1b[2J' + raw.replaceAll('\n', '\r\n'), { full: true });
    fixture.nativeScreen(frame, 'pane-codex');
  };
  const manager = new AgentQuestions({
    herdr: { readPane: async () => raw },
    exactPane: async () => session.pane,
    readQuestionState: async () => {
      throw Error('archive temporarily unavailable');
    },
    keys: async (_id, input) => {
      keys.push(...input);
      if (input.includes('down')) raw = raw.replace('› 1.', '  1.').replace('  2.', '› 2.');
      if (input.includes('enter')) raw = composer;
    },
  });
  session.question = await manager.read(session.pane);
  assert(session.question);
  fixture.state.questionAction = async (body) => {
    submitted.push(body);
    await gate;
    const result = await manager.answer(body);
    session.question = null;
    await publishScreen();
    fixture.changed();
    return result;
  };
  const transfers = [],
    draftManager = new NativeDraft({
      herdr: { readPane: async () => raw },
      exactPane: async () => session.pane,
      operate: (_id, work) => work(),
      press: async () => {
        raw = composer;
        await publishScreen();
        fixture.changed();
      },
    });
  try {
    // Production dashboard panes omit process runtimeId; exact observations include it.
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const pane of data.panes || []) delete pane.runtimeId;
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/agents/native-draft', async (route) => {
      const body = route.request().postDataJSON();
      transfers.push(body.action);
      try {
        const result = await draftManager.handle(body);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      } catch (error) {
        await route.fulfill({
          status: error.status || 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: error.message }),
        });
      }
    });
    await page.route('**/api/transcript?*', (route) =>
      new URL(route.request().url()).searchParams.get('state') === '1'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'archive controls unavailable' }),
          })
        : route.continue(),
    );
    await publishScreen();
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    const input = page.locator('#commandInput'),
      summary = page.locator('#chatQuestionSummary'),
      box = page.locator('#chatInlineQuestion');
    await expect(summary).toContainText('额度提醒');
    await expect(summary).toContainText('接近额度限制');
    await expect(box).toBeHidden();
    await input.fill('保留我的消息草稿');
    await expect(page.locator('#sendButton')).toBeDisabled();
    await input.press('Enter');
    assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 0);
    assert.equal(submitted.length, 0);
    await summary.locator('button').click();
    await expect(box).toContainText('Codex 额度提醒');
    await expect(box.locator('.chat-inline-option')).toHaveCount(3);
    await box.locator('.chat-inline-option').nth(1).click();
    await summary.locator('button').click();
    await expect(box).toBeHidden();
    await summary.locator('button').click();
    await expect(box.locator('.chat-inline-option').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: path.join(output, viewport.name + '-choices.png') });
    const geometry = await box.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    assert(geometry.left >= 0 && geometry.right <= viewport.width + 1);
    await box.locator('[data-action="answer"]').click();
    await expect.poll(() => submitted.length).toBe(1);
    await expect(box.getByRole('status')).toHaveText('正在操作…');
    await input.fill('确认期间继续编辑的消息');
    release();
    await expect(summary).toBeHidden();
    await expect(box).toBeHidden();
    await expect(input).toHaveValue('确认期间继续编辑的消息');
    await expect(page.locator('#sendButton')).toBeEnabled();
    await expect(page.locator('#chatModelAction')).toBeEnabled();
    assert.deepEqual(keys, ['down', 'enter']);
    assert.equal(submitted.length, 1);
    raw = '› 终端草稿内容\n\nGPT-6.1-Sol high · /fixture';
    await publishScreen();
    fixture.changed();
    const move = page.locator('#chatMoveNativeDraft');
    await expect(page.locator('#chatStatusHint')).toContainText('herdr终端输入有内容未发送');
    await expect(move).toBeVisible();
    await expect(page.locator('#sendButton')).toBeEnabled();
    await page.screenshot({ path: path.join(output, viewport.name + '-draft-offer.png') });
    if (!viewport.touch) {
      await page.evaluate(() => {
        window.restoreDraftStorage = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('agentStudioDrafts:'))
            throw new DOMException('storage full', 'QuotaExceededError');
          return window.restoreDraftStorage.call(this, key, value);
        };
      });
      await move.click();
      await expect(move).toBeEnabled();
      await expect.poll(() => transfers.length).toBe(1);
      assert.deepEqual(transfers, ['prepare']);
      assert(raw.includes('终端草稿内容'));
      await expect(input).toHaveValue('确认期间继续编辑的消息');
      await page.evaluate(() => {
        Storage.prototype.setItem = window.restoreDraftStorage;
        delete window.restoreDraftStorage;
      });
      transfers.length = 0;
    }
    await move.click();
    await expect(input).toHaveValue('确认期间继续编辑的消息\n\n终端草稿内容');
    await expect(move).toBeHidden();
    assert.deepEqual(transfers, ['prepare', 'clear']);
    assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 0);
    await page.screenshot({ path: path.join(output, viewport.name + '-draft-moved.png') });
    await page.screenshot({ path: path.join(output, viewport.name + '-restored.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      quotaEntry: true,
      options: 3,
      explicitChoice: true,
      draftPreserved: true,
      controlsRestored: true,
      geometry,
    };
  } finally {
    release();
    terminal.close();
    await context.close();
    await fixture.close();
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'narrow', width: 320, height: 740, touch: true },
    ]) {
      results.push(await run(browser, viewport));
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

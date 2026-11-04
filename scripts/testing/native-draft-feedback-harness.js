'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { NativeDraft } = require('../../lib/native-draft');
const { TerminalScreen } = require('../../lib/terminal-screen');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_DRAFT_FEEDBACK_OUTPUT || 'artifacts/testing/native-draft-notice/review-browser',
);
async function run(browser, viewport) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = fixture.state.unified = true;
  session.messages = [];
  session.pane.agent.session.value = '';
  session.pane.agent.status = 'idle';
  const context = await browser.newContext({
      viewport,
      hasTouch: viewport.touch,
      serviceWorkers: 'block',
    }),
    page = await context.newPage();
  const empty = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\nGPT-6.1-Sol high · /fixture';
  let raw = empty,
    frame,
    mode = '',
    release;
  const transfers = [],
    keys = [];
  let identityReads = 0;
  const terminal = new TerminalScreen({
    cols: viewport.touch ? 45 : 140,
    rows: 45,
    onScreen: (value) => {
      frame = value;
    },
  });
  const publish = async () => {
    await terminal.feed('\x1b[H\x1b[2J' + raw.replaceAll('\n', '\r\n'), { full: true });
    fixture.nativeScreen(frame, 'pane-codex');
    fixture.changed();
  };
  const manager = new NativeDraft({
    herdr: { readPane: async () => raw },
    exactPane: async () => session.pane,
    operate: (_id, work) => work(),
    press: async (input) => {
      keys.push(input);
      raw = empty;
      await publish();
    },
  });
  const select = async (id) => {
    if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
    await page.locator(`#chatPickerList [data-pane-id="${id}"]`).click();
  };
  try {
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const pane of data.panes || []) delete pane.runtimeId;
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/transcript?*', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      if (new URL(route.request().url()).searchParams.has('window')) identityReads++;
      else {
        delete data.binding;
        delete data.identity;
      }
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/agents/native-draft', async (route) => {
      const body = route.request().postDataJSON();
      transfers.push(body);
      if (mode === 'hold')
        await new Promise((resolve) => {
          release = resolve;
        });
      if (mode === 'fail' || mode === 'late-fail')
        return route.fulfill({ status: 409, json: { message: '模拟原生草稿操作失败' } });
      try {
        await route.fulfill({ json: await manager.handle(body) });
      } catch (error) {
        await route.fulfill({
          status: error.status || 500,
          json: { message: error.message, code: error.code },
        });
      }
    });
    await publish();
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    const error = page.locator('#chatComposerError'),
      input = page.locator('#commandInput'),
      move = page.locator('#chatMoveNativeDraft');
    await expect(input).toBeEnabled();
    await expect(error).toBeHidden();
    await expect(move).toBeHidden();
    await input.fill('新会话可以继续输入');
    await expect(page.locator('#sendButton')).toBeEnabled();
    assert.equal(transfers.length, 0, 'empty new session performs no draft operation');
    raw = '› 终端草稿\n\nGPT-6.1-Sol high · /fixture';
    await publish();
    await expect(move).toBeVisible();
    mode = 'fail';
    await move.click();
    await expect(error).toContainText('模拟原生草稿操作失败');
    await expect(move).toBeEnabled();
    assert(identityReads > 0, 'missing initial binding is resolved read-only');
    session.question = {
      provider: 'codex',
      paneId: session.pane.paneId,
      sessionId: '',
      source: 'app-server',
      stage: 'question',
      index: 0,
      total: 1,
      queued: true,
      challenge: 'error-with-question',
      draftKey: 'error-with-question',
      blocking: true,
      question: '需要处理的确认问题',
      options: [{ label: '继续' }, { label: '返回' }],
    };
    fixture.changed();
    const summary = page.locator('#chatQuestionSummary');
    await expect(summary).toBeVisible();
    await expect(error).toBeVisible();
    await summary.locator('button').click();
    await expect(page.locator('#chatInlineQuestion')).toContainText('需要处理的确认问题');
    await page.screenshot({ path: path.join(output, viewport.width + '-error-and-question.png') });
    session.question = null;
    fixture.changed();
    await expect(summary).toBeHidden();
    mode = '';
    raw = empty;
    await move.click();
    await expect(error).toBeHidden();
    await publish();
    await expect(move).toBeHidden();
    await expect(input).toHaveValue('新会话可以继续输入');
    assert.deepEqual(keys, [], 'empty draft does not clear or send');
    raw = '› 慢请求中的原生草稿\n\nGPT-6.1-Sol high · /fixture';
    await publish();
    await expect(move).toBeVisible();
    mode = 'hold';
    const count = transfers.length;
    await move.click();
    await expect.poll(() => transfers.length).toBe(count + 1);
    await select('pane-claude');
    await input.fill('另一个会话继续编辑与发送');
    await expect(page.locator('#sendButton')).toBeEnabled();
    await expect(error).toBeHidden();
    mode = 'late-fail';
    release();
    await expect(input).toHaveValue('另一个会话继续编辑与发送');
    await expect(error).toBeHidden();
    await select('pane-codex');
    await expect(error).toBeHidden();
    await expect(input).toHaveValue('新会话可以继续输入');
    assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 0);
    assert.deepEqual(keys, []);
    assert(transfers.every((body) => body.action === 'prepare' && body.binding));
    return {
      width: viewport.width,
      emptyNewSession: true,
      exactBindingWithoutProcessField: true,
      errorsDoNotHideQuestions: true,
      emptySuccessClearsOwnError: true,
      pendingOperationIsolated: true,
      lateFailureIgnored: true,
      draftsPreserved: true,
      noNativeInput: true,
    };
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
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
      { width: 1440, height: 900 },
      { width: 390, height: 844, touch: true },
      { width: 320, height: 740, touch: true },
    ]) {
      results.push(await run(browser, viewport));
      console.log(JSON.stringify(results.at(-1)));
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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

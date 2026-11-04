'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/codex-interaction/browser');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'narrow-mobile', width: 320, height: 740, touch: true },
];
async function run(browser, viewport) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = true;
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() =>
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }),
  );
  const page = await context.newPage(),
    errors = [],
    meta = deferred();
  let metaHeld = true;
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const posts = (route) => fixture.state.requests.filter((row) => row.route === 'POST ' + route);
  const evidence = { viewport: viewport.name };
  try {
    await page.route('**/api/transcript?*', async (route) => {
      const url = new URL(route.request().url());
      if (metaHeld && url.searchParams.get('state') === '1') await meta.promise;
      await route.continue();
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    assert(metaHeld, 'history must render while control metadata remains unresolved');
    evidence.historyIndependentOfMetadata = true;
    metaHeld = false;
    meta.resolve();
    await expect(page.locator('#chatModelAction')).toContainText('codex-fixture-model');
    const input = page.locator('#commandInput'),
      send = page.locator('#sendButton');
    await input.fill('保留用户选字');
    await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    const settingsWrites = posts('/api/agent-settings').length;
    await input.press('Shift+ArrowLeft');
    assert.equal(await input.evaluate((el) => el.selectionEnd - el.selectionStart), 1);
    assert.equal(posts('/api/agent-settings').length, settingsWrites);
    evidence.textSelectionPreserved = true;
    const statusBeforeSend = await page.locator('#chatExecutionState').textContent();
    await input.fill('慢速投递');
    fixture.setSendBehavior('慢速投递', 'hold');
    await send.click();
    await expect(page.locator('#chatExecutionState')).toHaveText(statusBeforeSend);
    await expect(send).toHaveAttribute('aria-busy', 'true');
    await expect(input).toBeEnabled();
    await expect(page.locator('#chatControls #chatInterrupt')).toHaveCount(0);
    await page
      .locator(':is(#chatCurrentName, .herdr-tab.selected .herdr-tab-select):visible')
      .click();
    await expect(page.locator('#chatInterrupt')).toBeEnabled();
    await page.keyboard.press('Escape');
    await input.fill('请求期间写的新草稿');
    await expect
      .poll(() => posts('/api/messages').some((row) => row.body.text === '慢速投递'))
      .toBe(true);
    const held = posts('/api/messages').find((row) => row.body.text === '慢速投递');
    fixture.release(held.body.id);
    await expect(send).toHaveAttribute('aria-busy', 'false');
    await expect(input).toHaveValue('请求期间写的新草稿');
    evidence.sendPendingLeavesInputEditable = true;
    evidence.lateAcceptancePreservesNewDraft = true;
    await page.route('**/api/messages', async (route) => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().text !== '丢失响应')
        return route.continue();
      await route.fetch();
      await route.abort();
    });
    await input.fill('丢失响应');
    await send.click();
    await expect(page.locator('#chatExecutionState')).toContainText('Unconfirmed');
    await page.locator('#chatExecutionAction').click();
    await expect(page.locator('#chatDeliveryCheck')).toBeVisible();
    await expect(input).toHaveValue('丢失响应');
    const writes = posts('/api/messages').length;
    await page.locator('#chatDeliveryCheck').click();
    await expect(page.locator('#chatExecutionState')).not.toContainText('Accepted');
    await page.keyboard.press('Escape');
    assert.equal(posts('/api/messages').length, writes);
    await expect(input).toHaveValue('');
    evidence.lostReplyReadOnlyReceipt = true;
    const questionBase = {
      provider: 'codex',
      paneId: session.pane.paneId,
      terminalId: session.pane.terminalId,
      runtimeId: session.pane.runtimeId || '',
      sessionId: session.pane.agent.session.value,
      queued: true,
      blocking: false,
      canWrite: true,
    };
    const questions = [
      {
        challenge: 'q1',
        draftKey: 'd1',
        question: '选择构建平台',
        options: [{ label: 'Desktop' }, { label: 'Mobile' }],
      },
      { challenge: 'q2', draftKey: 'd2', question: '项目叫什么名字', options: [] },
      {
        challenge: 'q3',
        draftKey: 'd3',
        question: '选择实现方式',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ].map((q, index) => ({
      ...questionBase,
      ...q,
      toolId: 'fixture-call',
      index,
      total: 3,
      allowText: true,
    }));
    const publish = () => {
      session.question = questions.length
        ? {
            ...questions[0],
            items: questions,
            collapsed: true,
            expanded: false,
            remaining: questions.length,
            position: 0,
            navigation: { open: 'alt+up' },
          }
        : null;
      fixture.changed();
    };
    fixture.state.questionAction = (body) => {
      const index = questions.findIndex((q) => q.challenge === body.challenge);
      assert(index >= 0);
      assert(
        ['answer', 'skip'].includes(body.action),
        'local browsing must never write native navigation',
      );
      questions.splice(index, 1);
      publish();
      return { ok: true, delivery: body.action === 'answer' ? 'sent' : 'skipped' };
    };
    publish();
    await expect(page.locator('#chatQuestionSummary')).toContainText('3 个问题');
    const before = posts('/api/agents/questions').length;
    await page.locator('#chatQuestionSummary button').click();
    const box = page.locator('#chatInlineQuestion');
    await expect(box).toContainText('选择构建平台');
    await box.locator('[data-action="next"]').click();
    await expect(box).toContainText('项目叫什么名字');
    await box.locator('textarea').fill('回答草稿');
    await box.locator('[data-action="next"]').click();
    await expect(box).toContainText('选择实现方式');
    await box.locator('[data-action="previous"]').click();
    await expect(box.locator('textarea')).toHaveValue('回答草稿');
    assert.equal(posts('/api/agents/questions').length, before);
    evidence.questionBrowsingWritesNothing = true;
    await page.locator('#chatLog').evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(box).toBeInViewport();
    await expect(page.locator('#chatQuestionSummary')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const q = document.querySelector('#chatInlineQuestion').getBoundingClientRect(),
        i = document.querySelector('#chatInput').getBoundingClientRect();
      return {
        aboveInput: q.bottom <= i.top + 1,
        aligned: Math.abs(q.x - i.x) < 2 && Math.abs(q.width - i.width) < 2,
        overflow: document.documentElement.scrollWidth > innerWidth,
        height: q.height,
        viewportHeight: innerHeight,
      };
    });
    assert(geometry.aboveInput && geometry.aligned && !geometry.overflow);
    evidence.questionGeometry = geometry;
    await page.screenshot({ path: path.join(output, viewport.name + '-question.png') });
    await box.locator('[data-action="answer"]').click();
    await expect(page.locator('#chatQuestionSummary')).toContainText('2 个问题');
    assert.equal(posts('/api/agents/questions').length, before + 1);
    evidence.exactQuestionSubmitted = posts('/api/agents/questions').at(-1).body.challenge === 'q2';
    await page.locator('#chatQuestionSummary button').click();
    await expect(box).toBeHidden();
    await input.fill('普通消息草稿');
    await input.press('Alt+ArrowUp');
    await expect(box).toBeVisible();
    await input.focus();
    await expect(input).toHaveValue('普通消息草稿');
    assert.equal(posts('/api/agents/questions').length, before + 1);
    evidence.inputFocusWritesNothing = true;
    session.question = null;
    fixture.changed();
    await expect(box).toBeHidden();
    if (viewport.touch) {
      const writes = posts('/api/messages').length;
      await input.evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: '', bubbles: true, cancelable: true }),
        ),
      );
      assert.equal(posts('/api/messages').length, writes);
      await input.press('Enter');
      await expect(input).toHaveValue('');
      evidence.tabletHardwareEnterAndVirtualEnter = true;
    }
    await page.locator('#chatSessionMore').click();
    await expect(page.locator('.popover')).toBeVisible();
    await expect(page.locator('.popover')).toContainText('会话工具');
    await page.keyboard.press('Escape');
    evidence.visibleSessionMenu = true;
    if (viewport.touch) {
      await page.locator('#chatModeToggle').click();
      const key = page.locator('[data-terminal-key="2"]');
      await expect(key).toBeVisible();
      await expect(key).toBeEnabled();
      const frames = (fixture.state.shellFrames || []).length;
      await key.click();
      await expect
        .poll(() =>
          (fixture.state.shellFrames || [])
            .slice(frames)
            .some((row) => row.type === 'terminal.input' && row.data === '2'),
        )
        .toBe(true);
      evidence.touchNativeKeys = true;
      await page.locator('#chatModeToggle').click();
    }
    assert.deepEqual(errors, []);
    evidence.ok = true;
    return evidence;
  } finally {
    meta.resolve();
    await context.close();
    await fixture.close();
  }
}
async function verifyResponseIdentity(browser) {
  const fixture = await createFixture(),
    C = require('../../lib/conversation-state');
  fixture.state.unified = fixture.state.sync = fixture.state.productionPresentation = true;
  for (const session of Object.values(fixture.state.sessions))
    session.pane.runtimeId = 'original-' + session.pane.paneId;
  const session = fixture.state.sessions['pane-codex'],
    oldGate = deferred(),
    freshGate = deferred();
  const context = await browser.newContext({ serviceWorkers: 'block' }),
    page = await context.newPage();
  let armed = false,
    frozen = false,
    holdFresh = false,
    waitingFresh = 0;
  const prepares = [];
  try {
    await page.route('**/api/transcript?*', async (route) => {
      const url = new URL(route.request().url());
      if (holdFresh) {
        waitingFresh++;
        await freshGate.promise;
        return route.continue();
      }
      if (armed && url.searchParams.get('terminal') === '0') {
        armed = false;
        const response = await route.fetch(),
          data = await response.json();
        frozen = true;
        await oldGate.promise;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    await page.route('**/api/agents/rewind', (route) => {
      const body = route.request().postDataJSON();
      prepares.push(body);
      assert.equal(body.binding, C.binding(session.pane));
      return route.fulfill({
        json: {
          ok: true,
          preparation: {
            id: 'fresh-process',
            messageId: body.messageId,
            sourceText: '已核验的当前进程消息',
          },
        },
      });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    const edit = page.locator('.chat-meta .chat-message-edit-action').first();
    await expect(edit).toBeEnabled();
    armed = true;
    fixture.changed();
    await expect.poll(() => frozen).toBe(true);
    session.pane.runtimeId = 'replacement-native-process';
    holdFresh = true;
    fixture.changed();
    await fixture.synced();
    await expect(edit).toBeDisabled();
    oldGate.resolve();
    await expect.poll(() => waitingFresh > 0).toBe(true);
    await expect(edit).toBeDisabled();
    assert.equal(prepares.length, 0, 'old archive responses cannot authorize a new process');
    holdFresh = false;
    freshGate.resolve();
    await expect(edit).toBeEnabled();
    await edit.click();
    await expect(page.locator('#commandInput')).toHaveValue('已核验的当前进程消息');
    assert.equal(prepares.length, 1);
    assert.equal(prepares[0].binding, C.binding(session.pane));
    return { oldResponseRejected: true, pendingIdentityVisible: true, verifiedPreparation: true };
  } finally {
    oldGate.resolve();
    freshGate.resolve();
    await context.close();
    await fixture.close();
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  let identity;
  try {
    for (const viewport of viewports) {
      console.log('Checking ' + viewport.name);
      results.push(await run(browser, viewport));
    }
    identity = await verifyResponseIdentity(browser);
  } finally {
    await browser.close();
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        { before, after: sourceFingerprint(process.cwd()), results, identity },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ ok: true, results, identity }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

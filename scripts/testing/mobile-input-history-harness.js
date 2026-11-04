#!/usr/bin/env node
'use strict';

// Exercise the real composer in an isolated fixture. Pointer gestures are
// synthetic; ordinary touch taps use Firefox's touchscreen input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const Conversation = require('../../lib/conversation-state');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/testing/mobile-input-history/browser');
const viewports = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'mobile-small', width: 320, height: 640, touch: true },
];

function populate(state) {
  state.unified = true;
  state.productionPresentation = true;
  const history = {};
  for (const [paneId, session] of Object.entries(state.sessions)) {
    session.pane.runtimeId = 'fixture-process-' + paneId;
    session.pane.agent.status = 'idle';
    history[paneId] = [
      paneId + ' 第一条历史',
      paneId + ' 第二条历史\n完整的第二行',
      paneId +
        ' 最新的多行历史\n' +
        Array.from({ length: 18 }, (_, i) => '第 ' + i + ' 行，保留中文和长文本。').join('\n'),
    ];
    session.messages = session.messages.filter((message) => message.role !== 'user');
    for (const message of session.messages)
      for (const block of message.blocks || [])
        for (const tool of block.items || []) tool.running = false;
    session.messages.push(
      ...history[paneId].map((text, i) => ({
        id: paneId + '-input-history-' + i,
        role: 'user',
        ts: '2026-10-24T08:00:00.000Z',
        sourceText: text,
        blocks: [{ kind: 'text', text }],
      })),
    );
  }
  return history;
}

async function oneViewport(browser, viewport) {
  const fixture = await createFixture(),
    history = populate(fixture.state);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
  );
  const input = page.locator('#commandInput'),
    button = page.locator('#sendButton'),
    zone = page.locator('#sendHistoryZone');
  const result = { viewport, ok: false, checks: [], geometry: [] };
  let stage = 'startup',
    pointerId = 80,
    expectedMessages = 0;
  const mark = (name) => result.checks.push(name);
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const requests = () =>
    fixture.state.requests.filter((request) => request.route === 'POST /api/messages');
  const writes = () =>
    fixture.state.requests.filter(
      (request) =>
        request.route.startsWith('POST ') &&
        !['POST /api/config', 'POST /api/panes/view', 'POST /api/panes/focus'].includes(
          request.route,
        ) &&
        !(request.route === 'POST /api/agents/rewind' && request.body.action === 'prepare'),
    ).length;
  const noWrite = async (before, label) => {
    await settle();
    assert.equal(writes(), before, label);
  };
  const refresh = async () => {
    fixture.changed();
    await fixture.synced();
    await settle();
  };
  const fill = async (value) => {
    await input.fill(value);
    await settle();
  };
  const geometry = async (label) => {
    const value = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      return {
        zone: rect('#sendHistoryZone'),
        button: rect('#sendButton'),
        card: rect('#chatInput'),
        input: rect('#commandInput'),
        overflow: document.documentElement.scrollWidth - innerWidth,
        mainPanelScrollLeft: document.querySelector('.main-panel').scrollLeft,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    result.geometry.push({ label, ...value });
    assert.equal(value.overflow, 0);
    assert.equal(value.mainPanelScrollLeft, 0);
    assert(Math.abs(value.zone.width - 34) <= 1 && Math.abs(value.button.width - 34) <= 1);
    assert(Math.abs(value.button.height - 34) <= 1);
    assert(
      Math.abs(value.zone.top - value.card.top) <= 1 &&
        Math.abs(value.zone.bottom - value.card.bottom) <= 1,
      'The 34px send column must cover the full input card height: ' + JSON.stringify(value),
    );
    assert(value.button.left >= value.zone.left - 1 && value.button.right <= value.zone.right + 1);
    assert(value.input.height >= 55 && value.input.height <= 169);
    return value;
  };
  const point = async (selector = '#sendHistoryZone', fraction = 0.5) =>
    page.locator(selector).evaluate((el, fraction) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * fraction };
    }, fraction);
  const pointer = async (
    type,
    at,
    id,
    { pointerType = 'touch', primary = true, target = null } = {},
  ) =>
    page.evaluate(
      ({ type, at, id, pointerType, primary, target }) => {
        const el = target
          ? document.querySelector(target)
          : document.elementFromPoint(at.x, at.y) || document;
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType,
            pointerId: id,
            isPrimary: primary,
            button: 0,
            buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
            clientX: at.x,
            clientY: at.y,
          }),
        );
      },
      { type, at, id, pointerType, primary, target },
    );
  const compatClick = async () =>
    button.evaluate((el) =>
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, button: 0 }),
      ),
    );
  const begin = async ({
    selector = '#sendHistoryZone',
    fraction = 0.5,
    pointerType = 'touch',
  } = {}) => {
    const start = await point(selector, fraction),
      id = ++pointerId;
    await pointer('pointerdown', start, id, { pointerType });
    return { start, id, pointerType };
  };
  const move = (gesture, dx, dy) =>
    pointer('pointermove', { x: gesture.start.x + dx, y: gesture.start.y + dy }, gesture.id, {
      pointerType: gesture.pointerType,
    });
  const end = async (gesture, dx, dy, { cancel = false, click = true } = {}) => {
    await pointer(
      cancel ? 'pointercancel' : 'pointerup',
      { x: gesture.start.x + dx, y: gesture.start.y + dy },
      gesture.id,
      { pointerType: gesture.pointerType },
    );
    if (click) await compatClick();
    await settle();
  };
  const swipe = async (dy, options = {}) => {
    const before = writes(),
      gesture = await begin(options),
      dx = options.dx || 0;
    await move(gesture, dx, dy);
    await end(gesture, dx, dy, options);
    await noWrite(before, 'A history gesture must not send, confirm a command, or interrupt');
  };
  const openPane = async (provider) => {
    if (
      viewport.width <= 760 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#chatPickerList [data-pane-id="pane-' + provider + '"]').click();
    await expect(page.locator('#chatLog')).toHaveAttribute('data-pane-id', 'pane-' + provider);
    await expect(page.locator('#chatLog')).toContainText(provider + ' 浏览器验收样例');
    await expect(input).toBeEnabled();
    await settle();
  };
  const tapButton = async () => {
    const at = await point('#sendButton');
    if (viewport.touch) await page.touchscreen.tap(at.x, at.y);
    else await page.mouse.click(at.x, at.y);
  };
  const unchangedGesture = async (action, value) => {
    const before = writes();
    await action();
    await expect(input).toHaveValue(value);
    await noWrite(before, 'Cancelled or guarded gestures must not write');
  };
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await expect(input).toBeEnabled();
    await expect(zone).toBeVisible();
    await expect(button).toBeDisabled();
    await geometry('empty');
    mark('fullHeightSendColumnRetainsButtonSizeAndComposerBounds');

    stage = 'normal native button tap';
    await fill('正常点击发送');
    const blankTap = await point('#sendHistoryZone', 0.02),
      beforeBlankTap = writes();
    if (viewport.touch) await page.touchscreen.tap(blankTap.x, blankTap.y);
    else await page.mouse.click(blankTap.x, blankTap.y);
    await expect(input).toHaveValue('正常点击发送');
    await noWrite(beforeBlankTap, 'Tapping the empty send column must not send');
    await tapButton();
    expectedMessages++;
    await expect(input).toHaveValue('');
    await expect.poll(() => requests().length).toBe(expectedMessages);
    assert.equal(requests().at(-1).body.text, '正常点击发送');
    mark('ordinaryButtonTapUsesExistingMessageSubmission');

    stage = 'shared keyboard and touch navigation';
    const draft = '尚未发送的独立草稿\n第二行草稿';
    await fill(draft);
    await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await input.press('ArrowUp');
    await expect(input).toHaveValue(draft);
    await input.evaluate((el) => el.setSelectionRange(0, 4));
    await input.press('ArrowUp');
    await expect(input).toHaveValue(draft);
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await input.press('ArrowUp');
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][1]);
    await swipe(80);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await input.press('ArrowDown');
    await expect(input).toHaveValue(draft);
    mark('keyboardCaretRulesAndTouchShareHistoryAndRestoreDraft');

    stage = 'disabled empty send and full column gestures';
    await fill('');
    await expect(button).toBeDisabled();
    await swipe(-80, { fraction: 0.05 });
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await geometry('long-history');
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][1]);
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][0]);
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][0]);
    for (const value of [history['pane-codex'][1], history['pane-codex'][2], '']) {
      await swipe(80);
      await expect(input).toHaveValue(value);
    }
    await fill(draft);
    const longGesture = await begin();
    const longBefore = writes();
    await move(longGesture, 0, -40);
    await move(longGesture, 0, -100);
    await move(longGesture, 0, -200);
    await expect(input).toHaveValue(draft);
    await end(longGesture, 0, -200);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await noWrite(longBefore, 'A long gesture commits one entry only on release');
    await swipe(80);
    await expect(input).toHaveValue(draft);
    await swipe(-28);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await expect(input).toBeFocused();
    await tapButton();
    expectedMessages++;
    await expect(input).toHaveValue('');
    await expect.poll(() => requests().length).toBe(expectedMessages);
    assert.equal(requests().at(-1).body.text, history['pane-codex'][2]);
    await swipe(80);
    await expect(input).toHaveValue('');
    mark('emptyDisabledButtonAndCrossCardSwipesMoveOneEntryAtRelease');

    stage = 'caret selection and normal text scrolling';
    await fill(draft);
    await input.evaluate((el) => el.setSelectionRange(3, el.value.length));
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    const longBox = await geometry('maximum-input');
    // Long drafts cap at 168px; touch screens reserve at least 75% for other content.
    const maximumHeight = Math.min(168, viewport.touch ? viewport.height / 4 : Infinity);
    assert(
      Math.abs(longBox.input.height - maximumHeight) <= 1,
      'Long draft must respect the available viewport height',
    );
    await input.evaluate((el) => {
      el.scrollTop = 0;
    });
    const field = await input.boundingBox();
    await page.mouse.move(field.x + field.width / 2, field.y + field.height / 2);
    const beforeWheel = writes();
    await page.mouse.wheel(0, 220);
    await expect.poll(() => input.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    await noWrite(beforeWheel, 'Textarea scrolling remains native');
    await swipe(80);
    await expect(input).toHaveValue(draft);
    mark('touchIgnoresCaretLineAndSelectionWithoutInterceptingTextScroll');

    stage = 'cancelled gestures and click suppression';
    for (const options of [
      { dy: -20 },
      { dy: -40, dx: 50 },
      { dy: -27 },
      { dy: -80, cancel: true },
    ]) {
      await fill('取消手势的草稿');
      await unchangedGesture(() => swipe(options.dy, options), '取消手势的草稿');
    }
    await fill('多指手势的草稿');
    const multi = await begin(),
      second = { x: multi.start.x - 60, y: multi.start.y };
    const multiBefore = writes();
    await pointer('pointerdown', second, multi.id + 100, { primary: false });
    await move(multi, 0, -80);
    await pointer('pointerup', second, multi.id + 100, { primary: false });
    await end(multi, 0, -80);
    await expect(input).toHaveValue('多指手势的草稿');
    await noWrite(multiBefore, 'Multitouch cannot recall or send');
    await fill('新的一次点击仍可发送');
    await tapButton();
    expectedMessages++;
    await expect(input).toHaveValue('');
    await expect.poll(() => requests().length).toBe(expectedMessages);
    mark('shortHorizontalCancelledAndMultitouchGesturesNeverSendButNextTapWorks');

    stage = 'IME and disabled readonly guards';
    await fill('中文预编辑草稿');
    await input.dispatchEvent('compositionstart', { data: '中' });
    await unchangedGesture(() => swipe(-80), '中文预编辑草稿');
    await input.dispatchEvent('compositionend', { data: '中文' });
    await fill('滑动中开始中文预编辑');
    const composingSwipe = await begin(),
      composingBefore = writes();
    await move(composingSwipe, 0, -80);
    await input.dispatchEvent('compositionstart', { data: '中' });
    await input.dispatchEvent('compositionend', { data: '中文' });
    await end(composingSwipe, 0, -80);
    await expect(input).toHaveValue('滑动中开始中文预编辑');
    await noWrite(
      composingBefore,
      'Composition during a swipe invalidates history even after composition ends',
    );
    await fill('中文预编辑草稿');
    await input.evaluate((el) => {
      el.disabled = true;
    });
    await unchangedGesture(() => swipe(-80), '中文预编辑草稿');
    await input.evaluate((el) => {
      el.disabled = false;
      el.readOnly = true;
    });
    await unchangedGesture(() => swipe(-80), '中文预编辑草稿');
    await input.evaluate((el) => {
      el.readOnly = false;
    });
    await input.dispatchEvent('compositionstart', { data: '中' });
    const commitTap = await begin({ selector: '#sendButton' });
    await input.evaluate((el) => {
      el.value = '输入法提交后点击发送的消息';
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: '中文',
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      );
    });
    await input.dispatchEvent('compositionend', { data: '中文' });
    await end(commitTap, 0, 0);
    expectedMessages++;
    await expect(input).toHaveValue('');
    await expect.poll(() => requests().length).toBe(expectedMessages);
    assert.equal(requests().at(-1).body.text, '输入法提交后点击发送的消息');
    mark('compositionSwipesAreBlockedButCommittedButtonTapsRemainSendable');

    stage = 'native command guard';
    await fill('/');
    await expect(page.locator('.native-command-panel')).toBeVisible();
    const selectedCommand = await page
      .locator('.native-command-row[aria-selected="true"]')
      .textContent();
    await unchangedGesture(() => swipe(-80), '/');
    assert.equal(
      await page.locator('.native-command-row[aria-selected="true"]').textContent(),
      selectedCommand,
    );
    await page
      .locator('.native-command-panel')
      .getByRole('button', { name: '结束命令交互' })
      .click();
    await expect(page.locator('.native-command-panel')).toBeHidden();
    mark('nativeCommandSelectionIsNotChangedOrConfirmedByHistoryGesture');

    stage = 'historical message edit guard';
    const targetId = 'pane-codex-input-history-1',
      session = fixture.state.sessions['pane-codex'];
    await page.route('**/api/agents/rewind', (route) => {
      const body = route.request().postDataJSON();
      assert.equal(body.messageId, targetId);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          preparation: {
            id: 'input-history-edit-preparation',
            messageId: targetId,
            sourceText: history['pane-codex'][1],
            historyRevision: Conversation.historyVersion(session.messages),
            identity: Conversation.identity(session.pane),
          },
        }),
      });
    });
    await fill('编辑前普通草稿');
    const bubble = page.locator('.chat-msg[data-message-id="' + targetId + '"]');
    await bubble.scrollIntoViewIfNeeded();
    const blank = await bubble.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 5 };
    });
    await page.mouse.click(blank.x, blank.y, { button: 'right' });
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await expect(input).toHaveValue(history['pane-codex'][1]);
    await unchangedGesture(() => swipe(-80), history['pane-codex'][1]);
    await page.getByRole('button', { name: '取消编辑历史消息', exact: true }).click();
    await expect(input).toHaveValue('编辑前普通草稿');
    mark('historicalMessageEditCannotBecomeInputHistoryOrSubmit');

    stage = 'changed draft and input enabled state';
    await fill('动作开始的草稿');
    const changed = await begin(),
      changedBefore = writes();
    await move(changed, 0, -80);
    await fill('动作期间的新草稿');
    await end(changed, 0, -80);
    await expect(input).toHaveValue('动作期间的新草稿');
    await noWrite(changedBefore, 'Changed input invalidates an active gesture');
    const disabled = await begin();
    await move(disabled, 0, -80);
    await input.evaluate((el) => {
      el.disabled = true;
    });
    await end(disabled, 0, -80);
    await expect(input).toHaveValue('动作期间的新草稿');
    await noWrite(changedBefore, 'Disabled input invalidates an active gesture');
    await input.evaluate((el) => {
      el.disabled = false;
    });
    mark('draftOrEnabledChangesInvalidateGestureAndSuppressReleaseClick');

    stage = 'session and runtime isolation';
    await fill('Codex 原会话草稿');
    const switching = await begin(),
      switchBefore = writes();
    await move(switching, 0, -80);
    await openPane('claude');
    await fill('Claude 独立草稿');
    await end(switching, 0, -80);
    await expect(input).toHaveValue('Claude 独立草稿');
    await noWrite(switchBefore, 'Changing sessions invalidates a gesture');
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-claude'][2]);
    await swipe(80);
    await expect(input).toHaveValue('Claude 独立草稿');
    await openPane('codex');
    await expect(input).toHaveValue('Codex 原会话草稿');
    const runtime = await begin();
    await move(runtime, 0, -80);
    fixture.state.runtimeId = 'input-history-runtime-restarted';
    session.pane = {
      ...session.pane,
      title: 'Runtime refreshed input history',
      displayAgent: 'Runtime refreshed input history',
      tabTitle: 'Runtime refreshed input history',
    };
    const runtimeSnapshot = page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === '/api/snapshot' &&
        (await response.json()).runtimeId === fixture.state.runtimeId,
    );
    await refresh();
    result.observedRuntimeId = (await (await runtimeSnapshot).json()).runtimeId;
    await expect(page.locator('#chatPickerList [data-pane-id="pane-codex"]')).toContainText(
      'Runtime refreshed input history',
    );
    await end(runtime, 0, -80);
    await expect(input).toHaveValue('Codex 原会话草稿');
    await noWrite(switchBefore, 'Runtime changes invalidate a gesture');
    const rootChange = await begin();
    await move(rootChange, 0, -80);
    await page.evaluate(async () => {
      const response = await fetch('/api/config?token=fixture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootDirectory: '/fixture/project' }),
      });
      if (!response.ok) throw new Error('Fixture root change failed');
    });
    await expect(input).toHaveValue('');
    await fill('新根目录的独立草稿');
    await end(rootChange, 0, -80);
    await expect(input).toHaveValue('新根目录的独立草稿');
    await noWrite(switchBefore, 'Root changes invalidate a gesture');
    mark('sessionRuntimeAndRootChangesKeepEachDraftAndHistoryIsolated');

    stage = 'pending submission guard';
    const pendingDraft = '发送挂起时的草稿';
    fixture.setSendBehavior(pendingDraft, 'hold');
    await fill(pendingDraft);
    await tapButton();
    expectedMessages++;
    await expect.poll(() => requests().length).toBe(expectedMessages);
    const heldId = requests().at(-1).body.id;
    await expect.poll(() => fixture.isHeld(heldId)).toBe(true);
    await unchangedGesture(() => swipe(-80), pendingDraft);
    fixture.release(heldId);
    await expect(input).toHaveValue('');
    mark('pendingSubmissionCannotRecallHistoryOrResend');

    stage = 'mouse drag and independent interruption with empty history';
    await fill('新根目录的独立草稿');
    const mouseStart = await point('#sendHistoryZone', 0.02),
      mouseBefore = writes();
    await page.mouse.move(mouseStart.x, mouseStart.y);
    await page.mouse.down();
    await page.mouse.move(mouseStart.x, mouseStart.y - 80, { steps: 4 });
    await page.mouse.up();
    await expect(input).toHaveValue('新根目录的独立草稿');
    await noWrite(mouseBefore, 'A real mouse drag keeps its existing behavior');
    session.pane.agent.status = 'working';
    await refresh();
    await fill('');
    await expect(button).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('#chatControls #chatInterrupt')).toHaveCount(0);
    await swipe(-80);
    await expect(input).toHaveValue(history['pane-codex'][2]);
    session.messages = session.messages.filter((message) => message.role !== 'user');
    await refresh();
    await expect(page.locator('#chatLog .chat-msg[data-role="user"]')).toHaveCount(0);
    await fill('');
    await expect(button).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('#chatControls #chatInterrupt')).toHaveCount(0);
    await swipe(-80);
    await expect(input).toHaveValue('');
    mark('mouseDragDoesNotRecallAndBusyOrEmptyHistorySwipesNeverInterrupt');

    stage = 'failed send draft and reading position';
    const failed = '发送失败后仍保留的草稿';
    fixture.setSendBehavior(failed, 'fail');
    await fill(failed);
    await tapButton();
    expectedMessages++;
    await expect(page.locator('#chatComposerError')).toContainText('模拟发送失败');
    await expect(input).toHaveValue(failed);
    await expect.poll(() => requests().length).toBe(expectedMessages);
    await swipe(-80);
    await expect(input).toHaveValue(failed);
    const log = page.locator('#chatLog');
    await log.evaluate((el) => {
      el.scrollTop = 120;
      el.dispatchEvent(new Event('scroll'));
    });
    const reading = await log.evaluate((el) => el.scrollTop);
    assert(reading > 0);
    await fill(Array.from({ length: 20 }, (_, i) => '第' + i + '行继续输入中文。').join('\n'));
    await expect
      .poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(maximumHeight);
    await geometry('long-draft');
    assert(
      Math.abs((await log.evaluate((el) => el.scrollTop)) - reading) <= 1,
      'Input resize must preserve the chat reading position',
    );
    await fill('最终草稿');
    await expect.poll(() => input.evaluate((el) => el.getBoundingClientRect().height)).toBe(56);
    await geometry('final');
    await page.screenshot({ path: path.join(output, viewport.name + '-final.png') });
    mark('sendFailurePreservesDraftAndInputHeightChangesPreserveReading');

    assert.equal(requests().length, expectedMessages);
    assert.equal(writes(), expectedMessages, 'Only the explicit ordinary taps may write');
    assert(!fixture.state.frames.some((frame) => /terminal\.(input|paste|key)/.test(frame)));
    assert.deepEqual(fixture.state.unexpected, []);
    assert.deepEqual(errors, []);
    mark('noGestureWritesNativeInputOrSendsAnUnexpectedMessage');
    result.ok = true;
  } catch (error) {
    result.stage = stage;
    result.error = error.stack;
    result.browserErrors = errors;
    result.requests = fixture.state.requests.slice(-20);
    await page
      .screenshot({ path: path.join(output, viewport.name + '-failure.png'), fullPage: true })
      .catch(() => {});
  } finally {
    await context.close();
    await fixture.close();
  }
  console.log(
    (result.ok ? 'PASS ' : 'FAIL ') +
      viewport.name +
      (result.error ? ' ' + stage + ': ' + result.error : ''),
  );
  return result;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(root),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of viewports) results.push(await oneViewport(browser, viewport));
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(root),
    unchanged = JSON.stringify(before) === JSON.stringify(after);
  const report = {
    ok: unchanged && results.every((result) => result.ok),
    before,
    after,
    browser: 'firefox',
    touch: 'synthetic PointerEvent gestures and native Firefox touchscreen taps',
    productionInput: false,
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  assert(unchanged, 'Source changed during input history validation');
  assert(
    report.ok,
    'Mobile input history browser failures; see ' + path.join(output, 'report.json'),
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

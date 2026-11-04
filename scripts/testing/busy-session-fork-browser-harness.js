#!/usr/bin/env node
'use strict';
// Real production UI, isolated controllable job API. Native process safety is
// verified by the separate backend and PTY harnesses.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { createBusyForkFixture } = require('./busy-session-fork-fixture');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/testing/busy-session-fork/browser');
const viewports = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'mobile-small', width: 320, height: 640, touch: true },
];

async function oneViewport(browser, viewport) {
  const fixture = await createBusyForkFixture(),
    state = fixture.state;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  if (viewport.touch)
    await context.addInitScript(() => {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
  );
  await fixture.attach(page);
  const input = page.locator('#commandInput'),
    menu = page.locator('.popover.context-menu');
  const notice = page.locator('.herdr-operation-notice:not(.herdr-restore-notice)'),
    restore = page.locator('.herdr-restore-notice');
  const closeOperation = page.getByRole('button', { name: '关闭操作提示', exact: true });
  const closeRestore = page.getByRole('button', { name: '关闭恢复提示', exact: true });
  const forkItem = () => menu.getByRole('menuitem', { name: 'Fork 会话', exact: true });
  const result = {
    viewport,
    ok: false,
    checks: [],
    geometry: [],
    randomUUIDUnavailable: viewport.touch,
  };
  const draft = '父会话继续输入的草稿\n保留中文和原有内容。';
  let stage = 'startup',
    refreshId = 0;
  const mark = (name) => result.checks.push(name);
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const settled = () => expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
  const tap = async (locator) => {
    if (viewport.touch) {
      const box = await locator.boundingBox();
      assert(box);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else await locator.click();
  };
  const openMenu = async () => {
    const nativeTab = page.locator('.herdr-tab[data-tab-id="tab-codex"]');
    const anchor = (await nativeTab.isVisible()) ? nativeTab : page.locator('#chatCurrentName');
    await expect(anchor).toBeVisible();
    if (viewport.touch)
      await anchor.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
    else await anchor.click({ button: 'right' });
    await expect(menu).toBeVisible();
  };
  const start = async ({ duplicateClick = false } = {}) => {
    const before = fixture.starts.length;
    await openMenu();
    await expect(forkItem()).toBeEnabled();
    if (duplicateClick)
      await forkItem().evaluate((button) => {
        button.click();
        button.click();
      });
    else await forkItem().click();
    await expect.poll(() => fixture.starts.length).toBe(before + 1);
    await expect(page.locator('body')).toHaveClass(/herdr-operation-pending/);
    return fixture.starts.at(-1).requestId;
  };
  const refresh = async () => {
    const label = 'Fork browser refresh ' + ++refreshId,
      other = state.sessions['pane-claude'];
    other.pane = { ...other.pane, title: label, displayAgent: label, tabTitle: label };
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/snapshot' && r.request().method() === 'GET',
    );
    fixture.changed();
    await (await response).finished();
    await expect(page.locator('#chatPickerList [data-pane-id="pane-claude"]')).toHaveAttribute(
      'title',
      new RegExp(label),
    );
    await settle();
  };
  const receipt = async (id) => {
    // APIRequestContext bypasses page routes. Use the browser's real fetch so
    // these reads exercise the same isolated endpoint as the UI's polling.
    const response = await page.evaluate(async (id) => {
      const response = await fetch('/api/agents/fork?requestId=' + encodeURIComponent(id));
      return { status: response.status, body: await response.json() };
    }, id);
    assert.equal(response.status, 200);
    const data = response.body;
    assert.equal(data.ok, true);
    assert.equal(data.job.requestId, id);
    return data.job;
  };
  const geometry = async (label) => {
    const value = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element || element.hidden || !element.getClientRects().length) return null;
        const r = element.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overflow: document.documentElement.scrollWidth - innerWidth,
        mainPanelScrollLeft: document.querySelector('.main-panel').scrollLeft,
        operation: box('.herdr-operation-notice:not(.herdr-restore-notice)'),
        restore: box('.herdr-restore-notice'),
        closeOperation: box('[aria-label="关闭操作提示"]'),
        closeRestore: box('[aria-label="关闭恢复提示"]'),
        input: box('#commandInput'),
      };
    });
    result.geometry.push({ label, ...value });
    assert.equal(value.overflow, 0);
    assert.equal(value.mainPanelScrollLeft, 0);
    for (const [rect, close] of [
      [value.operation, value.closeOperation],
      [value.restore, value.closeRestore],
    ])
      if (rect) {
        assert(rect.left >= -1 && rect.right <= viewport.width + 1);
        assert(
          rect.scrollWidth <= rect.clientWidth + 1,
          'Long feedback must wrap within the notice',
        );
        assert(
          close &&
            close.width >= (viewport.touch ? 44 : 28) - 1 &&
            close.height >= (viewport.touch ? 44 : 28) - 1,
        );
        assert(
          close.left >= rect.left - 1 &&
            close.right <= rect.right + 1 &&
            close.top >= rect.top - 1 &&
            close.bottom <= rect.bottom + 1,
        );
      }
    return value;
  };
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    if (viewport.touch)
      assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await input.fill(draft);
    const inputNode = await input.elementHandle(),
      parent = fixture.snapshotParent();
    const readDraft = () =>
      page.evaluate(() =>
        Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) =>
              key.endsWith(':draft:' + encodeURIComponent('codex:session:thread-codex')),
            )
            .map((key) => [key, localStorage.getItem(key)]),
        ),
      );
    const draftBefore = await readDraft();
    const preserved = async () => {
      assert.deepEqual(fixture.snapshotParent(), parent);
      await expect(input).toHaveValue(draft);
      await expect(page.locator('#chatLog')).toHaveAttribute('data-pane-id', 'pane-codex');
      assert(
        await inputNode.evaluate(
          (node) => node === document.querySelector('#commandInput') && node.isConnected,
        ),
      );
      assert.deepEqual(await readDraft(), draftBefore);
    };

    stage = 'busy fork pending and dismiss';
    const first = await start({ duplicateClick: true });
    await expect(notice).toContainText('正在 Fork');
    const readsBefore = fixture.reads.length;
    await tap(closeOperation);
    await expect(notice).toBeHidden();
    await expect.poll(() => fixture.reads.length).toBeGreaterThan(readsBefore + 1);
    await expect(page.locator('body')).toHaveClass(/herdr-operation-pending/);
    const parentTabControl = page.locator('.herdr-tab[data-tab-id="tab-codex"] .herdr-tab-select');
    if (await parentTabControl.isVisible()) await expect(parentTabControl).toBeDisabled();
    else {
      await openMenu();
      await expect(forkItem()).toBeDisabled();
      await page.keyboard.press('Escape');
    }
    assert.equal(fixture.starts.length, 1);
    assert.equal(fixture.children.length, 0);
    await refresh();
    await expect(notice).toBeHidden();
    await preserved();
    mark('pendingNoticeDismissalKeepsBusyLockAndDoesNotReplay');

    const firstJob = fixture.complete(first);
    await settled();
    await expect(notice).toBeHidden();
    await preserved();
    assert.equal(firstJob.status, 'succeeded');
    assert.equal(firstJob.goalPaused, true);
    assert.equal(firstJob.goalStatus, 'paused');
    assert.equal(state.sessions[firstJob.paneId].pane.agent.session.value, firstJob.sessionId);
    assert.equal(state.sessions[firstJob.paneId].pane.agent.status, 'idle');
    const parentTab = state.sessions['pane-codex'].pane.tabId,
      index = state.tabs.findIndex((tab) => tab.tab_id === parentTab);
    assert.equal(state.tabs[index + 1].tab_id, firstJob.tabId);
    mark('busyParentForkPreservesItsInputDraftGoalAndFocusAndPausesChild');

    stage = 'receipt reads never create another child';
    for (let i = 0; i < 3; i++) {
      const job = await receipt(first);
      assert.equal(job.paneId, firstJob.paneId);
    }
    assert.equal(fixture.children.length, 1);
    assert.equal(fixture.starts.length, 1);
    mark('repeatedReceiptReadsDoNotCreateAnotherChild');

    stage = 'lost POST reply is recovered using GET only';
    fixture.loseNextStartReply();
    const lost = await start();
    await expect
      .poll(() => fixture.reads.filter((read) => read.requestId === lost).length)
      .toBeGreaterThan(0);
    const recovered = fixture.complete(lost);
    await settled();
    await expect(notice).toBeHidden();
    await preserved();
    assert.equal(fixture.starts.filter((body) => body.requestId === lost).length, 1);
    assert.equal(fixture.children.length, 2);
    assert.equal(recovered.goalPaused, true);
    mark('lostStartReplyRecoversSameRequestIdWithoutRepeatingPost');

    stage = 'failure can be dismissed without reopening on refresh';
    const failure = 'Fork 夹具失败：已保留现场，请核对当前会话。';
    const failed = await start();
    fixture.fail(failed, failure);
    await settled();
    await expect(notice).toContainText(failure);
    const failedStarts = fixture.starts.length,
      failedReads = fixture.reads.length;
    await tap(closeOperation);
    await expect(notice).toBeHidden();
    await receipt(failed);
    await refresh();
    await expect(notice).toBeHidden();
    assert.equal(fixture.starts.length, failedStarts);
    assert(fixture.reads.length > failedReads);
    await preserved();
    mark('failureDismissalSurvivesReceiptReadsAndSnapshotRefresh');

    stage = 'same error in a new operation and keyboard dismissal';
    const sameFailure = await start();
    fixture.fail(sameFailure, failure);
    await settled();
    await expect(notice).toContainText(failure);
    await closeOperation.focus();
    await page.keyboard.press('Enter');
    await expect(notice).toBeHidden();
    await expect(input).toBeFocused();
    await refresh();
    await expect(notice).toBeHidden();
    await preserved();
    mark('newOperationShowsSameFailureAndKeyboardDismissalReturnsFocus');

    stage = 'new long error and independent restoration feedback';
    const longFailure =
      '新的 Fork 错误：' + 'long_unbroken_session_identifier_'.repeat(6) + ' 请保留现场后检查。';
    const changedFailure = await start();
    fixture.fail(changedFailure, longFailure);
    await settled();
    await expect(notice).toContainText(longFailure);
    await geometry('long-failure');
    await page.screenshot({ path: path.join(output, viewport.name + '-long-error.png') });
    mark('newFailureTextIsVisibleAndWrapsWithinNarrowViewport');

    const restoreError = 'fixture restore guard must remain after dismissal';
    fixture.setRestoreError(restoreError);
    await refresh();
    await expect(restore).toContainText(restoreError);
    await tap(closeOperation);
    await expect(notice).toBeHidden();
    await expect(restore).toBeVisible();
    assert.equal(state.sessions['pane-codex'].pane.restoreError, restoreError);
    await closeRestore.focus();
    await page.keyboard.press('Enter');
    await expect(restore).toBeHidden();
    await expect(input).toBeFocused();
    await refresh();
    await expect(restore).toBeHidden();
    await expect(notice).toBeHidden();
    const snapshot = await (await page.request.get(fixture.url + '/api/snapshot')).json();
    assert.equal(
      snapshot.panes.find((pane) => pane.paneId === 'pane-codex').restoreError,
      restoreError,
    );
    assert.equal(fixture.starts.length, 5);
    mark('independentRestoreDismissalRetainsBackendErrorAndDoesNotRetry');
    fixture.setRestoreError('');
    await refresh();
    await expect(restore).toBeHidden();

    stage = 'uncertain result and final notice dismissal';
    const uncertain = await start();
    fixture.uncertain(uncertain, 'Fork 结果尚未确认，请核对已创建的 Tab；不会自动重复创建。');
    await settled();
    await expect(notice).toContainText('尚未确认');
    const uncertainPosts = fixture.starts.length;
    await tap(closeOperation);
    await receipt(uncertain);
    await refresh();
    await expect(notice).toBeHidden();
    assert.equal(fixture.starts.length, uncertainPosts);
    assert.equal(fixture.children.length, 2);
    await preserved();
    mark('uncertainResultDismissalNeverCreatesOrReplaysAChild');

    fixture.setRestoreError('新的恢复错误仍可单独关闭。');
    await refresh();
    await expect(restore).toContainText('新的恢复错误');
    await geometry('final');
    await page.screenshot({ path: path.join(output, viewport.name + '-final.png') });
    const forbidden = state.requests.filter(
      (request) =>
        request.route.startsWith('POST ') &&
        !['POST /api/panes/view', 'POST /api/panes/focus'].includes(request.route),
    );
    assert.deepEqual(
      forbidden,
      [],
      'Fork feedback must not send ordinary messages, interrupt, or invoke the old native command flow',
    );
    assert(!state.frames.some((frame) => /terminal\.(input|paste|key)/.test(frame)));
    assert.deepEqual(state.unexpected, []);
    assert.deepEqual(errors, []);
    assert(fixture.starts.every((body) => !Object.hasOwn(body, 'action')));
    assert.equal(fixture.starts.length, 6);
    result.counts = {
      checks: result.checks.length + 1,
      startRequests: fixture.starts.length,
      uniqueJobs: fixture.jobsMap.size,
      receiptReads: fixture.reads.length,
      childrenCreated: fixture.children.length,
      ordinaryMessages: 0,
      interrupts: 0,
      legacyCommandRequests: 0,
      terminalInputs: 0,
    };
    result.jobs = [...fixture.jobsMap.values()];
    result.requestTrace = fixture.trace;
    mark('forkAndDismissActionsNeverWriteToParentOrLegacyCommandEndpoints');
    result.ok = true;
  } catch (error) {
    result.stage = stage;
    result.error = error.stack;
    result.browserErrors = errors;
    result.requestTrace = fixture.trace;
    result.requests = state.requests.slice(-20);
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

async function main() {
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
    fixtureBackend: true,
    productionInput: false,
    touch: 'synthetic OS context menus and native Firefox touchscreen notice taps',
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  assert(unchanged, 'Source changed during busy fork browser validation');
  assert(report.ok, 'Busy fork browser failures; see ' + path.join(output, 'report.json'));
}
module.exports = { main };
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });

'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/mobile-session-fork/fork-view');
const cases = [
  'initializing',
  'queued-initialization',
  'known-session-changed',
  'terminal-changed',
  'runtime-changed',
  'root-changed',
  'selection-changed',
  'reply-lost',
  'rejected-again',
];

async function run(browser, viewport, kind) {
  const fixture = await createFixture(),
    state = fixture.state;
  state.productionPresentation = true;
  const parent = state.sessions['pane-codex'].pane;
  parent.agent.status = 'idle';
  state.tabs = Object.values(state.sessions).map((s) => ({
    tab_id: s.pane.tabId,
    workspace_id: s.pane.workspaceId,
    label: s.pane.title,
  }));
  let child, held, release, parentHeld, releaseParent;
  state.nativeFork = async () => {
    const session = structuredClone(state.sessions['pane-codex']);
    const known = ['known-session-changed', 'reply-lost'].includes(kind);
    child = session.pane = {
      ...session.pane,
      paneId: 'fork-starting',
      terminalId: 'fork-terminal',
      tabId: 'fork-tab',
      title: 'Codex fork',
      agent: known ? structuredClone(parent.agent) : null,
    };
    if (known) child.agent.session.value = 'fork-session';
    state.sessions[child.paneId] = session;
    state.tabs.splice(state.tabs.findIndex((t) => t.tab_id === parent.tabId) + 1, 0, {
      tab_id: child.tabId,
      workspace_id: child.workspaceId,
      label: child.title,
    });
    return child;
  };
  state.holdNativeView = async (body) => {
    if (kind === 'queued-initialization' && body.target === parent.paneId && !parentHeld) {
      parentHeld = true;
      await new Promise((resolve) => {
        releaseParent = resolve;
      });
      return;
    }
    if (body.target !== child?.paneId || held) return;
    held = true;
    if (kind === 'reply-lost') return;
    child.agent = structuredClone(parent.agent);
    child.agent.session.value =
      kind === 'known-session-changed' ? 'different-session' : 'fork-session';
    if (kind === 'terminal-changed') child.terminalId = 'replacement-terminal';
    if (kind === 'runtime-changed') state.runtimeId = 'replacement-runtime';
    if (kind === 'root-changed') state.rootDirectory = '/fixture';
    if (kind === 'selection-changed')
      await new Promise((resolve) => {
        release = resolve;
      });
    // No notification yet: a native report can precede the next UI snapshot.
  };
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [],
    views = [],
    writes = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const route = new URL(request.url()).pathname;
    if (request.method() !== 'POST') return;
    if (route === '/api/panes/view') views.push(request.postDataJSON());
    if (['/api/command-interaction', '/api/agents/fork', '/api/messages'].includes(route))
      writes.push({ route, body: request.postDataJSON() });
  });
  const childViews = () => views.filter((v) => v.target === child?.paneId);
  const composerError = page.locator('#chatComposerError');
  const select = async (id) => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarWorkspaces').click();
    await page.locator(`#chatPickerList [data-pane-id="${id}"]`).click();
  };
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('保留父会话草稿');
    // Simulate an external Fork/new Tab, then explicitly select it below. This
    // harness verifies native-view identity recovery, not Swift's Fork API;
    // the busy-session-fork browser harness covers that creation workflow.
    await state.nativeFork();
    fixture.changed();
    await fixture.synced();
    assert.equal(state.focusedPaneId, parent.paneId);
    await expect(page.locator('#commandInput')).toHaveValue('保留父会话草稿');
    let intercepted = 0;
    if (['reply-lost', 'rejected-again'].includes(kind)) {
      await page.route('**/api/panes/view', async (route) => {
        if (route.request().postDataJSON().target !== child.paneId) return route.continue();
        intercepted++;
        if (kind === 'reply-lost' && intercepted === 1) {
          await route.fetch();
          return route.abort();
        }
        if (kind === 'rejected-again' && intercepted > 1)
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'TARGET_CHANGED', message: '原生视图仍拒绝定位' }),
          });
        return route.continue();
      });
    }
    const readback = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/snapshot' && held,
    );
    await select(child.paneId);
    if (kind === 'queued-initialization') {
      await expect.poll(() => Boolean(releaseParent)).toBe(true);
      child.agent = structuredClone(parent.agent);
      child.agent.session.value = 'fork-session';
      fixture.changed();
      await fixture.synced();
      await expect(page.locator('#chatCurrentDot')).toHaveAttribute('data-status', 'idle');
      releaseParent();
    }
    if (kind === 'selection-changed') {
      await expect.poll(() => Boolean(release)).toBe(true);
      await select(parent.paneId);
      release();
    }
    await readback;
    if (['initializing', 'queued-initialization'].includes(kind)) {
      await expect.poll(() => state.focusedPaneId).toBe(child.paneId);
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await expect(composerError).toBeHidden();
      assert.deepEqual(
        childViews().map((v) => v.expected.sessionId),
        kind === 'initializing' ? ['', 'fork-session'] : ['fork-session'],
      );
      await page.screenshot({ path: path.join(output, viewport.name + '-ready.png') });
      await select(parent.paneId);
      await expect(page.locator('#commandInput')).toHaveValue('保留父会话草稿');
    } else if (kind === 'reply-lost') {
      await expect(composerError).toContainText('原生会话定位失败');
      assert.equal(childViews().length, 1, 'Uncertain replies must not replay native navigation');
      await select(child.paneId);
      await expect(composerError).toBeHidden();
      assert.equal(childViews().length, 2, 'Only explicit reselection may navigate again');
      await page.route('**/api/messages', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'FIXTURE_SEND_FAILED', message: '模拟消息发送失败' }),
        }),
      );
      await page.locator('#commandInput').fill('必须保留的发送错误');
      await page.locator('#sendButton').click();
      await expect(composerError).toContainText('模拟消息发送失败');
      await select(child.paneId);
      await expect.poll(() => childViews().length).toBe(3);
      await expect(composerError).toContainText('模拟消息发送失败');
    } else if (kind === 'rejected-again') {
      await expect(composerError).toContainText('原生视图仍拒绝定位');
      await expect(composerError).toHaveAttribute('data-source', 'native-view');
      assert.equal(childViews().length, 2, 'Initialization recovery is bounded to one retry');
      assert.equal(state.focusedPaneId, parent.paneId);
      await page.screenshot({ path: path.join(output, viewport.name + '-rejected.png') });
      await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
      await select(child.paneId);
      await expect.poll(() => childViews().length).toBe(3);
      await expect(composerError).toBeVisible();
    } else {
      await fixture.synced();
      if (kind === 'selection-changed')
        await expect(page.locator('#commandInput')).toHaveValue('保留父会话草稿');
      assert.equal(state.focusedPaneId, parent.paneId);
      assert.equal(
        childViews().length,
        1,
        'Changed identities or a later selection must not retarget native navigation',
      );
    }
    assert.deepEqual(errors, []);
    assert(
      !writes.some((r) => r.route === '/api/command-interaction' || r.route === '/api/agents/fork'),
      'Native-view recovery must not invoke Fork or native commands',
    );
    assert.deepEqual(
      writes.filter((r) => r.route === '/api/messages').map((r) => r.body.text),
      kind === 'reply-lost' ? ['必须保留的发送错误'] : [],
      'Only the explicit send-error isolation case may send a message',
    );
    if (kind !== 'reply-lost')
      assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
    return {
      viewport: viewport.name,
      case: kind,
      ok: true,
      nativeViewRequests: childViews().length,
    };
  } catch (error) {
    await page
      .screenshot({ path: path.join(output, `${viewport.name}-${kind}-failure.png`) })
      .catch(() => {});
    throw error;
  } finally {
    release?.();
    releaseParent?.();
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
      { name: 'desktop', width: 1440, height: 900, touch: false },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'phone', width: 390, height: 844, touch: true },
      { name: 'small-phone', width: 320, height: 640, touch: true },
    ]) {
      for (const kind of cases) {
        const result = await run(browser, viewport, kind);
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      { ok: true, before, after, browser: 'firefox', touch: 'emulated contextmenu', results },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, cases: results.length }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

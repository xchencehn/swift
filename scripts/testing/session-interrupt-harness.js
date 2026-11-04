'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length) ||
    'artifacts/testing/mobile-session-fork/interrupt-browser',
);
async function run(browser, viewport) {
  const fixture = await createFixture(),
    state = fixture.state;
  state.productionPresentation = true;
  const other = structuredClone(state.sessions['pane-codex']);
  other.pane = {
    ...other.pane,
    paneId: 'other',
    terminalId: 'other-terminal',
    tabId: 'other-tab',
    title: '中断目标',
  };
  other.pane.agent.session.value = 'other-session';
  other.pane.agent.status = 'idle';
  state.sessions.other = other;
  state.tabs = Object.values(state.sessions).map((s) => ({
    tab_id: s.pane.tabId,
    workspace_id: s.pane.workspaceId,
    label: s.pane.title,
  }));
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const menu = page.locator('.context-menu'),
    item = menu.getByRole('menuitem', { name: '中断会话', exact: true });
  const notice = page.locator('.herdr-operation-notice').first();
  let release = () => {},
    submitChange = '';
  await page.route('**/api/agents/interrupt*', async (route) => {
    if (route.request().method() === 'POST' && submitChange) {
      if (submitChange === 'complete') other.pane.agent.status = 'idle';
      if (submitChange === 'session') other.pane.agent.session.value = 'replacement';
      if (submitChange === 'turn') other.interruptTurn = 'live-turn-after-preview';
      submitChange = '';
    }
    await route.continue();
  });
  const open = async (id = 'other') => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarRecent').click();
    const row = page.locator(`#chatPickerList [data-pane-id="${id}"]`);
    if (viewport.touch) await row.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
    else await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
  };
  const settled = () => expect(page.locator('body')).not.toHaveClass(/herdr-operation-pending/);
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('保留原会话草稿');
    await open();
    await expect(item).toBeDisabled();
    const labels = await menu.getByRole('menuitem').allTextContents();
    assert.equal(labels.indexOf('中断会话'), labels.indexOf('Fork 会话') + 1);
    await page.screenshot({ path: path.join(output, viewport.name + '-idle.png') });
    other.pane.agent.status = 'working';
    fixture.changed();
    await expect(item).toBeEnabled();
    other.pane.agent.status = 'done';
    fixture.changed();
    await expect(item).toBeDisabled();
    other.pane.agent.status = 'working';
    other.interruptTurn = 'turn-2';
    fixture.changed();
    await expect(item).toBeEnabled();
    await page.screenshot({ path: path.join(output, viewport.name + '-working.png') });
    state.interruptGate = new Promise((resolve) => {
      release = resolve;
    });
    await item.evaluate((button) => {
      button.click();
      button.click();
    });
    await expect.poll(() => state.interruptCalls?.length).toBe(1);
    assert.deepEqual(state.interruptCalls, ['other']);
    await open();
    await expect(item).toBeDisabled();
    await page.keyboard.press('Escape');
    release();
    await settled();
    await expect(notice).toContainText('中断请求已接收');
    await open();
    await expect(item).toBeDisabled();
    // Herdr can still report working for a frame after Esc. The same turn stays disabled.
    other.pane.agent.status = 'working';
    fixture.changed();
    await expect(item).toBeDisabled();
    other.interruptTurn = 'turn-3';
    await expect(item).toBeEnabled();
    // Completion after the preview must be checked again before any key write.
    submitChange = 'complete';
    await item.click();
    await settled();
    await expect(notice).toContainText('无法确认中断');
    assert.equal(state.interruptCalls.length, 1);
    other.pane.agent.status = 'working';
    other.interruptTurn = 'turn-4';
    await open();
    await expect(item).toBeEnabled();
    submitChange = 'turn';
    await item.click();
    await settled();
    await expect(notice).toContainText('中断请求已接收');
    assert.deepEqual(state.interruptCalls, ['other', 'other']);
    other.pane.agent.status = 'working';
    other.interruptTurn = 'turn-5';
    await open();
    await expect(item).toBeEnabled();
    submitChange = 'session';
    await item.click();
    await settled();
    await expect(notice).toContainText('会话已改变');
    assert.equal(state.interruptCalls.length, 2);
    other.pane.agent.session.value = 'other-session';
    await open('pane-claude');
    await expect(item).toHaveCount(0);
    await page.keyboard.press('Escape');
    await context.setOffline(true);
    fixture.disconnect(true);
    await expect(page.locator('#sendButton')).toBeDisabled();
    await open();
    await expect(item).toBeDisabled();
    await page.keyboard.press('Escape');
    if (viewport.width < 761)
      await page.locator('#chatPickerScrim').click({ position: { x: viewport.width - 4, y: 50 } });
    await expect(page.locator('#commandInput')).toHaveValue('保留原会话草稿');
    assert.equal(state.focusedPaneId, 'pane-codex');
    assert(!state.requests.some((r) => r.route === 'POST /api/messages'));
    assert.deepEqual(errors, []);
    assert.deepEqual(state.unexpected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    return {
      viewport: viewport.name,
      idleDisabled: true,
      runningEnabled: true,
      liveMenuUpdates: true,
      oneEscPerTurn: true,
      completionRaceNoEsc: true,
      stalePreviewRefreshed: true,
      staleIdentityRejected: true,
      offlineDisabled: true,
      draftAndFocusPreserved: true,
    };
  } catch (error) {
    await page
      .screenshot({ path: path.join(output, viewport.name + '-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    release();
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
    ])
      results.push(await run(browser, viewport));
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
  console.log(JSON.stringify({ ok: true, viewports: results.length }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

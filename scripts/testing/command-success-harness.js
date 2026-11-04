'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/command-success-dismiss/browser');
async function run(browser, viewport) {
  const fixture = await createFixture();
  fixture.state.productionPresentation = true;
  fixture.state.sessions['pane-codex'].pane.agent.label = 'codex';
  const context = await browser.newContext({
      viewport,
      hasTouch: viewport.touch,
      serviceWorkers: 'block',
    }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const state = fixture.state,
    calls = (route) => state.requests.filter((r) => r.route === 'POST /api/' + route);
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    const input = page.locator('#commandInput'),
      panel = page.locator('.native-command-panel');
    const execute = async (text) => {
      await input.fill(text);
      await input.press('Enter');
    };
    const finished = async () => {
      await expect(panel).toBeHidden();
      await expect(input).toHaveValue('');
      await expect(input).toBeFocused();
      assert.equal(await input.evaluate((el) => el.readOnly), false);
    };
    await execute('/rename 保留全部测试并继续当前任务');
    await finished();
    assert.equal(calls('command-interaction').filter((r) => r.body.action === 'execute').length, 1);
    assert.equal(
      calls('command-interaction').filter((r) => r.body.action === 'close').length,
      0,
      'Success must not send cleanup keys',
    );
    await page.screenshot({ path: path.join(output, viewport.name + '-success.png') });
    await input.fill('命令完成后的新草稿');
    await page.waitForTimeout(400);
    await expect(input).toHaveValue('命令完成后的新草稿');
    for (const command of ['/status', '/compact']) {
      await execute(command);
      await finished();
    }
    await execute('/permissions');
    await expect(panel).toContainText('Choose permissions');
    await expect(panel.getByRole('option')).toHaveCount(2);
    await panel.getByRole('option').filter({ hasText: 'Default' }).click();
    await finished();
    await execute('/model');
    await expect(panel).toContainText('选择模型');
    await panel.getByRole('option').filter({ hasText: '测试模型二' }).click();
    await expect(panel).toContainText('推理强度');
    await panel.getByRole('option').filter({ hasText: 'low' }).click();
    await finished();
    for (const option of ['Fast', 'Standard']) {
      await execute('/fast');
      await panel.getByRole('option').filter({ hasText: option }).click();
      await finished();
    }
    const native = state.nativeCommands,
      press = native.press;
    // Hold the empty frame deterministically: the browser must keep polling it,
    // and another Enter must not submit the command again.
    const clock = native.now,
      at = clock();
    native.now = () => at;
    let releaseDelayed;
    native.press = async (id, keys) => {
      const p = state.nativeCommandPanes[id],
        delayed = keys.includes('enter') && p.input === '/rename delayed-failure',
        before = { command: p.command, result: p.result };
      await press(id, keys);
      if (delayed) {
        p.command = before.command;
        p.result = before.result;
        releaseDelayed = () => {
          p.command = '/rename delayed-failure';
          p.result = '\x1b[31m■ Delayed native command failure\x1b[0m';
        };
      }
    };
    await execute('/rename delayed-failure');
    await expect(panel).toContainText('正在由 Codex 确认');
    const delayedWrites = state.nativeCommandPanes['pane-codex'].writes.length;
    await input.press('Enter');
    releaseDelayed();
    native.now = clock;
    await expect(panel).toContainText('Delayed native command failure');
    assert.equal(state.nativeCommandPanes['pane-codex'].writes.length, delayedWrites);
    await input.press('Escape');
    await expect(panel).toBeHidden();
    native.press = async (id, keys) => {
      await press(id, keys);
      const p = state.nativeCommandPanes[id];
      if (p.command === '/rename native-failure')
        p.result = '\x1b[31m■ Failed to run command: thread/rename/set failed in TUI\x1b[0m';
    };
    await execute('/rename native-failure');
    await expect(panel).toContainText('Failed to run command');
    await page.screenshot({ path: path.join(output, viewport.name + '-native-error.png') });
    const interrupts = calls('messages/interrupt').length;
    await input.press('Escape');
    await expect(panel).toBeHidden();
    assert.equal(calls('messages/interrupt').length, interrupts);
    native.press = press;
    const p = state.nativeCommandPanes['pane-codex'];
    p.input = '保留原生草稿';
    const writes = p.writes.length;
    await execute('/status');
    await finished();
    assert.equal(p.input, '');
    assert(p.writes.length > writes);
    assert(
      p.writes.slice(writes).some((w) => w.keys?.includes('ctrl+u')),
      'Explicit commands clear and acknowledge the occupied native composer',
    );
    let lost = false;
    await page.route('**/api/command-interaction', async (route) => {
      const body = route.request().postDataJSON();
      if (!lost && body.action === 'execute') {
        lost = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    const enterCount = () => p.writes.filter((w) => w.keys?.includes('enter')).length,
      before = enterCount();
    await execute('/compact');
    await expect.poll(() => lost).toBe(true);
    await finished();
    assert.equal(
      enterCount(),
      before + 1,
      'A lost reply is recovered by reading, never executing again',
    );
    await page.unroute('**/api/command-interaction');
    await page.route('**/api/agent-settings', async (route) => {
      if (route.request().method() === 'POST')
        await route.fulfill({ status: 409, json: { message: '设置未确认，请核对原生界面。' } });
      else await route.continue();
    });
    await execute('/fast');
    await panel.getByRole('option').filter({ hasText: 'Fast' }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#chatComposerError')).toContainText('设置未确认');
    await page.unroute('**/api/agent-settings');
    let release,
      started = false;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route('**/api/command-interaction', async (route) => {
      if (route.request().postDataJSON().action === 'execute') {
        started = true;
        await gate;
      }
      await route.continue();
    });
    const pendingEnters = enterCount();
    await execute('/compact');
    await expect.poll(() => started).toBe(true);
    await expect(panel).toContainText('正在由 Codex 确认');
    await input.press('Enter');
    release();
    await finished();
    assert.equal(enterCount(), pendingEnters + 1);
    const after = calls('command-interaction').length;
    await page.waitForTimeout(500);
    assert.equal(calls('command-interaction').length, after, 'Completed commands stop polling');
    assert.equal(calls('messages').length, 0);
    assert(!p.writes.some((w) => w.keys?.includes('esc')));
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      completedCommandsHidden: true,
      settingsHidden: true,
      interactiveMenusRetained: true,
      nativeAndTransportErrorsRetained: true,
      delayedNativeErrorRetained: true,
      lostReplyReadOnlyRecovery: true,
      noCleanupEscape: true,
      inputAndFocusRestored: true,
      newDraftPreserved: true,
      pendingKeysNotRepeated: true,
    };
  } finally {
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
  const report = { ok: true, before, after, results };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

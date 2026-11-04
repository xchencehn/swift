'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/new-codex-tab/commands');
async function run(browser, viewport) {
  const fixture = await createFixture();
  fixture.state.productionPresentation = true;
  const context = await browser.newContext({
    viewport,
    hasTouch: Boolean(viewport.touch),
    serviceWorkers: 'block',
  });
  await context.addInitScript(() =>
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const input = page.locator('#commandInput'),
    panel = page.locator('.native-command-panel');
  const posts = (route) => fixture.state.requests.filter((r) => r.route === 'POST /api/' + route);
  const executes = () => posts('command-interaction').filter((r) => r.body.action === 'execute');
  const select = async (name) => {
    await input.fill('/' + name);
    const row = panel.getByRole('option').filter({
      has: page.locator('.command-choice-name', { hasText: new RegExp('^/' + name + '$') }),
    });
    await expect(row).toHaveCount(1);
    await row.click();
  };
  const choosePane = async (id) => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarRecent').click();
    await page.locator('#chatPickerList [data-pane-id="' + id + '"]').click();
  };
  try {
    await page.route('**/api/commands?*', async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.commands.push(
        ...['rename', 'cd', 'mention', 'daemon'].map((name) => ({
          name,
          description: 'Fixture command with arguments',
        })),
        {
          name: 'project-task',
          argumentHint: '<instructions>',
          description: 'Fixture project command',
        },
      );
      await route.fulfill({ json: data });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await input.fill('/');
    await expect(panel.getByRole('option').filter({ hasText: '/rename' })).toContainText(
      '填写内容',
    );
    await expect(panel.getByRole('option').filter({ hasText: '/model' })).toContainText('执行');
    const geometry = await panel.boundingBox();
    assert(
      geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.x + geometry.width <= viewport.width &&
        geometry.y + geometry.height <= viewport.height,
    );
    await page.screenshot({ path: path.join(output, viewport.name + '-menu.png') });
    await select('rename');
    await expect(input).toHaveValue('/rename ');
    await expect(input).toBeFocused();
    await expect(panel).toBeHidden();
    assert.equal(await input.evaluate((el) => el.selectionStart), 8);
    assert.equal(await input.evaluate((el) => el.readOnly), false);
    assert.equal(
      posts('command-interaction').length,
      0,
      'A completion must not send even an edit or a cleanup key',
    );
    await page.locator('#sendButton').click();
    await expect(input).toHaveValue('/rename ');
    assert.equal(executes().length, 0, 'An empty argument must not be submitted');
    await input.fill('/rename 保留中文目标，并等待明确发送');
    await expect(panel).toBeHidden();
    assert.equal(executes().length, 0);
    await input.dispatchEvent('compositionstart');
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
      bubbles: true,
    });
    assert.equal(executes().length, 0, 'IME composition does not submit');
    await input.dispatchEvent('compositionend');
    await page.screenshot({ path: path.join(output, viewport.name + '-goal-draft.png') });
    await page.locator('#sendButton').click();
    await expect.poll(() => executes().length).toBe(1);
    await expect(panel).toBeHidden();
    await expect(input).toHaveValue('');
    assert.equal(executes()[0].body.text, '/rename 保留中文目标，并等待明确发送');
    for (const [name, args] of [
      ['rename', '新的会话名称'],
      ['cd', '/fixture/directory with spaces'],
      ['project-task', '完整参数'],
    ]) {
      const before = posts('command-interaction').length;
      await select(name);
      await expect(input).toHaveValue('/' + name + ' ');
      await expect(panel).toBeHidden();
      assert.equal(posts('command-interaction').length, before);
      await input.fill('/' + name + ' ' + args);
      await page.locator('#sendButton').click();
      await expect(input).toHaveValue('');
      await expect(panel).toBeHidden();
      assert.equal(executes().at(-1).body.text, '/' + name + ' ' + args);
    }
    // Completing and editing a command remains a normal per-session draft.
    await select('rename');
    await input.fill('/rename 尚未发送的独立草稿');
    const beforeSwitch = posts('command-interaction').length;
    await choosePane('pane-claude');
    await expect(input).toHaveValue('');
    await choosePane('pane-codex');
    await expect(input).toHaveValue('/rename 尚未发送的独立草稿');
    await page.reload();
    await expect(input).toHaveValue('/rename 尚未发送的独立草稿');
    await expect(panel).toBeHidden();
    assert.equal(posts('command-interaction').length, beforeSwitch);
    await input.fill('/rename resume');
    await page.locator('#sendButton').click();
    await expect(input).toHaveValue('');
    assert.equal(executes().at(-1).body.text, '/rename resume');
    await input.fill('/rename 回车明确提交完整内容');
    const beforeEnter = executes().length;
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(panel).toBeHidden();
    assert.equal(executes().length, beforeEnter + 1);
    assert.equal(executes().at(-1).body.text, '/rename 回车明确提交完整内容');
    // Both pointer selection and keyboard completion keep direct commands usable.
    const beforeStatus = executes().length;
    await select('status');
    await expect.poll(() => executes().length).toBe(beforeStatus + 1);
    await expect(panel).toBeHidden();
    await input.fill('/sta');
    await input.press('Tab');
    await expect(input).toHaveValue('/status ');
    await expect(panel).toBeHidden();
    await page.locator('#sendButton').click();
    await expect(input).toHaveValue('');
    assert.equal(executes().length, beforeStatus + 2);
    // Daemon owns a native selector; it must be submitted without inline args.
    await select('daemon');
    await expect(input).toHaveValue('');
    await expect(panel).toBeHidden();
    assert.equal(executes().at(-1).body.text, '/daemon');
    await select('model');
    await expect(panel).toContainText('选择模型');
    await panel.getByRole('option').filter({ hasText: '测试模型二' }).click();
    await expect(panel).toContainText('推理强度');
    await panel.getByRole('option').filter({ hasText: 'low' }).click();
    await expect(panel).toBeHidden();
    await select('effort');
    await expect(panel).toContainText('推理强度');
    await panel.getByRole('option').filter({ hasText: 'high' }).click();
    await expect(panel).toBeHidden();
    assert.equal(posts('agent-settings').length, 2);
    assert.equal(posts('messages').length, 0);
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      geometry,
      clickOnlyCompletes: true,
      emptyArgumentsNotSent: true,
      explicitArgumentsSentOnce: true,
      subcommandsAndPaths: true,
      localDraftSurvivesSwitchAndReload: true,
      imePreserved: true,
      directCommandsAndSettingsPreserved: true,
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
  const report = { ok: true, before, after, browser: 'firefox', results };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

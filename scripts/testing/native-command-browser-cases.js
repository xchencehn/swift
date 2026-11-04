'use strict';
const assert = require('node:assert/strict'),
  path = require('node:path');
const { expect } = require('@playwright/test');
const panel = (page) => page.locator('.native-command-panel');
async function command(page, name) {
  await page.locator('#commandInput').fill('/' + name);
  await page.locator('#commandInput').press('Enter');
  await expect(panel(page)).toBeVisible();
}
async function choose(page, text) {
  await panel(page).getByRole('option').filter({ hasText: text }).click();
}
async function close(page) {
  if (await panel(page).isVisible())
    await panel(page).getByRole('button', { name: '结束命令交互' }).click();
  await expect(panel(page)).toBeHidden();
}
async function within(page, element) {
  const r = await element.boundingBox(),
    v = page.viewportSize();
  assert(
    r && r.x >= -1 && r.y >= -1 && r.x + r.width <= v.width + 1 && r.y + r.height <= v.height + 1,
    JSON.stringify({ r, v }),
  );
}
async function consecutiveModelSelection(page, fixture, viewport, { output }) {
  await command(page, 'model');
  await expect(panel(page)).toContainText('codex 测试模型二');
  await choose(page, 'codex 测试模型二');
  await expect(panel(page)).toContainText('推理强度');
  await page.locator('#commandInput').press('Escape');
  await expect(panel(page)).toContainText('选择模型');
  await choose(page, 'codex 测试模型二');
  await within(page, panel(page));
  await page.screenshot({ path: path.join(output, `${viewport.name}-native-effort.png`) });
  await choose(page, 'low');
  await expect
    .poll(() => fixture.state.sessions['pane-codex'].settings.model)
    .toBe('codex-fixture-model-alternate');
  assert.equal(
    fixture.state.requests.filter(
      (r) => r.route === 'POST /api/messages' || r.route === 'POST /api/command-interaction',
    ).length,
    0,
  );
  assert.equal(
    fixture.state.requests.filter((r) => r.route === 'POST /api/agent-settings').length,
    1,
  );
}
async function compactComposerAndCommands(page, fixture, viewport, { output, switchTo }) {
  const input = page.locator('#commandInput'),
    list = page.locator('#slashCommands');
  await input.fill('第一行完整显示\n第二行完整显示');
  assert.equal(await input.evaluate((el) => el.scrollTop), 0);
  await input.fill('/');
  await expect(panel(page).getByRole('option').first()).toBeVisible();
  await expect(list).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  const posts = () =>
    fixture.state.requests.filter((row) => row.route === 'POST /api/command-interaction').length;
  const before = posts();
  await input.press('ArrowDown');
  await expect(panel(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp');
  await expect(panel(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  assert.equal(posts(), before);
  await page.screenshot({ path: path.join(output, `${viewport.name}-local-command-menu.png`) });
  await input.fill('/mo');
  await input.press('Tab');
  await expect(input).toHaveValue('/model ');
  await input.press('Enter');
  await expect(panel(page)).toContainText('选择模型');
  await close(page);
  await input.fill('/compact');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(panel(page)).toBeHidden();
  assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 0);
  await input.fill('/status');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(panel(page)).toBeHidden();
  await page.screenshot({ path: path.join(output, `${viewport.name}-native-status.png`) });
  await input.fill('/missing');
  const noWrites = posts();
  await input.press('Escape');
  assert.equal(posts(), noWrites);
  await expect(list).toBeHidden();
  await switchTo(page, 'claude');
  await input.fill('/');
  await expect(list).toHaveAttribute('aria-label', 'Claude Code 命令');
  await expect(list).toContainText('/effort');
  await input.fill('/mo');
  await list.getByRole('option').click();
  await expect(page.locator('.popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await input.fill('普通消息 /mo');
  await expect(list).toBeHidden();
}
async function composerMenuKeepsFocus(page, fixture, viewport, { output }) {
  const input = page.locator('#commandInput');
  await command(page, 'model');
  await expect(input).toBeFocused();
  await choose(page, 'codex 测试模型二');
  await expect(input).toBeFocused();
  await expect(panel(page).locator('.native-command-row.selected')).toHaveCount(1);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(output, `${viewport.name}-native-menu-focus.png`) });
  await close(page);
  await expect(input).toBeFocused();
}
async function draftsModelsMenus(page, fixture, viewport, { switchTo, refresh }) {
  const input = page.locator('#commandInput');
  await command(page, 'model');
  const anchor = await input.elementHandle();
  await refresh(page, fixture);
  assert(await anchor.evaluate((node) => node.isConnected));
  await choose(page, 'codex 测试模型二');
  await choose(page, 'low');
  await expect.poll(() => fixture.state.sessions['pane-codex'].settings.effort).toBe('low');
  await expect(panel(page)).toBeHidden();
  await input.fill('Codex 独立草稿');
  await switchTo(page, 'claude');
  await expect(input).toHaveValue('');
  await input.fill('/model ');
  await page.locator('#sendButton').click();
  await expect(page.locator('.popover')).toContainText('此 Claude 会话不支持外部修改模型');
  await page.keyboard.press('Escape');
  await input.fill('Claude 独立草稿');
  await switchTo(page, 'codex');
  await expect(input).toHaveValue('Codex 独立草稿');
  await switchTo(page, 'claude');
  await expect(input).toHaveValue('Claude 独立草稿');
}
async function settingsActionsAndSkills(page, fixture, viewport) {
  const input = page.locator('#commandInput');
  await command(page, 'fast');
  await choose(page, 'Fast');
  await expect
    .poll(() => fixture.state.sessions['pane-codex'].settings.serviceTier)
    .toBe('priority');
  await expect(panel(page)).toBeHidden();
  await command(page, 'fast');
  await choose(page, 'Standard');
  await expect(panel(page)).toBeHidden();
  await command(page, 'skills');
  await choose(page, 'test-skill');
  await expect(panel(page)).toContainText('$test-skill');
  await input.press('R');
  await expect(panel(page)).toContainText('$test-skill R');
  await input.press('Enter');
  await expect(panel(page)).toBeHidden();
  assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 0);
  await input.fill('普通消息仍直接投递');
  await page.locator('#sendButton').click();
  await expect(input).toHaveValue('');
  assert.equal(fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length, 1);
}
async function nativeAnchoring(page, fixture, viewport) {
  await command(page, 'model');
  await within(page, panel(page));
  await page.evaluate(() => visualViewport?.dispatchEvent(new Event('resize')));
  await expect(panel(page)).toBeVisible();
  await within(page, panel(page));
  await close(page);
}
module.exports = {
  consecutiveModelSelection,
  compactComposerAndCommands,
  composerMenuKeepsFocus,
  draftsModelsMenus,
  settingsActionsAndSkills,
  nativeAnchoring,
  command,
  choose,
  close,
};

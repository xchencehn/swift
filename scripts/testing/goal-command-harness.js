'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { codexGoal } = require('../../lib/agent-goal');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/goal-command/browser');
async function run(browser, viewport) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = true;
  session.webStatus = { goal: null };
  const posts = [],
    jobs = new Map(),
    errors = [];
  let held = false,
    loseReply = true,
    fail = false,
    readFails = false,
    loseReceipt = false,
    goal = null;
  const context = await browser.newContext({
      viewport,
      hasTouch: viewport.touch,
      serviceWorkers: 'block',
    }),
    page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const dialog = page.locator('#chatDialog'),
    input = page.locator('#commandInput');
  const button = (name) => dialog.getByRole('button', { name, exact: true });
  const finish = (body) => {
    if (fail) return { status: 'failed', message: '模拟 Goal 已改变', code: 'GOAL_CHANGED' };
    goal =
      body.action === 'clear'
        ? null
        : {
            objective: body.objective || goal.objective,
            status:
              body.action === 'pause'
                ? 'paused'
                : ['resume', 'set'].includes(body.action)
                  ? 'active'
                  : goal.status,
          };
    session.webStatus.goal = codexGoal(goal);
    fixture.changed();
    return {
      status: 'succeeded',
      goal: session.webStatus.goal,
      message:
        body.action === 'set'
          ? 'Goal 已设置。'
          : body.action === 'clear'
            ? '当前 Goal 已清空。'
            : body.action === 'edit'
              ? 'Goal 已修改。'
              : body.action === 'pause'
                ? '当前 Goal 已暂停。'
                : '当前 Goal 已继续。',
    };
  };
  const submit = async (text) => {
    await input.fill(text);
    await input.press('Enter');
    await expect(dialog).toBeVisible();
  };
  const capture = async (name) => {
    const result = await dialog.evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      overflow: document.documentElement.scrollWidth > innerWidth,
      actions: [...el.querySelectorAll('.chat-dialog-actions button')]
        .filter((b) => !b.hidden)
        .map((b) => ({ text: b.textContent, box: b.getBoundingClientRect().toJSON() })),
    }));
    assert(!result.overflow);
    assert(
      result.box.left >= 0 &&
        result.box.right <= viewport.width + 1 &&
        result.box.top >= 0 &&
        result.box.bottom <= viewport.height + 1,
    );
    for (const b of result.actions)
      assert(
        b.box.height >= 44 && b.box.left >= result.box.left && b.box.right <= result.box.right + 1,
      );
    await page.screenshot({ path: path.join(output, `${viewport.width}-${name}.png`) });
    return result;
  };
  try {
    await page.route('**/api/commands?*', (route) =>
      route.fulfill({ json: require('../../data/commands/codex-0.166.0.json') }),
    );
    await page.route('**/api/agents/goal*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posts.push(body);
        jobs.set(body.requestId, held ? { status: 'running' } : finish(body));
        if (loseReply) {
          loseReply = false;
          return route.abort();
        }
        return route.fulfill({ status: 202, json: { ok: true } });
      }
      if (url.searchParams.has('requestId') && loseReceipt)
        return route.fulfill({ status: 503, json: { message: '模拟收据读取中断' } });
      if (url.searchParams.has('requestId'))
        return route.fulfill({
          json: { ok: true, job: jobs.get(url.searchParams.get('requestId')) },
        });
      if (readFails)
        return route.fulfill({ status: 503, json: { message: '模拟暂时无法读取 Goal' } });
      return route.fulfill({
        json: {
          ok: true,
          goal: codexGoal(goal),
          revision: 'revision-' + posts.length,
          processRuntimeId: 'fixture-process',
        },
      });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await input.fill('/goal');
    await expect(
      page.locator('.command-choice-name').filter({ hasText: /^\/goal$/ }),
    ).toBeVisible();
    await input.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(button('启动 Goal')).toBeEnabled();
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('未设置');
    await capture('empty');
    assert.equal(posts.length, 0);
    await button('取消').click();
    await submit('/goal 持续直到整个服务全部开发完成');
    await expect(dialog).toContainText('Goal 已设置');
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('进行中');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, 'set');
    assert.equal(posts[0].objective, '持续直到整个服务全部开发完成');
    await expect(dialog).not.toContainText('npm install');
    await expect(page.locator('.native-command-panel')).toBeHidden();
    await capture('active');
    await button('关闭').click();
    await input.fill('保留主聊天草稿');
    await page.locator('#chatGoalSummary').click();
    await expect(button('暂停 Goal')).toBeEnabled();
    await button('关闭').click();
    await expect(input).toHaveValue('保留主聊天草稿');
    await submit('/goal 新的目标');
    await expect(dialog).toContainText('原目标的预算不会沿用');
    assert.equal(posts.length, 1);
    await expect(dialog.getByRole('textbox', { name: 'Goal 目标' })).toHaveValue('新的目标');
    await capture('replace');
    await button('替换目标').click();
    await expect(dialog).toContainText('Goal 已设置');
    assert.equal(posts[1].confirmReplace, true);
    await button('关闭').click();
    held = true;
    await submit('/goal pause');
    await expect(button('暂停中…')).toBeDisabled();
    await button('关闭').click();
    await page.locator('#chatGoalSummary').click();
    await expect(button('暂停中…')).toBeDisabled();
    assert.equal(posts.length, 3);
    jobs.set(posts[2].requestId, finish(posts[2]));
    held = false;
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('已暂停');
    await expect(button('继续')).toBeEnabled();
    await button('关闭').click();
    await submit('/goal edit');
    const objective = dialog.getByRole('textbox', { name: 'Goal 目标' });
    await objective.fill('');
    await button('保存修改').click();
    await expect(dialog).toContainText('Goal 不能为空');
    assert.equal(posts.length, 3);
    if (viewport.touch) {
      await page.setViewportSize({ width: viewport.width, height: 360 });
      await expect
        .poll(() => dialog.evaluate((el) => el.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(360);
      await capture('keyboard');
      await page.setViewportSize(viewport);
    }
    await objective.fill('多行目标\n保留原有预算与会话');
    await button('保存修改').click();
    await expect(dialog).toContainText('Goal 已修改');
    await button('关闭').click();
    readFails = true;
    await submit('/goal');
    await expect(dialog).toContainText('模拟暂时无法读取');
    await expect(button('刷新核对')).toBeEnabled();
    readFails = false;
    await button('刷新核对').click();
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('已暂停');
    await button('关闭').click();
    fail = true;
    await submit('/goal clear');
    assert.equal(posts.length, 4);
    await button('确认清空 Goal').click();
    await expect(dialog).toContainText('模拟 Goal 已改变');
    await expect(button('刷新核对')).toBeEnabled();
    await capture('failed');
    await button('取消').click();
    fail = false;
    await submit('/goal clear');
    await button('确认清空 Goal').click();
    await expect(dialog).toContainText('当前 Goal 已清空');
    await expect(button('启动 Goal')).toBeEnabled();
    await button('取消').click();
    goal = { objective: '完整的长目标。'.repeat(800), status: 'blocked' };
    session.webStatus.goal = codexGoal(goal);
    fixture.changed();
    await expect(page.locator('#chatGoalSummary')).toBeVisible();
    await page.locator('#chatGoalSummary').click();
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('受阻');
    await capture('long');
    await page.evaluate(() => {
      StudioDeviceTheme.apply('light', false);
      document.documentElement.style.setProperty('--device-font-scale', '1.5');
    });
    await capture('light-large');
    await button('关闭').click();
    const mutations = posts.length;
    loseReceipt = true;
    await submit('/goal resume');
    await expect(dialog).toContainText('操作结果尚未确认');
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('进行中');
    assert.equal(posts.length, mutations + 1);
    loseReceipt = false;
    await button('刷新核对').click();
    await expect(button('暂停 Goal')).toBeEnabled();
    assert.equal(posts.length, mutations + 1);
    await button('关闭').click();
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/command-interaction').length,
      0,
      'Goal never uses raw terminal results',
    );
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
      0,
    );
    assert.deepEqual(errors, []);
    return {
      width: viewport.width,
      catalogGoalPresent: true,
      structuredGoalOnly: true,
      newGoalSet: true,
      replacementConfirmed: true,
      pendingReopenNoDuplicate: true,
      nativeStatuses: true,
      editPauseClear: true,
      readRetry: true,
      lostReplyNoReplay: true,
      mainDraftPreserved: true,
      longAndLightLarge: true,
    };
  } finally {
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
      { width: 1024, height: 768, touch: true },
      { width: 390, height: 844, touch: true },
      { width: 320, height: 640, touch: true },
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

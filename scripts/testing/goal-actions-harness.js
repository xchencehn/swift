'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { codexGoal } = require('../../lib/agent-goal');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/goal-dialog-actions/browser');
async function run(browser, viewport) {
  const fixture = await createFixture(),
    state = fixture.state,
    session = state.sessions['pane-codex'];
  state.productionPresentation = true;
  session.pane.agent.label = 'codex';
  session.webStatus = {
    goal: codexGoal({ objective: '优化 A3 softmax 到第一名', status: 'paused' }),
  };
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
  });
  await context.addInitScript(() =>
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }),
  );
  const page = await context.newPage(),
    errors = [],
    posts = [],
    jobs = new Map();
  let held = false,
    fail = false,
    loseReply = true;
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const dialog = page.locator('#chatDialog'),
    button = (name) => dialog.getByRole('button', { name, exact: true });
  const open = async () => {
    await page.locator('#chatGoalSummary').click();
    await expect(dialog).toBeVisible();
  };
  const capture = async (name) => {
    const geometry = await dialog.evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      buttons: [...el.querySelectorAll('.chat-dialog-actions button')]
        .filter((b) => !b.hidden)
        .map((b) => ({ text: b.textContent, box: b.getBoundingClientRect().toJSON() })),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert(!geometry.overflow);
    assert(
      geometry.box.x >= 0 &&
        geometry.box.y >= 0 &&
        geometry.box.right <= viewport.width &&
        geometry.box.bottom <= viewport.height,
    );
    for (const b of geometry.buttons)
      assert(b.box.height >= 44 && b.box.x >= geometry.box.x && b.box.right <= geometry.box.right);
    await fs.writeFile(
      path.join(output, viewport.name + '-' + name + '.json'),
      JSON.stringify(geometry, null, 2),
    );
    await page.screenshot({ path: path.join(output, viewport.name + '-' + name + '.png') });
  };
  const finish = (body) => {
    if (fail)
      return {
        requestId: body.requestId,
        status: 'failed',
        code: 'GOAL_CHANGED',
        message: 'Goal 已改变，请重新打开后操作。',
      };
    session.webStatus.goal =
      body.action === 'clear'
        ? null
        : codexGoal({
            objective: body.objective || session.webStatus.goal.objective,
            status:
              body.action === 'resume'
                ? 'active'
                : body.action === 'pause'
                  ? 'paused'
                  : session.webStatus.goal.status,
          });
    fixture.changed();
    return {
      requestId: body.requestId,
      status: 'succeeded',
      goal: session.webStatus.goal,
      message:
        body.action === 'clear'
          ? '当前 Goal 已清空。'
          : body.action === 'edit'
            ? 'Goal 已修改。'
            : body.action === 'pause'
              ? '当前 Goal 已暂停。'
              : '当前 Goal 已继续。',
    };
  };
  try {
    await page.route('**/api/agents/goal*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posts.push(body);
        const job = held ? { requestId: body.requestId, status: 'running' } : finish(body);
        jobs.set(body.requestId, job);
        if (loseReply) {
          loseReply = false;
          return route.abort();
        }
        return route.fulfill({ status: 202, json: { ok: true, job } });
      }
      if (url.searchParams.has('requestId'))
        return route.fulfill({
          json: { ok: true, job: jobs.get(url.searchParams.get('requestId')) },
        });
      return route.fulfill({
        json: {
          ok: true,
          goal: session.webStatus.goal,
          revision: 'fixture-revision',
          processRuntimeId: 'fixture-process',
        },
      });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('保留主聊天草稿');
    await open();
    await expect(button('修改')).toBeEnabled();
    assert.deepEqual(
      await dialog.locator('.chat-dialog-actions button:visible').allTextContents(),
      ['修改', '继续', '清空 Goal', '关闭'],
    );
    await capture('actions');
    await button('关闭').click();
    assert.equal(posts.length, 0);
    await open();
    await button('修改').click();
    const input = dialog.getByRole('textbox', { name: 'Goal 目标' });
    await expect(input).toHaveValue('优化 A3 softmax 到第一名');
    await input.fill('');
    await button('保存修改').click();
    await expect(dialog).toContainText('Goal 不能为空');
    assert.equal(posts.length, 0);
    await input.fill('优化 A3 softmax 到第一名\n保留全部测试。');
    await capture('edit');
    await button('保存修改').click();
    await expect(dialog).toContainText('Goal 已修改');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, 'edit');
    await expect(input).toBeHidden();
    await button('关闭').click();
    held = true;
    await open();
    await button('继续').click();
    await expect(button('继续中…')).toBeDisabled();
    await button('关闭').click();
    await open();
    await expect(button('继续中…')).toBeDisabled();
    assert.equal(posts.length, 2);
    jobs.set(posts[1].requestId, finish(posts[1]));
    held = false;
    await expect(dialog).toContainText('当前 Goal 已继续');
    await expect(button('暂停 Goal')).toBeEnabled();
    await button('关闭').click();
    await open();
    await button('暂停 Goal').click();
    await expect(dialog.locator('.goal-dialog-status')).toHaveText('已暂停');
    await expect(button('继续')).toBeEnabled();
    await button('关闭').click();
    fail = true;
    await open();
    await button('清空 Goal').click();
    await button('确认清空 Goal').click();
    await expect(dialog).toContainText('Goal 已改变');
    await capture('failure');
    await button('取消').click();
    fail = false;
    await open();
    await button('清空 Goal').click();
    await button('确认清空 Goal').click();
    await expect(dialog).toContainText('当前 Goal 已清空');
    await expect(button('启动 Goal')).toBeEnabled();
    await capture('cleared');
    await button('取消').click();
    await expect(page.locator('#chatGoal')).toBeHidden();
    await expect(page.locator('#commandInput')).toHaveValue('保留主聊天草稿');
    assert.deepEqual(
      posts.map((p) => p.action),
      ['edit', 'resume', 'pause', 'clear', 'clear'],
    );
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      fourActions: true,
      multilineEdit: true,
      closeWritesNothing: true,
      lostReplyNoReplay: true,
      reopenPending: true,
      failureVisible: true,
      clearConfirmed: true,
      draftPreserved: true,
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

'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/space-agent-actions/browser');
async function run(browser, viewport) {
  const fixture = await createFixture();
  fixture.state.productionPresentation = true;
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [],
    posts = [];
  let recent,
    partial = false,
    loseReply = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const targets = [
    {
      paneId: 'working',
      provider: 'codex',
      name: '正在执行的 Codex',
      available: true,
      binding: 'a',
    },
    { paneId: 'idle', provider: 'codex', name: '等待输入的 Codex', available: true, binding: 'b' },
    { paneId: 'claude', provider: 'claude', name: 'Claude 会话', available: true, binding: 'c' },
  ];
  const menu = page.locator('.context-menu'),
    dialog = page.locator('#chatDialog');
  const open = async (name) => {
    if (
      viewport.width < 761 &&
      !(await page.locator('#chatSidebar').evaluate((el) => el.classList.contains('open')))
    )
      await page.locator('#chatDrawerToggle').click();
    await page.locator('#sidebarWorkspaces').click();
    await page.locator('[data-workspace-id="workspace-fixture"]').click({ button: 'right' });
    await menu.getByRole('menuitem', { name, exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const capture = async (name) => {
    const box = await dialog.boundingBox();
    assert(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `${viewport.name}-${name}.png`) });
    return box;
  };
  try {
    await page.route('**/api/spaces/actions*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posts.push(body);
        recent = {
          ...body,
          items: body.targets.map((t, i) => ({
            ...t,
            status: partial && i === 1 ? 'uncertain' : 'succeeded',
            message:
              partial && i === 1
                ? '结果尚未确认，请查看会话；不会自动重试。'
                : body.action === 'stop'
                  ? '已发送 Esc。'
                  : body.action === 'restart'
                    ? '已恢复原会话，Goal 已继续运行。'
                    : '已发送。',
          })),
          done: true,
        };
        if (loseReply) {
          loseReply = false;
          return route.abort();
        }
        return route.fulfill({ status: 202, json: { ok: true, job: recent } });
      }
      if (url.searchParams.has('requestId'))
        return route.fulfill({ json: { ok: true, job: recent } });
      return route.fulfill({
        json: {
          ok: true,
          workspaceId: 'workspace-fixture',
          runtimeId: 'fixture-runtime',
          label: '浏览器验收',
          targets,
          recent,
        },
      });
    });
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
    await page.locator('#commandInput').fill('保留当前草稿');
    await open('一键发送');
    await expect(dialog).toContainText('2 个 Codex 会话');
    const input = dialog.getByRole('textbox', { name: '发送给所有 Codex 的消息' });
    await input.fill('请继续当前任务，先检查已有结果。');
    const form = await capture('send');
    await page.locator('#chatDialogConfirm').click();
    await expect(dialog).toContainText('2 个成功');
    assert.deepEqual(
      posts[0].targets.map((t) => t.paneId),
      ['working', 'idle'],
    );
    assert.equal(posts[0].text, '请继续当前任务，先检查已有结果。');
    await page.locator('#chatDialogCancel').click();
    await open('全部停止');
    await expect(dialog).toContainText('3 个成功');
    assert.equal(posts.at(-1).action, 'stop');
    await page.locator('#chatDialogCancel').click();
    await open('全部重启');
    await expect(dialog).toContainText('继续未完成的 Goal');
    assert.equal(posts.length, 2);
    await page.locator('#chatDialogConfirm').click();
    await expect(dialog).toContainText('Goal 已继续运行');
    await capture('restart-result');
    await page.locator('#chatDialogCancel').click();
    partial = true;
    loseReply = true;
    await open('一键发送');
    await input.fill('检查当前进度');
    await page.locator('#chatDialogConfirm').click();
    await expect(dialog).toContainText('1 个需查看');
    await capture('partial-result');
    assert.equal(posts.length, 4);
    await page.locator('#chatDialogCancel').click();
    await open('查看操作结果');
    await expect(dialog).toContainText('1 个需查看');
    assert.equal(posts.length, 4);
    await page.locator('#chatDialogCancel').click();
    if (viewport.width < 761)
      await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
    await expect(page.locator('#commandInput')).toHaveValue('保留当前草稿');
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      form,
      idleIncluded: true,
      partialFailure: true,
      lostReplyReadOnlyRecovery: true,
      draftsPreserved: true,
      errors,
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
  const report = {
    ok: true,
    before,
    after,
    browser: 'firefox',
    touch: 'emulated contextmenu',
    results,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

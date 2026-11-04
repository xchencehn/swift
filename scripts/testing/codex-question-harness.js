'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_QUESTIONS_OUTPUT || 'artifacts/testing/codex-interaction/questions',
);
async function run(browser, viewport) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = true;
  const context = await browser.newContext({
      viewport,
      hasTouch: viewport.touch,
      serviceWorkers: 'block',
    }),
    page = await context.newPage(),
    errors = [];
  const receipts = new Map(),
    answers = [],
    skipped = [];
  let holdReceipt = false,
    releaseReceipt,
    receiptStarted = false;
  const receiptGate = new Promise((resolve) => {
    releaseReceipt = resolve;
  });
  const base = {
    provider: 'codex',
    paneId: session.pane.paneId,
    terminalId: session.pane.terminalId,
    runtimeId: session.pane.runtimeId || '',
    sessionId: session.pane.agent.session.value,
    queued: true,
    blocking: false,
    canWrite: true,
  };
  const items = [
    ['build', '选择构建平台', ['Desktop', 'Mobile']],
    ['text', '项目叫什么名字', []],
    ['other', '选择实现方式', ['Default', 'Custom']],
    ['lost', '选择执行模式', ['One', 'Two']],
    ['skip-key', '键盘跳过这一题', ['Yes', 'No']],
    ['skip-mouse', '鼠标跳过这一题', ['Yes', 'No']],
  ].map(([id, question, options], index) => ({
    ...base,
    id,
    question,
    options: options.map((label) => ({ label })),
    toolId: id,
    challenge: 'question-' + id,
    draftKey: 'draft-' + id,
    index: 0,
    total: 1,
    allowText: true,
  }));
  const publish = () => {
    session.question = items.length
      ? {
          ...items[0],
          items: items.slice(),
          collapsed: true,
          expanded: false,
          remaining: items.length,
          navigation: { open: 'alt+up' },
        }
      : null;
    fixture.changed();
  };
  fixture.state.questionAction = (body) => {
    if (receipts.has(body.requestId)) return receipts.get(body.requestId);
    const index = items.findIndex((item) => item.challenge === body.challenge);
    assert(index >= 0);
    const item = items[index];
    assert(['answer', 'skip'].includes(body.action));
    if (body.action === 'answer')
      answers.push({ id: item.id, answer: body.text || item.options[body.choices[0]].label });
    else skipped.push(item.id);
    items.splice(index, 1);
    const result = { ok: true, delivery: body.action === 'skip' ? 'skipped' : 'sent' };
    receipts.set(body.requestId, result);
    publish();
    return result;
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const input = page.locator('#commandInput'),
    summary = page.locator('#chatQuestionSummary'),
    box = page.locator('#chatInlineQuestion');
  const open = async () => {
    if (!(await box.isVisible())) await summary.locator('.chat-question-open').click();
  };
  try {
    await page.route('**/api/agents/questions?*', async (route) => {
      const id = new URL(route.request().url()).searchParams.get('requestId');
      if (id && holdReceipt) {
        receiptStarted = true;
        await receiptGate;
      }
      return id
        ? route.fulfill({ json: receipts.get(id) || { ok: true, delivery: 'uncertain' } })
        : route.continue();
    });
    publish();
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(summary).toContainText('6 个问题');
    await expect(box).toBeHidden();
    await input.fill('保留普通消息草稿');
    await expect(page.locator('#chatExecutionState')).toHaveText('Working');
    await expect(page.locator('#sendButton')).toBeEnabled();
    const geometry = await summary.evaluate((node) => {
      const row = node.closest('.chat-status-hint-row'),
        controls = node.closest('#chatControls');
      return {
        inStatus: Boolean(row && controls),
        height: controls?.getBoundingClientRect().height,
        rowHeight: row?.getBoundingClientRect().height,
        buttonHeight: node.querySelector('button').getBoundingClientRect().height,
        accessible: !node.closest('[aria-hidden="true"]'),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert(geometry.inStatus && geometry.accessible && geometry.overflow === 0);
    assert.equal(geometry.height, geometry.rowHeight * 3);
    assert.equal(geometry.rowHeight, geometry.buttonHeight);
    await page.screenshot({ path: path.join(output, viewport.name + '-question-status.png') });
    await summary.locator('.chat-question-open').click();
    await expect(box).toContainText('选择构建平台');
    await summary.locator('.chat-question-open').click();
    await expect(box).toBeHidden();
    await input.press('Alt+ArrowUp');
    await expect(box).toContainText('选择构建平台');
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/agents/questions').length,
      0,
    );
    await page.keyboard.press('2');
    await expect(summary).toContainText('5 个问题');
    assert.deepEqual(answers, [{ id: 'build', answer: 'Mobile' }]);
    await open();
    await expect(box).toContainText('项目叫什么名字');
    const text = box.locator('textarea');
    await text.fill('中文项目名');
    const node = await text.elementHandle();
    fixture.changed();
    await expect(text).toHaveValue('中文项目名');
    assert(await node.evaluate((el) => el.isConnected));
    await page.reload();
    await expect(summary).toContainText('5 个问题');
    await open();
    await expect(box.locator('textarea')).toHaveValue('中文项目名');
    await box
      .locator('textarea')
      .dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    assert.equal(answers.length, 1);
    await box.locator('textarea').press('Control+Enter');
    await expect(summary).toContainText('4 个问题');
    await open();
    await box.locator('.chat-inline-option').last().click();
    await box.locator('textarea').fill('自填实现方案');
    await summary.locator('.chat-question-open').click();
    await expect(box).toBeHidden();
    await open();
    await expect(box.locator('textarea')).toHaveValue('自填实现方案');
    await box.locator('textarea').press('Control+Enter');
    await expect(summary).toContainText('3 个问题');
    await open();
    await box.locator('.chat-inline-option').filter({ hasText: 'Two' }).click();
    let lost = false;
    await page.route('**/api/agents/questions', async (route) => {
      if (
        !lost &&
        route.request().method() === 'POST' &&
        route.request().postDataJSON().challenge === 'question-lost'
      ) {
        lost = true;
        await route.fetch();
        return route.abort();
      }
      return route.continue();
    });
    await box.locator('[data-action="answer"]').click();
    holdReceipt = true;
    const check = box.getByRole('button', { name: '核对操作结果', exact: true });
    await check.click();
    await expect.poll(() => receiptStarted).toBe(true);
    await expect(box.getByRole('status')).toHaveText('正在核对操作结果…');
    const checkNode = await check.elementHandle();
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().includes('/api/agents/questions?') &&
        !new URL(response.url()).searchParams.has('requestId'),
    );
    fixture.changed();
    await refreshed;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert(
      await checkNode.evaluate((node) => node.isConnected),
      'An unchanged observation must retain the active receipt control',
    );
    releaseReceipt();
    await expect(box).toContainText('键盘跳过这一题');
    assert.equal(answers.length, 4);
    const writes = fixture.state.requests.filter(
      (row) => row.route === 'POST /api/agents/questions' && row.body.challenge === 'question-lost',
    );
    assert.equal(writes.length, 1);
    await box.locator('.codex-question-interaction').focus();
    await page.keyboard.press('Control+]');
    await expect(box).toContainText('鼠标跳过这一题');
    await page.screenshot({ path: path.join(output, viewport.name + '-question.png') });
    await box.locator('[data-action="skip"]').click();
    await expect(summary).toBeHidden();
    await expect(box).toBeHidden();
    assert.deepEqual(skipped, ['skip-key', 'skip-mouse']);
    await expect(input).toHaveValue('保留普通消息草稿');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    return {
      viewport: viewport.name,
      localBrowse: true,
      draftReload: true,
      imePreserved: true,
      exactAnswers: answers,
      skipped,
      lostReplyReadOnlyReceipt: true,
      plainDraftPreserved: true,
    };
  } finally {
    releaseReceipt();
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
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'narrow-mobile', width: 320, height: 740, touch: true },
    ]) {
      console.log('Checking ' + viewport.name);
      results.push(await run(browser, viewport));
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, results }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

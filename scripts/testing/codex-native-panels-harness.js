'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { AgentQuestions } = require('../../lib/agent-questions');
const { TerminalScreen } = require('../../lib/terminal-screen');
const capture = require('../../test/fixtures/codex-native-panels-0164.json').captures.find(
  (c) => c.state === '03-resume-goal',
);
const output = path.resolve('artifacts/testing/codex-control-reliability/browser');

async function run(browser, viewport, startup = false) {
  const fixture = await createFixture(),
    session = fixture.state.sessions['pane-codex'];
  fixture.state.productionPresentation = true;
  if (startup) {
    fixture.state.unified = true;
    session.pane.agent.session = { value: '' };
    session.pane.runtimeId = 'startup-process:1';
    session.messages = [];
  }
  const context = await browser.newContext({
    viewport,
    hasTouch: viewport.touch,
    serviceWorkers: 'block',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const manager = new AgentQuestions({
    herdr: { readPane: async () => capture.ansi },
    exactPane: async () => session.pane,
    readLines: async () => [],
  });
  const original = await manager.read(session.pane);
  assert(original.nativeModal);
  let release,
    started = false,
    nativeScreen;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const answers = [];
  fixture.state.questionAction = async (body) => {
    assert.equal(body.challenge, original.challenge);
    assert.deepEqual(body.choices, [1]);
    assert.equal(body.action, 'answer');
    started = true;
    answers.push(body.requestId);
    await gate;
    if (startup) session.pane.agent.session = { value: 'created-startup-session' };
    session.question = null;
    fixture.changed();
    return { ok: true, delivery: 'sent' };
  };
  session.question = original;
  const input = page.locator('#commandInput'),
    summary = page.locator('#chatQuestionSummary'),
    box = page.locator('#chatInlineQuestion');
  try {
    await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
    await expect(summary).toContainText('原生选项');
    await input.fill('弹窗期间保留我的草稿');
    await expect(box).toBeHidden();
    await input.press('Enter');
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
      0,
    );
    await summary.locator('.chat-question-open').click();
    await expect(box).toContainText('Leave paused');
    await expect(box.locator('[data-action="skip"]')).toHaveCount(0);
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/agents/questions').length,
      0,
    );
    await box.locator('.chat-inline-option').nth(1).click();
    await summary.locator('.chat-question-open').click();
    await expect(box).toBeHidden();
    await summary.locator('.chat-question-open').click();
    await expect(box.locator('.chat-inline-option').nth(1)).toHaveAttribute('aria-pressed', 'true');
    if (viewport.touch) await box.locator('[data-action="answer"]').click();
    else {
      await box.locator('.codex-question-interaction').focus();
      await page.keyboard.press('2');
    }
    await expect.poll(() => started).toBe(true);
    await expect(box.getByRole('status')).toHaveText('正在操作…');
    await input.fill('等待回复时继续编辑草稿');
    await expect(input).toHaveValue('等待回复时继续编辑草稿');
    const geometry = await box.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });
    assert(geometry.left >= 0 && geometry.right <= viewport.width + 1);
    assert.equal(answers.length, 1);
    await page.screenshot({
      path: path.join(output, (startup ? 'startup-' : '') + viewport.name + '-pending.png'),
    });
    release();
    await expect(summary).toBeHidden();
    await expect(box).toBeHidden();
    await expect(input).toHaveValue('等待回复时继续编辑草稿');
    assert.equal(answers.length, 1);
    let frame;
    nativeScreen = new TerminalScreen({
      cols: 120,
      rows: 40,
      onScreen: (value) => {
        frame = value;
      },
    });
    await nativeScreen.feed(
      '\x1b[H\x1b[2J\x1b[1mConfigure Status Line\x1b[0m\r\n\r\n› [x] model\r\n\r\nspace toggle · enter save · esc cancel',
      { full: true },
    );
    assert.equal(frame.projection.interaction.inputTarget, 'form');
    fixture.nativeScreen(frame, 'pane-codex');
    await expect(page.locator('#chatNativeRegion')).toHaveCount(0);
    await expect(page.locator('#chatExecutionState')).toHaveText('等待原生操作');
    await expect(page.locator('#chatNativeAction')).toHaveCount(0);
    await expect(page.locator('#sendButton')).toBeDisabled();
    await input.fill('原生表单期间也能编辑');
    await input.press('Enter');
    assert.equal(
      fixture.state.requests.filter((row) => row.route === 'POST /api/messages').length,
      0,
    );
    await expect(input).toHaveValue('原生表单期间也能编辑');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    if (startup) await page.reload();
    await expect(input).toHaveValue('原生表单期间也能编辑');
    return {
      viewport: viewport.name,
      startupBeforeSession: startup,
      localSelectionAndCollapse: true,
      scopedDigitOrTouchSubmission: true,
      slowResponseFeedback: true,
      draftPreserved: true,
      exactlyOneAnswer: true,
      geometry,
      actualNativeInput: false,
    };
  } finally {
    release();
    nativeScreen?.close();
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
      for (const startup of [false, true]) {
        results.push(await run(browser, viewport, startup));
        console.log(JSON.stringify(results.at(-1)));
      }
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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');

(async () => {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve('artifacts/codex-side');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture(),
        writes = [],
        errors = [],
        observations = [];
      fixture.state.nativeTerminalText =
        '› 我们优化过的算子都提交上榜了吗？\r\n\r\n• 本轮有 4 项优化版本已经正式上榜。\r\n\r\n  MhcSinkhorn    64.1259\r\n  ArgMax        53.1372\r\n  RmsNorm       57.4767\r\n\r\n  Worked for 58s\r\n\r\n› Ask a follow-up question\r\n\r\n  GPT-6.1-Sol · Agent\r\n  Side from main thread · ^/ to switch · ^c to close';
      fixture.state.nativeTerminalText += '\x1b[11;3H\x1b[K';
      const context = await browser.newContext({
        viewport,
        hasTouch: Boolean(viewport.touch),
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      let state = {
          supported: true,
          mode: 'main',
          hasSide: false,
          canClose: false,
          binding: 'fixture-binding',
          paneId: 'pane-codex',
          revision: '0',
        },
        sequence = 0,
        reject = false;
      const change = (mode, hasSide = true) => {
        state = {
          ...state,
          mode,
          hasSide,
          canClose: mode === 'side',
          revision: String(++sequence),
        };
      };
      await context.route('**/api/agents/side*', async (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (reject) {
            reject = false;
            return route.fulfill({
              status: 409,
              json: { message: '原生会话已变化，请重新操作。' },
            });
          }
          assert.equal(body.revision, state.revision);
          if (body.action === 'open' || body.action === 'side') change('side');
          else change('main', body.action !== 'close');
        }
        if (route.request().method() === 'GET') observations.push({ ...state });
        return route.fulfill({ json: state });
      });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatSideToggle')).toBeEnabled();
        await page.keyboard.press('Tab');
        await page.locator('#chatSideToggle').focus();
        const focus = await page.locator('#chatSideToggle').evaluate((el) => ({
          visible: el.matches(':focus-visible'),
          outline: getComputedStyle(el).outlineStyle,
          width: getComputedStyle(el).outlineWidth,
        }));
        assert(focus.visible && focus.outline !== 'none' && focus.width !== '0px');
        await page.screenshot({ path: path.join(output, viewport.name + '-focus.png') });
        await page.locator('#commandInput').fill('主会话尚未发送的草稿');
        const beforeScroll = await page.locator('#chatLog').evaluate((el) => {
          el.scrollTop = 180;
          return el.scrollTop;
        });
        await page.screenshot({ path: path.join(output, viewport.name + '-main.png') });
        await page.locator('#chatSideToggle').click();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        await expect(page.locator('#shellTerminal')).toContainText('MhcSinkhorn');
        await expect(page.locator('#chatLog')).toBeHidden();
        await expect(page.locator('#chatInput')).toBeHidden();
        await expect(page.locator('#chatModeToggle')).toBeHidden();
        const bar = page.locator('#chatSideThread');
        await expect(bar.locator('[data-side="side"]')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('#shellTerminal .xterm-helper-textarea').focus();
        await page.keyboard.insertText('临时问题');
        await expect
          .poll(() =>
            fixture.state.shellFrames
              ?.filter((f) => f.type === 'terminal.input')
              .map((f) => f.data)
              .join(''),
          )
          .toContain('临时问题');
        const geometry = await bar.evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth - innerWidth,
          controls: [...el.querySelectorAll('button')].map((button) => {
            const r = button.getBoundingClientRect();
            return { x: r.x, right: r.right, height: r.height };
          }),
        }));
        assert.equal(geometry.overflow, 0);
        assert(geometry.controls.every((r) => r.x >= 0 && r.right <= viewport.width));
        await page.screenshot({ path: path.join(output, viewport.name + '-side.png') });
        await bar.locator('[data-side="main"]').click();
        await expect(page.locator('#chatLog')).toBeVisible();
        await expect(page.locator('#commandInput')).toHaveValue('主会话尚未发送的草稿');
        await expect
          .poll(() => page.locator('#chatLog').evaluate((el) => el.scrollTop))
          .toBe(beforeScroll);
        assert.equal(writes.length, 2);
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('主会话尚未发送的草稿');
        await expect(bar).toBeVisible();
        await bar.locator('[data-side="side"]').click();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        // Native external return is observed without sending a new control action.
        change('main');
        fixture.changed();
        await expect(page.locator('#chatLog')).toBeVisible();
        assert.equal(writes.length, 3);
        change('side');
        fixture.changed();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        assert.equal(writes.length, 3);
        change('unknown');
        fixture.changed();
        await expect(bar.locator('.side-thread-note')).toHaveCount(0);
        await expect(bar.locator('[data-side="main"]')).toBeDisabled();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        assert.equal(writes.length, 3);
        await page.screenshot({ path: path.join(output, viewport.name + '-unknown.png') });
        change('side');
        fixture.changed();
        await expect(bar.locator('[data-side="main"]')).toBeEnabled();
        reject = true;
        await bar.locator('[data-side="main"]').click();
        await expect(bar.locator('.side-thread-error')).toBeVisible();
        await expect(page.locator('#shellTerminal')).toBeVisible();
        await page.screenshot({ path: path.join(output, viewport.name + '-error.png') });
        await bar.locator('[data-side="close"]').click();
        await expect(page.locator('#chatDialog')).toBeVisible();
        await page.screenshot({ path: path.join(output, viewport.name + '-confirm.png') });
        await page.locator('#chatDialogCancel').click();
        assert.equal(writes.length, 4);
        await bar.locator('[data-side="close"]').click();
        await page.locator('#chatDialogConfirm').click();
        await expect(page.locator('#chatLog')).toBeVisible();
        await expect(bar).toBeHidden();
        await expect(page.locator('#commandInput')).toHaveValue('主会话尚未发送的草稿');
        assert.equal(writes.length, 5);
        assert.equal(
          fixture.state.requests.filter((r) => r.route === 'POST /api/messages').length,
          0,
        );

        // A rejected send is not a permanent session failure. Observe recovery
        // without changing the draft or replaying the original message.
        fixture.state.unified = true;
        const binding = require('../../lib/conversation-state').binding(
          fixture.state.sessions['pane-codex'].pane,
        );
        state = { ...state, binding };
        const unified = page.waitForResponse(
          async (response) =>
            response.url().includes('/api/transcript?') &&
            response.ok() &&
            (await response.json()).binding === binding,
        );
        change('main', false);
        fixture.changed();
        await unified;
        const input = page.locator('#commandInput'),
          composerError = page.locator('#chatComposerError');
        const attachments = page.locator('#attachmentList'),
          submissions = [];
        let delivery = 'rejected',
          accepted = 0,
          rejectedAt = null,
          acceptedAt = null;
        const rejection = '原生会话状态正在恢复，内容尚未发送。';
        const uncertain = '原生端接收结果尚未确认，请保留本次投递记录。';
        await context.route('**/api/messages', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          const body = route.request().postDataJSON();
          submissions.push(body);
          assert.equal(body.binding, binding);
          const success = delivery === 'accepted',
            unconfirmed = delivery === 'uncertain';
          // A host clock adjustment must not discard a later native receipt.
          const updatedAt = success ? rejectedAt - 1000 : Date.now();
          if (success) {
            accepted++;
            acceptedAt = updatedAt;
          } else if (!unconfirmed) rejectedAt = updatedAt;
          return route.fulfill({
            status: 202,
            json: {
              ok: true,
              message: {
                id: body.id,
                paneId: body.paneId,
                text: body.text,
                status: success ? 'dispatched' : 'failed',
                deliveryUncertain: unconfirmed,
                retryable: !success && !unconfirmed,
                ...(success ? { transportAcceptedAt: updatedAt } : {}),
                error: success
                  ? null
                  : { code: 'SIDE_UNKNOWN', message: unconfirmed ? uncertain : rejection },
                updatedAt,
              },
            },
          });
        });
        async function observe(mode, observedBinding = binding) {
          state = { ...state, binding: observedBinding };
          change(mode, false);
          const revision = state.revision;
          fixture.changed();
          await expect
            .poll(() => observations.some((view) => view.revision === revision))
            .toBe(true);
          if (mode === 'unknown') await expect(page.locator('#chatSideToggle')).toBeDisabled();
          else await expect(page.locator('#chatSideToggle')).toBeEnabled();
        }
        const draft = '会话状态恢复后仍需由我确认发送的中文草稿';
        await input.fill(draft);
        await page.locator('#attachInput').setInputFiles({
          name: '恢复检查.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('保留未发送附件'),
        });
        await expect(attachments).toContainText('恢复检查.txt');
        await expect(attachments).not.toContainText('上传中');
        await observe('unknown');
        await page.locator('#sendButton').click();
        await expect(composerError).toHaveText(rejection);
        assert.equal(submissions.length, 1);
        assert.equal(accepted, 0);
        for (let i = 0; i < 3; i++) {
          await observe('unknown');
          await expect(composerError).toHaveText(rejection);
          await expect(input).toHaveValue(draft);
          await expect(attachments).toContainText('恢复检查.txt');
          assert.equal(submissions.length, 1);
        }
        await observe('main', 'different-native-binding');
        await expect(composerError).toHaveText(rejection);
        assert.equal(submissions.length, 1);
        await observe('main');
        await expect(composerError).toBeHidden();
        await expect(input).toHaveValue(draft);
        await expect(attachments).toContainText('恢复检查.txt');
        await observe('main');
        await observe('main');
        await expect(composerError).toBeHidden();
        await expect(input).toHaveValue(draft);
        assert.equal(submissions.length, 1);
        assert.equal(accepted, 0);
        await page.screenshot({ path: path.join(output, viewport.name + '-send-recovered.png') });
        delivery = 'accepted';
        await page.locator('#sendButton').click();
        await expect(input).toHaveValue('');
        await expect(attachments).toBeHidden();
        assert.equal(submissions.length, 2);
        assert.equal(accepted, 1);
        assert.equal(acceptedAt, rejectedAt - 1000);
        assert.equal(submissions[1].id, submissions[0].id);
        assert.equal(submissions[1].retry, true);
        assert.equal(submissions[1].text, submissions[0].text);

        // A transport result that may already have reached the native input
        // must stay visible even after the same thread becomes readable.
        delivery = 'uncertain';
        await input.fill('接收结果不确定时不能自动消除的中文草稿');
        await observe('unknown');
        await page.locator('#sendButton').click();
        await expect(composerError).toHaveText(uncertain);
        await observe('main');
        await expect(composerError).toHaveText(uncertain);
        await observe('main');
        await expect(composerError).toHaveText(uncertain);
        await expect(input).toHaveValue('接收结果不确定时不能自动消除的中文草稿');
        assert.equal(submissions.length, 3);
        assert.equal(accepted, 1);
        assert.equal(writes.length, 5);
        await page.screenshot({ path: path.join(output, viewport.name + '-send-uncertain.png') });
        assert.deepEqual(errors, []);
        assert.deepEqual(fixture.state.unexpected, []);
        results.push({
          viewport: viewport.name,
          geometry,
          focus,
          openSwitchClose: true,
          draftAndScroll: true,
          reload: true,
          externalSwitch: true,
          unknownPreservesSide: true,
          staleRejection: true,
          sendRecovery: {
            repeatedUnknown: 3,
            draftAndAttachmentsPreserved: true,
            differentBindingRejected: true,
            noAutomaticResend: true,
            explicitRetrySameId: true,
            accepted: 1,
            clockRollbackMs: 1000,
            uncertainDeliveryPreserved: true,
          },
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    const after = sourceFingerprint(process.cwd());
    assert.equal(before.treeSha256, after.treeSha256);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ ok: true, before, after, results }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, results }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

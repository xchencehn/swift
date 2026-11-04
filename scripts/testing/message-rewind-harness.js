#!/usr/bin/env node
'use strict';
// Exercise the actual app with the repository fixture and isolated Firefox.
// Native prepare and network failures are fixture responses, never live input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const C = require('../../lib/conversation-state');
const output = path.resolve(__dirname, '../../artifacts/message-rewind/browser');
const sourceText = '这是一条需要修改的历史消息。\n中文与 emoji 🧪 均保留原文。\n\n短行。';
const normalDraft = '原来的普通消息草稿，编辑取消和发送后都应保留。';
const viewports = [
  { name: 'desktop', width: 1920, height: 1080, touch: false },
  { name: 'tablet', width: 1024, height: 768, touch: true },
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'mobile-small', width: 320, height: 740, touch: true },
];
async function run() {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch({ headless: true }),
    results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      fixture.state.unified = true;
      for (const session of Object.values(fixture.state.sessions)) {
        session.pane.runtimeId = 'fixture-process-' + session.pane.paneId;
        session.pane.cwd = '/fixture/workdir/project/subdirectory';
      }
      fixture.state.workspaces[0].cwd = '/fixture/workdir/project/subdirectory';
      const session = fixture.state.sessions['pane-codex'];
      session.messages.push({
        id: 'rewind-integrated-message',
        role: 'user',
        sourceText,
        blocks: [{ kind: 'text', text: sourceText }],
      });
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      await context.addInitScript(() => {
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      });
      const result = {
        viewport,
        ok: false,
        canonicalPublic: true,
        randomUUIDUnavailable: true,
        syntheticPointers: true,
        nativeOperation: false,
      };
      let page;
      try {
        page = await context.newPage();
        page.setDefaultTimeout(6000);
        const errors = [],
          prepares = [],
          posts = [];
        let prepareMode = 'ok',
          postMode = 'ok',
          releasePrepare,
          releasePost;
        page.on('pageerror', (error) => errors.push(error.message));
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort(),
        );
        await page.route('**/api/agents/rewind', async (route) => {
          const body = route.request().postDataJSON();
          prepares.push(body);
          assert.equal(body.action, 'prepare');
          assert.equal(body.paneId, 'pane-codex');
          assert.equal(body.terminalId, 'term-codex');
          assert.equal(body.sessionId, 'thread-codex');
          assert.equal(body.runtimeId, fixture.state.runtimeId || 'fixture-runtime');
          assert.equal(body.messageId, 'rewind-integrated-message');
          assert.equal(typeof body.clientId, 'string');
          assert(body.clientId.trim());
          assert.equal(typeof body.requestId, 'string');
          assert(body.requestId.trim());
          assert.notEqual(body.clientId, body.requestId);
          assert(
            !prepares.slice(0, -1).some((previous) => previous.requestId === body.requestId),
            'each preparation gets a fresh request id',
          );
          if (prepares.length > 1)
            assert.equal(
              body.clientId,
              prepares[0].clientId,
              'one controller keeps the same client id',
            );
          if (prepareMode === 'hold')
            await new Promise((resolve) => {
              releasePrepare = resolve;
            });
          await route
            .fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                preparation: {
                  id: 'integrated-preparation-' + prepares.length,
                  messageId: body.messageId,
                  sourceText,
                  historyRevision: C.historyVersion(session.messages),
                  identity: C.identity(session.pane),
                },
              }),
            })
            .catch(() => {}); // A pure read can finish after local cancellation aborted fetch.
        });
        await page.route('**/api/messages', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          const body = route.request().postDataJSON();
          posts.push(body);
          if (postMode === 'hold')
            await new Promise((resolve) => {
              releasePost = resolve;
            });
          if (postMode === 'lost') {
            await route.fetch();
            return route.abort('failed');
          }
          if (postMode === 'reject')
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: false,
                code: 'REWIND_LITERAL_PREFIX',
                message: '原生命令前缀不能作为编辑消息发送。',
                deliveryUncertain: false,
                retryable: true,
              }),
            });
          return route.continue();
        });
        await page.goto(`${fixture.url}/?token=fixture&view=chat`);
        assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
        const bubble = page.locator('.chat-msg[data-message-id="rewind-integrated-message"]'),
          input = page.locator('#commandInput');
        await expect(bubble).toBeVisible();
        await input.fill(normalDraft);
        await page.locator('#attachInput').setInputFiles({
          name: '原草稿文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('original draft attachment'),
        });
        await expect(page.locator('#attachmentList')).toContainText('原草稿文件.txt');
        await expect(page.locator('#attachmentList')).not.toContainText('上传中');
        const menu = page.locator('.popover.context-menu'),
          edit = page.getByRole('menuitem', { name: '编辑', exact: true });
        const blank = async () => {
          await bubble.scrollIntoViewIfNeeded();
          // Flush the scroll event before beginning the separate hold gesture.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          return bubble.evaluate((el) => {
            const b = el.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + 5 };
          });
        };
        const start = async () => {
          await expect(
            page.locator(
              '.chat-msg[data-message-id="rewind-integrated-message"] + .chat-meta .chat-message-edit-action',
            ),
          ).toBeEnabled();
          const point = await blank();
          await page.mouse.click(point.x, point.y, { button: 'right' });
          await expect(edit).toBeVisible();
          await edit.click();
        };
        const contextAt = async (point) =>
          page.evaluate((point) => {
            const target = document.elementFromPoint(point.x, point.y);
            if (!target?.closest('.chat-msg'))
              throw new Error('Context menu point missed the message');
            const event = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
            });
            target.dispatchEvent(event);
            return event.defaultPrevented;
          }, point);
        const pointer = async (type, point, pointerId = 11, extra = {}) =>
          page.evaluate(
            ({ type, point, pointerId, extra }) => {
              const target =
                document.elementFromPoint(point.x, point.y) || document.querySelector('#chatLog');
              target.dispatchEvent(
                new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  pointerType: 'touch',
                  pointerId,
                  isPrimary: pointerId === 11,
                  button: 0,
                  clientX: point.x,
                  clientY: point.y,
                  ...extra,
                }),
              );
            },
            { type, point, pointerId, extra },
          );

        const restore = async () => {
          await expect(input).toHaveValue(normalDraft);
          await expect(page.locator('#attachmentList')).toContainText('原草稿文件.txt');
          await expect(page.locator('.chat-message-edit')).toBeHidden();
        };
        const point = await bubble.evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          walker.nextNode();
          const range = document.createRange();
          range.setStart(walker.currentNode, 0);
          range.setEnd(walker.currentNode, 1);
          const b = range.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        });
        assert.equal(
          await page.evaluate((point) => {
            const event = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
            });
            document.elementFromPoint(point.x, point.y).dispatchEvent(event);
            return event.defaultPrevented;
          }, point),
          false,
        );
        await expect(menu).toHaveCount(0);
        const assistant = page.locator('.chat-msg[data-role="assistant"]').last();
        await assistant.scrollIntoViewIfNeeded();
        const assistantPoint = await assistant.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return { x: b.x + 4, y: b.y + 4 };
        });
        assert.equal(await contextAt(assistantPoint), false);
        await expect(menu).toHaveCount(0);
        result.assistantMessageKeepsNativeContextMenu = true;

        let gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await expect(edit).toBeVisible();
        assert.equal(await contextAt(gesturePoint), true);
        await expect(menu).toHaveCount(1);
        await pointer('pointerup', gesturePoint);
        await page.evaluate(
          (point) =>
            document.elementFromPoint(point.x, point.y).dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 1,
                clientX: point.x,
                clientY: point.y,
              }),
            ),
          gesturePoint,
        );
        assert.equal(prepares.length, 0);
        await expect(menu).toHaveCount(1);
        await page.keyboard.press('Escape');
        result.longPressAndSystemMenuAreDeduplicated = true;

        gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await pointer('pointercancel', gesturePoint);
        await page.waitForTimeout(560);
        await expect(menu).toHaveCount(0);
        assert.equal(await contextAt(gesturePoint), true);
        await expect(menu).toHaveCount(1);
        await page.keyboard.press('Escape');
        result.pointerCancelStopsTimerButAllowsStableSystemContextMenu = true;
        gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await pointer('pointercancel', gesturePoint);
        await pointer('pointermove', { x: gesturePoint.x + 20, y: gesturePoint.y });
        assert.equal(await contextAt(gesturePoint), false);
        await expect(menu).toHaveCount(0);
        gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await pointer('pointercancel', gesturePoint);
        await page.locator('#chatLog').dispatchEvent('scroll');
        assert.equal(await contextAt(gesturePoint), false);
        await expect(menu).toHaveCount(0);
        result.movementAndScrollCancelSystemContextMenu = true;
        gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await pointer('pointerdown', gesturePoint, 12);
        await pointer('pointerup', gesturePoint, 12);
        await pointer('pointerup', gesturePoint);
        await page.waitForTimeout(560);
        assert.equal(await contextAt(gesturePoint), false);
        await expect(menu).toHaveCount(0);
        result.multitouchCancelsMenu = true;
        gesturePoint = await blank();
        await pointer('pointerdown', gesturePoint);
        await bubble.evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          walker.nextNode();
          const range = document.createRange();
          range.setStart(walker.currentNode, 0);
          range.setEnd(walker.currentNode, 2);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        });
        await pointer('pointerup', gesturePoint);
        assert.equal(await contextAt(gesturePoint), false);
        await expect(menu).toHaveCount(0);
        assert.equal(await page.evaluate(() => getSelection().toString()), '这是');
        await page.evaluate(() => getSelection().removeAllRanges());
        result.textSelectionRemainsNative = true;

        const bindingPoint = await blank(),
          bindingBeforeMenu = C.binding(session.pane),
          preparesBeforeBinding = prepares.length;
        await page.mouse.click(bindingPoint.x, bindingPoint.y, { button: 'right' });
        await expect(edit).toBeVisible();
        session.pane.runtimeId += '-menu-binding-change';
        fixture.changed();
        assert.notEqual(C.binding(session.pane), bindingBeforeMenu);
        await expect(edit).toHaveCount(0);
        await expect(input).toHaveValue(normalDraft);
        assert.equal(prepares.length, preparesBeforeBinding);
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        result.nativeBindingChangeInvalidatesOpenMenu = true;

        const selectionPoint = await blank(),
          preparesBeforeSelection = prepares.length;
        await page.mouse.click(selectionPoint.x, selectionPoint.y, { button: 'right' });
        await expect(edit).toBeVisible();
        const selectedAtActivation = await bubble.evaluate((element) => {
          const button = [...document.querySelectorAll('.context-menu [role="menuitem"]')].find(
            (button) => button.textContent === '编辑',
          );
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          walker.nextNode();
          const range = document.createRange();
          range.setStart(walker.currentNode, 0);
          range.setEnd(walker.currentNode, 2);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          button.click();
          return getSelection().toString();
        });
        assert.equal(selectedAtActivation, '这是');
        await expect(menu).toHaveCount(0);
        assert.equal(prepares.length, preparesBeforeSelection);
        await expect(input).toHaveValue(normalDraft);
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        await page.evaluate(() => getSelection().removeAllRanges());
        result.selectionChangeRejectsMenuActivation = true;
        const blankPoint = await blank();
        await page.mouse.click(blankPoint.x, blankPoint.y, { button: 'right' });
        await expect(edit).toBeVisible();
        await expect(menu.locator('[role=menuitem]')).toHaveCount(1);
        assert.equal(await bubble.locator('button').count(), 0);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-menu.png`),
          fullPage: true,
        });
        result.menuGeometry = await bubble.evaluate((element, point) => {
          const before = element.getBoundingClientRect();
          element.style.transform = `translateY(-${before.height + 32}px)`;
          const after = element.getBoundingClientRect();
          return {
            connected: element.isConnected,
            sameNode:
              element ===
              document.querySelector('.chat-msg[data-message-id="rewind-integrated-message"]'),
            before: { x: before.x, y: before.y, width: before.width, height: before.height },
            after: { x: after.x, y: after.y, width: after.width, height: after.height },
            oldPointInsideMovedBubble:
              point.x >= after.left &&
              point.x <= after.right &&
              point.y >= after.top &&
              point.y <= after.bottom,
          };
        }, blankPoint);
        assert(result.menuGeometry.connected && result.menuGeometry.sameNode);
        assert.notEqual(result.menuGeometry.before.y, result.menuGeometry.after.y);
        assert.equal(result.menuGeometry.oldPointInsideMovedBubble, false);
        await expect(edit).toBeVisible();
        await edit.hover();
        await page.mouse.down();
        const refreshed = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/api/transcript' && url.searchParams.get('state') === '1';
        });
        fixture.changed();
        await (await refreshed).finished();
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(edit).toBeVisible();
        assert.equal(prepares.length, 0);
        await page.mouse.up();
        await bubble.evaluate((element) => element.style.removeProperty('transform'));
        await expect(input).toHaveValue(sourceText);
        await expect(page.locator('#attachmentList')).toBeHidden();
        assert.equal(posts.length, 0);
        assert.equal(prepares.length, 1);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-editing.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: '取消编辑历史消息', exact: true }).click();
        await restore();
        result.menuActivationSurvivesGeometryChange = true;
        result.menuTargetSurvivesBackgroundRefresh = true;
        result.blankOnlyMenuAndReadOnlyPrepare = true;
        result.cancelRestoresDraftAndAttachment = true;

        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('/model');
        await page.waitForTimeout(160);
        await expect(page.locator('#slashCommands')).toBeHidden();
        await expect(page.locator('.native-command-panel')).toBeHidden();
        assert.equal(
          fixture.state.requests.filter((item) => item.route === 'POST /api/command-interaction')
            .length,
          0,
        );
        postMode = 'reject';
        await page.locator('#sendButton').click();
        await expect(page.locator('#chatComposerError')).toContainText('原生命令前缀');
        assert.equal(posts.length, 1);
        assert.equal(posts[0].text, '/model');
        assert.equal(typeof posts[0].rewind.preparationId, 'string');
        await expect(page.locator('.chat-message-edit-label')).toHaveText('正在编辑历史消息');
        await expect(input).toHaveValue('/model');
        await page.getByRole('button', { name: '取消编辑历史消息', exact: true }).click();
        await restore();
        result.slashNeverInvokesCommand = true;

        postMode = 'ok';
        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('修改后的中文内容');
        await input.dispatchEvent('compositionstart');
        await input.dispatchEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        });
        assert.equal(posts.length, 1);
        await input.dispatchEvent('compositionend');
        await page.locator('#attachInput').setInputFiles({
          name: '编辑新增文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('edited message attachment'),
        });
        await expect(page.locator('#attachmentList')).toContainText('编辑新增文件.txt');
        await expect(page.locator('#attachmentList')).not.toContainText('上传中');
        await page.locator('#sendButton').click();
        await restore();
        assert.equal(posts.length, 2);
        assert(posts[1].text.includes('修改后的中文内容'));
        assert(posts[1].text.includes('编辑新增文件.txt'));
        assert(!posts[1].text.includes('原草稿文件.txt'));
        assert.equal(typeof posts[1].rewind.preparationId, 'string');
        assert.notEqual(
          posts[0].id,
          posts[1].id,
          'different edit intents cannot share reliable ids',
        );
        await expect(page.locator('#attachmentList')).not.toContainText('编辑新增文件.txt');
        result.realComposerDescriptorAndSuccessRestore = true;
        result.imeEnterDoesNotSend = true;

        postMode = 'hold';
        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('发送中的修改正文');
        await page.locator('#sendButton').click();
        await expect.poll(() => posts.length).toBe(3);
        await input.fill('发送过程中继续写的新草稿');
        releasePost();
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        await expect(input).toHaveValue('发送过程中继续写的新草稿');
        result.newTypingSurvivesAcceptance = true;
        await input.fill(normalDraft);
        postMode = 'hold';
        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('相同字节也要保留的新输入');
        const beforeIdentical = posts.length;
        await page.locator('#sendButton').click();
        await expect.poll(() => posts.length).toBe(beforeIdentical + 1);
        const identicalSendCount = posts.length;
        await input.fill('中间改成别的内容');
        await input.fill('相同字节也要保留的新输入');
        releasePost();
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        await expect(input).toHaveValue('相同字节也要保留的新输入');
        assert.equal(posts.length, identicalSendCount);
        result.retypedIdenticalTextSurvivesAcceptance = true;
        await input.fill(normalDraft);
        await page.locator('#attachInput').setInputFiles({
          name: '原草稿文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('original draft attachment'),
        });
        await expect(page.locator('#attachmentList')).not.toContainText('上传中');

        postMode = 'lost';
        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('丢失响应的编辑正文');
        const postCountBeforeLost = posts.length;
        await page.locator('#sendButton').click();
        await restore();
        assert.equal(
          posts.length,
          postCountBeforeLost + 1,
          'lost response recovery must only read the same receipt',
        );
        result.lostResponseRecoversWithoutReplay = true;

        postMode = 'hold';
        await start();
        await expect(input).toHaveValue(sourceText);
        await input.fill('后台发送中的编辑正文');
        const beforeBackground = posts.length;
        await page.locator('#sendButton').click();
        await expect.poll(() => posts.length).toBe(beforeBackground + 1);
        await input.fill('发送中先写好、切走后仍要保留的新草稿');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        await input.fill('另一个会话的独立草稿');
        releasePost();
        await expect(input).toHaveValue('另一个会话的独立草稿');
        await expect
          .poll(() =>
            page.evaluate(() => {
              const key = Object.keys(localStorage).find((key) =>
                key.endsWith(':draft:' + encodeURIComponent('codex:session:thread-codex')),
              );
              return key && JSON.parse(localStorage.getItem(key));
            }),
          )
          .toBe('发送中先写好、切走后仍要保留的新草稿');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
        await expect(input).toHaveValue('发送中先写好、切走后仍要保留的新草稿');
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        result.backgroundAcceptancePreservesNewDraft = true;
        await input.fill(normalDraft);
        await page.locator('#attachInput').setInputFiles({
          name: '原草稿文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('original draft attachment'),
        });
        await expect(page.locator('#attachmentList')).not.toContainText('上传中');

        postMode = 'hold';
        await input.fill('正在普通发送的草稿');
        const beforeOrdinary = posts.length;
        await page.locator('#sendButton').click();
        await expect.poll(() => posts.length).toBe(beforeOrdinary + 1);
        const preparesBeforeOrdinary = prepares.length;
        const blockedPoint = await blank();
        await page.mouse.click(blockedPoint.x, blockedPoint.y, { button: 'right' });
        await expect(edit).toHaveCount(0);
        assert.equal(prepares.length, preparesBeforeOrdinary);
        releasePost();
        await expect(input).toHaveValue('');
        postMode = 'ok';
        await input.fill(normalDraft);
        await page.locator('#attachInput').setInputFiles({
          name: '原草稿文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('original draft attachment'),
        });
        await expect(page.locator('#attachmentList')).not.toContainText('上传中');
        result.normalSubmissionCannotBecomeEditBackup = true;

        const beforeDraftPrepare = prepares.length;
        releasePrepare = null;
        prepareMode = 'hold';
        await start();
        await expect(page.locator('.chat-message-edit-label')).toHaveText('正在读取历史消息…');
        await expect.poll(() => prepares.length).toBe(beforeDraftPrepare + 1);
        await expect.poll(() => typeof releasePrepare).toBe('function');
        const releaseDraftPrepare = releasePrepare;
        await expect(input).toHaveValue(normalDraft);
        await input.fill('准备期间的新输入');
        releaseDraftPrepare();
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        await expect(input).toHaveValue('准备期间的新输入');
        prepareMode = 'ok';
        await input.fill(normalDraft);
        result.preparePreservesNewTyping = true;

        await start();
        await expect(input).toHaveValue(sourceText);
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
        await restore();
        result.switchingSessionRestoresOrdinaryDraft = true;

        const beforeLatePrepare = prepares.length;
        releasePrepare = null;
        prepareMode = 'hold';
        await start();
        await expect(page.locator('.chat-message-edit-label')).toHaveText('正在读取历史消息…');
        await expect.poll(() => prepares.length).toBe(beforeLatePrepare + 1);
        await expect.poll(() => typeof releasePrepare).toBe('function');
        const releaseLatePrepare = releasePrepare;
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        await input.fill('其他会话正在写的草稿');
        releaseLatePrepare();
        await expect(input).toHaveValue('其他会话正在写的草稿');
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        prepareMode = 'ok';
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
        await restore();
        result.latePreparationCannotChangeAnotherSession = true;

        await start();
        await expect(input).toHaveValue(sourceText);
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        await expect(page.locator('.chat-message-edit')).toBeHidden();
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await restore();
        result.switchingModeCancelsLocally = true;
        await start();
        await expect(input).toHaveValue(sourceText);
        fixture.state.runtimeId = 'fixture-runtime-restarted';
        fixture.changed();
        await restore();
        await start();
        await expect(input).toHaveValue(sourceText);
        await page.getByRole('button', { name: '取消编辑历史消息', exact: true }).click();
        await restore();
        result.runtimeRefreshKeepsCurrentMessageMapping = true;

        postMode = 'hold';
        await start();
        await expect(input).toHaveValue(sourceText);
        const beforeRoot = posts.length;
        await page.locator('#sendButton').click();
        await expect.poll(() => posts.length).toBe(beforeRoot + 1);
        await page.evaluate(async () => {
          await fetch('/api/config?token=fixture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootDirectory: '/fixture/workdir/project' }),
          });
        });
        await expect(input).toHaveValue('');
        await expect(bubble).toBeVisible();
        await input.fill('其他根目录的新草稿');
        releasePost();
        await expect
          .poll(() =>
            page.evaluate(() => {
              const key = Object.keys(localStorage).find(
                (key) =>
                  key.includes(':/fixture/workdir:draft:') &&
                  key.endsWith(encodeURIComponent('codex:session:thread-codex')),
              );
              return key && JSON.parse(localStorage.getItem(key));
            }),
          )
          .toBe(normalDraft);
        await expect(input).toHaveValue('其他根目录的新草稿');
        await page.evaluate(async () => {
          await fetch('/api/config?token=fixture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootDirectory: '/fixture/workdir' }),
          });
        });
        await restore();
        result.sameSessionRootRoundTripRestoresDraftAndAttachment = true;
        const visibleEdit = page.locator(
          '.chat-msg[data-message-id="rewind-integrated-message"] + .chat-meta .chat-message-edit-action',
        );
        await expect(visibleEdit).toBeVisible();
        await visibleEdit.click();
        await expect(input).toHaveValue(sourceText);
        await expect(page.locator('.chat-message-edit-note')).toContainText('工作文件不会撤销');
        await page.getByRole('button', { name: '取消编辑历史消息', exact: true }).click();
        await restore();
        result.visibleEditUsesVerifiedPreparation = true;
        result.geometry = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - innerWidth,
          editButtonsBesideCopy: document.querySelectorAll('.chat-meta .chat-message-edit-action')
            .length,
        }));
        assert.equal(result.geometry.overflow, 0);
        assert(result.geometry.editButtonsBesideCopy > 0);
        assert.deepEqual(errors, []);
        assert(!fixture.state.frames.some((frame) => frame.includes('terminal.input')));
        assert.deepEqual(fixture.state.unexpected, []);
        result.wire = { prepares, posts };
        result.ok = true;
      } catch (error) {
        result.error = error.stack;
        await page
          ?.screenshot({ path: path.join(output, `${viewport.name}-failure.png`), fullPage: true })
          .catch(() => {});
      } finally {
        await context.close();
        await fixture.close();
      }
      results.push(result);
      console.log(
        `${result.ok ? 'PASS' : 'FAIL'} ${viewport.name}${result.error ? ': ' + result.error : ''}`,
      );
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2),
  );
  assert(
    results.every((result) => result.ok),
    'message rewind browser failures',
  );
}
run().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

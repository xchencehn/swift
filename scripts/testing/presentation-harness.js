'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve(process.env.SWIFT_PRESENTATION_OUTPUT || 'artifacts/chat-presentation');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'narrow-mobile', width: 320, height: 740, touch: true },
      { name: 'wide-desktop', width: 1920, height: 1080, touch: false },
    ]) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
        });
      fixture.state.productionPresentation = true;
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatModeToggle')).toHaveAccessibleName('切换到终端模式');
        await expect(page.locator('#chatModeToggle')).toHaveAttribute(
          'title',
          '切换到终端模式（当前窗口所有会话）',
        );
        await expect(page.locator('.herdr-pane-menu')).toHaveCount(0);
        const headerGeometry = async () =>
          page.evaluate(() => {
            const rect = (id) => {
              const e = document.getElementById(id),
                r = e.getBoundingClientRect();
              return {
                x: r.x,
                right: r.right,
                width: r.width,
                visible: !!e.getClientRects().length,
              };
            };
            return {
              name: rect('chatCurrentName'),
              kind: rect('chatCurrentKind'),
              mode: rect('chatModeToggle'),
              side: rect('chatSideToggle'),
              more: rect('chatSessionMore'),
              files: rect('chatFilesToggle'),
              tabs: document
                .querySelector('.herdr-tabs:not([hidden])')
                ?.getBoundingClientRect()
                .toJSON(),
              head: document.querySelector('.chat-head').getBoundingClientRect().toJSON(),
              overflow: document.documentElement.scrollWidth - innerWidth,
            };
          });
        const assertHeader = async () => {
          const g = await headerGeometry(),
            previous = g.tabs || (g.kind.visible ? g.kind : g.name);
          if (viewport.width <= 760) {
            const last = [g.mode, g.side, g.more, g.files]
              .filter((button) => button.visible)
              .at(-1);
            assert(
              g.mode.x >= previous.right - 1 &&
                g.side.x >= g.mode.right &&
                g.more.x >= g.side.right,
              'Mobile actions must follow the title without overlap',
            );
            assert(g.head.right - last.right <= 25, 'Mobile actions must stay at the right edge');
          } else
            assert(
              g.mode.x >= previous.right - 1 && g.mode.x - previous.right <= 16,
              'Desktop mode switch must immediately follow the session identity',
            );
          assert(
            (g.tabs?.width > 0 || g.name.width > 0) && g.mode.right <= g.head.right,
            'Native tabs or title and mode switch must fit',
          );
          if (g.files.visible)
            assert(
              g.files.x >= g.mode.right && g.head.right - g.files.right <= 25,
              'Files must remain right aligned',
            );
          assert.equal(g.overflow, 0);
          return g;
        };
        const originalName = await page.locator('#chatCurrentName').textContent();
        await page.locator('#chatCurrentName').evaluate((el) => (el.textContent = '短会话'));
        const header = await assertHeader();
        await page.screenshot({ path: path.join(output, viewport.name + '-short-title.png') });
        await page
          .locator('#chatCurrentName')
          .evaluate(
            (el) =>
              (el.textContent = '很长的会话标题用于检查切换按钮与文件入口不会重叠'.repeat(15)),
          );
        const longHeader = await assertHeader();
        await page.screenshot({ path: path.join(output, viewport.name + '-long-title.png') });
        await page
          .locator('#chatCurrentName')
          .evaluate((el, text) => (el.textContent = text), originalName);

        await page.locator('#commandInput').fill('保留结构化草稿');
        const input = await page.locator('#commandInput').elementHandle();
        const content = (selector) =>
          page.locator(selector).evaluate((el) => {
            const r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            return {
              left: r.left + parseFloat(s.paddingLeft),
              width: r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
            };
          });
        const originalChat = await content('#chatLog');
        const mainWidth = await page.locator('.chat-main').evaluate((el) => el.clientWidth);
        if (viewport.width > 760)
          assert(
            originalChat.width >= mainWidth * 0.85 && originalChat.width <= mainWidth - 48 + 1,
            'Chat defaults use a wide responsive column',
          );
        await page.screenshot({
          path: path.join(output, viewport.name + '-chat-default-width.png'),
        });
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        await expect(page.locator('#chatModeToggle')).toHaveAccessibleName('切换到结构化模式');
        await expect(page.locator('#commandInput')).toHaveValue('保留结构化草稿');
        let terminalWidth, chatWidth;
        if (!viewport.touch) {
          const handle = page.locator('#chatContentResizer');
          await expect(handle).toBeVisible();
          const before = await content('#shellTerminal');
          assert(
            Math.abs(before.width - mainWidth + 48) < 1,
            'Terminal defaults fill the main region with its existing side padding',
          );
          await page.screenshot({
            path: path.join(output, viewport.name + '-terminal-default-width.png'),
          });
          await expect(handle).toHaveAttribute('aria-valuenow', /^[1-9][0-9]*$/);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(100);
          const previousCols = fixture.state.shellFrames.findLast(
            (f) => f.type === 'terminal.resize' && f.paneId === 'pane-codex',
          )?.cols;
          const h = await handle.boundingBox();
          await page.mouse.move(h.x + h.width / 2, h.y + 12);
          await page.mouse.down();
          await page.mouse.move(h.x + h.width / 2 + 65, h.y + 12, { steps: 5 });
          await page.mouse.up();
          await expect
            .poll(async () => (await content('#shellTerminal')).width)
            .toBeLessThan(before.width - 100);
          await handle.focus();
          await page.keyboard.press('Home');
          await expect.poll(async () => (await content('#shellTerminal')).width).toBe(before.width);
          await expect
            .poll(() =>
              page.evaluate(async () =>
                fetch('/api/config?token=fixture')
                  .then((r) => r.json())
                  .then((d) => d.settings.ui.studioTerminalContentWidth),
              ),
            )
            .toBe('auto');
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowRight');
          const resized = await content('#shellTerminal');
          await expect
            .poll(
              () =>
                fixture.state.shellFrames.findLast(
                  (f) => f.type === 'terminal.resize' && f.paneId === 'pane-codex',
                )?.cols,
            )
            .not.toBe(previousCols);
          await page.screenshot({ path: path.join(output, viewport.name + '-terminal-width.png') });
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#chatLog')).toBeVisible();
          const chat = await content('#chatLog');
          assert.deepEqual(chat, originalChat, 'Terminal resizing must not change chat width');
          await expect(handle).toHaveAccessibleName('聊天内容宽度');
          const chatHandle = await handle.boundingBox();
          await page.mouse.move(chatHandle.x + chatHandle.width / 2, chatHandle.y + 12);
          await page.mouse.down();
          await page.mouse.move(chatHandle.x + chatHandle.width / 2 - 35, chatHandle.y + 12, {
            steps: 5,
          });
          await page.mouse.up();
          await expect
            .poll(async () => (await content('#chatLog')).width)
            .toBeGreaterThan(chat.width + 50);
          await handle.focus();
          await page.keyboard.press('ArrowLeft');
          const wider = await content('#chatLog');
          assert(wider.width > chat.width);
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toContainText('native terminal');
          const terminal = await content('#shellTerminal');
          assert.deepEqual(terminal, resized, 'Chat resizing must not change terminal width');
          await expect(handle).toHaveAccessibleName('终端宽度');
          terminalWidth = terminal.width;
          chatWidth = wider.width;
          await expect
            .poll(() =>
              page.evaluate(async () => {
                const d = await fetch('/api/config?token=fixture').then((r) => r.json());
                return d.settings.ui;
              }),
            )
            .toMatchObject({
              studioContentWidth: String(Math.round(chatWidth)),
              studioTerminalContentWidth: String(Math.round(terminalWidth)),
            });
        }
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#commandInput')).toHaveValue('保留结构化草稿');
        assert(await input.evaluate((el) => el.isConnected));
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        await page.reload();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        if (terminalWidth) {
          assert(
            Math.abs(
              (await page.locator('.shell-terminal-canvas').evaluate((el) => el.clientWidth)) -
                terminalWidth,
            ) < 1,
          );
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#chatLog')).toBeVisible();
          assert(
            Math.abs((await content('#chatLog')).width - chatWidth) < 1,
            'Reload must restore the independent chat width',
          );
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        }
        {
          const terminal = page.locator('#shellTerminal'),
            textarea = terminal.locator('.xterm-helper-textarea'),
            composition = terminal.locator('.composition-view');
          await textarea.focus();
          await page.keyboard.press('Escape');
          await page.keyboard.insertText('[999;7H');
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .filter((f) => f.type === 'terminal.input')
                .map((f) => f.data)
                .join(''),
            )
            .toContain('\x1b[999;7H');
          await page.waitForTimeout(100);
          const before = fixture.state.shellFrames.length;
          await textarea.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            el.value = "zhong'duan";
            el.dispatchEvent(
              new CompositionEvent('compositionupdate', { bubbles: true, data: el.value }),
            );
          });
          await expect(composition).toBeHidden();
          await page.waitForTimeout(50);
          const geometry = await terminal.evaluate((el) => {
            const c = el.querySelector('.composition-view'),
              t = el.querySelector('textarea'),
              screen = el.querySelector('.xterm-screen');
            return {
              anchor: t.getBoundingClientRect().toJSON(),
              area: screen.getBoundingClientRect().toJSON(),
            };
          });
          assert(
            geometry.anchor.width <= 2 && geometry.anchor.height > 0 && geometry.anchor.height < 30,
            'IME must use a narrow single-line anchor',
          );
          assert(
            geometry.anchor.y >= geometry.area.y - 1 &&
              geometry.anchor.bottom <= geometry.area.bottom + 1,
          );
          await page.screenshot({ path: path.join(output, viewport.name + '-ime-short.png') });
          await textarea.evaluate((el) => {
            for (const [key, keyCode] of [
              ['PageDown', 34],
              ['PageUp', 33],
              ['Enter', 13],
              ['Escape', 27],
            ])
              el.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key,
                  code: key,
                  keyCode,
                  isComposing: true,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            el.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'PageDown',
                code: 'PageDown',
                keyCode: 229,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await page.waitForTimeout(50);
          assert(
            !fixture.state.shellFrames
              .slice(before)
              .some((f) => ['terminal.input', 'terminal.scroll'].includes(f.type)),
            'Composition keys and pinyin must stay inside the IME',
          );
          await textarea.evaluate((el) => {
            el.value = '终端';
            el.dispatchEvent(
              new CompositionEvent('compositionupdate', { bubbles: true, data: el.value }),
            );
            el.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: el.value }),
            );
          });
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .slice(before)
                .filter((f) => f.type === 'terminal.input')
                .map((f) => f.data)
                .join(''),
            )
            .toBe('终端');
          await expect(composition).toBeHidden();
          assert.equal(await textarea.evaluate((el) => el.style.transform), '');
          const committed = fixture.state.shellFrames.length;
          await textarea.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            el.value = 'quxiao';
            el.dispatchEvent(
              new CompositionEvent('compositionupdate', { bubbles: true, data: el.value }),
            );
          });
          await expect(composition).toBeHidden();
          await textarea.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
          });
          await page.waitForTimeout(50);
          assert(
            !fixture.state.shellFrames.slice(committed).some((f) => f.type === 'terminal.input'),
            'Cancelled composition must not send',
          );
        }
        if (viewport.touch) {
          await page.setViewportSize({ width: viewport.width, height: 500 });
          const terminal = page.locator('#shellTerminal'),
            screen = terminal.locator('.xterm-screen'),
            textarea = terminal.locator('.xterm-helper-textarea');
          await textarea.focus();
          await page.waitForTimeout(100);
          const width = (await screen.boundingBox()).width;
          const cols = fixture.state.shellFrames.findLast(
            (f) => f.type === 'terminal.resize' && f.paneId === 'pane-codex',
          )?.cols;
          await page.keyboard.type('x'.repeat(Math.max(1, (cols || 40) - 4)));
          const text = '中文输入自动换行'.repeat(45) + ' long-word'.repeat(30);
          await textarea.evaluate((el, text) => {
            el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            el.value = text;
            el.dispatchEvent(
              new CompositionEvent('compositionupdate', { bubbles: true, data: text }),
            );
          }, text);
          const composing = terminal.locator('.composition-view.active');
          await expect(composing).toBeHidden();
          await page.waitForTimeout(100);
          assert.equal((await screen.boundingBox()).width, width);
          assert.equal(
            fixture.state.shellFrames.findLast(
              (f) => f.type === 'terminal.resize' && f.paneId === 'pane-codex',
            )?.cols,
            cols,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
            0,
          );
          await page.screenshot({ path: path.join(output, viewport.name + '-ime.png') });
          await textarea.evaluate((el) =>
            el.dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true, data: el.value }),
            ),
          );
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .filter((f) => f.type === 'terminal.input')
                .map((f) => f.data)
                .join(''),
            )
            .toContain('中文输入自动换行');
          await page.setViewportSize(viewport);
        }
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarRecent').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        const windowFrames = fixture.state.shellFrames.length;
        const peer = await context.newPage();
        peer.on('pageerror', (e) => errors.push(e.message));
        await peer.goto(fixture.url + '/?token=fixture&pane=pane-codex&surface=pane');
        await expect(peer.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(peer.locator('#commandInput')).toHaveValue('保留结构化草稿');
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        await page.locator('#commandInput').fill('保留 Claude 草稿');
        await peer.locator('#chatModeToggle').click();
        await expect(peer.locator('#shellTerminal')).toBeVisible();
        await expect(page.locator('#shellTerminal')).toBeHidden();
        await expect(page.locator('#commandInput')).toHaveValue('保留 Claude 草稿');
        await peer.reload();
        await expect(peer.locator('#shellTerminal')).toBeVisible();
        await page.goto(fixture.url + '/?token=fixture&pane=pane-claude');
        await expect(page.locator('#chatLog')).toContainText('claude 浏览器验收样例');
        await expect(page.locator('#commandInput')).toHaveValue('保留 Claude 草稿');
        await page.screenshot({ path: path.join(output, viewport.name + '-window-chat.png') });
        await peer.screenshot({ path: path.join(output, viewport.name + '-window-terminal.png') });
        await page.locator('#chatModeToggle').click();
        await peer.locator('#chatModeToggle').click();
        await expect(peer.locator('#shellTerminal')).toBeHidden();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        await expect(peer.locator('#commandInput')).toHaveValue('保留结构化草稿');
        // A legacy shared write or clear must not change either window, even on reload.
        await peer.evaluate(() => localStorage.setItem('swiftChatPresentation', 'terminal'));
        await peer.reload();
        await expect(peer.locator('#shellTerminal')).toBeHidden();
        await peer.evaluate(() => localStorage.removeItem('swiftChatPresentation'));
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#commandInput')).toHaveValue('保留 Claude 草稿');
        await peer.close();
        if (viewport.name === 'desktop') {
          await page.evaluate(() => localStorage.setItem('swiftChatPresentation', 'terminal'));
          const migrated = await context.newPage();
          await migrated.goto(fixture.url + '/?token=fixture&pane=pane-codex');
          await expect(migrated.locator('#shellTerminal')).toBeVisible();
          await migrated.locator('#chatModeToggle').click();
          await expect(migrated.locator('#chatLog')).toBeVisible();
          assert.equal(
            await migrated.evaluate(() => localStorage.getItem('swiftChatPresentation')),
            'terminal',
          );
          await migrated.reload();
          await expect(migrated.locator('#shellTerminal')).toBeHidden();
          await expect(page.locator('#shellTerminal')).toBeHidden();
          await migrated.close();
          await page.evaluate(() => localStorage.removeItem('swiftChatPresentation'));
        }
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
        await expect(page.locator('#commandInput')).toHaveValue('保留结构化草稿');
        await expect(page.locator('#shellTerminal')).toBeHidden();
        if (viewport.width <= 760) await expect(page.locator('#chatSidebar')).toBeHidden();
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        await page.locator('#chatModeToggle').click();
        fixture.state.runtimeId = 'fixture-runtime-restarted';
        fixture.state.rootDirectory = '/fixture';
        await page.reload();
        await expect(page.locator('#shellTerminal')).toContainText('native terminal');
        assert(
          !fixture.state.shellFrames.slice(windowFrames).some((f) => f.type === 'terminal.input'),
          'Window mode changes must not send terminal input',
        );
        assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          header,
          longHeader,
          defaultStructured: true,
          toggle: true,
          windowChoice: true,
          crossWindowIsolation: true,
          reloadRestored: true,
          rootAndRuntimeIndependent: true,
          draftPreserved: true,
          independentWidths: !viewport.touch,
          terminalWidth,
          chatWidth,
          mobileImeWrap: viewport.touch,
          imeTransparentSurface: true,
          imeAnchorBounded: true,
          imeKeysNotForwarded: true,
          imeCommitOnce: true,
          imeCancel: true,
        });
        console.log('PASS presentation switch', viewport.name);
      } finally {
        await context.close();
        await fixture.close();
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
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});

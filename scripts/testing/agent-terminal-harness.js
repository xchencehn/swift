'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { touchDrag } = require('./terminal-touch-fixture');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve('artifacts/agent-terminal-preview');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      fixture.state.terminalPreview = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('native terminal');
        await expect(page.locator('#chatInput')).toBeHidden();
        await expect(page.locator('#chatLog')).toBeHidden();
        await expect(page.locator('#chatCurrentName')).toContainText('Codex 验收会话');
        await expect(terminal).toContainText('中文字体');
        const fonts = await terminal.locator('.xterm-rows').evaluate((el) => ({
          terminal: getComputedStyle(el).fontFamily,
          ui: getComputedStyle(document.body).fontFamily,
        }));
        assert(
          fonts.terminal.includes('Swift Terminal CJK') && fonts.terminal.includes('Cascadia Mono'),
        );
        assert(fonts.terminal.includes(fonts.ui));
        const streams = fixture.state.shellConnections;
        fixture.changed();
        await page.waitForTimeout(300);
        assert.equal(fixture.state.shellConnections, streams);
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type('/model');
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+c');
        const input = (id) =>
          fixture.state.shellFrames
            ?.filter((f) => f.paneId === id && f.type === 'terminal.input')
            .map((f) => f.data)
            .join('') || '';
        await expect.poll(() => input('pane-codex')).toContain('/model\r\x1b[B\x1b\x03');
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: fixture.url,
        });
        await page.evaluate(() => navigator.clipboard.writeText('中文终端输入'));
        await page.keyboard.press('Control+Shift+v');
        await expect.poll(() => input('pane-codex')).toContain('中文终端输入');
        const writeClipboardImage = () =>
          page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 2;
            canvas.height = 2;
            canvas.getContext('2d').fillRect(0, 0, 2, 2);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          });
        await writeClipboardImage();
        const clipboardHash = await page.evaluate(async () => {
          const image = (await navigator.clipboard.read())[0],
            blob = await image.getType('image/png');
          return [
            ...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
          ]
            .map((n) => n.toString(16).padStart(2, '0'))
            .join('');
        });
        const uploads = () =>
          fixture.state.requests.filter((r) => r.route === 'POST /api/attachments');
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.press('Control+v');
        await expect.poll(() => uploads().length).toBe(1);
        const imageUpload = uploads()[0];
        assert.equal(imageUpload.sha256, clipboardHash);
        assert.equal(imageUpload.terminalId, fixture.state.sessions['pane-codex'].pane.terminalId);
        assert.equal(
          imageUpload.sessionId,
          fixture.state.sessions['pane-codex'].pane.agent.session.value,
        );
        assert.equal(imageUpload.runtimeId, 'fixture-runtime');
        await expect.poll(() => input('pane-codex')).toContain(`\x1b[200~/fixture/uploads/`);
        await expect.poll(() => input('pane-codex')).toContain(`${imageUpload.name}\x1b[201~`);
        if (!viewport.touch) {
          const box = await terminal.locator('.xterm-screen').boundingBox();
          await page.keyboard.down('Shift');
          await page.mouse.move(box.x + 1, box.y + 5);
          await page.mouse.down();
          await page.mouse.move(box.x + 90, box.y + 5);
          await page.mouse.up();
          await page.keyboard.up('Shift');
          await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toMatch(/OpenAI|Codex/);
          await page.evaluate(() => navigator.clipboard.writeText('SHIFT_RIGHT_PASTE'));
          await page.keyboard.down('Shift');
          await page.mouse.click(box.x + 100, box.y + 30, { button: 'right' });
          await page.keyboard.up('Shift');
          await expect.poll(() => input('pane-codex')).toContain('SHIFT_RIGHT_PASTE');
          await expect(page.locator('.context-menu')).toHaveCount(0);
          await writeClipboardImage();
          await page.keyboard.down('Shift');
          await page.mouse.click(box.x + 100, box.y + 30, { button: 'right' });
          await page.keyboard.up('Shift');
          await expect.poll(() => uploads().length).toBe(2);
          assert.equal(uploads()[1].sha256, clipboardHash);
        }
        await page.evaluate(() => navigator.clipboard.writeText('CTRL_V_TEXT'));
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.press('Control+v');
        await expect.poll(() => input('pane-codex')).toContain('CTRL_V_TEXT');
        assert(!input('pane-codex').includes('\x16'));
        await terminal
          .locator('.xterm-screen')
          .dispatchEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        await expect
          .poll(() =>
            fixture.state.shellFrames.some(
              (f) => f.type === 'terminal.scroll' && f.direction === 'up',
            ),
          )
          .toBe(true);
        const wheel = fixture.state.shellFrames.findLast((f) => f.type === 'terminal.scroll');
        assert(Number.isInteger(wheel.column) && Number.isInteger(wheel.row));
        if (!viewport.touch) {
          await context.route('https://example.com/**', (route) =>
            route.fulfill({ body: 'link fixture' }),
          );
          const link = terminal
            .locator('.xterm-rows span')
            .filter({ hasText: 'https://example.com' })
            .last();
          const rect = await link.evaluate((el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const index = walker.currentNode.textContent.indexOf('https://example.com');
              if (index < 0) continue;
              const range = document.createRange();
              range.setStart(walker.currentNode, index);
              range.setEnd(walker.currentNode, index + 19);
              return range.getBoundingClientRect().toJSON();
            }
            throw new Error('Rendered URL text was not found');
          });
          // Runs can include trailing spaces. Click actual URL glyphs, not the run.
          await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.waitForTimeout(150);
          const opened = context.waitForEvent('page');
          await page.keyboard.down('Control');
          await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.keyboard.up('Control');
          const popup = await opened;
          await popup.waitForURL('https://example.com/');
          await popup.close();
        }
        if (viewport.touch) {
          const start = fixture.state.shellFrames.length,
            screen = terminal.locator('.xterm-screen');
          assert((await touchDrag(screen, { dy: 120 })).every(Boolean));
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .slice(start)
                .some(
                  (f) =>
                    f.type === 'terminal.scroll' && f.source === 'touch' && f.direction === 'up',
                ),
            )
            .toBe(true);
          await touchDrag(screen, { dy: -120 });
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .slice(start)
                .some(
                  (f) =>
                    f.type === 'terminal.scroll' && f.source === 'touch' && f.direction === 'down',
                ),
            )
            .toBe(true);
          const count = fixture.state.shellFrames.length;
          await touchDrag(screen, { dy: 4 });
          await touchDrag(screen, { dy: 100, multi: true });
          assert.equal(fixture.state.shellFrames.length, count);
          const cancelled = fixture.state.shellFrames.length;
          await touchDrag(screen, { dy: 120, cancel: true });
          assert(
            fixture.state.shellFrames.slice(cancelled).filter((f) => f.source === 'touch').length <=
              1,
          );
          assert.equal(
            await screen.evaluate((el) => getComputedStyle(el).touchAction),
            'pinch-zoom',
          );
        }
        const full = await terminal.boundingBox();
        if (viewport.touch) {
          const count = fixture.state.shellFrames.length;
          assert(
            (await touchDrag(terminal.locator('.xterm-screen'), { dx: -100 })).every((v) => !v),
          );
          assert.equal(fixture.state.shellFrames.length, count);
        } else await page.locator('#chatFilesToggle').click();
        await expect(page.locator('#sessionFilesPage')).toBeVisible();
        await expect(page.locator('#sessionFilesPage')).toContainText('当前结果');
        if (!viewport.touch) {
          const narrow = await terminal.boundingBox();
          assert(narrow.width < full.width);
        }
        await page.screenshot({ path: path.join(output, viewport.name + '-files.png') });
        await page.getByRole('button', { name: /当前结果/ }).click();
        await expect(page.locator('.workspace-file-view:not([hidden])')).toBeVisible();
        await page.evaluate(() => window.StudioNavigation.back());
        await expect(page.locator('#sessionFilesList')).toBeVisible();
        if (viewport.touch) await page.evaluate(() => window.StudioNavigation.back());
        else await page.locator('#chatFilesToggle').click();
        await expect(terminal).toBeVisible();
        let releaseUpload;
        const uploaded = Promise.withResolvers();
        await context.route('**/api/attachments?*', async (route) => {
          uploaded.resolve();
          await new Promise((resolve) => (releaseUpload = resolve));
          await route.fulfill({
            json: { attachment: { name: 'late.png', path: '/fixture/uploads/late-image.png' } },
          });
        });
        await terminal.locator('.xterm-helper-textarea').evaluate((el) => {
          const data = new DataTransfer();
          data.items.add(new File([new Uint8Array([1, 2, 3])], 'late.png', { type: 'image/png' }));
          el.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        });
        await uploaded.promise;
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarRecent').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        releaseUpload();
        await page.waitForTimeout(80);
        assert(
          !input('pane-claude').includes('late-image') &&
            !input('pane-codex').includes('late-image'),
          'A pending image must not paste after switching Pane',
        );
        await context.unroute('**/api/attachments?*');

        await expect(terminal).toContainText('native terminal');
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type('CLAUDE_TARGET');
        await expect.poll(() => input('pane-claude')).toContain('CLAUDE_TARGET');
        assert(!input('pane-codex').includes('CLAUDE_TARGET'));
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatDeviceSettings').click();
        await expect(page.locator('#settingsPage')).toBeVisible();
        for (const name of ['外观', '连接', '根目录'])
          await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
        await page.locator('#settingsBack').click();
        await expect(terminal).toContainText('native terminal');
        const typed = fixture.state.shellFrames.filter((f) => f.type === 'terminal.input').length;
        await expect(terminal.locator('.shell-terminal-notice')).toHaveCount(0);
        fixture.disconnect(true);
        await page.waitForTimeout(350);
        await expect(terminal.locator('.shell-terminal-notice')).toHaveCount(0);
        fixture.disconnect(false);
        await expect(terminal.locator('.shell-terminal-canvas')).toHaveAttribute(
          'aria-busy',
          'false',
          { timeout: 10000 },
        );
        assert.equal(
          fixture.state.shellFrames.filter((f) => f.type === 'terminal.input').length,
          typed,
        );
        assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
        assert(!(fixture.state.observeFrames || []).includes('terminal-codex'));
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        fixture.state.history = [
          {
            provider: 'codex',
            sessionId: 'old-codex',
            title: '已关闭的会话',
            cwd: '/fixture/project',
            updatedAt: Date.now(),
          },
        ];
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarHistory').click();
        await page.locator('.history-item').click();
        await expect(terminal).toBeHidden();
        await expect(page.locator('#chatLog')).toContainText('归档里的回答');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarRecent').click();
        await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
        await expect(terminal).toContainText('native terminal');
        if (viewport.name === 'desktop') {
          await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
          await expect(terminal).toContainText('native terminal');
          await terminal.locator('.xterm-helper-textarea').focus();
          await page.keyboard.type('TAB_A');
          await expect.poll(() => input('pane-codex')).toContain('TAB_A');
          assert(!input('pane-claude').includes('TAB_A'));
          await page.locator('#chatModeToggle').click();
          await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
          await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
          await expect(terminal).toBeVisible();
          await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
          await expect(page.locator('#chatLog')).toBeVisible();
          await page.locator('#chatModeToggle').click();
          await expect(terminal).toContainText('native terminal');
          await expect(page.locator('.herdr-pane-frame, .herdr-sibling-pane')).toHaveCount(0);
          await page.screenshot({ path: path.join(output, 'desktop-tabs.png') });
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          nativeInput: true,
          uiChineseFontFallback: true,
          touchScroll: viewport.touch,
          desktopLink: !viewport.touch,
          mouseScroll: true,
          clipboard: true,
          clipboardImageBytes: true,
          imageTargetBound: true,
          pendingImageCancelledOnSwitch: true,
          copyOnSelect: !viewport.touch,
          shiftRightPaste: !viewport.touch,
          sidebars: true,
          settings: true,
          exactTargets: true,
          reconnectWithoutReplay: true,
          independentTabs: viewport.name === 'desktop',
        });
        console.log('PASS agent terminal preview', viewport.name);
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
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

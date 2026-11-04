#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
(async () => {
  const output = path.resolve('artifacts/shell-terminal');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
        });
      try {
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        fixture.state.sessions['pane-shell'] = {
          pane: {
            ...fixture.state.sessions['pane-codex'].pane,
            paneId: 'pane-shell',
            terminalId: 'terminal-shell',
            tabId: 'tab-shell',
            title: 'Shell',
            agent: null,
          },
          messages: [],
          queue: [],
        };
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('PRESERVED_AGENT_DRAFT');
        async function select(id) {
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator('#sidebarWorkspaces').click();
          await page.locator(`#chatPickerList [data-pane-id="${id}"]`).click();
        }
        await select('pane-shell');
        const terminal = page.locator('#shellTerminal');
        await expect(terminal).toContainText('SHELL_FIXTURE_READY');
        assert(
          await terminal
            .locator('.xterm-viewport, .xterm-scrollable-element')
            .evaluateAll((elements) =>
              elements.every((element) => getComputedStyle(element).scrollbarWidth === 'none'),
            ),
          'Native terminal scrollbars stay hidden',
        );
        assert(
          await terminal
            .locator('.xterm-scrollable-element > .scrollbar')
            .evaluateAll((elements) =>
              elements.every((element) => getComputedStyle(element).display === 'none'),
            ),
          'The xterm scrollbar and its arrows stay hidden',
        );
        await expect(page.locator('#chatLog')).toBeHidden();
        await expect(page.locator('#chatInput')).toBeHidden();
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type('echo hello');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+c');
        await expect
          .poll(() =>
            fixture.state.shellFrames
              ?.filter((frame) => frame.type === 'terminal.input')
              .map((frame) => frame.data)
              .join(''),
          )
          .toContain('echo hello\r\x03');
        // Firefox has no Playwright clipboard permission grant; use an isolated fixture.
        await page.evaluate(() =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText: async () => '中文粘贴' },
          }),
        );
        await page.keyboard.press('Control+Shift+v');
        await expect
          .poll(() =>
            fixture.state.shellFrames
              .filter((frame) => frame.type === 'terminal.input')
              .map((frame) => frame.data)
              .join(''),
          )
          .toContain('中文粘贴');
        await terminal
          .locator('.xterm-screen')
          .dispatchEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        await expect
          .poll(() =>
            fixture.state.shellFrames?.some(
              (frame) => frame.type === 'terminal.scroll' && frame.direction === 'up',
            ),
          )
          .toBe(true);
        assert(fixture.state.shellFrames.every((frame) => frame.paneId === 'pane-shell'));
        assert(!fixture.state.observeFrames?.includes('terminal-shell'));
        const count = fixture.state.shellConnections;
        fixture.changed();
        await page.waitForTimeout(300);
        assert.equal(fixture.state.shellConnections, count);
        const geometry = await terminal.boundingBox();
        assert(geometry.width > viewport.width * (viewport.width > 760 ? 0.5 : 0.9));
        assert(geometry.height > viewport.height * 0.7);
        await page.screenshot({ path: path.join(output, `${viewport.name}.png`) });
        const inputs = fixture.state.shellFrames.filter(
          (frame) => frame.type === 'terminal.input',
        ).length;
        fixture.disconnect(true);
        await expect(terminal.locator('.shell-terminal-canvas')).toHaveAttribute(
          'aria-busy',
          'true',
        );
        await expect(terminal.locator('.shell-terminal-notice')).toHaveCount(0);
        fixture.disconnect(false);
        await expect(terminal.locator('.shell-terminal-canvas')).toHaveAttribute(
          'aria-busy',
          'false',
          { timeout: 10000 },
        );
        assert.equal(
          fixture.state.shellFrames.filter((frame) => frame.type === 'terminal.input').length,
          inputs,
        );
        await select('pane-codex');
        await expect(terminal).toBeHidden();
        await expect(page.locator('#commandInput')).toHaveValue('PRESERVED_AGENT_DRAFT');
        await select('pane-shell');
        await expect(terminal).toContainText('SHELL_FIXTURE_READY');
        fixture.state.sessions['pane-shell'].pane.agent = structuredClone(
          fixture.state.sessions['pane-codex'].pane.agent,
        );
        fixture.state.sessions['pane-shell'].messages = structuredClone(
          fixture.state.sessions['pane-codex'].messages,
        );
        fixture.changed();
        await expect(terminal).toBeHidden();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        fixture.state.sessions['pane-shell'].pane.agent = null;
        fixture.changed();
        await expect(terminal).toContainText('SHELL_FIXTURE_READY');
        if (viewport.name === 'desktop') {
          await select('pane-codex');
          await expect(page.locator('#commandInput')).toHaveValue('PRESERVED_AGENT_DRAFT');
          await select('pane-shell');
          await terminal.locator('.xterm-helper-textarea').focus();
          await page.keyboard.type('TAB_SHELL');
          await expect
            .poll(() =>
              fixture.state.shellFrames
                .filter((frame) => frame.type === 'terminal.input')
                .map((frame) => frame.data)
                .join(''),
            )
            .toContain('TAB_SHELL');
          assert(
            fixture.state.shellFrames
              .filter((frame) => frame.type === 'terminal.input')
              .every((frame) => frame.paneId === 'pane-shell'),
          );
          await expect(page.locator('.herdr-pane-frame')).toHaveCount(0);
          await page.screenshot({ path: path.join(output, 'desktop-tabs.png') });
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport: viewport.name,
          geometry,
          targetBound: true,
          input: true,
          scroll: true,
          reconnectWithoutReplay: true,
          draftPreserved: true,
          lifecycle: true,
        });
        console.log('PASS Shell', viewport.name);
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

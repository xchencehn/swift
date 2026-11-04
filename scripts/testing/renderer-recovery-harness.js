'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const root = path.resolve(__dirname, '../..'),
  output = path.join(root, 'artifacts/renderer-recovery');
async function geometry(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      ['.chat-input', '#chatLog', '#chatSidebar'].map((selector) => [
        selector,
        document.querySelector(selector).getBoundingClientRect().toJSON(),
      ]),
    ),
  );
}
async function run() {
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch({ headless: true });
  const results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,

        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${fixture.url}/?token=fixture&view=chat`);
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const chat = await geometry(page);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: path.join(output, `${viewport.name}-chat.png`),
        });

        assert.deepEqual(await page.evaluate(() => StudioRenderers.listed()), [
          'claude',
          'codex',
          'devin',
          'gjc',
          'omo',
          'omp',
          'opencode',
          'pi',
        ]);
        await page.evaluate(() => {
          const box = document.createElement('section');
          box.id = 'worker-probe';
          document.body.append(box);
          StudioCodeView.render(box, 'const value = 42;\nconsole.log(value);', 'a.js');
        });
        await expect(page.locator('#worker-probe .code-view')).toHaveClass(/hljs/);
        await expect(page.locator('#worker-probe .hljs-keyword')).toContainText('const');
        await page.locator('#worker-probe').evaluate((el) => el.remove());

        await page.evaluate(() => {
          window.restoreRenderer = StudioRenderers.for('codex').renderer.renderMessage;
          StudioRenderers.for('codex').renderer.renderMessage = () => {
            throw new Error('intentional renderer fault');
          };
        });
        const message = fixture.state.sessions['pane-codex'].messages.at(-1);
        message.blocks[0].text += '\nRENDER_FALLBACK_PROBE';
        fixture.changed();
        const bubble = page.locator(`[data-message-id="${message.id}"][data-content="text"]`);
        await expect(bubble).toContainText('RENDER_FALLBACK_PROBE');
        await expect(bubble.getByRole('button', { name: '重新显示' })).toBeVisible();
        await page.evaluate(() => {
          StudioRenderers.for('codex').renderer.renderMessage = window.restoreRenderer;
        });
        await bubble.getByRole('button', { name: '重新显示' }).click();
        await expect(bubble.getByRole('button', { name: '重新显示' })).toHaveCount(0);
        const pi = structuredClone(fixture.state.sessions['pane-codex']);
        pi.pane.paneId = 'pane-pi';
        pi.pane.terminalId = 'term-pi';
        pi.pane.agent.label = 'pi';
        pi.pane.agent.session = { kind: 'path', value: '/fixture/.pi/agent/sessions/pi.jsonl' };
        pi.messages = [
          {
            id: 'pi-user',
            role: 'user',
            ts: '2026-10-10',
            harness: 'pi',
            blocks: [{ kind: 'text', text: 'PI_READ_ONLY_PROBE' }],
          },
        ];
        fixture.state.sessions['pane-pi'] = pi;
        fixture.state.focusedPaneId = 'pane-pi';
        await page.goto(`${fixture.url}/?token=fixture&pane=pane-pi`);
        await expect(page.locator('#chatLog')).toContainText('PI_READ_ONLY_PROBE');
        await expect(page.locator('#commandInput')).toBeDisabled();
        await expect(page.locator('#sendButton')).toBeDisabled();
        assert.equal(errors.length, 0, JSON.stringify(errors));
        assert.deepEqual(fixture.state.unexpected, []);

        results.push({ viewport: viewport.name, chat, errors });
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
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  console.log(
    `Passed ${results.length} viewport captures, worker rendering, provider isolation and renderer recovery.`,
  );
}
run().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

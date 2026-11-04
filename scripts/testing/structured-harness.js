#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..'),
  output = path.join(root, 'artifacts/structured');
(async () => {
  const before = sourceFingerprint(root),
    results = [];
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch();
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
      try {
        const page = await context.newPage(),
          errors = [],
          resources = [],
          interactiveSockets = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
          if (
            /vendor\/xterm|terminal\/client|notifications\.js|\/machines\.js/.test(
              new URL(request.url()).pathname,
            )
          )
            resources.push(request.url());
        });
        page.on('websocket', (socket) => {
          if (new URL(socket.url()).searchParams.get('observe') !== '1')
            interactiveSockets.push(socket.url());
        });
        await page.goto(`${fixture.url}/?token=fixture&view=chat&mode=terminal`);
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatTerminalView,#terminalKeys,.xterm')).toHaveCount(0);
        assert(
          await page.evaluate(
            () => typeof StudioTerminal === 'undefined' && typeof Terminal === 'undefined',
          ),
        );
        await page.locator('#commandInput').fill('STRUCTURED_ONLY_DRAFT');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatDeviceSettings').click();
        await expect(page.locator('#settingsPage')).toBeVisible();
        await page.locator('#settingsAppearanceTab').click();
        await expect(page.locator('#settingsAppearance')).toBeVisible();
        await expect(page.locator('#settingsAppearance .device-settings-section h3')).toHaveText([
          '主题',
        ]);
        await page.screenshot({ path: path.join(output, `${viewport.name}-settings.png`) });
        await page.locator('#settingsBack').click();
        if (await page.locator('#settingsPage').isVisible())
          await page.locator('#settingsBack').click();
        await expect(page.locator('#commandInput')).toHaveValue('STRUCTURED_ONLY_DRAFT');
        if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
        if (viewport.touch)
          await page.locator('#sidebarWorkspaces').dispatchEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 40,
          });
        else await page.locator('#sidebarWorkspaces').click({ button: 'right' });
        await page.getByRole('menuitem', { name: '新建 Space', exact: true }).click();
        await expect(page.locator('dialog[open]')).toBeVisible();
        await page
          .locator('dialog[open]')
          .getByRole('button', { name: '取消', exact: true })
          .click();
        assert(
          !fixture.state.herdrCalls?.length,
          'cancelling workspace creation must not mutate Herdr',
        );
        if (viewport.width <= 760)
          await page
            .locator('#chatPickerScrim')
            .click({ position: { x: viewport.width - 8, y: 100 } });
        await page.locator('#commandInput').press('Control+b');
        await expect(page.locator('#chatLog')).toBeVisible();
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('STRUCTURED_ONLY_DRAFT');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          0,
        );
        assert(!fixture.state.frames.some((frame) => /terminal\.(input|resize)/.test(frame)));
        assert(
          !fixture.state.requests.some((request) =>
            /\/api\/(notifications|herdr\/runtime)/.test(request.route),
          ),
        );
        assert.deepEqual(resources, []);
        assert.deepEqual(interactiveSockets, []);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, `${viewport.name}-chat.png`) });
        results.push({
          viewport: viewport.name,
          structuredOnly: true,
          noTerminalResources: true,
          noInteractiveSocket: true,
          settingsOpened: true,
          workspaceCreationAvailable: true,
          draftPreserved: true,
          errors,
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(root);
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, results }, null, 2));
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

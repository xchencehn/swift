'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test'),
  { createFixture } = require('./chat-harness');
(async () => {
  const out = path.resolve('artifacts/settings-save');
  fs.mkdirSync(out, { recursive: true });
  const browser = await firefox.launch({ headless: true });
  const results = [];
  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      const fixture = await createFixture(),
        context = await browser.newContext({
          viewport,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => {
          if (localStorage.getItem('seededPreferences')) return;
          localStorage.setItem('seededPreferences', '1');
          localStorage.setItem('agentStudioDevice', 'preferences-fixture');
          const seen = JSON.stringify(
            Object.fromEntries(
              Array.from({ length: 400 }, (_, i) => [
                `completion:["terminal-${i}","codex","00000000-0000-0000-0000-${String(i).padStart(12, '0')}","scope"]:123`,
                1700000000000 + i,
              ]),
            ),
          );
          localStorage.setItem(
            'studioPendingSettings::preferences-fixture',
            JSON.stringify([
              {
                root: '/fixture/workdir',
                settings: { fontSize: 17, ui: { studioSeenDone: seen } },
              },
            ]),
          );
        });
        await page.route('**/api/settings', (route) => {
          const settings = route.request().postDataJSON().settings;
          try {
            require('../../lib/root-preferences').mergeSettings({}, settings);
            return route.continue();
          } catch (error) {
            return route.fulfill({
              status: error.status,
              contentType: 'application/json',
              body: JSON.stringify({ ok: false, code: error.code, message: error.message }),
            });
          }
        });
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                Object.keys(localStorage).filter((k) => k.startsWith('studioPendingSettings:'))
                  .length,
            ),
          )
          .toBe(0);
        await expect(page.locator('#chatComposerError')).toBeHidden();
        assert.equal(await page.evaluate(() => StudioDeviceFont.current()), 17);
        await page.unroute('**/api/settings');
        let failures = 0,
          requests = 0;
        await page.route('**/api/settings', (route) => {
          requests++;
          if (failures++ === 0) return route.abort('timedout');
          return route.continue();
        });
        await page.evaluate(() => StudioDeviceFont.apply(18));
        const error = page.locator('#chatComposerError');
        await expect(error).toContainText('已保存在本机');
        const geometry = await page.evaluate(() => {
          const a = document.querySelector('#chatComposerError').getBoundingClientRect(),
            b = document.querySelector('.chat-status-hint-row').getBoundingClientRect();
          return { left: a.left, inputLeft: b.left, right: a.right, inputRight: b.right };
        });
        assert(Math.abs(geometry.left - geometry.inputLeft) < 1);
        assert(Math.abs(geometry.right - geometry.inputRight) < 1);
        await page.screenshot({ path: path.join(out, `${viewport.width}-pending.png`) });
        await expect(error).toBeHidden();
        await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
        assert.equal(
          await page.evaluate(
            () =>
              Object.keys(localStorage).filter((k) => k.startsWith('studioPendingSettings:'))
                .length,
          ),
          0,
        );
        await page.reload();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        assert.equal(await page.evaluate(() => StudioDeviceFont.current()), 18);
        // A reload while another root is selected must retain, then resume only
        // the restored root's own pending preferences when that root is reopened.
        const originalRoot = fixture.state.rootDirectory || '/fixture/workdir';
        await page.unroute('**/api/settings');
        await page.route('**/api/settings', (route) => route.abort('timedout'));
        await page.evaluate(() => StudioDeviceFont.apply(19));
        await expect(page.locator('#chatComposerError')).toContainText('已保存在本机');
        const switchRoot = async (root) =>
          page.evaluate(async (root) => {
            const response = await fetch('/api/config', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-agent-studio-device-id': localStorage.getItem('agentStudioDevice'),
                'x-agent-studio-token': 'fixture',
              },
              body: JSON.stringify({ rootDirectory: root }),
            });
            if (!response.ok) throw Error('Fixture rejected root change');
          }, root);
        await switchRoot('/fixture/recovery-other');
        await page.reload();
        await expect.poll(() => page.evaluate(() => StudioDeviceFont.current())).toBe(14);
        await page.unroute('**/api/settings');
        await switchRoot(originalRoot);
        await expect.poll(() => page.evaluate(() => StudioDeviceFont.current())).toBe(19);
        await expect
          .poll(() =>
            page.evaluate(
              (root) =>
                Object.keys(localStorage)
                  .filter((key) => key.startsWith('studioPendingSettings:'))
                  .flatMap((key) => JSON.parse(localStorage.getItem(key) || '[]'))
                  .filter((row) => row.root === root).length,
              originalRoot,
            ),
          )
          .toBe(0);
        results.push({ viewport, geometry, recovered: true, rootRecovery: true, requests });
        console.log('PASS settings recovery and alignment', viewport.width);
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ ok: true, results }, null, 2) + '\n',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

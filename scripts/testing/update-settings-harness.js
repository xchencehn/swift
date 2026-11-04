'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { startClient } = require('./desktop-harness');
async function main() {
  const output = path.resolve(
    process.env.SWIFT_UPDATE_SETTINGS_OUTPUT || 'artifacts/tasks/209-update-settings/browser',
  );
  fs.mkdirSync(output, { recursive: true });
  const browser = await firefox.launch(),
    report = [];
  try {
    for (const width of [1440, 1024, 390, 320]) {
      const fixtures = [await createFixture(), await createFixture()];
      fixtures[0].state.serverVersion = '0.19.0';
      fixtures[1].state.serverVersion = '0.18.0';
      for (const fixture of fixtures)
        fixture.state.serverUpdate = {
          currentVersion: fixture.state.serverVersion,
          version: '0.20.0',
          available: true,
          downloadUrl: 'https://150.158.39.216:8002/desktop/swift-0.20.0-server.tar.gz',
          sha256: 'a'.repeat(64),
        };
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-update-settings-'));
      const client = await startClient(directory),
        context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width < 1440,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
        });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(client.bootstrap);
        const paths = await page.evaluate(
          async (urls) => {
            const result = [];
            for (const [index, address] of urls.entries())
              result.push(
                await StudioDesktopConnections.api('connect', {
                  mode: 'local',
                  address,
                  name: `服务器 ${index + 1}`,
                }),
              );
            return result.map((value) => value.path);
          },
          fixtures.map((fixture) => fixture.url),
        );
        await page.goto(client.origin + paths[0]);
        await expect(page.locator('#chatLog')).not.toBeEmpty();
        await page.locator('#commandInput').fill('更新设置保留草稿');
        if (!(await page.locator('#chatDeviceSettings').isVisible()))
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatDeviceSettings').click();
        await page.screenshot({ path: path.join(output, `${width}-global.png`) });
        await page.locator('#settingsUpdateTab').click();
        await expect(page.locator('.client-update-version')).toContainText(
          require('../../package.json').version,
        );
        let checks = 0,
          installs = 0;
        await page.route('**/desktop/update/check', (route) => {
          checks++;
          return route.fulfill({
            status: checks === 1 ? 502 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
              checks === 1
                ? { message: '无法获取更新，请重试。' }
                : { available: true, version: '0.20.0' },
            ),
          });
        });
        await page.route('**/desktop/update/install', (route) => {
          installs++;
          return route.fulfill({ json: { ok: true } });
        });
        await page.locator('.check-client-update').click();
        await expect(page.locator('#settingsUpdate [role=status]')).toContainText('请重试');
        await page.locator('.check-client-update').click();
        await expect(page.locator('.install-client-update')).toBeVisible();
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('.install-client-update').click();
        await expect.poll(() => installs).toBe(1);
        await page.screenshot({ path: path.join(output, `${width}-client.png`) });
        await page.locator('#settingsBack').click();
        await page.locator('#settingsConnectionTab').click();
        assert.equal(await page.locator('#settingsConnection .check-client-update').count(), 0);
        for (const index of [0, 1]) {
          await page
            .getByRole('button', { name: `管理服务器：服务器 ${index + 1}`, exact: true })
            .click();
          await page.getByRole('menuitem', { name: '编辑服务器', exact: true }).click();
          await expect(page.locator('.server-update-version')).toContainText(
            fixtures[index].state.serverVersion,
          );
          const previous = fixtures[1 - index].state.requests.filter(
            (value) => value.route === 'GET /api/server-update',
          ).length;
          await page.locator('.server-update-settings button').click();
          await expect(page.locator('.server-update-settings [role=status]')).toContainText(
            '0.20.0',
          );
          await expect(page.locator('.server-update-settings a')).toHaveAttribute(
            'href',
            fixtures[index].state.serverUpdate.downloadUrl,
          );
          assert.equal(
            fixtures[1 - index].state.requests.filter(
              (value) => value.route === 'GET /api/server-update',
            ).length,
            previous,
          );
          await page.screenshot({ path: path.join(output, `${width}-server-${index + 1}.png`) });
          await page.locator('#cancelAddServer').click();
          assert.equal(new URL(page.url()).pathname, paths[0]);
        }
        let resolveDelayed;
        await page.route(
          '**/api/server-update',
          (route) =>
            new Promise((resolve) => {
              resolveDelayed = async () => {
                await route
                  .fulfill({ json: { currentVersion: 'old', version: 'old', available: false } })
                  .catch(() => {});
                resolve();
              };
            }),
        );
        await page.getByRole('button', { name: '管理服务器：服务器 1', exact: true }).click();
        await page.getByRole('menuitem', { name: '编辑服务器', exact: true }).click();
        await page.locator('.server-update-settings button').click();
        await expect.poll(() => Boolean(resolveDelayed)).toBe(true);
        await page.locator('#cancelAddServer').click();
        await page.getByRole('button', { name: '管理服务器：服务器 2', exact: true }).click();
        await page.getByRole('menuitem', { name: '编辑服务器', exact: true }).click();
        await resolveDelayed();
        await expect(page.locator('.server-update-version')).toContainText('0.18.0');
        await expect(page.locator('.server-update-settings [role=status]')).toBeEmpty();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        assert.equal(overflow, 0);
        await page.locator('#cancelAddServer').click();
        await page.locator('#settingsBack').click();
        await page.locator('#settingsBack').click();
        await expect(page.locator('#commandInput')).toHaveValue('更新设置保留草稿');
        assert.deepEqual(errors, []);
        assert(
          !fixtures.some((fixture) =>
            fixture.state.requests.some((value) => value.route === 'POST /api/messages'),
          ),
        );
        report.push({
          width,
          clientGlobal: true,
          serverIsolation: true,
          delayedResponseIgnored: true,
          retry: true,
          installRequestedOnce: installs === 1,
          draftPreserved: true,
          overflow,
          errors,
        });
      } finally {
        await context.close();
        client.close();
        for (const fixture of fixtures) await fixture.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

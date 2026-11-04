'use strict';
// Server selection uses a real Rust gateway and synthetic servers, never user profiles.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { firefox, expect } = require('@playwright/test');
const { startClient } = require('./desktop-harness');
const { createTokenFixture } = require('./fixtures/token-server');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(
  process.env.SWIFT_DESKTOP_START_OUTPUT || 'artifacts/testing/desktop-start',
);
async function stop(client) {
  const done =
    client.child.exitCode === null && client.child.signalCode === null
      ? once(client.child, 'exit')
      : null;
  client.close();
  if (done) await done;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [],
    before = sourceFingerprint(root);
  try {
    for (const width of [1440, 1918, 768, 390, 320]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-start-'));
      const manyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-start-many-'));
      const fixture = await createTokenFixture();
      const client = await startClient(directory),
        context = await browser.newContext({
          viewport: { width, height: width === 1918 ? 922 : 900 },
          hasTouch: width < 1000,
          serviceWorkers: 'block',
        });
      const page = await context.newPage(),
        errors = [];
      let manyClient,
        manyContext,
        fixtureClosed = false;
      page.on('pageerror', (error) => errors.push(error.message));
      const metadata = () => JSON.parse(fs.readFileSync(path.join(directory, 'connections.json')));
      const shot = (name) =>
        page.screenshot({ path: path.join(output, `${width}-${name}.png`), fullPage: true });
      try {
        await page.goto(client.bootstrap);
        await expect(page.locator('#serverEmpty')).toBeVisible();
        await shot('empty');
        await page.getByRole('button', { name: '添加服务器', exact: true }).click();
        await expect(page.locator('#address')).toBeFocused();
        await page.locator('#address').fill(fixture.url + '/?token=wrong-fixture');
        await page.locator('#name').fill('研发工作站');
        await page.locator('#connectButton').click();
        await expect(page.locator('#status')).toContainText('Token');
        await expect(page.locator('#name')).toHaveValue('研发工作站');
        await shot('add-error');
        await page.locator('#address').fill(fixture.url + '/?token=fixture-direct-token');
        await page.locator('#connectButton').click();
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        const first = metadata().profiles[0];
        await page.evaluate(async (address) => {
          await StudioDesktopConnections.api('connect', {
            mode: 'local',
            address,
            token: '',
            name: '本机 WSL',
          });
        }, fixture.fixture.url);
        await page.goto(client.origin + '/connect');
        await expect(page.locator('#continueName')).toHaveText('研发工作站');
        await expect(page.locator('.server-row-open')).toHaveCount(1);
        await shot('home');
        await page.getByRole('button', { name: '管理服务器：研发工作站', exact: true }).click();
        await expect(
          page.getByRole('menuitem', { name: '在新窗口打开', exact: true }),
        ).toBeFocused();
        await shot('menu');
        await page.keyboard.press('Escape');
        await expect(
          page.getByRole('button', { name: '管理服务器：研发工作站', exact: true }),
        ).toBeFocused();
        await page.getByRole('button', { name: '管理服务器：研发工作站', exact: true }).click();
        const activeBefore = metadata().active;
        const popupPromise = page.waitForEvent('popup');
        await page.getByRole('menuitem', { name: '在新窗口打开', exact: true }).click();
        const popup = await popupPromise;
        await expect(popup).toHaveURL(new RegExp(`/e/${first.id}/`));
        await popup.close();
        assert.equal(
          metadata().active,
          activeBefore,
          'Opening a window must not change another window’s selection.',
        );
        await page.getByRole('button', { name: '管理服务器：研发工作站', exact: true }).click();
        await page.getByRole('menuitem', { name: '编辑服务器', exact: true }).click();
        await expect(page.locator('#editServerRoot')).toHaveValue('/fixture/workdir');
        await shot('edit');
        await page.locator('#name').fill('研发工作站 · 已重命名');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('#continueName')).toHaveText('研发工作站 · 已重命名');
        assert.equal(
          metadata().profiles.find((profile) => profile.name.includes('已重命名')).id,
          first.id,
        );
        await expect(page.locator('#address')).toHaveValue('');
        await page.locator('#connectionBack').click();
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await page.locator('#commandInput').fill('不要发送：连接修复后应保留这条草稿');
        fixture.rotateToken('rotated-fixture-token');
        await page.reload();
        await expect(page).toHaveURL(/\/connect\?auth=1/);
        await expect(page.locator('#addServerTitle')).toHaveText('更新连接链接');
        await expect(page.locator('#name')).toHaveValue('研发工作站 · 已重命名');
        await page.locator('#address').fill(fixture.url + '/?token=rotated-fixture-token');
        await page.getByRole('button', { name: '保存并重试', exact: true }).click();
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await expect(page.locator('#commandInput')).toHaveValue(
          '不要发送：连接修复后应保留这条草稿',
        );
        assert.equal(metadata().profiles.length, 2);
        assert.equal(
          metadata().profiles.find((profile) => profile.name.includes('已重命名')).id,
          first.id,
        );
        assert(!JSON.stringify(metadata()).includes('fixture-token'));
        await page.route('**/api/config', (route) =>
          route.fulfill({ status: 503, json: { message: '临时不可用' } }),
        );
        await page.evaluate((id) => fetch(`/e/${id}/api/config`), first.id);
        assert(
          new URL(page.url()).pathname.startsWith('/e/'),
          'Later failures must keep the running view in place.',
        );
        await page.unroute('**/api/config');
        // Many saved entries are synthetic metadata for the same isolated local fixture.
        const profiles = Array.from({ length: 25 }, (_, index) => ({
          id: (index + 1).toString(16).padStart(64, '0'),
          name: index === 0 ? '本机 WSL' : index === 1 ? '待移除服务器' : `演示服务器 ${index + 1}`,
          mode: 'direct',
          address: fixture.fixture.url + '/',
          remote_base: '',
        }));
        fs.writeFileSync(
          path.join(manyDirectory, 'connections.json'),
          JSON.stringify({ profiles, active: profiles[0].id }),
        );
        manyClient = await startClient(manyDirectory);
        manyContext = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width < 1000,
          serviceWorkers: 'block',
        });
        const many = await manyContext.newPage();
        await many.goto(manyClient.bootstrap);
        await expect(many).toHaveURL(new RegExp(`/e/${profiles[0].id}/`));
        await many.goto(manyClient.origin + '/connect');
        await expect(many.locator('.server-row-open')).toHaveCount(24);
        await many.screenshot({ path: path.join(output, `${width}-many.png`), fullPage: true });
        await many.locator('#serverSearch').fill('演示服务器 24');
        await expect(many.locator('.server-row-open')).toHaveCount(1);
        await many.locator('#serverSearch').fill('没有这样的服务器');
        await expect(many.locator('#serverNoResults')).toBeVisible();
        await many.getByRole('button', { name: '清除搜索', exact: true }).click();
        await expect(many.locator('#serverSearch')).toBeFocused();
        await many.getByRole('button', { name: '管理服务器：待移除服务器', exact: true }).click();
        await many.getByRole('menuitem', { name: '移除服务器', exact: true }).click();
        await expect(many.locator('#cancelRemoveServer')).toBeFocused();
        await many.screenshot({ path: path.join(output, `${width}-remove.png`), fullPage: true });
        await many.locator('#cancelRemoveServer').click();
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(manyDirectory, 'connections.json'))).profiles.length,
          25,
        );
        await many.getByRole('button', { name: '管理服务器：待移除服务器', exact: true }).click();
        await many.getByRole('menuitem', { name: '移除服务器', exact: true }).click();
        await many.locator('#confirmRemoveServer').click();
        await expect(
          many.getByRole('button', { name: '管理服务器：待移除服务器', exact: true }),
        ).toHaveCount(0);
        const remaining = JSON.parse(fs.readFileSync(path.join(manyDirectory, 'connections.json')));
        assert.equal(remaining.profiles.length, 24);
        assert.equal(remaining.active, profiles[0].id);
        for (const surface of [page, many])
          assert.equal(
            await surface.evaluate(() => document.documentElement.scrollWidth - innerWidth),
            0,
          );
        await manyContext.close();
        manyContext = null;
        await stop(manyClient);
        manyClient = null;
        await page.goto(client.origin + '/connect');
        await expect(page.locator('#continueName')).toBeVisible();
        await fixture.close();
        fixtureClosed = true;
        await page.goto(`${client.origin}/e/${first.id}/`);
        await expect(page).toHaveURL(new RegExp(`/connect\\?failed=${first.id}`));
        await expect(page.locator('#serverListStatus')).toContainText('无法连接');
        await expect(page.locator('#repairServer')).toBeVisible();
        await shot('restore-failed');
        assert.equal(
          await page.evaluate(() =>
            Object.values(localStorage).some((value) =>
              String(value).includes('rotated-fixture-token'),
            ),
          ),
          false,
        );
        assert.deepEqual(errors, []);
        results.push({
          width,
          ok: true,
          empty: true,
          directClick: true,
          menuAndFocus: true,
          independentWindow: true,
          editKeepsIdentity: true,
          repairKeepsDraftAndProfile: true,
          search25: true,
          removeConfirmed: true,
          automaticRestore: true,
          startupFailureSelectsServer: true,
          laterFailureKeepsView: true,
        });
      } finally {
        if (manyContext) await manyContext.close();
        if (manyClient) await stop(manyClient);
        await context.close();
        await stop(client);
        if (!fixtureClosed) await fixture.close();
        for (const dir of [directory, manyDirectory])
          fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  const report = { ok: true, before, after: sourceFingerprint(root), results };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { main };

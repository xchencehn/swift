'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { firefox, expect } = require('@playwright/test');
const { createTokenFixture } = require('./fixtures/token-server');
const root = path.resolve(__dirname, '../..');
async function startClient(directory, port = 0) {
  const child = spawn(
    path.join(root, 'desktop/target/debug/desktop-fixture'),
    [directory, String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (x) => (stderr += x));
  const ready = await new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(Error('Client startup timed out: ' + stderr)), 15000);
    child.stdout.on('data', (x) => {
      data += x;
      if (data.includes('\n')) {
        clearTimeout(timer);
        resolve(JSON.parse(data.split('\n')[0]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('Client failed ' + code + ': ' + stderr));
    });
  });
  return {
    ...ready,
    child,
    close() {
      child.kill('SIGINT');
    },
  };
}
async function main() {
  const output = path.resolve(
    process.env.SWIFT_DIRECT_OUTPUT || 'artifacts/testing/open-source-direct/browser',
  );
  fs.mkdirSync(output, { recursive: true });
  const browser = await firefox.launch(),
    results = [];
  try {
    for (const width of [1440, 768, 390, 320]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-direct-client-'));
      const fixture = await createTokenFixture();
      fixture.fixture.state.productionPresentation = true;
      const client = await startClient(directory),
        context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width < 1000,
          serviceWorkers: 'block',
        }),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(client.bootstrap);
        await page.getByRole('button', { name: '添加服务器', exact: true }).click();
        await expect(page.getByRole('radio', { name: '同一系统', exact: true })).toBeChecked();
        await page.getByRole('radio', { name: 'Windows / WSL', exact: true }).check();
        await expect(page.locator('#connectionHint')).toContainText('无需认证');
        await page.getByRole('radio', { name: '局域网', exact: true }).check();
        assert.equal(await page.getByText('Swift 账号', { exact: true }).count(), 0);
        await page.getByRole('radio', { name: '同一系统', exact: true }).check();
        await page.locator('#address').fill(fixture.fixture.url);
        await page.locator('#name').fill('本机测试机');
        await page.getByRole('button', { name: '添加并连接', exact: true }).click();
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await page.goto(client.origin + '/connect');
        await page.getByRole('button', { name: '添加服务器', exact: true }).click();
        await page.getByRole('radio', { name: '局域网', exact: true }).check();
        await page.locator('#address').fill(fixture.url + '/?token=wrong-fixture');
        await page.getByRole('button', { name: '添加并连接', exact: true }).click();
        await expect(page.locator('#status')).toContainText('Token');
        await page.locator('#address').fill(fixture.url + '/?token=fixture-direct-token');
        await page.locator('#name').fill('局域网测试机');
        await page.screenshot({ path: path.join(output, width + '-connect.png') });
        await page.getByRole('button', { name: '添加并连接', exact: true }).click();
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await expect(page.locator('#chatLog')).not.toBeEmpty();
        await page.locator('#commandInput').fill('直连连接保留草稿');
        const metadata = JSON.parse(
          fs.readFileSync(path.join(directory, 'connections.json'), 'utf8'),
        );
        const lan = metadata.profiles.find((p) => p.name === '局域网测试机');
        assert.equal(lan.address, fixture.url + '/');
        assert(!JSON.stringify(metadata).includes('fixture-direct-token'));
        assert(
          !(await page.evaluate(() =>
            Object.values(localStorage).some((x) => String(x).includes('fixture-direct-token')),
          )),
        );
        assert.equal(
          (
            await page.request.post(client.origin + '/desktop/activate', {
              headers: { origin: 'https://other.invalid' },
              data: { id: lan.id },
            })
          ).status(),
          403,
        );
        const selected = await page.evaluate(async (id) => {
          const r = await fetch('/desktop/activate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          return { status: r.status, body: await r.json() };
        }, lan.id);
        assert.equal(
          selected.status,
          200,
          'A saved LAN connection must restore its native credential',
        );
        await page.screenshot({ path: path.join(output, width + '-connected.png') });
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('直连连接保留草稿');
        fixture.state.token = 'revoked';
        await page.reload();
        await expect(page).toHaveURL(/\/connect\?auth=1/);
        await expect(page.locator('#status')).toContainText('连接凭据');
        assert(!fixture.fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
        assert.deepEqual(errors, []);
        results.push({
          width,
          ok: true,
          localNoToken: true,
          wslChoiceVerified: true,
          lanToken: true,
          rejectedAndRevoked: true,
          draftPreserved: true,
          secretInMetadata: false,
        });
      } finally {
        await context.close();
        const exited =
          client.child.exitCode === null && client.child.signalCode === null
            ? once(client.child, 'exit')
            : null;
        client.close();
        if (exited) await exited;
        await fixture.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
module.exports = { startClient, main };
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

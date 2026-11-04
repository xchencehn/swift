#!/usr/bin/env node
'use strict';
// Real IndexedDB and Service Worker, in isolated fixture browser contexts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const browserType = firefox;
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');

async function draftFailures(page, output, viewport) {
  const input = page.locator('#commandInput'),
    error = page.locator('#chatComposerError');
  await input.fill('原有草稿');
  const quota = await page.evaluate(() => {
    localStorage.setItem('studioDraftFixtureKeep', 'preserved');
    let count = 0;
    for (const size of [65536, 1024]) {
      try {
        for (; count < 10000; count++)
          localStorage.setItem('agentStudioBoot:quota-fixture:' + count, 'x'.repeat(size));
      } catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
      }
    }
    return count;
  });
  assert(quota > 0 && quota < 10000);
  const text = '存储空间回收后保留草稿'.repeat(200);
  await input.fill(text);
  await expect(error).toBeHidden();
  assert.equal(
    await page.evaluate(() => localStorage.getItem('agentStudioBoot:quota-fixture:0')),
    null,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('studioDraftFixtureKeep')),
    'preserved',
  );
  await page.reload();
  await expect(input).toHaveValue(text);
  await page.evaluate(() => {
    window.draftFixtureSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('agentStudioDrafts:'))
        throw new DOMException('fixture denied', 'SecurityError');
      return window.draftFixtureSetItem.call(this, key, value);
    };
  });
  await input.fill('暂时不能保存');
  await expect(error).toContainText('存储不可用');
  await input.press('End');
  await input.press('a');
  await expect(error).toContainText('存储不可用');
  await page.screenshot({ path: path.join(output, `${viewport}-draft-unavailable.png`) });
  await page.evaluate(() => {
    Storage.prototype.setItem = window.draftFixtureSetItem;
    delete window.draftFixtureSetItem;
  });
  await input.fill('恢复保存后的草稿');
  await expect(error).toBeHidden();
  await page.reload();
  await expect(input).toHaveValue('恢复保存后的草稿');
  await input.fill('');
  await page.reload();
  await expect(input).toHaveValue('');
  await expect(error).toBeHidden();
  return {
    actualQuotaRecovery: true,
    unrelatedStoragePreserved: true,
    persistentFailure: true,
    retryAndReload: true,
    emptyReload: true,
  };
}

async function transactionFailures(page) {
  return page.evaluate(async () => {
    const name = `recovery-${crypto.randomUUID()}`;
    let mode = '',
      mutate = null;
    const wrapped = {
      open(...args) {
        const request = indexedDB.open(...args);
        request.addEventListener('success', () => {
          const db = request.result,
            transaction = db.transaction.bind(db);
          db.transaction = (...args) => {
            const tx = transaction(...args);
            if (args[1] === 'readwrite') {
              if (mode === 'abort') queueMicrotask(() => tx.abort());
              if (mode === 'quota') {
                const objectStore = tx.objectStore.bind(tx);
                tx.objectStore = (name) => {
                  const store = objectStore(name);
                  store.put = () => {
                    throw new DOMException('Full fixture', 'QuotaExceededError');
                  };
                  return store;
                };
              }
              if (mutate) {
                const run = mutate;
                mutate = null;
                queueMicrotask(run);
              }
            }
            return tx;
          };
        });
        return request;
      },
    };
    const replica = StudioReplica.create({
      indexedDB: wrapped,
      databaseName: name,
      retryDelays: [],
    });
    await replica.load('/old');
    const record = (revision) => ({
      revision,
      messages: [{ id: revision, role: 'user', blocks: [] }],
    });
    replica.put('codex:s', record('v1'));
    mode = 'abort';
    if (await replica.flush()) throw Error('Aborted transaction was reported as saved');
    if (replica.persistence().state !== 'error' || replica.persistence().pending !== 1)
      throw Error('Aborted write discarded dirty versions');
    mode = '';
    await replica.retry();
    const reader = StudioReplica.create({ databaseName: name });
    await reader.load();
    if (reader.get('codex:s')?.revision !== 'v1')
      throw Error('Retry failed to persist original data');
    if (reader.rootDirectory() !== '/old') throw Error('Write without snapshot lost root binding');
    replica.put('codex:s', record('v2'));
    mutate = () => replica.put('codex:s', record('v3'));
    await replica.flush();
    if (replica.persistence().pending !== 1)
      throw Error('In-flight mutation was cleared by older commit');
    await replica.flush();
    const latest = StudioReplica.create({ databaseName: name });
    await latest.load();
    if (latest.get('codex:s')?.revision !== 'v3') throw Error('New mutation was not persisted');
    replica.drop('codex:s');
    await replica.load('/old');
    if (replica.get('codex:s')) throw Error('Reload resurrected an uncommitted deletion');
    await replica.flush();
    replica.put('codex:s', record('v4'));
    mode = 'quota';
    await replica.flush();
    if (replica.persistence().error !== 'QuotaExceededError' || !replica.persistence().pending)
      throw Error('Quota failure lost pending write');
    mode = '';
    await replica.retry();
    replica.put('codex:s', record('v5'));
    mutate = () => {
      replica.clear('/new');
      replica.put('claude:new', record('new'));
    };
    await replica.flush();
    await replica.flush();
    const switched = StudioReplica.create({ databaseName: name });
    await switched.load();
    if (switched.get('codex:s') || switched.get('claude:new')?.revision !== 'new')
      throw Error('Root reset during write mixed records');
    return { abortRetry: true, concurrentMutation: true, quotaRetry: true, rootIsolation: true };
  });
}

async function main() {
  const output = path.join(root, 'artifacts/five-defects/recovery');
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(root),
    results = [];
  const browser = await browserType.launch({ headless: true });
  try {
    for (const viewport of viewports.filter(
      (v) => !process.argv.includes('--desktop') || v.name === 'desktop',
    )) {
      const fixture = await createFixture();
      fixture.state.sync = true;
      const context = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
        serviceWorkers: 'allow',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${fixture.url}/?token=fixture&view=chat`);
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const persistence = await transactionFailures(page);
        const drafts = await draftFailures(page, output, viewport.name);
        await page.locator('#commandInput').fill('断网和重启后必须保留的草稿');
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        // Reload once with an active worker so every versioned script is cached.
        await page.reload();
        await expect(page.locator('#commandInput')).toHaveValue('断网和重启后必须保留的草稿');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.waitForTimeout(1200);
        const diagnostic = await page.evaluate(async () => {
          const r = StudioReplica.create();
          await r.load();
          return {
            keys: r.keys(),
            root: r.rootDirectory(),
            snapshot: r.snapshot(),
            assets: await Promise.all(
              (await caches.keys()).map(async (name) => ({
                name,
                keys: (await (await caches.open(name)).keys()).map(
                  (req) => new URL(req.url).pathname,
                ),
              })),
            ),
            boot: JSON.parse(localStorage.getItem('agentStudioBoot') || 'null'),
          };
        });
        await fs.writeFile(
          path.join(output, `${viewport.name}-cache.json`),
          JSON.stringify(diagnostic, null, 2),
        );
        await context.setOffline(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#commandInput')).toHaveValue('断网和重启后必须保留的草稿');
        await expect(page.locator('#commandInput')).toBeEnabled();
        await expect(page.locator('#sendButton')).toBeDisabled();
        assert.equal(await page.locator('#authDialog').evaluate((el) => el.open), false);
        await expect(page.locator('#appShell')).toHaveAttribute(
          'data-connection',
          /offline|connecting/,
        );
        await expect(page.locator('#connectionBanner')).toBeHidden();
        await page.screenshot({
          path: path.join(output, `${viewport.name}-offline.png`),
          fullPage: true,
        });
        fixture.state.sessions['pane-codex'].messages.push({
          id: 'reconnected',
          role: 'assistant',
          blocks: [{ kind: 'text', text: '重连后新增内容已追平' }],
        });
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(page.locator('#chatLog')).toContainText('重连后新增内容已追平');
        await expect(page.locator('#commandInput')).toHaveValue('断网和重启后必须保留的草稿');
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        assert(geometry.scrollWidth <= geometry.width, 'Horizontal overflow');
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: path.join(output, `${viewport.name}-recovered.png`),
          fullPage: true,
        });
        results.push({ viewport: viewport.name, persistence, drafts, geometry, ok: true });
        console.log(
          `PASS ${viewport.name}: transaction failures, offline restart, draft restoration, reconnect`,
        );
      } catch (error) {
        await page
          .screenshot({ path: path.join(output, `${viewport.name}-failure.png`), fullPage: true })
          .catch(() => {});
        const resources = await page
          .evaluate(() => ({
            scripts: [...document.scripts].map((s) => s.src),
            loaded: Boolean(window.StudioBoot),
            cached: Boolean(window.StudioReplica),
          }))
          .catch(() => null);
        results.push({ viewport: viewport.name, ok: false, error: error.stack, errors, resources });
        console.error(`FAIL ${viewport.name}: ${error.stack}`);
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
    JSON.stringify({ before, after: sourceFingerprint(root), results }, null, 2),
  );
  assert(
    results.every((result) => result.ok),
    'Recovery harness failed',
  );
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

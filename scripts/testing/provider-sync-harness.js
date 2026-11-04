#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const browserType = firefox;
const { createFixture, viewports } = require('./chat-harness');
const Providers = require('../../public/provider-capabilities');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
async function main() {
  const before = sourceFingerprint(root),
    results = [],
    output = path.join(root, 'artifacts/five-defects/providers');
  await fs.mkdir(output, { recursive: true });
  const browser = await browserType.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      fixture.state.sync = true;
      for (const provider of Providers.providers.filter(
        (id) => !['codex', 'claude'].includes(id),
      )) {
        const paneId = `pane-${provider}`;
        fixture.state.sessions[paneId] = {
          pane: {
            paneId,
            terminalId: `term-${provider}`,
            title: `${provider} fixture`,
            cwd: '/fixture/project',
            workspaceId: 'workspace-fixture',
            agent: {
              label: provider,
              id: provider,
              session: { value: `session-${provider}` },
              status: 'idle',
            },
          },
          messages: [
            {
              id: `${provider}-first`,
              role: 'assistant',
              blocks: [{ kind: 'text', text: `${provider} 的独立历史` }],
            },
          ],
          settings: { editable: false },
          queue: [],
        };
      }
      const context = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(`${fixture.url}/?token=fixture&view=chat`);
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await fixture.synced();
        await page.waitForTimeout(300);
        for (const provider of Providers.providers) {
          const paneId = `pane-${provider}`;
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator(`#chatPickerList [data-pane-id="${paneId}"]`).click();
          await expect(page.locator('#chatLog')).toContainText(
            provider === 'codex' || provider === 'claude'
              ? `${provider} 浏览器验收样例`
              : `${provider} 的独立历史`,
          );
          const baseline = fixture.state.requests.filter(
            (r) =>
              r.route === 'GET /api/transcript' &&
              r.query.pane === paneId &&
              r.query.window !== '0',
          ).length;
          const expected = `来自 ${provider} 的实时更新`;
          fixture.state.sessions[paneId].messages.push({
            id: `${provider}-pushed`,
            role: 'assistant',
            blocks: [{ kind: 'text', text: expected }],
          });
          fixture.changed();
          await fixture.synced();
          await expect(page.locator('#chatLog')).toContainText(expected);
          assert.equal(
            fixture.state.requests.filter(
              (r) =>
                r.route === 'GET /api/transcript' &&
                r.query.pane === paneId &&
                r.query.window !== '0',
            ).length,
            baseline,
          );
          if (!Providers.get(provider).send) {
            await expect(page.locator('#commandInput')).toBeDisabled();
            await expect(page.locator('#sendButton')).toBeDisabled();
          }
          results.push({
            viewport: viewport.name,
            provider,
            sync: true,
            readOnly: !Providers.get(provider).send,
            ok: true,
          });
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, `${viewport.name}.png`), fullPage: true });
        console.log(
          `PASS ${viewport.name}: all eight providers sync; six additional providers stay read-only`,
        );
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
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createTokenFixture } = require('./fixtures/token-server');
const { viewports } = require('./chat-harness'),
  { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const output = path.resolve(__dirname, '../../artifacts/token-connection/browser');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch({ headless: true }),
    results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createTokenFixture(),
        context = await browser.newContext({ viewport, hasTouch: viewport.touch });
      try {
        await context.addInitScript(() => {
          window.StudioApp = {
            authenticationRequired() {
              window.tokenRejected = true;
            },
          };
          localStorage.setItem('agentStudioToken', 'obsolete-fixture-token');
        });
        const page = await context.newPage();
        await page.goto(`${fixture.url}/?view=chat#token=fixture-direct-token`);
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        assert(!page.url().includes('token='));
        assert(fixture.state.documentQueries.every((query) => !query.includes('token=')));
        assert.equal(
          await page.evaluate(() => localStorage.getItem('agentStudioToken')),
          'fixture-direct-token',
        );
        await page.evaluate(async () => {
          const r = await fetch('/fixture/echo', {
            method: 'POST',
            headers: { 'x-agent-studio-token': localStorage.getItem('agentStudioToken') },
            body: 'token-upload-fixture',
          });
          if ((await r.text()) !== 'token-upload-fixture') throw Error('Upload failed');
        });
        await page.screenshot({ path: path.join(output, `${viewport.name}.png`) });
        fixture.state.token = 'revoked-fixture-token';
        await page.reload();
        await expect.poll(() => page.evaluate(() => window.tokenRejected === true)).toBe(true);
        assert(fixture.state.denied > 0);
        assert(fixture.state.authenticated > 0);
        results.push({
          viewport: viewport.name,
          fragmentLogin: true,
          oldTokenReplaced: true,
          httpWebSocket: true,
          upload: true,
          revokedReturnsToConnection: true,
        });
        console.log(
          `PASS ${viewport.name}: fragment login, HTTP/WebSocket/upload and rejected token`,
        );
      } finally {
        await context.close();
        await fixture.close();
      }
    }
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          source: sourceFingerprint(path.resolve(__dirname, '../..')),
          results,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

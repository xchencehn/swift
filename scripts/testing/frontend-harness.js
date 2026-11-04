#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');

async function main() {
  const output = path.resolve(__dirname, '../../artifacts/frontend');
  await fs.mkdir(output, { recursive: true });
  const browser = await firefox.launch({ headless: true });
  const results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(fixture.url + '/?token=fixture');
        await expect(page.locator('#appShell')).toHaveAttribute('data-connection', 'connected');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const input = page.locator('#commandInput');
        await input.fill('FRONTEND_SUBMIT');
        await page.locator('#sendButton').click();
        const requests = () =>
          fixture.state.requests.filter(
            (request) =>
              request.route === 'POST /api/messages' && request.body.text === 'FRONTEND_SUBMIT',
          );
        await expect.poll(() => requests().length).toBe(1);
        assert.equal(requests()[0].body.paneId, 'pane-codex');
        await expect(input).toHaveValue('');
        assert(
          !fixture.state.frames.some((frame) => frame.type === 'terminal.input'),
          'A chat message must not be replayed through terminal input.',
        );
        const geometry = await page.evaluate(() => {
          const rect = (selector) =>
            document.querySelector(selector).getBoundingClientRect().toJSON();
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            input: rect('.chat-input'),
            log: rect('#chatLog'),
            send: rect('#sendButton'),
          };
        });
        assert(geometry.overflow <= 1, JSON.stringify(geometry));
        assert(geometry.input.top >= geometry.log.bottom - 2, 'Composer overlaps message history.');
        assert(
          geometry.send.width >= (viewport.touch ? 44 : 32) &&
            geometry.send.height >= (viewport.touch ? 44 : 32),
          `Send target is too small: ${JSON.stringify(geometry.send)}`,
        );
        await input.fill('FRONTEND_DRAFT');
        if (!(await page.locator('#chatDeviceSettings').isVisible()))
          await page.locator('#chatDrawerToggle').click();
        await page.locator('#chatDeviceSettings').click();
        await expect(page.locator('#settingsPage')).toBeVisible();
        await page.locator('#settingsBack').click();
        await expect(input).toBeVisible();
        await expect(input).toHaveValue('FRONTEND_DRAFT');
        await page.screenshot({ path: path.join(output, `${viewport.name}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        assert.deepEqual(fixture.state.unexpected, []);
        results.push({ viewport: viewport.name, geometry, submission: true, draftRetained: true });
        console.log(
          `PASS frontend ${viewport.name}: rendering, message delivery, geometry and draft`,
        );
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ results }, null, 2) + '\n');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const engine = firefox;
const output = path.resolve(__dirname, '../../artifacts/settings-layout');

async function inspect(page) {
  return page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    const nav = document.querySelector('.settings-nav');
    return {
      page: box('#settingsPage'),
      nav: box('.settings-nav'),
      detail: document
        .querySelector('.settings-panel:not([hidden])')
        ?.getBoundingClientRect()
        .toJSON(),
      orientation: nav.getAttribute('aria-orientation'),
      buttons: [...nav.querySelectorAll('button')].map((button) =>
        button.getBoundingClientRect().toJSON(),
      ),
      overflow:
        document.querySelector('#settingsPage').scrollWidth -
        document.querySelector('#settingsPage').clientWidth,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await engine.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 320, height: 700 },
      { width: 390, height: 844 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      const fixture = await createFixture();
      const context = await browser.newContext({
        viewport,
        screen: viewport,
        hasTouch: viewport.width < 1440,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.locator('#commandInput').fill('设置页返回后保留此草稿');
        const footer = page.locator('#chatDeviceSettings');
        const open = async () => {
          if (!(await footer.isVisible())) await page.locator('#chatDrawerToggle').click();
          await footer.click();
        };
        await open();
        await expect(page.locator('.settings-nav')).toBeVisible();
        await expect(page.locator('#settingsBody')).toBeHidden();
        await expect(page.locator('.settings-row-title')).toHaveText([
          '主题',
          '界面字号',
          '终端字号',
          '客户端更新',
          '服务器',
        ]);
        const initial = await inspect(page);
        assert.equal(initial.overflow, 0);
        assert.equal(initial.documentOverflow, 0);
        assert(initial.buttons.every((box) => box.height >= 44));
        await page.screenshot({ path: path.join(output, `${viewport.width}-list.png`) });
        const category = async (id) => {
          if (!(await page.locator('.settings-nav').isVisible()))
            await page.locator('#settingsBack').click();
          await page.locator(id).click();
          await expect(page.locator('.settings-nav')).toBeHidden();
        };
        await category('#settingsAppearanceTab');
        await expect(page.locator('#settingsTitle')).toHaveText('主题');
        await page.screenshot({ path: path.join(output, `${viewport.width}-appearance.png`) });
        await category('#settingsTerminalTab');
        await expect(page.locator('#terminalFontSize')).toBeVisible();
        await page.locator('#terminalFontSize').fill('16.5');
        await page.locator('#terminalFontSize').dispatchEvent('input');
        await page.locator('#terminalFontSize').dispatchEvent('change');
        await expect.poll(() => page.evaluate(() => StudioTerminalFont.current())).toBe(16.5);
        await expect
          .poll(() =>
            page
              .locator('.settings-terminal-preview')
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
          )
          .toBe(16.5);
        await page.locator('#settingsBack').click();
        await expect(page.locator('[data-settings-value=terminal]')).toHaveText('16.5 px');
        await page.reload();
        await open();
        await category('#settingsTerminalTab');
        await expect(page.locator('#terminalFontSize')).toHaveValue('16.5');
        await page
          .locator('#terminalFontSize')
          .locator('..')
          .getByRole('button', { name: '恢复默认' })
          .click();
        await expect.poll(() => page.evaluate(() => StudioTerminalFont.current())).toBe(0);
        await page.locator('#terminalFontSize').dispatchEvent('change');
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(output, `${viewport.width}-terminal-font.png`) });

        const before = fixture.state.requests.filter((row) => row.route.startsWith('POST')).length;
        await page.locator('#settingsBack').click();
        await expect(page.locator('#settingsTerminalTab')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#settingsUpdateTab')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#settingsConnectionTab')).toBeFocused();
        await page.keyboard.press('Enter');
        await page.locator('#chatRootDirectory').fill('/fixture/unsaved-settings-draft');
        await category('#settingsAppearanceTab');
        await category('#settingsConnectionTab');
        await expect(page.locator('#chatRootDirectory')).toHaveValue(
          '/fixture/unsaved-settings-draft',
        );
        assert.equal(
          fixture.state.requests.filter((row) => row.route.startsWith('POST')).length,
          before,
          'classification must not save or control sessions',
        );
        await page.locator('#chatRootDirectory').fill('/fixture/missing');
        await page.locator('#deviceRootSave').click();
        await expect(page.locator('#deviceRootStatus')).toContainText('目录不存在');
        await category('#settingsAppearanceTab');
        await category('#settingsConnectionTab');
        await expect(page.locator('#deviceRootStatus')).toContainText('目录不存在');
        await expect(page.locator('#deviceRootSave')).toBeEnabled();

        await page.route('**/api/server-update', (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: '检查更新暂时不可用。' }),
          }),
        );
        await category('#settingsConnectionTab');
        await page.locator('.server-update-settings button').click();
        await expect(page.locator('.server-update-settings [role=status]')).toContainText(
          '无法检查服务器更新',
        );
        await expect(page.locator('.server-update-settings button')).toBeEnabled();
        await page.screenshot({
          path: path.join(output, `${viewport.width}-connection-error.png`),
        });
        await category('#settingsConnectionTab');
        await expect(page.locator('.execution-settings')).toHaveCount(0);
        await expect(page.locator('script[src*="execution-settings"]')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '账号与网络', exact: true })).toHaveCount(0);
        assert(
          !fixture.state.requests.some((row) => row.route.includes('/api/execution-environments')),
        );
        await expect(
          page
            .locator('#settingsConnection')
            .getByRole('heading', { name: '服务器', level: 2, exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: path.join(output, `${viewport.width}-connection.png`) });

        await category('#settingsFontTab');
        await expect(page.locator('.settings-font-preview')).toBeVisible();
        await page.locator('#deviceFontSize').focus();
        await page.keyboard.press('End');
        await category('#settingsFontTab');
        await expect(page.locator('#deviceFontSize')).toHaveValue('20');
        await expect
          .poll(() =>
            page
              .locator('.settings-font-preview p')
              .first()
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
          )
          .toBeCloseTo((16 * 20) / 14, 3);
        await page.locator('#settingsBack').click();
        await expect(page.locator('[data-settings-value=font]')).toHaveText('20 px');
        await category('#settingsAppearanceTab');
        const themes = await page
          .locator('input[name=deviceTheme]')
          .evaluateAll((inputs) => inputs.map((input) => input.value));
        assert.deepEqual(themes, ['default', 'light']);
        for (const theme of themes) {
          await page.locator(`.device-theme-option:has(input[value="${theme}"])`).click();
          await expect(page.locator(`input[name=deviceTheme][value="${theme}"]`)).toBeChecked();
          const maximum = await inspect(page);
          assert.equal(maximum.overflow, 0, `${viewport.width}/${theme}`);
          assert.equal(maximum.documentOverflow, 0);
          if (viewport.width === 1440)
            await page.screenshot({
              path: path.join(output, `${viewport.width}-${theme}-maximum-font.png`),
            });
        }
        await page.screenshot({ path: path.join(output, `${viewport.width}-maximum-font.png`) });
        await page.locator('#settingsBack').click();
        await page.locator('#settingsBack').click();
        await expect(page.locator('#commandInput')).toHaveValue('设置页返回后保留此草稿');
        await open();
        await expect(page.locator('#settingsBody')).toBeHidden();
        await category('#settingsAppearanceTab');
        await expect(page.locator('#settingsAppearance')).toBeVisible();
        await category('#settingsFontTab');
        await expect(page.locator('#deviceFontSize')).toHaveValue('20');
        assert.deepEqual(errors, []);
        fs.writeFileSync(
          path.join(output, `${viewport.width}-measurements.json`),
          JSON.stringify({ initial, errors }, null, 2),
        );
        console.log(
          `PASS settings layout ${viewport.width}: navigation, drafts, errors, themes, maximum font and chat return`,
        );
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

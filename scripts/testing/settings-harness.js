#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const output = path.join(__dirname, '../../artifacts/settings');

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await firefox.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      const fixture = await createFixture();
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.width < 1440,

        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const settings = page.locator('#chatDeviceSettings');
        if (!(await settings.isVisible())) await page.locator('#chatDrawerToggle').click();
        assert.equal(await page.locator('.chat-settings-footer').count(), 0);
        assert.equal(await settings.innerText(), '设置');
        const geometry = await settings.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            side = el.parentElement.getBoundingClientRect();
          return { height: r.height, gap: side.bottom - r.bottom, parent: el.parentElement.id };
        });
        assert.equal(geometry.parent, 'chatSidebar');
        assert.equal(geometry.height, 44);
        assert(geometry.gap <= 20);
        const inputShadow = await page
          .locator('.chat-input')
          .evaluate((el) => getComputedStyle(el).boxShadow);
        await page.locator('#commandInput').fill('保留设置前的草稿');
        assert.equal(
          await page.locator('.chat-input').evaluate((el) => getComputedStyle(el).boxShadow),
          inputShadow,
        );
        const chatWidth = await page
          .locator('.chat-input')
          .evaluate((el) => el.getBoundingClientRect().width);
        const attachments = await page.evaluate(() => {
          const root = document.documentElement,
            list = document.querySelector('#attachmentList');
          const savedWidth = root.style.getPropertyValue('--chat-content-width'),
            hidden = list.hidden;
          const probe = document.createElement('span');
          probe.textContent = '布局检查.png';
          list.append(probe);
          list.hidden = false;
          try {
            return [540, 780, 940].map((width) => {
              root.style.setProperty('--chat-content-width', `${width}px`);
              const attachment = list.getBoundingClientRect(),
                input = document.querySelector('.chat-input').getBoundingClientRect();
              return {
                width,
                leftDifference: attachment.left - input.left,
                widthDifference: attachment.width - input.width,
              };
            });
          } finally {
            probe.remove();
            list.hidden = hidden;
            if (savedWidth) root.style.setProperty('--chat-content-width', savedWidth);
            else root.style.removeProperty('--chat-content-width');
          }
        });
        assert(
          attachments.every(
            (row) => Math.abs(row.leftDifference) < 1 && Math.abs(row.widthDifference) < 1,
          ),
          JSON.stringify(attachments),
        );
        await settings.click();
        await page.locator('#settingsAppearanceTab').click();
        const category = async (id) => {
          if (!(await page.locator('.settings-nav').isVisible()))
            await page.locator('#settingsBack').click();
          await page.locator(id).click();
        };
        await expect(page.locator('#chatDialog')).toBeHidden();
        await expect(page.locator('#chatLog')).toBeHidden();
        const layout = await page.evaluate(() => {
          const main = document.querySelector('.chat-main').getBoundingClientRect();
          const page = document.querySelector('#settingsPage'),
            rect = page.getBoundingClientRect();
          const content = document.querySelector('.settings-content').getBoundingClientRect();
          return {
            main: main.toJSON(),
            page: rect.toJSON(),
            content: content.toJSON(),
            scrollbar: getComputedStyle(page).scrollbarWidth,
          };
        });
        assert.equal(layout.page.width, layout.main.width);
        assert.equal(layout.page.height, layout.main.height);
        // Removing personal images must not leave an empty section or an image-dependent column.
        await expect(
          page.locator(
            '.profile-settings, [data-profile-image], .chat-brand, .herdr-session-selector',
          ),
        ).toHaveCount(0);
        await expect(page.locator('.sidebar-modes [role="tab"]')).toHaveText([
          'spaces',
          'agent',
          'archive',
          'files',
        ]);
        const column = await page.evaluate(() => {
          const content = document.querySelector('.settings-content').getBoundingClientRect();
          const headings = [
            ...document.querySelectorAll('#settingsAppearance .device-settings-section h3'),
          ].map((el) => el.getBoundingClientRect().left);
          const rows = [
            ...document.querySelectorAll(
              '#settingsPage .device-settings-section > :not(h3):not(.device-font-label)',
            ),
          ]
            .filter((el) => el.offsetParent)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return [el.className, r.left, r.right];
            });
          const detail = document.querySelector('#settingsAppearance').getBoundingClientRect();
          return {
            content: [content.left, content.right, content.width],
            detail: detail.toJSON(),
            headings,
            rows,
          };
        });
        assert(
          column.content[2] >= layout.main.width * 0.8 &&
            column.content[2] <= layout.main.width - 48 + 1,
          'Default settings width follows the available main region',
        );
        const themeColumns = await page
          .locator('.device-theme-options')
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
        assert.equal(themeColumns, 2);
        if (viewport.width > 760)
          assert(column.content[2] > 408, 'tablet and desktop settings use the available width');
        assert(
          Math.abs(
            column.content[0] + column.content[2] / 2 - layout.main.x - layout.main.width / 2,
          ) < 1,
          'settings column stays centered',
        );
        for (const left of column.headings) assert(Math.abs(left - column.detail.left) < 1);
        for (const [name, left, right] of column.rows)
          assert(
            left >= column.detail.left - 1 && right <= column.detail.right + 1,
            `${name} stays inside the detail column`,
          );
        assert(
          !fixture.state.requests.some((r) => /\/api\/(profile|herdr\/sessions)/.test(r.route)),
          'removed controls must not fetch profile images or enumerate Sessions',
        );
        assert(
          !fixture.state.requests.some((r) =>
            /\/api\/(notifications|herdr\/runtime)/.test(r.route),
          ),
          'removed settings must not fetch notification or runtime controls',
        );
        // 返回在左上角：标题栏最左边，紧跟标题；与会话文件面板的标题栏同一个样子。
        const bar = await page.evaluate(() => {
          const box = (selector) =>
            document.querySelector(selector).getBoundingClientRect().toJSON();
          return {
            back: box('#settingsBack'),
            title: box('#settingsTitle'),
            page: box('#settingsPage'),
          };
        });
        assert(
          bar.back.left - bar.page.left <= 24 && bar.back.top - bar.page.top <= 20,
          JSON.stringify(bar),
        );
        assert(
          bar.title.left > bar.back.right &&
            Math.abs(
              (bar.title.top + bar.title.bottom) / 2 - (bar.back.top + bar.back.bottom) / 2,
            ) < 3,
          JSON.stringify(bar),
        );
        assert.equal(await page.locator('#settingsBack').getAttribute('aria-label'), '返回设置');
        assert.equal(layout.scrollbar, 'none');
        assert(
          !/当前根目录|所有设备共用|只显示此目录/.test(
            await page.locator('#settingsPage').innerText(),
          ),
        );
        await category('#settingsConnectionTab');
        for (const selector of ['#chatRootDirectory']) {
          const field = page.locator(selector);
          const beforeFocus = await field.evaluate((el) => {
            const s = getComputedStyle(el);
            return [s.borderColor, s.boxShadow];
          });
          await field.focus();
          assert.deepEqual(
            await field.evaluate((el) => {
              const s = getComputedStyle(el);
              return [s.borderColor, s.boxShadow];
            }),
            beforeFocus,
          );
          assert.equal(await field.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
        }
        await page.locator('#settingsPage').evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.locator('#chatRootDirectory').focus();
        await page.screenshot({ path: path.join(output, `${viewport.width}-full-page.png`) });
        let settingsWidth;
        const widthHandle = page.locator('#chatContentResizer');
        if (viewport.width >= 1440) {
          await expect(widthHandle).toBeVisible();
          await expect(widthHandle).toHaveAccessibleName('设置内容宽度');
          const beforeWidth = await page
              .locator('.settings-content')
              .evaluate((el) => el.getBoundingClientRect().width),
            h = await widthHandle.boundingBox();
          await page.mouse.move(h.x + h.width / 2, h.y + 12);
          await page.mouse.down();
          await page.mouse.move(h.x + h.width / 2 + 90, h.y + 12, { steps: 6 });
          await page.mouse.up();
          settingsWidth = await page
            .locator('.settings-content')
            .evaluate((el) => el.getBoundingClientRect().width);
          assert(settingsWidth < beforeWidth - 150, 'Settings width must follow mouse dragging');
          await widthHandle.focus();
          await page.keyboard.press('ArrowLeft');
          settingsWidth += 20;
          await expect
            .poll(() =>
              page.locator('.settings-content').evaluate((el) => el.getBoundingClientRect().width),
            )
            .toBe(settingsWidth);
          await expect
            .poll(() =>
              page.evaluate(async () =>
                fetch('/api/config?token=fixture')
                  .then((r) => r.json())
                  .then((d) => d.settings.ui.studioSettingsContentWidth),
              ),
            )
            .toBe(String(Math.round(settingsWidth)));
          await page.screenshot({ path: path.join(output, `${viewport.width}-resized.png`) });
        } else await expect(widthHandle).toBeHidden();
        await page.locator('#settingsBack').click();
        await page.locator('#settingsBack').click();
        await expect(page.locator('#commandInput')).toHaveValue('保留设置前的草稿');
        assert.equal(
          await page.locator('.chat-input').evaluate((el) => el.getBoundingClientRect().width),
          chatWidth,
          'Settings resize must not change chat width',
        );
        if (!(await settings.isVisible())) await page.locator('#chatDrawerToggle').click();
        await settings.click();
        await page.locator('#settingsAppearanceTab').click();
        assert.deepEqual(await page.locator('.device-settings-section h3').allTextContents(), [
          '主题',
          '界面基准字号',
          '终端字体大小',
          '服务器更新',
        ]);
        await category('#settingsConnectionTab');
        // A directory picker is an overlay over settings, and cancelling it keeps drafts.
        await page.locator('#chatRootDirectory').fill('/fixture/unsaved');
        await page.locator('#deviceRootBrowse').click();
        await expect(page.locator('#chatDialog')).toBeVisible();
        assert(await page.evaluate(() => StudioNavigation.back()));
        await expect(page.locator('#chatDialog')).toBeHidden();
        await expect(page.locator('#settingsPage')).toBeVisible();
        await expect(page.locator('#chatRootDirectory')).toHaveValue('/fixture/unsaved');
        await category('#settingsFontTab');
        const slider = page.locator('#deviceFontSize');
        await slider.scrollIntoViewIfNeeded();
        const size = () =>
          page
            .locator('.chat-msg[data-role="assistant"]')
            .first()
            .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const before = await size();
        const box = await slider.boundingBox();
        await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
        assert.equal(await slider.inputValue(), '20');
        assert(Math.abs((await size()) - (before * 20) / 14) < 0.05);
        await page.mouse.up();
        await page.screenshot({ path: path.join(output, `${viewport.width}-maximum-font.png`) });
        const bounds = await page.evaluate(() => {
          const d = document.querySelector('#settingsPage');
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            pageOverflow: d.scrollWidth - d.clientWidth,
          };
        });
        assert.equal(bounds.overflow, 0);
        assert.equal(bounds.pageOverflow, 0);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#settingsPage')).toBeHidden();
        await page.reload();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        assert(Math.abs((await size()) - 20) < 0.05);
        if (!(await settings.isVisible())) await page.locator('#chatDrawerToggle').click();
        await settings.click();
        await page.locator('#settingsFontTab').click();
        await expect(slider).toHaveValue('20');
        if (settingsWidth)
          assert.equal(
            await page
              .locator('.settings-content')
              .evaluate((el) => el.getBoundingClientRect().width),
            settingsWidth,
            'Settings width must survive reload',
          );
        await category('#settingsFontTab');
        await slider.focus();
        await page.keyboard.press('Home');
        await expect(slider).toHaveValue('12');
        assert(Math.abs((await size()) - 12) < 0.05);
        await page.locator('#deviceFontReset').click();
        await expect(slider).toHaveValue('14');
        const other = await context.newPage();
        await other.goto(fixture.url + '/?token=fixture&view=chat');
        await expect(other.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await category('#settingsConnectionTab');
        // Invalid paths leave both current sessions and saved root intact.
        await page.locator('#chatRootDirectory').fill('/fixture/missing');
        await page.locator('#deviceRootSave').click();
        await expect(page.locator('#deviceRootStatus')).toContainText('目录不存在');
        assert.equal(fixture.state.rootDirectory, undefined);
        // Root data changes independently of the complete Herdr runtime topology.
        await page.locator('#chatRootDirectory').fill('/fixture/empty');
        await page.locator('#deviceRootSave').click();
        await expect(page.locator('#deviceRootStatus')).toHaveText('已保存');
        await page.locator('#settingsBack').click();
        await page.locator('#settingsBack').click();
        await expect(page.locator('#chatCurrentName')).toHaveText('Codex 验收会话');
        await expect(other.locator('#chatCurrentName')).toHaveText('Codex 验收会话');
        await expect(other.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatPickerList .session-item')).toHaveCount(2);
        if (!(await settings.isVisible())) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarWorkspaces').click();
        await expect(page.locator('.chat-tree-group')).toHaveCount(1);
        fixture.state.history = [
          {
            provider: 'codex',
            sessionId: 'old-history',
            title: '旧目录历史',
            cwd: '/fixture/project',
            updatedAt: Date.now(),
          },
        ];
        await page.locator('#sidebarHistory').click();
        await expect(page.locator('#chatPickerList')).toContainText('没有已关闭的会话');
        await page.screenshot({ path: path.join(output, `${viewport.width}-empty-root.png`) });
        // Returning to a populated root uses the same existing session/archive parser.
        await settings.click();
        await page.locator('#settingsConnectionTab').click();
        await page.locator('#chatRootDirectory').fill('/fixture/project');
        await page.locator('#deviceRootSave').click();
        await expect(page.locator('#deviceRootStatus')).toHaveText('已保存');
        await page.locator('#settingsBack').click();
        await page.locator('#settingsBack').click();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#chatPickerList')).toContainText('旧目录历史');
        await expect(other.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await other.close();
        if (!(await settings.isVisible())) await page.locator('#chatDrawerToggle').click();
        await page.locator('#sidebarRecent').click();
        await settings.click();
        await page.locator('#settingsAppearanceTab').click();
        await expect(page.locator('#chatRootDirectory')).toHaveValue('/fixture/project');
        await page.screenshot({ path: path.join(output, `${viewport.width}-settings.png`) });
        await category('#settingsAppearanceTab');
        // The same root keeps separate settings for two browser/APP installations.
        await category('#settingsFontTab');
        await page.locator('#deviceFontSize').evaluate((el) => {
          el.value = '18';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await category('#settingsAppearanceTab');
        await page.locator('.device-theme-option:has(input[value="light"])').click();
        await expect
          .poll(
            () =>
              fixture.state.requests.filter((r) => r.route === 'POST /api/settings').at(-1)?.body
                .settings.theme,
          )
          .toBe('light');
        const deviceContext = await browser.newContext({ viewport, serviceWorkers: 'block' });
        try {
          const devicePage = await deviceContext.newPage();
          await devicePage.goto(fixture.url + '/?token=fixture&view=chat');
          await expect(devicePage.locator('#chatLog')).toContainText('codex 浏览器验收样例');
          assert.equal(await devicePage.evaluate(() => StudioDeviceTheme.current().id), 'default');
          assert.equal(await devicePage.evaluate(() => StudioDeviceFont.current()), 14);
          await devicePage.evaluate(() => {
            StudioDeviceTheme.apply('default');
            StudioDeviceFont.apply(16);
          });
          await expect
            .poll(
              () =>
                fixture.state.requests.filter((r) => r.route === 'POST /api/settings').at(-1)?.body
                  .settings.fontSize,
            )
            .toBe(16);
          assert.equal(await page.evaluate(() => StudioDeviceTheme.current().id), 'light');
          assert.equal(await page.evaluate(() => StudioDeviceFont.current()), 18);
          await category('#settingsConnectionTab');
          await page.locator('#chatRootDirectory').fill('/fixture/empty');
          await page.locator('#deviceRootSave').click();
          await expect(page.locator('#deviceRootStatus')).toHaveText('已保存');
          await expect.poll(() => devicePage.evaluate(() => StudioDeviceFont.current())).toBe(14);
          assert.equal(await page.evaluate(() => StudioDeviceFont.current()), 14);
          await page.locator('#chatRootDirectory').fill('/fixture/project');
          await page.locator('#deviceRootSave').click();
          await expect(page.locator('#deviceRootStatus')).toHaveText('已保存');
          await expect
            .poll(() => devicePage.evaluate(() => StudioDeviceTheme.current().id))
            .toBe('default');
          await expect.poll(() => page.evaluate(() => StudioDeviceFont.current())).toBe(18);
          assert.equal(await devicePage.evaluate(() => StudioDeviceFont.current()), 16);
          await devicePage.reload();
          await expect(devicePage.locator('#chatLog')).toContainText('codex 浏览器验收样例');
          assert.equal(await devicePage.evaluate(() => StudioDeviceFont.current()), 16);
          await page.screenshot({
            path: path.join(output, `${viewport.width}-device-root-settings.png`),
          });
        } finally {
          await deviceContext.close();
        }
        assert.deepEqual(errors, []);
        fs.writeFileSync(
          path.join(output, `${viewport.width}-measurements.json`),
          JSON.stringify(
            {
              geometry,
              layout,
              column,
              bounds,
              attachments,
              before,
              maximum: 20,
              settingsWidth,
              errors,
            },
            null,
            2,
          ),
        );
        console.log(
          `PASS ${viewport.width}×${viewport.height}: slider, persistence, empty/populated root, layout`,
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

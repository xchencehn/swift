'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_MOBILE_TERMINAL_OUTPUT || 'artifacts/testing/mobile-terminal-input/browser',
);
const viewports = [
  { name: 'desktop', width: 1440, height: 900, font: 14 },
  { name: 'tablet', width: 1024, height: 768, touch: true, font: 14 },
  { name: 'phone', width: 390, height: 844, touch: true, font: 11.5 },
  { name: 'small-phone', width: 320, height: 740, touch: true, font: 11.5 },
  { name: 'phone-landscape', width: 844, height: 390, touch: true, font: 11.5 },
];
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of viewports) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        screen: { width: viewport.width, height: viewport.height },
        hasTouch: Boolean(viewport.touch),
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(8000);
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await page.locator('#commandInput').fill('独立的结构化草稿');
        await page.locator('#chatModeToggle').click();
        const host = page.locator('#shellTerminal'),
          input = host.locator('.xterm-helper-textarea');
        await expect(host).toContainText('OpenAI Codex');
        await expect(
          host.locator('.shell-terminal-editor, .shell-terminal-input, .shell-terminal-fill'),
        ).toHaveCount(0);
        await expect
          .poll(() =>
            host
              .locator('.xterm-rows')
              .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
          )
          .toBe(viewport.font);
        if (!viewport.touch) {
          await expect(host.locator('.shell-terminal-combos')).toBeHidden();
          results.push({ viewport: viewport.name, font: viewport.font, desktopPreserved: true });
          continue;
        }
        const writes = () =>
          (fixture.state.shellFrames || []).filter((row) => row.type === 'terminal.input');
        const key = (name) => host.getByRole('button', { name, exact: true });
        await host.locator('.xterm-screen').tap({ position: { x: 12, y: 12 } });
        await expect(input).toBeFocused();
        assert.equal(await input.evaluate((node) => node.readOnly), false);
        assert.notEqual(await input.getAttribute('inputmode'), 'none');
        const start = writes().length;
        await input.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          el.value = 'zhongwen';
          el.dispatchEvent(
            new CompositionEvent('compositionupdate', { bubbles: true, data: 'zhongwen' }),
          );
        });
        await expect(host.locator('.composition-view')).toBeHidden();
        await page.waitForTimeout(50);
        assert.equal(writes().length, start);
        await input.evaluate((el) => {
          el.value = '中文';
          el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: '中文', inputType: 'insertText' }),
          );
        });
        await expect
          .poll(() =>
            writes()
              .slice(start)
              .map((row) => row.data)
              .join(''),
          )
          .toBe('中文');
        await page.waitForTimeout(50);
        assert.equal(writes().length, start + 1);
        await key('Enter').click();
        await expect.poll(() => writes().at(-1)?.data).toBe('\r');
        for (const [name, bytes] of [
          ['Ctrl+C', '\x03'],
          ['Shift+Tab', '\x1b[Z'],
          ['Alt+↑', '\x1b[1;3A'],
          ['Shift+↑', '\x1b[1;2A'],
          ['Tab', '\t'],
          ['退格', '\x7f'],
          ['4', '4'],
          ['5', '5'],
        ]) {
          if (name.includes('+')) await key('组合键').click();
          const count = writes().length;
          await key(name).click();
          await expect.poll(() => writes().length).toBe(count + 1);
          assert.equal(writes().at(-1).data, bytes);
          await expect(input).toBeFocused();
        }
        await page.locator('#chatModeToggle').click();
        await expect(page.locator('#commandInput')).toHaveValue('独立的结构化草稿');
        await page.locator('#chatModeToggle').click();
        await expect(host).toContainText('OpenAI Codex');
        await page.reload();
        await expect(host).toContainText('OpenAI Codex');
        const reloadedCount = writes().length;
        fixture.disconnect(true);
        await expect(key('Enter')).toBeDisabled();
        await input.focus();
        await page.keyboard.insertText('离线输入');
        assert.equal(writes().length, reloadedCount);
        fixture.disconnect(false);
        await expect(key('Enter')).toBeEnabled({ timeout: 10000 });
        await page.waitForTimeout(100);
        assert.equal(writes().length, reloadedCount, 'Recovery must not replay input');
        const geometry = await host.evaluate((node) => {
          return {
            keys: node.querySelector('.shell-terminal-keys').getBoundingClientRect().toJSON(),
            canvas: node.querySelector('.shell-terminal-canvas').getBoundingClientRect().toJSON(),
            overflow: document.documentElement.scrollWidth - innerWidth,
            targets: [...node.querySelectorAll('.shell-terminal-keys button')].map((button) => ({
              width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height,
            })),
          };
        });
        assert.equal(geometry.overflow, 0);
        assert(geometry.keys.bottom <= viewport.height + 1);
        assert(geometry.canvas.height > 60);
        assert(geometry.targets.every((item) => item.width >= 44 && item.height >= 44));
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        await key('组合键').click();
        const comboBox = await host.locator('.shell-terminal-combos').boundingBox();
        assert(
          comboBox.x >= 0 && comboBox.y >= 0 && comboBox.x + comboBox.width <= viewport.width + 1,
        );
        const comboTargets = await host
          .locator('.shell-terminal-combos button')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
        assert(comboTargets.every((item) => item.width >= 44 && item.height >= 44));
        await page.screenshot({ path: path.join(output, viewport.name + '-combos.png') });
        await key('组合键').click();
        if (viewport.name === 'tablet') {
          await page.setViewportSize({ width: 1024, height: 430 });
          await expect
            .poll(() =>
              host
                .locator('.xterm-rows')
                .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
            )
            .toBe(14);
        }
        assert.deepEqual(errors, []);
        assert(
          !fixture.state.requests.some((row) => row.route === 'POST /api/messages'),
          'Terminal input never creates chat API messages',
        );
        results.push({
          viewport: viewport.name,
          font: viewport.font,
          geometry,
          preeditHidden: true,
          commitExactlyOnce: true,
          comboBytesVerified: true,
          chatDraftPreserved: true,
          offlineInputNotReplayed: true,
          productionInput: false,
        });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2) + '\n',
  );
  console.log(
    'PASS direct mobile terminal input: hidden preedit, single commit, shortcuts, offline recovery and geometry.',
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

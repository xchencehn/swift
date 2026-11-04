'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const cases = require('./session-statusbar-cases');
const output = path.resolve(
  process.env.SWIFT_STATUSBAR_OUTPUT || 'artifacts/testing/native-statusbar/browser',
);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1520, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'narrow-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const session = fixture.state.sessions['pane-codex'];
      session.pane.sessionFullTitle =
        'Codex 当前会话完整名称：' + '完整保留名称，不使用顶栏省略文本。'.repeat(8);
      session.pane.cwd = '/fixture/workdir/' + '很长的目录和分支名称/'.repeat(12);
      for (let i = 0; i < 35; i++)
        session.messages.unshift({
          id: `history-${i}`,
          role: 'assistant',
          blocks: [{ kind: 'text', text: `历史阅读验证 ${i}\n${'保留当前阅读位置。'.repeat(10)}` }],
        });
      const context = await browser.newContext({
        viewport,
        hasTouch: Boolean(viewport.touch),
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(() =>
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }),
      );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        const geometry = await cases.facts(page, fixture, viewport, output);
        const stability = await cases.progress(page, fixture, viewport, output);
        const fixedLayout = await cases.fixedLayout(page, fixture, viewport, output);
        const operationFeedback = await cases.operationFeedback(page, fixture, viewport, output);
        await cases.unknown(page, fixture, viewport, output);
        const settings = await cases.settings(page, fixture);
        const queryRecovery = await cases.queryRecovery(page, fixture);
        await page.evaluate(() => window.StudioDeviceTheme.apply('light', false));
        await page.addStyleTag({ content: ':root { --device-font-scale: 1.5 !important; }' });
        await cases.facts(
          page,
          fixture,
          { ...viewport, fontScale: 1.5, name: viewport.name + '-light-large' },
          output,
        );
        await cases.fixedLayout(
          page,
          fixture,
          { ...viewport, fontScale: 1.5, name: viewport.name + '-light-large' },
          output,
        );
        await cases.dialogs(page, fixture);
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          geometry,
          stability,
          fixedLayout,
          operationFeedback,
          settings,
          queryRecovery,
          darkAndLightLargeFont: true,
          nativeDialogsPreservedDraft: true,
          unknownAndOfflineRecovery: true,
          rawNativeNodesRemoved: true,
          productionInput: false,
        });
        console.log(JSON.stringify(results.at(-1)));
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
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const output = path.resolve('artifacts/testing/transcript-terminal-consistency/identity');
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const context = await browser.newContext({
        viewport,
        hasTouch: viewport.touch,
        serviceWorkers: 'block',
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        const session = fixture.state.sessions['pane-codex'],
          originalId = session.pane.agent.session.value,
          originalMessages = structuredClone(session.messages);
        const message = (id, text) => ({
          id,
          role: 'assistant',
          ts: new Date().toISOString(),
          blocks: [{ kind: 'text', text }],
        });
        session.messages = [message('old-interruption', '旧会话已经中断，等待身份更新。')];
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('旧会话已经中断');
        await page.locator('#commandInput').fill('旧会话未发送的草稿');
        session.pane.agent.session.value = 'current-native-thread';
        session.messages = [message('latest-native-message', '当前原生会话正文，与终端一致。')];
        fixture.changed();
        await fixture.synced();
        await expect(page.locator('#chatLog')).toContainText('当前原生会话正文');
        await expect(page.locator('#chatLog')).not.toContainText('旧会话已经中断');
        await expect(page.locator('#commandInput')).toHaveValue('');
        await page.locator('#commandInput').fill('当前会话的独立草稿');
        await page.reload();
        await expect(page.locator('#chatLog')).toContainText('当前原生会话正文');
        await expect(page.locator('#commandInput')).toHaveValue('当前会话的独立草稿');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        await expect(page.locator('#shellTerminal')).toContainText('OpenAI Codex');
        const connections = fixture.state.shellConnections;
        session.pane.agent.session.value = 'second-current-native-thread';
        session.messages = [message('second-native-message', '同一终端切换后的最新原生会话正文。')];
        fixture.changed();
        await fixture.synced();
        await page.waitForTimeout(250);
        assert.equal(
          fixture.state.shellConnections,
          connections,
          'A thread identity change must not recreate the same terminal',
        );
        await page.getByRole('button', { name: '切换到结构化模式', exact: true }).click();
        await expect(page.locator('#chatLog')).toContainText('同一终端切换后的最新原生会话正文');
        await expect(page.locator('#commandInput')).toHaveValue('');
        session.pane.agent.session.value = originalId;
        session.messages = originalMessages;
        fixture.changed();
        await fixture.synced();
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await expect(page.locator('#commandInput')).toHaveValue('旧会话未发送的草稿');
        await page.screenshot({ path: path.join(output, viewport.name + '.png') });
        assert.deepEqual(errors, []);
        assert.equal(
          (fixture.state.shellFrames || []).filter((message) => message.type === 'terminal.input')
            .length,
          0,
        );
        results.push({
          viewport,
          followsCurrentNativeId: true,
          staleBodyRemoved: true,
          reloadCurrentBody: true,
          draftsIsolatedAndRestored: true,
          terminalInstancePreserved: true,
          noInput: true,
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
    `PASS native identity propagation and terminal / transcript consistency: ${results.length} viewports.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

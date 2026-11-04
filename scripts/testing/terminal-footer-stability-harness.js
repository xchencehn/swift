'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline');
const output = path.resolve(
  'artifacts/testing/terminal-footer-stability',
  baseline ? 'baseline' : 'browser',
);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 1024, height: 768, touch: true },
      { name: 'mobile', width: 390, height: 844, touch: true },
      { name: 'narrow', width: 320, height: 740, touch: true },
    ]) {
      const f = await createFixture();
      f.state.productionPresentation = true;
      const context = await browser.newContext({
          viewport,
          hasTouch: Boolean(viewport.touch),
          serviceWorkers: 'block',
        }),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(f.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        const host = page.locator('#shellTerminal');
        await expect(host).toContainText('OpenAI Codex');
        const rows = host.locator('.xterm-rows > div');
        const frame = (draft) =>
          '\x1b[2J\x1b[H' +
          Array.from({ length: 18 }, (_, i) => `\x1b[${i + 1};1HSTABLE BODY ${i}`).join('') +
          `\x1b[20;1HWorked for 26m 0s\x1b[22;1H› ${draft || 'Ask Codex to do anything'}\x1b[24;1HGPT-6-Astra high · ~/workdir/swift${draft ? '' : '\x1b[25;1H? for shortcuts'}\x1b[22;${draft ? 9 : 3}H\x1b[?25h`;
        const metrics = () =>
          page.evaluate(() => {
            const rows = [...document.querySelectorAll('#shellTerminal .xterm-rows > div')];
            const find = (text) => {
              const index = rows.findIndex((row) => row.textContent.includes(text));
              return { index, top: rows[index]?.getBoundingClientRect().top };
            };
            return {
              body: find('STABLE BODY 17'),
              worked: find('Worked for 26m'),
              prompt: find('› '),
              status: find('GPT-6-Astra'),
              hint: find('? for shortcuts'),
              height: rows[0].getBoundingClientRect().height,
            };
          });
        const observations = [];
        for (const [i, draft] of ['', '水电费', '', '再次输入', ''].entries()) {
          f.shellFrame(frame(draft), 'pane-codex', {
            full: true,
            geometry: { cols: 160, rows: 200 },
          });
          await expect(host).toContainText(draft || '? for shortcuts');
          if (draft) await expect(host).not.toContainText('? for shortcuts');
          await page.waitForTimeout(100);
          observations.push(await metrics());
          if (i < 2)
            await page.screenshot({
              path: path.join(output, viewport.name + (draft ? '-draft' : '-empty') + '.png'),
            });
        }
        const shifts = observations.map((m) => m.status.index - observations[0].status.index);
        if (baseline) assert.deepEqual(shifts, [0, 1, 0, 1, 0]);
        else {
          assert.deepEqual(shifts, [0, 0, 0, 0, 0]);
          for (const m of observations)
            for (const field of ['body', 'worked', 'prompt', 'status'])
              assert.equal(m[field].top, observations[0][field].top, field);
        }
        // Reconnect with a nonempty draft first; showing the hint later must not move native rows.
        f.shellFrame(frame('初始草稿'), 'pane-codex', {
          full: true,
          geometry: { cols: 160, rows: 200 },
        });
        await expect(host).toContainText('初始草稿');
        await page.reload();
        await expect(host).toContainText('初始草稿');
        await page.waitForTimeout(100);
        const initialDraft = await metrics();
        f.shellFrame(frame(''), 'pane-codex', { full: true, geometry: { cols: 160, rows: 200 } });
        await expect(host).toContainText('? for shortcuts');
        await page.waitForTimeout(100);
        const cleared = await metrics();
        if (!baseline) assert.equal(initialDraft.status.top, cleared.status.top);
        assert.deepEqual(errors, []);
        assert.equal(
          (f.state.shellFrames || []).filter((r) => r.type === 'terminal.input').length,
          0,
        );
        results.push({
          viewport,
          shifts,
          observations,
          initialDraft,
          cleared,
          noNativeInput: true,
        });
      } finally {
        await context.close();
        await f.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, baseline, before, after, results }, null, 2),
  );
  console.log(
    'PASS ' +
      (baseline ? 'reproduced one-row jump' : 'stable footer rows') +
      ' across four viewports',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

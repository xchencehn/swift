'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { expect } = require('@playwright/test');

module.exports = async (page, fixture, viewport, { output, refresh, switchTo, timestamp }) => {
  // Cold worker/library loading must not consume the one-second parsing budget.
  await page.context().route('**/files/highlight-worker.js*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const samples = [
    ['js', 'const answer = "<img src=x onerror=alert(1)>";\nconsole.log(answer, 42);'],
    ['python', 'def greet(name):\n    return "Hello " + name # 中文注释'],
    ['cpp', 'int main() { return 42; }'],
    ['json', '{"ready": true, "count": 3}'],
    ['bash', 'printf "%s\\n" "done"'],
  ];
  const ansi =
    '\x1b[1;32mPASS\nSECOND\x1b[0m normal \x1b[38;5;214mWARN\x1b[0m \x1b[38;2;140;120;210mRGB\x1b[0m <img src=x onerror=alert(1)>';
  const command = {
    id: 'color-command',
    name: 'exec_command',
    detail: 'python3 verify.py --verbose',
    action: { verb: 'Ran', command: 'python3 verify.py --verbose "中文参数"' },
    outcome: { exitCode: 0, output: ansi },
    input: { text: '{"cmd":"python3 verify.py"}' },
    result: { text: JSON.stringify({ exit_code: 0, output: ansi }) },
  };
  fixture.state.sessions['pane-codex'].messages = [
    {
      id: 'color-user',
      role: 'user',
      ts: timestamp,
      blocks: [{ kind: 'text', text: '检查输出与代码颜色。' }],
    },
    {
      id: 'color-answer',
      role: 'assistant',
      ts: timestamp,
      blocks: [
        {
          kind: 'text',
          text:
            'codex 浏览器验收样例\n\n输出保持原始强调，代码按语言高亮。\n\n' +
            samples.map(([lang, source]) => '```' + lang + '\n' + source + '\n```').join('\n\n'),
        },
        {
          kind: 'tools',
          items: [
            command,
            {
              id: 'color-write',
              name: 'write_file',
              input: { text: JSON.stringify({ path: '/fixture/main.py', content: samples[1][1] }) },
              result: { text: 'written' },
            },
          ],
        },
      ],
    },
  ];
  await page.locator('#commandInput').fill('配色验证保留的草稿');
  await refresh(page, fixture);
  const message = page.locator('[data-message-id="color-answer"]');
  const blocks = message.locator('.chat-md pre code');
  await expect(blocks).toHaveCount(samples.length);
  await expect(message.locator('.chat-md pre code.hljs')).toHaveCount(samples.length);
  for (let i = 0; i < samples.length; i++) await expect(blocks.nth(i)).toHaveText(samples[i][1]);
  await expect(message.locator('img')).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedHighlight = text;
        },
      },
    }),
  );
  const pre = blocks.first().locator('..');
  await pre.locator('.code-copy').click();
  assert.equal(await page.evaluate(() => window.copiedHighlight), samples[0][1]);
  await pre.locator('.code-wrap').click();
  await expect(pre).toHaveAttribute('data-wrap', 'off');
  await pre.locator('.code-wrap').click();
  await expect(pre).toHaveAttribute('data-wrap', 'on');
  const row = page.locator('[data-tool-key="pane-codex:color-command"]');
  await row.locator('summary').click();
  await expect(row.locator('.tool-body')).toContainText('PASS\nSECOND');
  await expect(row.locator('.tool-body .ansi-bold')).toHaveCount(1);
  await expect(row.locator('img')).toHaveCount(0);
  const write = page.locator('[data-tool-key="pane-codex:color-write"]');
  await write.locator('summary').click();
  await expect(write.locator('code.hljs')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const measurements = [];
  for (const theme of ['default', 'light']) {
    await page.evaluate((theme) => StudioDeviceTheme.apply(theme), theme);
    const result = await page.evaluate(() => {
      const style = (node) => getComputedStyle(node);
      const luminance = (color) =>
        color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .reduce((sum, value, i) => {
            const v = Number(value) / 255;
            return (
              sum +
              (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) *
                [0.2126, 0.7152, 0.0722][i]
            );
          }, 0);
      const bg = luminance(style(document.body).backgroundColor);
      const ratio = (node) => {
        const fg = luminance(style(node).color);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      };
      const row = document.querySelector('[data-tool-key="pane-codex:color-command"]');
      const spans = [...row.querySelectorAll('.tool-body pre span')];
      const firstCode = document.querySelector('[data-message-id="color-answer"] .chat-md code');
      return {
        theme: document.documentElement.dataset.deviceTheme,
        overflow: document.documentElement.scrollWidth - innerWidth,
        codeText: firstCode.textContent,
        keyword: style(firstCode.querySelector('.hljs-keyword')).color,
        code: style(firstCode).color,
        codeFont: style(firstCode).fontFamily,
        toolFont: style(document.querySelector('[data-tool-key="pane-codex:color-write"] code'))
          .fontFamily,
        fontLoaded: document.fonts.check('14px "Cascadia Mono"'),
        pass: style(spans.find((span) => span.textContent.includes('PASS'))).color,
        warn: style(spans.find((span) => span.textContent === 'WARN')).color,
        rgb: style(spans.find((span) => span.textContent === 'RGB')).color,
        reset: style(spans.find((span) => span.textContent.includes(' normal '))).color,
        summaryContrast: ratio(row.querySelector('.codex-verb')),
        bodyContrast: ratio(document.querySelector('.chat-msg[data-role="assistant"]')),
        commandContrasts: [...row.querySelectorAll('.codex-cmd,.codex-str,.codex-ddash')].map(
          ratio,
        ),
        body: style(document.querySelector('.chat-msg[data-role="assistant"]')).color,
      };
    });
    assert.notEqual(result.keyword, result.code);
    assert.match(result.codeFont, /^["']?Cascadia Mono/);
    assert.equal(result.toolFont, result.codeFont);
    assert.equal(result.fontLoaded, true);
    assert.notEqual(result.pass, result.reset);
    assert.equal(result.warn, 'rgb(255, 175, 0)');
    assert.equal(result.rgb, 'rgb(140, 120, 210)');
    assert(
      result.summaryContrast >= 4.5 && result.summaryContrast < result.bodyContrast,
      JSON.stringify(result),
    );
    assert(
      result.commandContrasts.every((ratio) => ratio >= 4.5 && ratio < result.bodyContrast),
      JSON.stringify(result),
    );
    assert.equal(result.overflow, 0);
    measurements.push(result);
    await blocks.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${viewport.name}-${theme}-code.png`) });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${viewport.name}-${theme}-output.png`) });
  }
  await switchTo(page, 'claude');
  await switchTo(page, 'codex');
  await expect(page.locator('#commandInput')).toHaveValue('配色验证保留的草稿');
  assert.equal(
    fixture.state.requests.filter((request) => request.route === 'POST /api/messages').length,
    0,
  );
  await fs.writeFile(
    path.join(output, `${viewport.name}-highlighting.json`),
    JSON.stringify(measurements, null, 2),
  );
};

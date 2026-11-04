'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
(async () => {
  const baseline = process.argv.includes('--baseline');
  const output = path.resolve(
    process.env.SWIFT_TERMINAL_CONTINUOUS_OUTPUT ||
      path.join(
        'artifacts/testing/transcript-terminal-consistency',
        baseline ? 'continuous-baseline' : 'continuous',
      ),
  );
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
      if (baseline)
        await page.route('**/assets/startup.js*', async (route) => {
          const response = await route.fetch(),
            bundle = await response.text();
          const current = await fs.readFile('public/chat/shell-terminal.js', 'utf8');
          assert(bundle.includes(current));
          await route.fulfill({
            response,
            body: bundle.replace(
              current,
              execFileSync('git', ['show', '5cb8a55:public/chat/shell-terminal.js'], {
                encoding: 'utf8',
              }),
            ),
          });
        });
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('#chatLog')).toContainText('codex 浏览器验收样例');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(160);
        await page.getByRole('button', { name: '切换到终端模式', exact: true }).click();
        const terminal = page.locator('#shellTerminal'),
          input = terminal.locator('.xterm-helper-textarea');
        await expect(terminal).toContainText('OpenAI Codex');
        const frame = (i) =>
          `\x1b[?2026h\x1b[2J\x1b[HSTABLE HEADER 中文\x1b[3;1H\x1b[2mThinking ${i}\x1b[0m\x1b[5;1H模型正在推理，输入应保持稳定\x1b[${7 + (i % 5)};${2 + (i % 3)}H\x1b[?25h\x1b[?2026l`;
        fixture.shellFrame(frame(0), 'pane-codex', { full: true });
        await expect(terminal).toContainText('STABLE HEADER');
        await input.focus();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(160);
        await page.evaluate(() => {
          const rows = document.querySelector('#shellTerminal .xterm-rows'),
            fixed = rows.children[0];
          window.continuousProbe = {
            blanks: 0,
            samples: 0,
            stableRowMutations: 0,
            visibleBytes: 0,
            clears: 0,
            positions: [],
          };
          window.continuousObserver = new MutationObserver((mutations) => {
            window.continuousProbe.stableRowMutations += mutations.length;
          });
          window.continuousObserver.observe(fixed, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          const write = Terminal.prototype.write;
          Terminal.prototype.write = function (data, ...rest) {
            if (this.element) {
              const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
              window.continuousProbe.visibleBytes += new TextEncoder().encode(text).length;
              window.continuousProbe.clears += text.split('\x1b[2J').length - 1;
            }
            return write.call(this, data, ...rest);
          };
          const sample = () => {
            const probe = window.continuousProbe,
              composition = document.querySelector('#shellTerminal .composition-view.active');
            probe.samples++;
            if (!rows.textContent.includes('STABLE HEADER')) probe.blanks++;
            if (composition?.textContent) {
              const a = composition.getBoundingClientRect(),
                b = document.querySelector('#shellTerminal textarea').getBoundingClientRect();
              probe.positions.push([a.x, a.y, b.x, b.y]);
            }
            probe.frame = requestAnimationFrame(sample);
          };
          window.continuousProbe.frame = requestAnimationFrame(sample);
        });
        await input.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          el.value = 'zhongwen';
          el.dispatchEvent(
            new CompositionEvent('compositionupdate', { data: '中文候选尚未提交', bubbles: true }),
          );
          el.dispatchEvent(
            new InputEvent('input', {
              data: 'zhongwen',
              inputType: 'insertCompositionText',
              isComposing: true,
              bubbles: true,
            }),
          );
        });
        await page.waitForTimeout(80);
        const cursor = terminal.locator('.xterm-cursor');
        if (!baseline) await expect(terminal.locator('.composition-view')).toBeHidden();
        let nativeBytes = 0;
        for (let i = 1; i <= 48; i++) {
          await input.evaluate(
            (el, count) => {
              el.value = 'zhongwen'.repeat(count);
              el.dispatchEvent(
                new CompositionEvent('compositionupdate', { data: el.value, bubbles: true }),
              );
            },
            1 + (i % 12),
          );
          const data = frame(i);
          nativeBytes += Buffer.byteLength(data);
          fixture.shellFrame(data, 'pane-codex', { full: i % 6 === 0 });
          await page.waitForTimeout(24);
          if (i === 24)
            await page.screenshot({ path: path.join(output, viewport.name + '-composing.png') });
        }
        await expect(terminal).toContainText('Thinking 48');
        await expect(input).toBeFocused();
        if (!baseline) await expect(terminal.locator('.composition-view')).toBeHidden();
        const beforeCommit = (fixture.state.shellFrames || []).filter(
          (item) => item.type === 'terminal.input',
        );
        assert.equal(beforeCommit.length, 0);
        const metrics = await page.evaluate(() => {
          const probe = window.continuousProbe;
          cancelAnimationFrame(probe.frame);
          window.continuousObserver.disconnect();
          const { frame, positions, ...rest } = probe;
          const movement = Math.max(
            ...[0, 1, 2, 3].map(
              (axis) =>
                Math.max(...positions.map((p) => p[axis])) -
                Math.min(...positions.map((p) => p[axis])),
            ),
          );
          return { ...rest, positionSamples: positions.length, movement };
        });
        await fs.writeFile(
          path.join(output, viewport.name + '-metrics.json'),
          JSON.stringify(metrics, null, 2),
        );
        if (baseline) {
          assert(metrics.stableRowMutations > 0);
        } else {
          assert.equal(metrics.blanks, 0);
          assert.equal(metrics.stableRowMutations, 0);
          assert.equal(metrics.clears, 0);
          assert(metrics.movement < 1, JSON.stringify(metrics));
        }
        await input.evaluate((el) => {
          el.value = '中文';
          el.dispatchEvent(
            new CompositionEvent('compositionupdate', { data: '中文', bubbles: true }),
          );
          el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
          el.dispatchEvent(
            new InputEvent('input', { data: '中文', inputType: 'insertText', bubbles: true }),
          );
        });
        await expect
          .poll(() =>
            (fixture.state.shellFrames || [])
              .filter((item) => item.type === 'terminal.input')
              .map((item) => item.data)
              .join(''),
          )
          .toBe('中文');
        await page.waitForTimeout(100);
        assert.equal(
          (fixture.state.shellFrames || []).filter((item) => item.type === 'terminal.input').length,
          1,
        );
        await expect(cursor).toHaveCSS('visibility', 'visible');
        await input.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          el.value = 'ni';
          el.dispatchEvent(
            new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }),
          );
        });
        if (!baseline) await expect(terminal.locator('.composition-view')).toBeHidden();
        await input.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
        });
        await expect(cursor).toHaveCSS('visibility', 'visible');
        await page.waitForTimeout(100);
        assert.equal(
          (fixture.state.shellFrames || []).filter((item) => item.type === 'terminal.input').length,
          1,
        );
        assert.deepEqual(errors, []);
        results.push({
          viewport,
          baseline,
          nativeBytes,
          ...metrics,
          focused: true,
          commitExactlyOnce: true,
          events:
            'Synthetic browser composition during 48 complete TUI redraws; not a physical IME test',
        });
      } catch (error) {
        await page.screenshot({ path: path.join(output, viewport.name + '-failure.png') });
        await fs.writeFile(
          path.join(output, viewport.name + '-failure.json'),
          JSON.stringify(
            await page.evaluate(() => ({
              body: document.body.className,
              mode: document.querySelector('#chatModeToggle')?.outerHTML,
              name: document.querySelector('#chatCurrentName')?.textContent,
              shell: document.querySelector('#shellTerminal')?.outerHTML.slice(0, 1000),
              storage: { ...localStorage },
              frames: [...document.querySelectorAll('iframe')].map((frame) => frame.src),
            })),
            null,
            2,
          ),
        );
        throw error;
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
    JSON.stringify({ ok: true, before, after, baseline, results }, null, 2) + '\n',
  );
  console.log(
    `PASS ${baseline ? 'reproduced continuous redraw and IME movement' : 'stable rows and Chinese composition under continuous redraw'}: ${results.length} viewports.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

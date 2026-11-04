'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { firefox, expect } = require('@playwright/test');
const engine = firefox;
const { createFixture } = require('./chat-harness');
const root = path.resolve(__dirname, '../..');
async function run() {
  const output = path.join(root, 'artifacts/mermaid');
  await fs.mkdir(output, { recursive: true });
  const source = await fs.readFile(path.join(root, 'test/fixtures/task51-flowchart.md'), 'utf8');
  const kernelcnlSource = await fs.readFile(
    path.join(root, 'test/fixtures/kernelcnl-flowchart.md'),
    'utf8',
  );
  const csp = require('../../lib/http').securityHeaders()['content-security-policy'];
  const browser = await engine.launch({ headless: true });
  const results = [];
  try {
    for (const [name, width, height] of [
      ['mobile', 390, 844],
      ['tablet', 1024, 768],
      ['desktop', 1440, 900],
    ]) {
      const fixture = await createFixture();
      fixture.state.contentSecurityPolicy = csp;
      const context = await browser.newContext({
        viewport: { width, height },
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const errors = [],
        external = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
          errors.push(message.text());
      });
      page.on('request', (r) => {
        if (/^https?:/.test(r.url()) && !r.url().startsWith(fixture.url)) external.push(r.url());
      });
      if (name === 'mobile') {
        let failOnce = true;
        await page.route('**/vendor/mermaid/mermaid.min.js*', (route) => {
          if (failOnce) {
            failOnce = false;
            return route.abort();
          }
          return route.continue();
        });
      }
      try {
        fixture.state.sessions['pane-codex'].messages = [
          { id: 'task51-diagram', role: 'assistant', blocks: [{ kind: 'text', text: source }] },
        ];
        await page.goto(fixture.url + '/?view=chat&token=fixture');
        const message = page.locator('[data-message-id="task51-diagram"]');
        const image = message.locator('.chat-diagram img');
        if (name === 'mobile') {
          await expect(message.locator('.diagram-error')).toBeVisible();
          await expect(message.locator('code')).toContainText('flowchart TD');
          await message.locator('.diagram-error button').click();
        }
        await expect(image).toHaveCount(1, { timeout: 20000 });
        await expect(image).toBeVisible();
        await message.scrollIntoViewIfNeeded();
        const measure = await message.evaluate((el) => {
          const image = el.querySelector('img'),
            viewport = el.querySelector('.diagram-viewport');
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(image.src.split(',').slice(1).join(',')),
            'image/svg+xml',
          );
          return {
            imageWidth: image.naturalWidth,
            imageHeight: image.naturalHeight,
            viewportWidth: viewport.clientWidth,
            scrollWidth: viewport.scrollWidth,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            nodes: svg.querySelectorAll('g.node').length,
            label: svg.documentElement.textContent.replace(/\s/g, '').includes('在Ascend950上执行'),
            source: el.querySelector('code').textContent,
            detailsOpen: el.querySelector('details').open,
          };
        });
        assert.equal(measure.nodes, 7);
        assert(measure.label);
        assert(measure.imageWidth > 0 && measure.imageHeight > 0);
        assert.equal(measure.pageOverflow, 0);
        assert.equal(measure.detailsOpen, false);
        assert(measure.source.includes('flowchart TD'));
        await page.screenshot({ path: path.join(output, `after-${name}.png`) });
        const sourceLink = await message.locator('summary').boundingBox();
        const sourceRow = await message.locator('details').boundingBox();
        assert(
          sourceLink.width < sourceRow.width / 2,
          'source toggle must fit its label, not fill the row',
        );
        await page.mouse.click(
          sourceRow.x + sourceRow.width - 4,
          sourceLink.y + sourceLink.height / 2,
        );
        assert.equal(
          await message.locator('details').evaluate((el) => el.open),
          false,
          'blank row area must not expand source',
        );
        await message.locator('summary').click();
        await expect(message.locator('pre')).toBeVisible();
        await expect(message.locator('.code-copy')).toHaveCount(1);
        await message.locator('summary').click();
        const themes = [];
        for (const theme of ['default', 'light']) {
          await page.evaluate((theme) => StudioDeviceTheme.apply(theme, false), theme);
          await expect(message.locator('.chat-diagram')).toHaveAttribute('data-theme', theme);
          const colors = await image.evaluate((image) => {
            const svg = new DOMParser().parseFromString(
              decodeURIComponent(image.src.split(',').slice(1).join(',')),
              'image/svg+xml',
            );
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed;left:-10000px;visibility:hidden';
            host.append(document.importNode(svg.documentElement, true));
            document.body.append(host);
            try {
              const rect = host.querySelector('g.node rect'),
                text = host.querySelector('g.node text');
              const fill = getComputedStyle(rect).fill,
                foreground = getComputedStyle(text).fill;
              const line = getComputedStyle(host.querySelector('.flowchart-link')).stroke;
              const background = getComputedStyle(document.documentElement)
                .getPropertyValue('--bg')
                .trim();
              const expectedText = getComputedStyle(document.documentElement)
                .getPropertyValue('--text')
                .trim();
              const ctx = document.createElement('canvas').getContext('2d');
              const rgb = (value) => {
                ctx.fillStyle = value;
                return ctx.fillStyle;
              };
              const luminance = (value) => {
                const hex = rgb(value).slice(1);
                return [0, 2, 4].reduce((sum, p, i) => {
                  const v = parseInt(hex.slice(p, p + 2), 16) / 255;
                  return (
                    sum +
                    (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) *
                      [0.2126, 0.7152, 0.0722][i]
                  );
                }, 0);
              };
              const contrast = (a, b) => {
                const x = luminance(a),
                  y = luminance(b);
                return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
              };
              return {
                rawFill: fill,
                filters: svg.querySelectorAll('filter').length,
                fill: rgb(fill === 'none' ? background : fill),
                foreground: rgb(foreground),
                expectedText: rgb(expectedText),
                line: rgb(line),
                background,
                textContrast: contrast(fill === 'none' ? background : fill, foreground),
                lineContrast: contrast(background, line),
              };
            } finally {
              host.remove();
            }
          });
          assert.equal(colors.rawFill, 'none');
          assert.equal(colors.filters, 0);
          assert.equal(colors.foreground, colors.expectedText);
          assert(colors.textContrast >= 4.5, JSON.stringify(colors));
          assert(colors.lineContrast >= 3, JSON.stringify(colors));
          themes.push({ theme, ...colors });
          await page.screenshot({ path: path.join(output, `${name}-${theme}.png`) });
        }
        // Rapid switches must not allow a late old-theme render to win.
        await page.evaluate(() => {
          StudioDeviceTheme.apply('light', false);
          StudioDeviceTheme.apply('default', false);
          StudioDeviceTheme.apply('default', false);
        });
        // A matching theme label can still belong to an earlier default render.
        // Wait for this generation before checking unchanged-image reuse.
        await page.evaluate(() => StudioDiagrams.render(document.querySelector('#chatLog')));
        await expect(message.locator('.chat-diagram')).toHaveAttribute('data-theme', 'default');
        // Unchanged refreshes must reuse the image, not enqueue a new render.
        const stableSource = await image.getAttribute('src');
        await page.evaluate(async () => {
          window.dispatchEvent(new Event('herdr:themechange'));
          window.dispatchEvent(new Event('herdr:themechange'));
          await StudioDiagrams.render(document.querySelector('#chatLog'));
        });
        assert.equal(
          await image.getAttribute('src'),
          stableSource,
          'identical theme notifications must preserve the rendered image',
        );
        await page.evaluate(() => StudioDiagrams.render(document.querySelector('#chatLog')));
        assert.equal(await image.getAttribute('src'), stableSource);
        // Exercise the Markdown/rendering entrypoints in the real chat DOM.
        const cases = [
          ['kernelcnl', kernelcnlSource, 'image'],
          ['invalid', '```mermaid\nflowchart TD\nA[broken\n```', 'error'],
          ['unfinished', '```mermaid\nflowchart TD\nA-->B', 'source'],
          ['ordinary', '```js\nflowchart TD\n```', 'source'],
          ['sequence', '```mermaid\nsequenceDiagram\nAlice->>Bob: hello\n```', 'image'],
          [
            'untrusted',
            '```mermaid\n%%{init: {"securityLevel":"loose", "htmlLabels":true}}%%\nflowchart TD\nA["<img src=x onerror=alert(1)>"]\nclick A "javascript:alert(1)"\n```',
            'image',
          ],
        ];
        for (const [id, text, expected] of cases) {
          await page.evaluate(
            ({ id, text }) => {
              const wrapper = document.createElement('div');
              wrapper.id = `diagram-test-${id}`;
              wrapper.className = 'chat-md';
              wrapper.append(StudioMarkdown.renderMarkdown(text));
              document.querySelector('#chatLog').append(wrapper);
              StudioDiagrams.render(document.querySelector('#chatLog'));
            },
            { id, text },
          );
          const wrapper = page.locator(`#diagram-test-${id}`);
          if (expected === 'image')
            await expect(wrapper.locator('.chat-diagram img')).toHaveCount(1, { timeout: 10000 });
          if (id === 'kernelcnl') {
            const graph = await wrapper.locator('img').evaluate((img) => {
              const svg = new DOMParser().parseFromString(
                decodeURIComponent(img.src.split(',').slice(1).join(',')),
                'image/svg+xml',
              );
              return {
                nodes: svg.querySelectorAll('g.node').length,
                text: svg.documentElement.textContent,
              };
            });
            assert.equal(graph.nodes, 7);
            assert(graph.text.includes('KernelCNL'));
            assert(graph.text.includes('CANNBench'));
            await wrapper.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(output, `${name}-kernelcnl.png`) });
          }
          if (expected === 'error') {
            await expect(wrapper.locator('.diagram-error')).toHaveCount(1);
            await expect(wrapper.locator('code')).toContainText('A[broken');
            for (const theme of ['light', 'default']) {
              // Emulate a failed earlier rendering generation retained in the
              // same pre; retry must replace every stale error, never stack it.
              await wrapper.evaluate((el) => {
                el.querySelector('pre').prepend(el.querySelector('.diagram-error').cloneNode(true));
              });
              await wrapper.locator('.diagram-error button').last().click();
              await expect(wrapper.locator('.diagram-error')).toHaveCount(1);
              await page.evaluate((theme) => StudioDeviceTheme.apply(theme, false), theme);
              await expect(page.locator('.diagram-measure')).toHaveCount(0);
              await expect(wrapper.locator('.diagram-error')).toHaveCount(1);
            }
          }
          if (expected === 'source') {
            await expect(wrapper.locator('pre')).toHaveCount(1);
            await expect(wrapper.locator('.chat-diagram')).toHaveCount(0);
          }
          if (id === 'unfinished') {
            await wrapper.evaluate((el, text) => {
              el.replaceChildren(StudioMarkdown.renderMarkdown(text + '\n```'));
              StudioDiagrams.render(document.querySelector('#chatLog'));
            }, text);
            await expect(wrapper.locator('.chat-diagram img')).toHaveCount(1);
          }
          assert.equal(
            await wrapper.locator('script, iframe, [onerror], a[href^="javascript:"]').count(),
            0,
          );
          await wrapper.evaluate((el) => el.remove());
        }
        // A reader 24px above the end is not following the bottom. Diagram
        // completion must obey the same scroll owner as streamed chat updates.
        const readingTop = await page.evaluate((text) => {
          const log = document.querySelector('#chatLog'),
            node = document.createElement('div');
          node.id = 'diagram-reading-position';
          node.append(StudioMarkdown.renderMarkdown(text));
          log.append(node);
          log.style.overflowAnchor = 'none';
          log.scrollTop = log.scrollHeight - log.clientHeight - 24;
          const top = log.scrollTop;
          StudioDiagrams.render(log);
          return top;
        }, kernelcnlSource);
        await expect(page.locator('#diagram-reading-position .chat-diagram img')).toHaveCount(1);
        const restoredTop = await page.locator('#chatLog').evaluate((el) => el.scrollTop);
        assert(
          Math.abs(restoredTop - readingTop) < 1,
          'diagram completion must preserve a near-bottom reading position',
        );
        await page.locator('#diagram-reading-position').evaluate((el) => {
          el.remove();
          document.querySelector('#chatLog').style.removeProperty('overflow-anchor');
        });
        // A pending render removed by a session switch may not reattach itself.
        await page.evaluate(() => {
          const log = document.querySelector('#chatLog'),
            node = document.createElement('div');
          node.id = 'removed-diagram';
          node.append(StudioMarkdown.renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```'));
          log.append(node);
          StudioDiagrams.render(log);
          node.remove();
        });
        await expect(page.locator('.diagram-measure')).toHaveCount(0);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual(fixture.state.unexpected, []);
        results.push({
          name,
          ...measure,
          themes,
          cases: cases.map((c) => c[0]),
          nearBottomReadingStable: true,
          pageErrors: errors,
          externalRequests: external,
        });
      } catch (error) {
        console.error(JSON.stringify({ name, errors, external }, null, 2));
        throw error;
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(
    path.join(root, 'artifacts/mermaid/report.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      results.map(({ source, ...result }) => result),
      null,
      2,
    ),
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

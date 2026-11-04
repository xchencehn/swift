'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { firefox, expect } = require('@playwright/test');
const { createFixture } = require('./chat-harness');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const baseline = process.argv.includes('--baseline');
const output = path.resolve(
  process.env.SWIFT_TOOL_PRESENTATION_OUTPUT || 'artifacts/testing/tool-presentation',
  baseline ? 'before' : 'browser',
);
function fixtures() {
  const tool = (id, name, input, result, extra = {}) => ({
    id,
    name,
    detail: input.file_path || input.pattern || input.cmd || name,
    input: { text: typeof input === 'string' ? input : JSON.stringify(input) },
    result: { text: result },
    ...extra,
  });
  return [
    tool(
      'read',
      'Read',
      { file_path: 'src/chat/会话视图.ts', offset: 18, limit: 24 },
      'export const title = "会话";',
    ),
    tool(
      'search',
      'Grep',
      { pattern: 'sessionId', path: 'src', output_mode: 'content' },
      'src/chat/session.ts:18:const sessionId = current.id;\nsrc/chat/session.ts-19:return sessionId;\n--\nsrc/chat/session.ts:42:restore(sessionId);\nsrc/chat/会话视图.ts:7:render(sessionId);',
    ),
    tool(
      'edit',
      'Edit',
      {
        file_path: 'src/chat/session.ts',
        old_string: 'function restore(id) {\n  return cache[id];\n}',
        new_string:
          'function restore(id) {\n  const session = cache.get(id);\n  return session ?? null;\n}',
      },
      'File updated successfully.',
    ),
    tool(
      'patch',
      'apply_patch',
      '*** Begin Patch\n*** Update File: src/theme.css\n@@\n .tool-row {\n-  padding: 8px;\n+  padding: 6px 8px;\n }\n*** End Patch',
      'Success. Updated src/theme.css.',
    ),
    tool('failed', 'Grep', { pattern: 'sessionId', path: 'private' }, 'Permission denied', {
      failed: true,
    }),
    tool('failed-shell', 'exec', 'await runChecks()', 'command failed', {
      outcome: { exitCode: 1, output: 'command failed' },
    }),
    tool('unknown', 'custom_tool', { value: '<img src=x onerror=alert(1)>' }, '原始结果完整保留。'),
  ];
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1024, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
    ]) {
      const fixture = await createFixture();
      fixture.state.productionPresentation = true;
      const items = fixtures();
      const command =
        "python3 - <<'PY'\n" +
        Array.from({ length: 80 }, (_, i) => `print("implementation line ${i}")`).join('\n') +
        '\nPY';
      const fullCommand = {
        id: 'command-envelope',
        name: 'exec',
        action: { verb: 'Ran', command },
        input: { text: 'text(await tools.exec_command({cmd:' + JSON.stringify(command) + '}));' },
        result: {
          text: JSON.stringify([
            { type: 'input_text', text: 'Script completed\nWall time 1.3 seconds\nOutput:\n' },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: 'fixture',
                wall_time_seconds: 1,
                session_id: 78038,
                output: '',
              }),
            },
            {
              type: 'input_text',
              text: JSON.stringify({
                exit_code: 1,
                output:
                  'checked input\n'.repeat(100) +
                  'ERROR: required report is missing\nChecked 9 tasks; 1 needs attention.',
              }),
            },
          ]),
        },
        failed: true,
      };
      const commandPreview = {
        ...fullCommand,
        input: {
          ...fullCommand.input,
          text: fullCommand.input.text.slice(0, 512),
          truncated: true,
        },
        result: {
          text: fullCommand.result.text.slice(0, 512),
          truncated: true,
          preview: require('../../public/chat/tool-presentation').outputPreview(
            fullCommand.result.text,
          ),
        },
      };
      items.push(commandPreview);
      items.push({
        ...items[1],
        id: 'truncated',
        result: { text: 'src/chat/session.ts:18:preview', truncated: true },
      });
      for (const provider of ['codex', 'claude'])
        fixture.state.sessions['pane-' + provider].messages = [
          {
            id: 'intro',
            role: 'user',
            blocks: [{ kind: 'text', text: '核对会话恢复逻辑，并调整工具记录的阅读体验。' }],
          },
          {
            id: 'reply',
            role: 'assistant',
            blocks: [
              {
                kind: 'text',
                text: '已检查会话身份与缓存路径。下面是相关搜索结果和文件修改，原始记录可以随时查看。',
              },
              { kind: 'tools', items },
            ],
          },
        ];
      const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width <= 1024,
          serviceWorkers: 'block',
        }),
        page = await context.newPage(),
        errors = [];
      await context.addInitScript(() =>
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (text) => {
              window.copiedToolText = text;
            },
          },
        }),
      );
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
        await expect(page.locator('details.chat-tool-row')).toHaveCount(items.length);
        await page.locator('#commandInput').fill('保留我的草稿');
        const search = page.locator('[data-tool-key="pane-codex:search"]'),
          edit = page.locator('[data-tool-key="pane-codex:edit"]');
        await search.locator(':scope > summary').click();
        await edit.locator(':scope > summary').click();
        await page.screenshot({ path: path.join(output, viewport.width + '-dark.png') });
        if (!baseline) {
          const commandRow = page.locator('[data-tool-key="pane-codex:command-envelope"]');
          let commandReads = 0;
          await page.route('**/api/tool?*', async (route) => {
            if (new URL(route.request().url()).searchParams.get('id') !== 'command-envelope')
              return route.fallback();
            commandReads++;
            await route.fulfill({
              status: commandReads === 1 ? 503 : 200,
              contentType: 'application/json',
              body: JSON.stringify(
                commandReads === 1 ? { message: '暂时无法读取，请重试。' } : { tool: fullCommand },
              ),
            });
          });
          await commandRow.locator(':scope > summary').click();
          const commandBody = commandRow.locator('.tool-body');
          await expect(commandBody).toContainText('ERROR: required report is missing');
          await expect(commandBody).toContainText('Checked 9 tasks; 1 needs attention.');
          await expect(commandBody).toContainText('退出码：1');
          await expect(commandBody).not.toContainText('input_text');
          await expect(commandBody).not.toContainText('implementation line');
          await expect(commandBody).not.toContainText('tools.exec_command');
          await expect(commandBody.locator('.codex-real')).toHaveCount(0);
          assert.equal(commandReads, 0);
          await commandBody.getByRole('button', { name: '复制', exact: true }).first().click();
          assert.match(
            await page.evaluate(() => window.copiedToolText),
            /ERROR: required report is missing/,
          );
          await commandRow.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(output, viewport.width + '-command-preview.png'),
          });
          await commandBody.getByRole('button', { name: '加载完整详情' }).click();
          await expect(commandBody.locator('.tool-load-error')).toBeVisible();
          await commandBody.getByRole('button', { name: '重试加载' }).click();
          await expect(commandBody.locator('pre').first()).toHaveText(fullCommand.input.text);
          await expect(commandBody.locator('pre').last()).toHaveText(fullCommand.result.text);
          await commandBody.getByRole('button', { name: '复制', exact: true }).last().click();
          assert.equal(await page.evaluate(() => window.copiedToolText), fullCommand.result.text);
          assert.equal(commandReads, 2);
          await commandRow.locator(':scope > summary').click();
          await expect(search.locator('.tool-search-file')).toHaveCount(2);
          await expect(edit.locator('.tool-diff-line.added')).toHaveCount(2);
          await expect(edit.locator('.tool-diff-line.removed')).toHaveCount(1);
          await expect(edit.locator('.tool-original')).not.toHaveAttribute('open');
          await edit.locator('.tool-original > summary').click();
          await expect(edit.locator('.tool-original')).toContainText('old_string');
          await edit.locator('.tool-original > summary').click();
          await expect(page.locator('[data-tool-key="pane-codex:failed"]')).toHaveAttribute(
            'data-status',
            'failed',
          );
          await expect(
            page.locator('[data-tool-key="pane-codex:failed-shell"] .chat-tools-mark'),
          ).toHaveAttribute('aria-label', '执行失败');
          assert.equal(await page.locator('.tool-body img').count(), 0);
          // Full detail loads once on request; failures remain local and retryable.
          let calls = 0;
          await page.route('**/api/tool?*', async (route) => {
            calls++;
            await route.fulfill({
              status: calls === 1 ? 503 : 200,
              contentType: 'application/json',
              body: JSON.stringify(
                calls === 1
                  ? { message: '暂时无法读取，请重试。' }
                  : { tool: { ...items[1], id: 'truncated' } },
              ),
            });
          });
          const truncated = page.locator('[data-tool-key="pane-codex:truncated"]');
          await truncated.locator(':scope > summary').click();
          await truncated.getByRole('button', { name: '加载完整详情' }).click();
          await expect(truncated.locator('.tool-load-error')).toBeVisible();
          await truncated.getByRole('button', { name: '重试加载' }).click();
          await expect(truncated.locator('.tool-search-file')).toHaveCount(2);
          assert.equal(calls, 2);
          await truncated.locator(':scope > summary').click();
          // Read-only navigation uses the owning pane cwd, preserving the chat and draft.
          await page.route('**/api/workspace-files/content?*', (route) =>
            route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                path: '/fixture/project/src/chat/session.ts',
                kind: 'code',
                text: 'const sessionId = current.id;',
                size: 27,
              }),
            }),
          );
          await search.locator('.tool-file-link').first().click();
          await expect(page.locator('#workspaceFilesPage')).toBeVisible();
          await expect(page.locator('.workspace-file-view')).toContainText('const sessionId');
          await page.keyboard.press('Escape');
          await expect(page.locator('#workspaceFilesPage')).toBeHidden();
          await expect(page.locator('#commandInput')).toHaveValue('保留我的草稿');
          // Other-provider rendering and retained disclosure must not transfer drafts.
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator('#chatPickerList [data-pane-id="pane-claude"]').click();
          const claude = page.locator('[data-tool-key="pane-claude:search"]');
          await expect(claude).toBeVisible();
          await claude.locator(':scope > summary').click();
          await expect(claude.locator('.tool-search-file')).toHaveCount(2);
          if (viewport.width <= 760) await page.locator('#chatDrawerToggle').click();
          await page.locator('#chatPickerList [data-pane-id="pane-codex"]').click();
          await expect(search).toHaveAttribute('open', '');
          await expect(page.locator('#commandInput')).toHaveValue('保留我的草稿');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(
            await search
              .locator('.tool-chevron')
              .evaluate((el) => getComputedStyle(el).transitionDuration),
            '0s',
          );
        }
        const geometry = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - innerWidth,
          rows: [...document.querySelectorAll('.chat-tool-row')].map((e) =>
            e.getBoundingClientRect().toJSON(),
          ),
        }));
        assert.equal(geometry.overflow, 0);
        await page.evaluate(() => window.StudioDeviceTheme.apply('light', false));
        await page.addStyleTag({ content: ':root{--device-font-scale:1.3 !important}' });
        await page.screenshot({ path: path.join(output, viewport.width + '-light.png') });
        await expect(page.locator('#commandInput')).toHaveValue('保留我的草稿');
        assert(!fixture.state.requests.some((r) => r.route === 'POST /api/messages'));
        assert.deepEqual(errors, []);
        results.push({ viewport, geometry, ok: true });
      } finally {
        await context.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, viewports: results.length, output }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

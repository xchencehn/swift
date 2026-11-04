'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
async function run(page, { expect, viewport, output, directory, delaySave }) {
  const file = path.join(directory, 'knowledge/guide.md'),
    original = await fs.readFile(file, 'utf8');
  const view = page.locator('.workspace-file-view:not([hidden])'),
    editor = view.locator('.cm-content[contenteditable="true"]');
  const source = () => view.locator('.cm-editor').evaluate((node) => node.studioEditor.getText());
  const replace = async (text) => {
    await editor.press('Control+a');
    await page.keyboard.insertText(text);
    await expect.poll(source).toBe(text);
  };
  const finish = () => page.locator('.workspace-file-cancel').click();
  const copy = page.locator('.workspace-file-copy'),
    outline = view.locator('.workspace-file-outline');
  await page.evaluate(() => {
    window.originalFileClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.fileCopied = text;
        },
      },
    });
  });
  await copy.click();
  await expect(copy).toHaveAttribute('data-copy-state', 'done');
  assert.equal(await page.evaluate(() => window.fileCopied), original, '复制应保留 Markdown 原文');
  const adjacent = await copy.evaluate(
    (node) =>
      node.nextElementSibling?.classList.contains('copy-feedback') &&
      node.nextElementSibling.nextElementSibling?.classList.contains('workspace-file-download'),
  );
  assert(adjacent, '全文复制紧邻下载');
  const compact = await view.evaluate((node) => node.clientWidth <= 760);
  await expect(page.locator('.message-navigation')).toBeHidden();
  if (compact) {
    await expect(outline).toBeHidden();
    await page.locator('.workspace-file-outline-toggle').click();
  }
  await expect(outline).toBeVisible();
  await expect(outline.locator('.workspace-outline-link')).toHaveCount(4);
  await outline.getByRole('button', { name: '检查结果', exact: true }).click();
  await expect
    .poll(() => view.locator('.workspace-markdown-reader').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(500);
  if (compact) await expect(outline).toBeHidden();
  const reader = view.locator('.workspace-markdown-reader');
  assert.equal(await outline.locator('[aria-current]').textContent(), '检查结果');
  let readingWidth = null;
  if (!viewport.touch) {
    const handle = view.locator('.workspace-markdown-resizer');
    await expect(handle).toBeVisible();
    const before = await view
      .locator('.workspace-file-document')
      .evaluate((node) => node.getBoundingClientRect().width);
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 20);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + 20, { steps: 8 });
    await page.mouse.up();
    const dragged = await view
      .locator('.workspace-file-document')
      .evaluate((node) => node.getBoundingClientRect().width);
    assert(Math.abs(dragged - (before - 80)) <= 2, JSON.stringify({ before, dragged }));
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    const keyboard = await view
      .locator('.workspace-file-document')
      .evaluate((node) => node.getBoundingClientRect().width);
    assert(Math.abs(keyboard - dragged - 20) <= 2);
    await page.keyboard.press('Home');
    assert.equal(
      await page
        .locator('#workspaceFilesPage')
        .evaluate((node) => node.style.getPropertyValue('--workspace-markdown-width')),
      '',
    );
    await page.keyboard.press('ArrowRight');
    readingWidth = await page
      .locator('#workspaceFilesPage')
      .evaluate((node) => node.style.getPropertyValue('--workspace-markdown-width'));
    assert(readingWidth.endsWith('px'));
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--chat-content-width'),
      ),
      '',
      '文件调宽不改变聊天宽度',
    );
  }
  await reader.evaluate((node) => {
    node.scrollTop = 0;
  });
  if (compact) await page.locator('.workspace-file-outline-toggle').click();
  await page.screenshot({ path: path.join(output, `${viewport.name}-markdown-layout.png`) });
  if (compact) await outline.getByRole('button', { name: '收起目录' }).click();
  const theme = await page.evaluate(() => window.StudioDeviceTheme.current().id);
  await page.evaluate(() => window.StudioDeviceTheme.apply('light', false));
  await page.screenshot({ path: path.join(output, `${viewport.name}-markdown-light.png`) });
  await page.evaluate((value) => window.StudioDeviceTheme.apply(value, false), theme);
  await page.getByRole('link', { name: '完整文件', exact: true }).click();
  await expect(view).toContainText('这份材料还有更多内容');
  await copy.click();
  await expect(copy).toHaveAttribute('data-copy-state', 'done');
  const complete = await fs.readFile(path.join(directory, 'large.txt'), 'utf8');
  assert.equal(await page.evaluate(() => window.fileCopied), complete);
  await page.locator('.workspace-file-edit').click();
  await expect(editor).toBeVisible();
  assert.equal(await source(), complete, '编辑截断预览必须读取完整原件');
  await finish();
  await page.getByRole('button', { name: '关闭 large.txt', exact: true }).click();
  await page.getByRole('link', { name: '空文件', exact: true }).click();
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveAttribute('data-copy-state', 'done');
  assert.equal(await page.evaluate(() => window.fileCopied), '');
  await page.getByRole('button', { name: '关闭 empty.txt', exact: true }).click();
  await page.getByRole('link', { name: '打开代码', exact: true }).click();
  await expect(view.locator('.cm-editor')).toHaveAttribute('data-language', 'JavaScript');
  await page.evaluate(() => {
    window.originalCodeEditor = document.querySelector(
      '.workspace-file-view:not([hidden]) .cm-editor',
    );
  });
  await page.locator('.workspace-file-edit').click();
  await expect(editor).toBeVisible();
  assert(
    await page.evaluate(
      () =>
        window.originalCodeEditor ===
        document.querySelector('.workspace-file-view:not([hidden]) .cm-editor'),
    ),
    '进入编辑必须沿用当前代码视图',
  );
  assert.equal(await view.locator('textarea').count(), 0, '文件页不得再出现独立textarea');
  const codeOriginal = await fs.readFile(path.join(directory, 'example.js'), 'utf8');
  await editor.press('Control+Home');
  await editor.press('Tab');
  assert.notEqual(await source(), codeOriginal);
  await editor.press('Shift+Tab');
  await expect.poll(source).toBe(codeOriginal);
  await editor.press('Control+f');
  await expect(view.locator('.cm-search input[name="search"]')).toBeVisible();
  await view.locator('.cm-search input[name="search"]').fill('value');
  await page.keyboard.press('Escape');
  await expect(page.locator('#workspaceFilesPage')).toBeVisible();
  await expect(view.locator('.cm-search')).toHaveCount(0);
  await editor.press('Control+End');
  await page.keyboard.insertText('\n// 原位修改');
  const codeModified = codeOriginal + '\n// 原位修改';
  await expect.poll(source).toBe(codeModified);
  await editor.press('Control+z');
  await expect.poll(source).toBe(codeOriginal);
  await editor.press('Control+y');
  await expect.poll(source).toBe(codeModified);
  await editor.press('Control+z');
  await expect.poll(source).toBe(codeOriginal);
  await editor.press('Control+Shift+Z');
  await expect.poll(source).toBe(codeModified);
  const position = await view.locator('.workspace-code-position').textContent();
  await editor.press('Control+s');
  await expect(view.locator('.workspace-editor-notice')).toHaveText('文件已保存。');
  await expect(page.locator('.workspace-file-save')).toBeDisabled();
  assert.equal(await fs.readFile(path.join(directory, 'example.js'), 'utf8'), codeModified);
  await expect(editor).toBeVisible();
  assert.equal(await view.locator('.workspace-code-position').textContent(), position);
  assert(
    await page.evaluate(
      () =>
        window.originalCodeEditor ===
        document.querySelector('.workspace-file-view:not([hidden]) .cm-editor'),
    ),
    '保存不得重建代码视图',
  );
  await page.screenshot({ path: path.join(output, `${viewport.name}-inline-code-editor.png`) });
  await editor.press('Control+End');
  await page.keyboard.insertText('\n// 慢保存前');
  const submitted = codeModified + '\n// 慢保存前';
  delaySave(350);
  await editor.press('Control+s');
  await page.keyboard.insertText('，保存期间继续输入');
  const continued = submitted + '，保存期间继续输入';
  await expect.poll(source).toBe(continued);
  await expect(page.locator('.workspace-file-save')).toBeEnabled();
  assert.equal(
    await fs.readFile(path.join(directory, 'example.js'), 'utf8'),
    submitted,
    '每次保存只提交按下保存时的内容',
  );
  await expect(view.locator('.workspace-editor-notice')).toHaveText('有未保存的修改。');
  delaySave(0);
  await editor.press('Control+s');
  await expect(view.locator('.workspace-editor-notice')).toHaveText('文件已保存。');
  assert.equal(await fs.readFile(path.join(directory, 'example.js'), 'utf8'), continued);
  await replace(codeOriginal);
  await editor.press('Control+s');
  await expect(view.locator('.workspace-editor-notice')).toHaveText('文件已保存。');
  await expect(page.locator('.workspace-file-save')).toBeDisabled();
  await finish();
  await page.getByRole('tab', { name: 'guide.md', exact: true }).click();
  await page.locator('.workspace-file-edit').click();
  await expect(editor).toBeVisible();
  assert.equal(await source(), original);
  await expect(view.locator('.cm-editor')).toHaveAttribute('data-language', 'Markdown');
  const modified =
    original + '\n本轮修改：' + viewport.name + '\n<script>window.fileEditExecuted=true</script>\n';
  await replace(modified);
  await expect(page.locator('.workspace-file-tab.modified')).toHaveCount(1);
  await page.getByRole('tab', { name: 'example.js', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('tab', { name: 'guide.md', exact: true }).click();
  await expect.poll(source).toBe(modified);
  await page.getByRole('button', { name: '关闭 example.js', exact: true }).click();
  await expect.poll(source).toBe(modified);
  await page.screenshot({ path: path.join(output, `${viewport.name}-editor.png`) });
  await page.evaluate(() => {
    window.markdownEditor = document.querySelector('.workspace-file-view:not([hidden]) .cm-editor');
  });
  await editor.press('Control+s');
  await expect(page.locator('.workspace-file-save')).toBeDisabled();
  await expect(editor).toBeVisible();
  await expect(view.locator('.workspace-editor-notice')).toHaveText('文件已保存。');
  assert(
    await page.evaluate(
      () =>
        window.markdownEditor ===
        document.querySelector('.workspace-file-view:not([hidden]) .cm-editor'),
    ),
    'Markdown保存后仍在同一源码编辑器',
  );
  assert.equal(await fs.readFile(file, 'utf8'), modified);
  await replace(modified + '\n未保存');
  await page.locator('.workspace-file-reload').click();
  await expect(page.locator('#chatDialog')).toBeVisible();
  await page.locator('#chatDialogCancel').click();
  await expect.poll(source).toBe(modified + '\n未保存');
  await page.getByRole('button', { name: '关闭 guide.md', exact: true }).click();
  await expect(page.locator('#chatDialog')).toBeVisible();
  await page.locator('#chatDialogCancel').click();
  await expect.poll(source).toBe(modified + '\n未保存');
  await finish();
  await page.locator('#chatDialogConfirm').click();
  await expect(editor).toHaveCount(0);
  assert.equal(await fs.readFile(file, 'utf8'), modified);
  await page.locator('.workspace-file-edit').click();
  const conflictDraft = modified + '\n网页修改';
  await replace(conflictDraft);
  await fs.writeFile(file, modified + '\n外部更新');
  await page.locator('.workspace-file-save').click();
  await expect(view.locator('.workspace-editor-notice')).toContainText('文件已被其他程序修改');
  assert.equal(await source(), conflictDraft);
  assert((await fs.readFile(file, 'utf8')).endsWith('外部更新'));
  await copy.click();
  await expect(copy).toHaveAttribute('data-copy-state', 'done');
  assert.equal(await page.evaluate(() => window.fileCopied), conflictDraft);
  await page.screenshot({ path: path.join(output, `${viewport.name}-conflict.png`) });
  await finish();
  await page.locator('#chatDialogConfirm').click();
  await page.locator('.workspace-file-reload').click();
  await expect.poll(source).toContain('外部更新');
  await fs.writeFile(file, original);
  await page.locator('.workspace-file-reload').click();
  await expect.poll(source).toBe(original);
  await page.locator('.workspace-file-source').click();
  await expect(view.locator('h1')).toHaveText('文件浏览');
  assert.equal(await page.evaluate(() => window.fileEditExecuted), undefined);
  await reader.evaluate((node) => {
    node.scrollTop = 0;
  });
  assert.equal(
    await page
      .locator('#workspaceFilesPage')
      .evaluate(() => document.documentElement.scrollWidth - innerWidth),
    0,
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: window.originalFileClipboard,
    });
  });
  return {
    inlineCodeEditor: true,
    markdownSourceMode: true,
    noTextarea: true,
    sameEditorAfterSave: true,
    typingDuringSave: true,
    snapshotSave: true,
    indentAndOutdent: true,
    undoRedo: true,
    search: true,
    externalConflict: true,
    dirtyTabsPreserved: true,
    discardConfirmed: true,
    fullAndEmptyCopy: true,
    outline: true,
    readingWidth,
  };
}
module.exports = { run };

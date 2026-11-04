'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { imageBlock, textImages, imageSources, readImage } = require('../lib/chat-images');
const { parseTranscript, textOnly } = require('../lib/agent-transcript');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hoAAAAASUVORK5CYII=';
const data = `data:image/png;base64,${png}`;
test('工具回传的图片不画进聊天流，消息响应里也不带它（2026-09-24）', () => {
  const lines = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'image-call',
        name: 'functions.wait',
        arguments: '{}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'image-call',
        output: [
          { type: 'input_text', text: 'Script completed\nOutput:' },
          { type: 'input_image', image_url: data, detail: 'high' },
          {
            type: 'input_text',
            text: 'Generated images are saved to /private/logo.png by default.',
          },
        ],
      },
    },
  ].map(JSON.stringify);
  const messages = textOnly(parseTranscript('codex', lines));
  assert.deepEqual(
    messages[0].blocks.map((block) => block.kind),
    ['tools'],
  );
  assert.equal(messages[0].blocks[0].items[0].images, undefined);
  assert(!JSON.stringify(messages).includes(png));
  assert.equal(imageSources(messages).size, 0);
});
test('Claude：用户发的图片照常显示；Read 读回的图片不画进聊天流，也不把工具回传显示成用户消息', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
  const messages = textOnly(
    parseTranscript(
      'claude',
      [
        { type: 'user', message: { content: [image] } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'img', name: 'Read', input: { file_path: '/image.png' } },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: [image] }] },
        },
      ].map(JSON.stringify),
    ),
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].blocks[0].kind, 'image');
  assert.deepEqual(
    messages[1].blocks.map((block) => block.kind),
    ['tools'],
  );
});
test('本地图片链接和附件路径转为图片块，代码与不安全链接保持正文', () => {
  const text =
    '前文\n![logo](</tmp/a b.png>)\n[下载原图](/tmp/logo.png)\n附件：照片.jpg\n文件路径："/tmp/photo.jpg"\n后文';
  const blocks = textImages(text);
  assert.equal(blocks.filter((block) => block.kind === 'image').length, 3);
  for (const source of [
    '`![图](/tmp/image.png)`',
    '```md\n![图](/tmp/image.png)\n```',
    '![x](javascript:bad)',
    '![x](/tmp/image.svg)',
    '/etc/shadow',
  ]) {
    assert.deepEqual(textImages(source), [{ kind: 'text', text: source }]);
  }
  assert.equal(imageBlock('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(imageBlock('data:image/png;base64,SGVsbG8='), null);
});
test('图片只读取会话已记录的普通文件，拒绝越过索引、符号链接和伪装内容', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-images-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logo.png');
  await fs.writeFile(file, Buffer.from(png, 'base64'));
  const block = imageBlock(file, 'logo'),
    sources = imageSources([{ blocks: [block] }]);
  const read = await readImage(sources, block.id);
  assert.deepEqual(read.bytes, Buffer.from(png, 'base64'));
  await assert.rejects(readImage(sources, 'another-id'), { code: 'IMAGE_NOT_IN_SESSION' });
  await fs.rename(file, path.join(dir, 'real.png'));
  await fs.symlink(path.join(dir, 'real.png'), file);
  await assert.rejects(readImage(sources, block.id), { code: 'INVALID_IMAGE_PATH' });
  await fs.unlink(file);
  await fs.writeFile(file, '<script>bad</script>');
  await assert.rejects(readImage(sources, block.id), { code: 'INVALID_IMAGE' });
});

test('file image MIME follows actual bytes when a messaging app gives PNG a jpg filename', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-image-mime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mmexport.jpg'),
    bytes = Buffer.from(png, 'base64');
  await fs.writeFile(file, bytes);
  const block = imageBlock(file),
    sources = imageSources([{ blocks: [block] }]);
  const result = await readImage(sources, block.id);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.bytes, bytes);
  assert.equal(block.source.mime, 'image/jpeg', 'reading does not mutate the archived source hint');
  await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await assert.rejects(readImage(sources, block.id), { code: 'INVALID_IMAGE' });
});

test('only the configured attachment root alias is accepted; nested links and unindexed images remain rejected', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-image-alias-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real'),
    alias = path.join(dir, 'alias');
  await fs.mkdir(path.join(real, 'attachments', 'upload'), { recursive: true });
  await fs.symlink(real, alias);
  const file = path.join(alias, 'attachments', 'upload', 'photo.jpg'),
    bytes = Buffer.from(png, 'base64');
  await fs.writeFile(file, bytes);
  const block = imageBlock(file),
    sources = imageSources([{ blocks: [block] }]);
  const options = { attachmentsDirectory: path.join(alias, 'attachments') };
  await assert.rejects(readImage(sources, block.id), { code: 'INVALID_IMAGE_PATH' });
  const result = await readImage(sources, block.id, options);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(readImage(sources, 'not-in-history', options), {
    code: 'IMAGE_NOT_IN_SESSION',
  });
  await assert.rejects(
    readImage(sources, block.id, { attachmentsDirectory: path.join(alias, 'other') }),
    { code: 'INVALID_IMAGE_PATH' },
  );
  // The configured storage alias does not grant permission to follow uploaded links.
  const outside = path.join(dir, 'outside.jpg');
  await fs.writeFile(outside, bytes);
  await fs.unlink(file);
  await fs.symlink(outside, file);
  await assert.rejects(readImage(sources, block.id, options), { code: 'INVALID_IMAGE_PATH' });
  await fs.unlink(file);
  await fs.rm(path.join(real, 'attachments', 'upload'), { recursive: true });
  await fs.mkdir(path.join(dir, 'other-upload'));
  await fs.writeFile(path.join(dir, 'other-upload', 'photo.jpg'), bytes);
  await fs.symlink(path.join(dir, 'other-upload'), path.join(real, 'attachments', 'upload'));
  await assert.rejects(readImage(sources, block.id, options), { code: 'INVALID_IMAGE_PATH' });
});

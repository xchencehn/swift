'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sandbox, DocumentPreview } = require('../../../lib/document-preview');
const { safeFile } = require('../../../lib/doc-files');

async function createMediaFiles(directory) {
  await fs.mkdir(path.join(directory, 'home'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'source.rtf'),
    '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Liberation Sans;}}\\f0\\fs48 Swift document preview\\par Page one\\page Page two}',
  );
  const namespaces =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
  await fs.writeFile(
    path.join(directory, 'slides.fodp'),
    `<?xml version="1.0"?><office:document ${namespaces} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation>${[1, 2].map((n) => `<draw:page draw:name="Slide${n}"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="10cm"><draw:text-box><text:p>Swift presentation: slide ${n}</text:p></draw:text-box></draw:frame></draw:page>`).join('')}</office:presentation></office:body></office:document>`,
  );
  await fs.writeFile(
    path.join(directory, 'sheet.fods'),
    `<?xml version="1.0"?><office:document ${namespaces} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet>${['Summary', 'Details'].map((name) => `<table:table table:name="${name}"><table:table-row><table:table-cell office:value-type="string"><text:p>${name}</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell></table:table-row></table:table>`).join('')}</office:spreadsheet></office:body></office:document>`,
  );
  for (const [source, formats] of [
    ['source.rtf', ['docx', 'doc']],
    ['slides.fodp', ['pptx', 'ppt']],
    ['sheet.fods', ['xlsx', 'xls']],
  ]) {
    for (const format of formats) {
      await sandbox(directory, '/usr/bin/libreoffice', [
        '-env:UserInstallation=file:///work/fixture-profile',
        '--headless',
        '--convert-to',
        format,
        '--outdir',
        '/work',
        '/work/' + source,
      ]);
      const converted = path.join(directory, path.parse(source).name + '.' + format);
      await fs.rename(converted, path.join(directory, '示例 文件.' + format));
    }
  }
  const preview = await new DocumentPreview().get(
    safeFile(directory, path.join(directory, 'source.rtf')),
  );
  await fs.writeFile(path.join(directory, '分页 报告.pdf'), preview.pdf);
  await fs.writeFile(
    path.join(directory, '架构 图片.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#294353"/><text x="48" y="180" fill="white" font-size="36" font-family="sans-serif">Swift image preview</text></svg>',
  );
  const length = 22050 * 2,
    wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(length * 2, 40);
  await fs.writeFile(path.join(directory, '录音 示例.wav'), wav);
  await promisify(execFile)('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x294353:s=320x180:r=12:d=2',
    '-c:v',
    'libvpx',
    '-threads',
    '1',
    '-y',
    path.join(directory, '演示 视频.webm'),
  ]);
  const files = (await fs.readdir(directory)).filter((name) =>
    /^(示例|分页|架构|录音|演示)/.test(name),
  );
  return files.map((name) => path.join(directory, name));
}
module.exports = { createMediaFiles };

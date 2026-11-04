/* 会话文件的类型与 MIME 由服务端和客户端共用。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioFileTypes = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const groups = {
    markdown: { label: 'Markdown', types: { md: 'text/markdown', markdown: 'text/markdown' } },
    text: { label: '文本', types: { txt: 'text/plain' } },
    html: { label: 'HTML', types: { html: 'text/html', htm: 'text/html' } },
    pdf: { label: 'PDF', types: { pdf: 'application/pdf' } },
    image: {
      label: '图片',
      types: {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        avif: 'image/avif',
        ico: 'image/vnd.microsoft.icon',
      },
    },
    video: {
      label: '视频',
      types: {
        mp4: 'video/mp4',
        m4v: 'video/mp4',
        webm: 'video/webm',
        ogv: 'video/ogg',
        mov: 'video/quicktime',
        mkv: 'video/x-matroska',
      },
    },
    audio: {
      label: '音频',
      types: {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        opus: 'audio/ogg',
        flac: 'audio/flac',
      },
    },
    presentation: {
      label: 'PowerPoint',
      types: {
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
        odp: 'application/vnd.oasis.opendocument.presentation',
      },
    },
    word: {
      label: 'Word',
      types: {
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        docm: 'application/vnd.ms-word.document.macroEnabled.12',
        odt: 'application/vnd.oasis.opendocument.text',
        rtf: 'application/rtf',
      },
    },
    spreadsheet: {
      label: 'Excel',
      types: {
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
        ods: 'application/vnd.oasis.opendocument.spreadsheet',
      },
    },
  };
  const KINDS = {},
    MIME = {},
    LABELS = {};
  for (const [kind, group] of Object.entries(groups)) {
    LABELS[kind] = group.label;
    for (const [extension, mime] of Object.entries(group.types)) {
      KINDS['.' + extension] = kind;
      MIME['.' + extension] = mime;
    }
  }
  const extension = (file) =>
    String(file || '')
      .split(/[\\/]/)
      .pop()
      .match(/\.[^.]+$/)?.[0]
      .toLowerCase() || '';
  return {
    KINDS,
    MIME,
    LABELS,
    kindOf: (file) => KINDS[extension(file)] || null,
    paginated: (kind) => ['pdf', 'presentation', 'word', 'spreadsheet'].includes(kind),
  };
});

'use strict';

// Read-only title formatting; Herdr tab labels remain native layout metadata.
/**
 * 从一个完整名字里裁出短语。
 *
 * 优先在子句边界断开（标点、破折号、竖线），短语本来就该到一个意群为止；
 * 边界都在很后面时才按字符硬截，并标上省略号说明还有下文。
 */
function shortPhrase(value, limit = 20) {
  const line = String(value || '')
    .trim()
    .split('\n')[0]
    .trim();
  if (!line) return '';
  const trim = (text) => text.replace(/[\s。．.！!？?，,、；;：:·\-—|｜/]+$/u, '').trim();
  const characters = Array.from(line);
  if (characters.length <= limit) return trim(line) || trim(characters.slice(0, limit).join(''));
  const head = characters.slice(0, limit + 1).join('');
  const boundary = head.search(/[。．！!？?，,、；;：:·—|｜]/u);
  // 边界太靠前裁出来的是个词不是短语，那还不如按长度截。
  if (boundary >= 6) return trim(head.slice(0, boundary));
  return `${trim(characters.slice(0, limit).join(''))}…`;
}

module.exports = { shortPhrase };

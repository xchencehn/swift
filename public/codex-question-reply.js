(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioCodexQuestionReply = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const OPEN = '<send_user_message_question_reply>',
    CLOSE = '</send_user_message_question_reply>';

  // A quoted protocol example is ordinary text, including in an unfinished fence.
  function codeRanges(text) {
    const ranges = [];
    let offset = 0,
      fence = null;
    for (const line of text.split('\n')) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!fence) fence = { start: offset, char: match[1][0], length: match[1].length };
        else if (
          match[1][0] === fence.char &&
          match[1].length >= fence.length &&
          !match[2].trim()
        ) {
          ranges.push([fence.start, offset + line.length]);
          fence = null;
        }
      }
      offset += line.length + 1;
    }
    if (fence) ranges.push([fence.start, text.length]);
    return ranges;
  }

  function parts(value) {
    const text = String(value || '');
    if (!text.includes(OPEN)) return [{ kind: 'text', text }];
    const protectedRanges = codeRanges(text),
      result = [];
    const pattern = /^<send_user_message_question_reply>/gm;
    let cursor = 0,
      match;
    while ((match = pattern.exec(text))) {
      if (protectedRanges.some(([start, end]) => match.index >= start && match.index < end))
        continue;
      let end = text.indexOf(CLOSE, pattern.lastIndex),
        replies = null;
      // A literal closing tag inside a JSON string is content, not the envelope end.
      while (end >= 0) {
        try {
          const items = JSON.parse(text.slice(pattern.lastIndex, end));
          if (
            Array.isArray(items) &&
            items.length &&
            items.every(
              (item) =>
                item &&
                typeof item === 'object' &&
                typeof item.question === 'string' &&
                typeof item.answer === 'string',
            )
          )
            replies = items;
        } catch {
          /* Incomplete or non-protocol content stays readable verbatim. */
        }
        if (replies) break;
        end = text.indexOf(CLOSE, end + CLOSE.length);
      }
      if (!replies) continue;
      if (match.index > cursor)
        result.push({ kind: 'text', text: text.slice(cursor, match.index) });
      for (const item of replies)
        result.push({
          kind: 'question_reply',
          question: item.question,
          answer: item.answer,
          ...(typeof item.questionItemId === 'string'
            ? { questionItemId: item.questionItemId }
            : {}),
        });
      cursor = end + CLOSE.length;
      pattern.lastIndex = cursor;
    }
    if (cursor < text.length || !result.length)
      result.push({ kind: 'text', text: text.slice(cursor) });
    return result;
  }
  function plainText(value) {
    const result = parts(value);
    if (!result.some((part) => part.kind === 'question_reply')) return String(value || '');
    return result
      .map((part) =>
        part.kind === 'question_reply'
          ? `问题：${part.question}\n回答：${part.answer}`
          : part.text.trim(),
      )
      .filter(Boolean)
      .join('\n\n');
  }
  return { parts, plainText };
});

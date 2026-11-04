'use strict';
const fs = require('node:fs/promises');
const { parseTranscript, textOnly } = require('./agent-transcript');
const { CodexLineage } = require('./codex-lineage');
const codexLineage = new CodexLineage();

// Read complete UTF-8 lines backwards. Tool outputs can exceed a block; retain
// fragments until the line is complete without repeatedly copying a long line.
async function* reverseLines(file) {
  const handle = await fs.open(file, 'r');
  try {
    let position = (await handle.stat()).size,
      fragments = [];
    while (position > 0) {
      const length = Math.min(position, 64 * 1024),
        buffer = Buffer.alloc(length);
      position -= length;
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      let end = bytesRead;
      while (end > 0) {
        const newline = buffer.lastIndexOf(10, end - 1);
        fragments.push(buffer.subarray(newline + 1, end));
        if (newline < 0) break;
        yield Buffer.concat(fragments.reverse()).toString('utf8');
        fragments = [];
        end = newline;
      }
    }
    if (fragments.length) yield Buffer.concat(fragments.reverse()).toString('utf8');
  } finally {
    await handle.close();
  }
}
function spoken(messages) {
  return textOnly(messages).filter((m) =>
    m.blocks.some((b) => b.kind === 'text' || b.kind === 'image'),
  );
}
async function lastUtterance(file, provider) {
  if (provider === 'codex') {
    const inherited = await codexLineage.read(file);
    if (inherited)
      return Date.parse(spoken(parseTranscript(provider, inherited.lines)).at(-1)?.ts || '') || 0;
  }
  for await (const line of reverseLines(file)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      provider === 'codex' &&
      entry.type === 'event_msg' &&
      entry.payload?.type === 'thread_rolled_back'
    ) {
      // A rollback can remove the apparent last message. Apply the authoritative
      // full history adapter only for this file, not every closed conversation.
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      return Date.parse(spoken(parseTranscript(provider, lines)).at(-1)?.ts || '') || 0;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    const message =
      provider === 'codex' ? entry.type === 'response_item' && entry.payload : entry.message;
    if (!['user', 'assistant'].includes(message?.role)) continue;
    const latest = spoken(parseTranscript(provider, [line])).at(-1);
    if (latest) return Date.parse(latest.ts || '') || 0;
  }
  return 0;
}
module.exports = { lastUtterance, reverseLines };

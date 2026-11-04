'use strict';
// Read-only archive measurement. Writes only the explicitly supplied report
// directory. Never contacts Herdr, a model service, or a terminal input path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const { AsyncConversationStore } = require('../../lib/async-conversation-store');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf('=');
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
const file = path.resolve(args.file),
  output = path.resolve(args.output);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const semantic = (messages) => ({
  text: messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind !== 'tools')
      .map((block) => [message.role, message.kind || null, block]),
  ),
  tools: messages.flatMap((message) =>
    message.blocks
      .filter((block) => block.kind === 'tools')
      .flatMap((block) =>
        block.items.map((item) => [
          item.id,
          item.running,
          item.failed,
          item.statusUnknown,
          item.input,
          item.result,
        ]),
      ),
  ),
});
const sample = async (work) => {
  const start = performance.now(),
    value = await work();
  return {
    value,
    ms: Math.round((performance.now() - start) * 100) / 100,
    bytes: v8.serialize(value).byteLength,
  };
};
async function main() {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const before = fs.statSync(file),
    store = new AsyncConversationStore({ indexFile: path.join(output, 'index.sqlite') });
  const report = {
    at: new Date().toISOString(),
    file,
    journalBytes: before.size,
    node: process.version,
    readOnlyNativeArchive: true,
  };
  try {
    let expected;
    if (args.baseline) {
      const Old = require(
          path.join(path.resolve(args.baseline), 'lib/async-conversation-store'),
        ).AsyncConversationStore,
        old = new Old();
      try {
        const result = await sample(() => old.read(file, 'codex'));
        report.baseline = { ms: result.ms, transferredBytes: result.bytes };
        expected = semantic(result.value.conversation);
      } finally {
        await old.close();
      }
    }
    const cold = await sample(() => store.page(file, 'codex'));
    report.cold = {
      ms: cold.ms,
      transferredBytes: cold.bytes,
      messages: cold.value.messages.length,
      total: cold.value.total,
    };
    const warm = [];
    for (let i = 0; i < 5; i++) {
      const read = await sample(() => store.page(file, 'codex'));
      warm.push({ ms: read.ms, transferredBytes: read.bytes });
    }
    report.warm = warm;
    if (expected) {
      let page = cold.value,
        messages = page.messages;
      while (page.hasMore) {
        page = await store.page(file, 'codex', {
          before: messages[0].id,
          limit: 100,
          revision: page.historyRevision,
        });
        messages = page.messages.concat(messages);
      }
      const actual = semantic(messages);
      assert.equal(
        digest(actual),
        digest(expected),
        'The complete indexed transcript must retain the native text and tool results',
      );
      report.semanticVerification = {
        ok: true,
        textBlocks: actual.text.length,
        toolCalls: actual.tools.length,
        digest: digest(actual),
      };
    }
    const after = fs.statSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    report.nativeArchiveUnchanged = true;
  } finally {
    await store.close();
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { CodexLineage, rolloutIdentity } = require('../lib/codex-lineage');
const sourceRoot = path.resolve(__dirname, '..');
const { parseTranscript } = require(path.join(sourceRoot, 'lib/agent-transcript'));
const { stableId } = require(path.join(sourceRoot, 'lib/conversation-state'));
const SESSION = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const raw = (value) => JSON.stringify(value);
const meta = (id = SESSION, base = null) =>
  raw({
    ordinal: base?.end_ordinal_exclusive || 0,
    type: 'session_meta',
    payload: { id, history_mode: 'paginated', ...(base ? { history_base: base } : {}) },
  });
const user = (ordinal, text) =>
  raw({
    ordinal,
    timestamp: '2026-10-24T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
const text = (lines) => lines.join('\n') + '\n';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-lineage-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sessions', '2026', '10', '24');
  await fs.mkdir(directory, { recursive: true });
  const file = (rolloutId = SESSION, sessionId = SESSION) =>
    path.join(
      directory,
      `rollout-2026-10-24T01-02-03-${sessionId}${rolloutId === sessionId ? '' : '_' + rolloutId}.jsonl`,
    );
  const aLines = [meta(), user(1, '保留中文前缀'), user(2, '应当移除')];
  const a = file();
  await fs.writeFile(a, text(aLines));
  const base = {
    thread_id: SESSION,
    end_ordinal_exclusive: 2,
    end_byte_offset: Buffer.byteLength(text(aLines.slice(0, 2))),
  };
  const b = file(B),
    bLines = [meta(SESSION, base), user(3, '编辑后发送')];
  await fs.writeFile(b, text(bLines));
  return { home, file, a, b, aLines, bLines, base };
}
test('immutable UUID comes from branch suffix, never logical session or timestamp', () => {
  assert.deepEqual(rolloutIdentity(`/x/rollout-2026-10-24T01-02-03-${SESSION}_${B}.jsonl.zst`), {
    sessionId: SESSION,
    rolloutId: B,
  });
});
test('exact byte prefix keeps original raw IDs and excludes replaced message', async (t) => {
  const f = await fixture(t),
    value = await new CodexLineage().read(f.b);
  assert.deepEqual(value.lines, [f.bLines[0], f.aLines[1], f.bLines[1]]);
  const messages = parseTranscript('codex', value.lines).filter(
    (message) => message.role === 'user',
  );
  assert.deepEqual(
    messages.map((m) => m.id),
    [`user-${stableId(f.aLines[1])}`, `user-${stableId(f.bLines[1])}`],
  );
  assert.equal(
    messages.some((m) => JSON.stringify(m).includes('应当移除')),
    false,
  );
});
test('nested revert follows immutable parent after logical thread selected path changes', async (t) => {
  const f = await fixture(t),
    c = f.file(C);
  const base = {
    thread_id: B,
    end_ordinal_exclusive: 4,
    end_byte_offset: Buffer.byteLength(text(f.bLines)),
  };
  const cLines = [meta(SESSION, base), user(5, '再编辑')];
  await fs.writeFile(c, text(cLines));
  assert.deepEqual((await new CodexLineage().read(c)).lines, [
    cLines[0],
    f.aLines[1],
    f.bLines[1],
    cLines[1],
  ]);
});
test('forked ancestor may belong to another logical thread', async (t) => {
  const f = await fixture(t),
    c = f.file(C, OTHER);
  const lines = [meta(OTHER, f.base), user(3, '另一个会话')];
  await fs.writeFile(c, text(lines));
  assert.deepEqual((await new CodexLineage().read(c)).lines, [lines[0], f.aLines[1], lines[1]]);
});
test('a later revert can refer directly to an older ancestor and abandon intermediate branch', async (t) => {
  const f = await fixture(t),
    c = f.file(C),
    lines = [meta(SESSION, f.base), user(3, '直接从祖先继续')];
  await fs.writeFile(c, text(lines));
  const value = await new CodexLineage().read(c);
  assert.equal(value.lines.includes(f.bLines[1]), false);
  assert.deepEqual(value.lines, [lines[0], f.aLines[1], lines[1]]);
});
test('metadata-only child shows retained prefix immediately before any new send', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.b, text(f.bLines.slice(0, 1)));
  assert.deepEqual((await new CodexLineage().read(f.b)).lines, [f.bLines[0], f.aLines[1]]);
});
test('archived source is located by its immutable ID, not the newest same-session branch', async (t) => {
  const f = await fixture(t),
    archive = path.join(f.home, 'archived_sessions');
  await fs.mkdir(archive);
  await fs.rename(f.a, path.join(archive, path.basename(f.a)));
  const value = await new CodexLineage().read(f.b);
  assert.deepEqual(value.lines, [f.bLines[0], f.aLines[1], f.bLines[1]]);
});
test('compressed source offsets apply to decoded UTF8 bytes, not compressed bytes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.a + '.zst', zlib.zstdCompressSync(Buffer.from(text(f.aLines))));
  await fs.unlink(f.a);
  assert.deepEqual((await new CodexLineage().read(f.b)).lines, [
    f.bLines[0],
    f.aLines[1],
    f.bLines[1],
  ]);
});
test('missing source, cycle, oversized offsets, line split and ordinal mismatch fail closed', async (t) => {
  for (const kind of ['missing', 'cycle', 'past-end', 'split-line', 'ordinal'])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        base = { ...f.base };
      if (kind === 'missing') base.thread_id = C;
      if (kind === 'cycle') base.thread_id = B;
      if (kind === 'past-end') base.end_byte_offset += 1e6;
      if (kind === 'split-line') base.end_byte_offset--;
      if (kind === 'ordinal') base.end_ordinal_exclusive = 1;
      await fs.writeFile(
        f.b,
        text([meta(SESSION, base), user(base.end_ordinal_exclusive + 1, 'replacement')]),
      );
      await assert.rejects(new CodexLineage().read(f.b), { code: 'ARCHIVE_LINEAGE_INVALID' });
    });
});
test('ancestor version participates in cache signature, even when leaf stat is unchanged', async (t) => {
  const f = await fixture(t),
    loader = new CodexLineage(),
    before = await loader.inspect(f.b);
  await fs.writeFile(f.a, text([f.aLines[0], user(1, '更改中文前缀'), f.aLines[2]]));
  // Same-sized writes can share one filesystem timestamp tick. This test
  // requires a changed ancestor version while the leaf remains untouched.
  const ancestor = await fs.stat(f.a);
  await fs.utimes(f.a, ancestor.atime, new Date(ancestor.mtimeMs + 1000));
  const after = await loader.inspect(f.b);
  assert.notEqual(after.signature, before.signature);
  assert.equal(after.version.mtimeMs, before.version.mtimeMs);
});
test('moving an immutable source into archived_sessions refreshes the cached path', async (t) => {
  const f = await fixture(t),
    loader = new CodexLineage();
  await loader.read(f.b);
  const archive = path.join(f.home, 'archived_sessions');
  await fs.mkdir(archive);
  await fs.rename(f.a, path.join(archive, path.basename(f.a)));
  assert.deepEqual((await loader.read(f.b)).lines, [f.bLines[0], f.aLines[1], f.bLines[1]]);
});
test('symlink source escapes and duplicate immutable IDs are rejected', async (t) => {
  const f = await fixture(t),
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-lineage-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rename(f.a, path.join(outside, path.basename(f.a)));
  await fs.symlink(path.join(outside, path.basename(f.a)), f.a);
  await assert.rejects(new CodexLineage().read(f.b), { code: 'ARCHIVE_LINEAGE_INVALID' });
  await fs.unlink(f.a);
  await fs.writeFile(f.a, text(f.aLines));
  const duplicate = path.join(path.dirname(f.a), `rollout-2026-10-24T04-05-06-${SESSION}.jsonl`);
  await fs.writeFile(duplicate, text(f.aLines));
  await assert.rejects(new CodexLineage().read(f.b), { code: 'ARCHIVE_LINEAGE_INVALID' });
});
test('bounded decoded bytes and lineage depth reject rather than truncate history', async (t) => {
  const f = await fixture(t);
  await assert.rejects(new CodexLineage({ maxBytes: 30 }).read(f.b), { code: 'ARCHIVE_LIMIT' });
  await assert.rejects(new CodexLineage({ maxSegments: 1 }).read(f.b), { code: 'ARCHIVE_LIMIT' });
});
test('standalone legacy input retains the original single-file reader', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-lineage-legacy-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'fixture.jsonl');
  await fs.writeFile(file, text([user(1, 'old archive')]));
  assert.equal((await new CodexLineage().inspect(file)).segments, null);
  assert.equal(await new CodexLineage().read(file), null);
});

test('duplicate and regressed ordinals are skipped; unknown outer records do not consume ordinals', async (t) => {
  const f = await fixture(t),
    rows = [
      f.bLines[0],
      user(3, '有效'),
      user(3, '重复'),
      user(2, '倒退'),
      raw({ ordinal: 4, type: 'future_record', payload: {} }),
      user(4, '未来记录后的有效项'),
    ];
  await fs.writeFile(f.b, text(rows));
  const value = await new CodexLineage().read(f.b);
  assert.deepEqual(value.lines, [f.bLines[0], f.aLines[1], rows[1], rows[5]]);
});
test('unchanged reads do not reread payloads or scan directories; leaf append reuses inherited parsed lines', async (t) => {
  const f = await fixture(t),
    loader = new CodexLineage(),
    originalStream = require('node:fs').createReadStream,
    originalDirectory = fs.readdir,
    originalParse = JSON.parse;
  const counts = { streams: [], directories: 0, ancestorParse: 0 };
  require('node:fs').createReadStream = (file, options) => {
    counts.streams.push(file);
    return originalStream(file, options);
  };
  fs.readdir = (...args) => {
    counts.directories++;
    return originalDirectory(...args);
  };
  JSON.parse = (value) => {
    if (value === f.aLines[1]) counts.ancestorParse++;
    return originalParse(value);
  };
  t.after(() => {
    require('node:fs').createReadStream = originalStream;
    fs.readdir = originalDirectory;
    JSON.parse = originalParse;
  });
  await loader.read(f.b);
  counts.streams = [];
  counts.directories = 0;
  counts.ancestorParse = 0;
  await loader.read(f.b);
  await loader.read(f.b);
  await loader.inspect(f.b);
  assert.deepEqual(counts, { streams: [], directories: 0, ancestorParse: 0 });
  await fs.appendFile(f.b, text([user(4, '追加')]));
  await loader.read(f.b);
  assert.equal(counts.directories, 0);
  assert.equal(counts.ancestorParse, 0);
  assert.equal(counts.streams.includes(f.a), false);
});
test('a second SessionMeta in one fragment is rejected rather than replacing head identity', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.b, text([meta(OTHER, f.base)]));
  await assert.rejects(new CodexLineage().read(f.b), { code: 'ARCHIVE_LINEAGE_INVALID' });
});

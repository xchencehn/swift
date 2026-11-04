'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConversationStore } = require('../lib/conversation-store');
const { AsyncConversationStore } = require('../lib/async-conversation-store');
const { SessionMetadata } = require('../lib/session-metadata');
const { lastUtterance } = require('../lib/history-recency');
const ID = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
const json = JSON.stringify;
const all = (lines) => lines.join('\n') + '\n';
const meta = (base) =>
  json({
    ordinal: base?.end_ordinal_exclusive || 0,
    type: 'session_meta',
    payload: {
      id: ID,
      cwd: '/fixture/workspace',
      history_mode: 'paginated',
      ...(base ? { history_base: base } : {}),
    },
  });
const user = (ordinal, text) =>
  json({
    ordinal,
    timestamp: '2026-10-24T01:02:03.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-lineage-store-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const d = path.join(home, 'sessions/2026/10/24');
  await fs.mkdir(d, { recursive: true });
  const a = path.join(d, `rollout-2026-10-24T01-02-03-${ID}.jsonl`),
    b = path.join(d, `rollout-2026-10-24T01-02-04-${ID}_${B}.jsonl`);
  const aLines = [meta(), user(1, 'original'), user(2, 'abandoned')];
  await fs.writeFile(a, all(aLines));
  const base = {
    thread_id: ID,
    end_ordinal_exclusive: 2,
    end_byte_offset: Buffer.byteLength(all(aLines.slice(0, 2))),
  };
  const bLines = [meta(base), user(3, 'edited')];
  await fs.writeFile(b, all(bLines));
  return { a, b, aLines, bLines };
}
for (const Store of [ConversationStore, AsyncConversationStore])
  test(`${Store.name} shares inherited history for messages, control lines, IDs and worker projections`, async (t) => {
    const f = await fixture(t),
      store = new Store();
    if (store.close) t.after(() => store.close());
    const first = await store.read(f.b, 'codex', ['messages', 'conversation', 'lines', 'archive']);
    assert.deepEqual(
      first.messages.map((x) => x.blocks[0].text),
      ['original', 'edited'],
    );
    assert.equal(first.lines.filter((l) => JSON.parse(l).type === 'session_meta').length, 1);
    assert.equal(first.archive.activeIds.size, 2);
    const firstIDs = first.messages.map((x) => x.id);
    await fs.appendFile(f.b, all([user(4, 'appended')]));
    const next = await store.read(f.b, 'codex', ['messages', 'conversation', 'lines', 'archive']);
    assert.deepEqual(
      next.messages.slice(0, 2).map((x) => x.id),
      firstIDs,
    );
    assert.equal(first.messages.length, 2);
    assert.equal(next.messages.length, 3);
    if (Store === ConversationStore) assert.equal(first.messages[0], next.messages[0]);
  });
for (const Store of [ConversationStore, AsyncConversationStore])
  test(`${Store.name} invalidates unchanged-leaf cache after ancestor rewrite`, async (t) => {
    const f = await fixture(t),
      store = new Store();
    if (store.close) t.after(() => store.close());
    const first = await store.read(f.b, 'codex');
    const signature = await store.sourceSignature(f.b, 'codex');
    await fs.writeFile(f.a, all([f.aLines[0], user(1, 'replaced'), f.aLines[2]]));
    assert.notEqual(await store.sourceSignature(f.b, 'codex'), signature);
    const next = await store.read(f.b, 'codex');
    assert.deepEqual(
      next.messages.map((x) => x.blocks[0].text),
      ['replaced', 'edited'],
    );
    assert.equal(first.messages[0].blocks[0].text, 'original');
  });
test('metadata-only child keeps inherited title and recency without a new user send', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.b, all(f.bLines.slice(0, 1)));
  const metadata = new SessionMetadata();
  metadata.conversations = new ConversationStore();
  const result = await metadata.read(f.b, 'codex');
  assert.equal(result.contentTitle, 'original');
  assert.equal(await lastUtterance(f.b, 'codex'), Date.parse('2026-10-24T01:02:03.000Z'));
});

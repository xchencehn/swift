'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RewindInteraction } = require('../lib/rewind-interaction');
const { rewindHistory, digest } = require('../lib/codex-rewind-history');
const { parseCodexTranscript, textOnly } = require('../lib/agent-transcript');
const encode = (entries, { historyMode = 'paginated' } = {}) =>
  [{ type: 'session_meta', payload: { id: 'thread', history_mode: historyMode } }, ...entries].map(
    (entry, ordinal) =>
      JSON.stringify({
        timestamp: `2026-10-24T00:00:${String(ordinal).padStart(2, '0')}.000Z`,
        ordinal,
        ...entry,
      }),
  );
const start = (turn_id) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id } });
const user = (id, text, kinds = ['user.text']) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text }],
    ...(kinds === null
      ? {}
      : { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } }),
  },
});
const receipt = (turn_id, id, text) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    turn_id,
    item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
  },
});
const reviewMarker = (turn_id, id, type) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', turn_id, item: { type, id } },
});
const done = (turn_id) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id } });
const journal = () =>
  encode([
    start('turn-a'),
    user('m-a', 'same'),
    receipt('turn-a', 'native-a', 'same'),
    done('turn-a'),
    start('turn-b'),
    user('m-b', '中文第一行\n第二行：保留多个  空格。'),
    receipt('turn-b', 'native-b', '中文第一行\n第二行：保留多个  空格。'),
    done('turn-b'),
    start('turn-c'),
    user('m-c', 'same'),
    receipt('turn-c', 'native-c', 'same'),
    done('turn-c'),
  ]);

test('history maps repeated text to exact original message IDs and stable native ordering', () => {
  const lines = journal(),
    history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(
    history.targets.map((target) => [
      target.messageId,
      target.turnId,
      target.visibleIndex,
      target.nativeUserItemId,
    ]),
    [
      ['m-a', 'turn-a', 0, 'native-a'],
      ['m-b', 'turn-b', 1, 'native-b'],
      ['m-c', 'turn-c', 2, 'native-c'],
    ],
  );
  assert(history.targets.every((target) => target.supported));
  const added = [
    ...lines,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'assistant-progress',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'More reasoning' }],
      },
    }),
  ];
  assert.equal(rewindHistory(added, parseCodexTranscript(added)).revision, history.revision);
});

test('raw text paths remain editable when Swift derives image blocks', () => {
  const text = '查看图片\n\n附件：image.png\n文件路径："/tmp/image.png"';
  const lines = encode([
    start('turn'),
    user('m', text),
    receipt('turn', 'native', text),
    done('turn'),
  ]);
  const parsed = textOnly(parseCodexTranscript(lines)),
    history = rewindHistory(lines, parsed);
  assert(parsed[0].blocks.some((block) => block.kind === 'image'));
  assert.equal(history.complete, true);
  assert.equal(history.targets[0].supported, true);
  assert.equal(history.targets[0].sourceText, text);
});

test('multiple native text chunks refill their exact concatenated message without adding newlines', () => {
  const source = user('chunked', 'first');
  source.payload.content.push({ type: 'input_text', text: '第二段\n末尾' });
  const native = receipt('turn', 'native-chunked', 'first');
  native.payload.item.content.push({ type: 'text', text: '第二段\n末尾' });
  const lines = encode([start('turn'), source, native, done('turn')]),
    history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.equal(history.targets[0].supported, true);
  assert.equal(history.targets[0].sourceText, 'first第二段\n末尾');
});

test('explicit environment metadata is excluded and legacy native receipts retain exact mapping', () => {
  const lines = encode(
    [
      start('turn'),
      user('env', '<environment_context>data</environment_context>', [
        'environments.environment_context',
      ]),
      user('old', 'legacy text', null),
      { type: 'event_msg', payload: { type: 'user_message', message: 'legacy text' } },
      done('turn'),
    ],
    { historyMode: 'legacy' },
  );
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(
    history.targets.map((target) => target.messageId),
    ['old'],
  );
  assert.equal(history.targets[0].supported, true);
  assert.equal(history.targets[0].nativeUserItemId, null);
  assert.equal(
    history.targets[0].nativeReceiptRecordId,
    require('../lib/conversation-state').stableId(
      lines.find((line) => JSON.parse(line).payload?.type === 'user_message'),
    ),
  );
});

test('old metadata without kinds or native receipts does not consume a native selector position', () => {
  const lines = encode(
    [
      start('turn'),
      user('old-env', '<environment_context>old metadata</environment_context>', null),
      user('human', 'actual input', null),
      { type: 'event_msg', payload: { type: 'user_message', message: 'actual input' } },
      done('turn'),
    ],
    { historyMode: 'legacy' },
  );
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(history.excludedMessageIds, ['old-env']);
  assert.deepEqual(
    history.targets.map((target) => [target.messageId, target.visibleIndex]),
    [['human', 0]],
  );
});

test('authorization kinds do not invent a native cell and positive native receipts outrank contextual labels', () => {
  const lines = encode([
    start('turn-a'),
    user('unreceived-human-kinds', 'context only'),
    done('turn-a'),
    start('turn-b'),
    user('native-context-like-input', '<environment_context>user text</environment_context>', [
      'environments.environment_context',
    ]),
    receipt('turn-b', 'real-native', '<environment_context>user text</environment_context>'),
    done('turn-b'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(history.excludedMessageIds, ['unreceived-human-kinds']);
  assert.deepEqual(
    history.targets.map((target) => [target.messageId, target.visibleIndex]),
    [['native-context-like-input', 0]],
  );
  assert.equal(history.targets[0].nativeUserItemId, 'real-native');
});

test('empty and CSI-only native user cells do not consume a Browsing selector position', () => {
  const lines = encode([
    start('turn-empty'),
    user('empty', '\n \t'),
    receipt('turn-empty', 'native-empty', '\n \t'),
    done('turn-empty'),
    start('turn-ansi'),
    user('ansi', '\u001b[31m\u001b[0m'),
    receipt('turn-ansi', 'native-ansi', '\u001b[31m\u001b[0m'),
    done('turn-ansi'),
    start('turn-visible'),
    user('visible', 'actual input'),
    receipt('turn-visible', 'native-visible', 'actual input'),
    done('turn-visible'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(history.excludedMessageIds, ['empty', 'ansi']);
  assert.deepEqual(
    history.targets.map((target) => [target.messageId, target.visibleIndex]),
    [['visible', 0]],
  );
});

test('started and completed native user lifecycle records map to one stable selector item', () => {
  const started = receipt('turn', 'native-user', 'actual input');
  started.payload.type = 'item_started';
  const rawUser = user(undefined, 'actual input');
  delete rawUser.payload.id;
  const lines = encode([
    start('turn'),
    rawUser,
    started,
    receipt('turn', 'native-user', 'actual input'),
    done('turn'),
  ]);
  const messages = parseCodexTranscript(lines),
    history = rewindHistory(lines, messages);
  assert.equal(history.complete, true);
  assert.equal(history.targets.length, 1);
  assert.equal(history.targets[0].messageId, messages[0].id);
  assert.match(messages[0].id, /^user-[a-f0-9]{24}$/);
  assert.equal(history.targets[0].nativeUserItemId, 'native-user');
});

test('unsupported native images retain their native position without blocking another exact text target', () => {
  const image = user('image', 'caption', ['user.text', 'user.image']);
  image.payload.content.push({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
  const lines = encode([
    start('image-turn'),
    image,
    receipt('image-turn', 'native-image', 'caption'),
    done('image-turn'),
    start('text-turn'),
    user('text', 'plain'),
    receipt('text-turn', 'native-text', 'plain'),
    done('text-turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.equal(history.targets[0].supported, false);
  assert.equal(history.targets[0].visibleIndex, 0);
  assert.equal(history.targets[1].supported, true);
  assert.equal(history.targets[1].visibleIndex, 1);
});

test('unmapped native events and duplicate stable message IDs cannot authorize selection', () => {
  const lines = [...journal(), JSON.stringify(receipt('unknown-turn', 'unmapped', 'extra'))];
  assert.equal(rewindHistory(lines, parseCodexTranscript(lines)).complete, false);
  const duplicate = encode([
    start('a'),
    user('same-id', 'a'),
    receipt('a', 'na', 'a'),
    done('a'),
    start('b'),
    user('same-id', 'b'),
    receipt('b', 'nb', 'b'),
    done('b'),
  ]);
  assert.equal(rewindHistory(duplicate, parseCodexTranscript(duplicate)).complete, false);
});

test('duplicate native user identities across turns cannot be used to attach a hidden source to a visible message', () => {
  const lines = encode([
    start('first-turn'),
    user('first', 'same body'),
    receipt('first-turn', 'duplicate-native', 'same body'),
    done('first-turn'),
    start('review-turn'),
    reviewMarker('review-turn', 'enter-review', 'EnteredReviewMode'),
    user('hidden', 'same body'),
    receipt('review-turn', 'duplicate-native', 'same body'),
    reviewMarker('review-turn', 'exit-review', 'ExitedReviewMode'),
    done('review-turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, false);
  assert(history.issues.some((issue) => issue.code === 'DUPLICATE_NATIVE_USER_ID'));
});

test('two unpaired identical source records cannot be assigned one native receipt by text alone', () => {
  const lines = encode([
    start('turn'),
    user('first-id', 'identical'),
    user('second-id', 'identical'),
    receipt('turn', 'one-native-item', 'identical'),
    done('turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, false);
  assert(history.issues.some((issue) => issue.code === 'NATIVE_USER_ORDER_UNVERIFIED'));
});

test('interleaved model context does not take the native receipt of one unique original user message', () => {
  const lines = encode([
    start('turn'),
    user('human', 'actual user input'),
    user('context', '<environment_context>injected context</environment_context>', null),
    receipt('turn', 'native-human', 'actual user input'),
    done('turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(
    history.targets.map((target) => target.messageId),
    ['human'],
  );
  assert.equal(history.targets[0].nativeUserItemId, 'native-human');
});

test('a primary prompt can rewind its whole turn while native steers are rejected independently', () => {
  const lines = encode([
    start('one-turn'),
    user('original', 'primary'),
    receipt('one-turn', 'native-original', 'primary'),
    user('steer', '追加'),
    receipt('one-turn', 'native-steer', '追加'),
    done('one-turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.equal(history.targets[0].supported, true);
  assert.equal(history.targets[0].isSteer, false);
  assert.equal(history.targets[1].supported, false);
  assert.equal(history.targets[1].isSteer, true);
  assert.equal(history.targets[1].visibleIndex, 1);
});

test('an invisible initial input still makes the next input in that turn a native steer', () => {
  const lines = encode([
    start('one-turn'),
    user('empty', ''),
    receipt('one-turn', 'native-empty', ''),
    user('visible', 'steer after empty input'),
    receipt('one-turn', 'native-visible', 'steer after empty input'),
    done('one-turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(
    history.targets.map((target) => target.messageId),
    ['visible'],
  );
  assert.equal(history.targets[0].isSteer, true);
  assert.equal(history.targets[0].supported, false);
});

test('native review mode hides its internal prompt without disabling later editable messages', () => {
  const lines = encode([
    start('review-turn'),
    user('before', 'review this change'),
    receipt('review-turn', 'native-before', 'review this change'),
    reviewMarker('review-turn', 'enter-review', 'EnteredReviewMode'),
    user('internal', 'internal review input'),
    receipt('review-turn', 'native-internal', 'internal review input'),
    reviewMarker('review-turn', 'exit-review', 'ExitedReviewMode'),
    done('review-turn'),
    start('later-turn'),
    user('after', 'normal later input'),
    receipt('later-turn', 'native-after', 'normal later input'),
    done('later-turn'),
  ]);
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.deepEqual(
    history.targets.map((target) => [target.messageId, target.visibleIndex]),
    [
      ['before', 0],
      ['after', 1],
    ],
  );
  assert(history.targets.every((target) => target.supported));
  assert(history.excludedMessageIds.includes('internal'));
});

test('only the exact interrupted nested review turn is removed from native selection order', () => {
  for (const completedAt of [null, '2026-10-24T00:00:20Z']) {
    const lines = encode([
      start('review-turn'),
      user('before', 'review this change'),
      receipt('review-turn', 'native-before', 'review this change'),
      reviewMarker('review-turn', 'enter-review', 'EnteredReviewMode'),
      reviewMarker('review-turn', 'exit-review', 'ExitedReviewMode'),
      done('review-turn'),
      start('nested-turn'),
      user('nested-one', 'duplicated nested prompt'),
      receipt('nested-turn', 'native-nested-one', 'duplicated nested prompt'),
      user('nested-two', 'duplicated nested prompt'),
      receipt('nested-turn', 'native-nested-two', 'duplicated nested prompt'),
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'nested-turn', completed_at: completedAt },
      },
      start('later-turn'),
      user('after', 'normal later input'),
      receipt('later-turn', 'native-after', 'normal later input'),
      done('later-turn'),
    ]);
    const history = rewindHistory(lines, parseCodexTranscript(lines));
    assert.equal(history.complete, true);
    assert.deepEqual(
      history.targets.map((target) => target.messageId),
      completedAt ? ['before', 'nested-one', 'nested-two', 'after'] : ['before', 'after'],
    );
    assert.equal(history.targets.at(-1).supported, true);
    assert.equal(history.targets.at(-1).visibleIndex, completedAt ? 3 : 1);
  }
});

test('legacy mode uses its actual UserMessage receipt and does not duplicate canonical fanout', () => {
  const lines = encode(
    [
      start('legacy-turn'),
      user('original', 'legacy input'),
      receipt('legacy-turn', 'ignored-canonical-id', 'legacy input'),
      { type: 'event_msg', payload: { type: 'user_message', message: 'legacy input' } },
      done('legacy-turn'),
    ],
    { historyMode: 'legacy' },
  );
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.equal(history.targets.length, 1);
  assert.equal(history.targets[0].nativeUserItemId, null);
  assert(history.targets[0].nativeReceiptRecordId);
  assert.equal(history.targets[0].supported, true);
});

test('an unverifiable legacy fallback turn is refused locally while a later explicit turn remains editable', () => {
  const lines = encode(
    [
      user('old', 'old implicit input', null),
      { type: 'event_msg', payload: { type: 'user_message', message: 'old implicit input' } },
      start('verified-turn'),
      user('new', 'new explicit input'),
      { type: 'event_msg', payload: { type: 'user_message', message: 'new explicit input' } },
      done('verified-turn'),
    ],
    { historyMode: 'legacy' },
  );
  const history = rewindHistory(lines, parseCodexTranscript(lines));
  assert.equal(history.complete, true);
  assert.equal(history.targets.length, 2);
  assert.equal(history.targets[0].turnIdVerified, false);
  assert.equal(history.targets[0].supported, false);
  assert.equal(history.targets[1].turnIdVerified, true);
  assert.equal(history.targets[1].supported, true);
  assert.equal(history.targets[1].visibleIndex, 1);
});

function fixture(options = {}) {
  const lines = journal(),
    original = rewindHistory(lines, parseCodexTranscript(lines));
  let history = structuredClone(original),
    root = '/private/root-one';
  const pane = {
    paneId: 'pane',
    terminalId: 'terminal',
    runtimeId: '42:100',
    agent: { label: 'codex', session: { value: 'thread' } },
  };
  const calls = [],
    phases = [],
    state = { mode: 'main', input: '' };
  const body = {
    paneId: 'pane',
    terminalId: 'terminal',
    runtimeId: 'herdr-runtime',
    sessionId: 'thread',
    clientId: 'client',
    requestId: 'prepare',
    messageId: 'm-b',
  };
  const native = {
    async select({ target, verify }) {
      await verify();
      calls.push('select');
      state.mode = 'selector';
      if (options.fail === 'select') throw new Error('selection failed');
      return {
        messageId: target.messageId,
        turnId: target.turnId,
        visibleIndex: target.visibleIndex,
      };
    },
    async confirm({ target, verify }) {
      await verify();
      calls.push('confirm');
      history.targets = history.targets.slice(0, target.visibleIndex);
      history.revision = digest(history.targets);
      state.mode = 'editing';
      state.input = target.sourceText;
      if (options.fail === 'confirm') throw new Error('revert reply lost');
    },
    async replace({ text, verify }) {
      await verify();
      calls.push('replace');
      if (options.fail === 'replace') throw new Error('replacement failed');
      state.input = '';
      state.editedText = text;
      state.mode = 'main';
    },
    async send({ text, verify }) {
      await verify();
      calls.push('send');
      assert.equal(text, state.editedText);
      if (options.fail === 'send') throw new Error('send reply lost');
      return { nativeUserMessageId: 'new-native-message' };
    },
    async cancel({ verify }) {
      await verify();
      calls.push('cancel');
      if (options.fail === 'cancel') throw new Error('cancel unknown');
      state.mode = 'main';
      state.input = '';
    },
    async read() {
      calls.push('read');
      return { mode: state.mode, input: state.input };
    },
  };
  const deps = {
    target: async () => structuredClone(pane),
    readHistory: async () => structuredClone(history),
    native,
    scope: () => root,
    timeoutMs: 20,
    stepMs: 1,
    beforeWrite: async () => {
      if (options.beforeWriteError) throw new Error('side active');
    },
  };
  const controller = new RewindInteraction(deps);
  const prepare = () => controller.prepare(body);
  const itemFor = (preparation) => ({
    id: 'send-id',
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    runtimeId: pane.runtimeId,
    sessionId: 'thread',
    agent: 'codex',
    text: '改过的消息\n保留草稿。',
    rewind: { preparationId: preparation.id },
  });
  const progress = (item) => async (fields) => {
    phases.push(fields.rewindProgress.phase);
    if (options.persistFailure === fields.rewindProgress.phase) throw new Error('storage failed');
    Object.assign(item, structuredClone(fields));
  };
  return {
    controller,
    prepare,
    itemFor,
    progress,
    calls,
    phases,
    pane,
    body,
    state,
    deps,
    setHistory: (value) => {
      history = value;
    },
    original,
    setScope: (value) => {
      root = value;
    },
  };
}

test('prepare and cancel are read-only and do not reserve native input', async () => {
  const f = fixture(),
    a = await f.prepare(),
    b = await f.prepare();
  assert.deepEqual(a, b);
  assert.deepEqual(f.calls, []);
  assert.equal(f.controller.busy.size, 0);
  assert.equal(a.preparation.sourceText, '中文第一行\n第二行：保留多个  空格。');
  assert(!JSON.stringify(a).includes('/private/root-one'));
  f.controller.cancel({ preparationId: a.preparation.id, clientId: 'client' });
  await assert.rejects(f.controller.submit(f.itemFor(a.preparation), f.progress({})), {
    code: 'REWIND_PREPARATION_EXPIRED',
  });
  assert.deepEqual(f.calls, []);
});

test('submit persists each irreversible boundary before its one native operation', async () => {
  const f = fixture(),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  const result = await f.controller.submit(item, f.progress(item));
  assert.equal(result.nativeUserMessageId, 'new-native-message');
  assert.deepEqual(f.calls, ['select', 'confirm', 'replace', 'send']);
  assert.deepEqual(f.phases, [
    'selecting',
    'selected',
    'revert_pending',
    'reverted',
    'draft_ready',
    'send_pending',
    'submitted',
  ]);
  assert.equal(f.controller.busy.size, 0);
  assert.deepEqual(await f.controller.submit(item, f.progress(item)), result);
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
});

test('transport acceptance without a native message UUID is persisted without inventing one', async () => {
  const f = fixture(),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  const receipt = { type: 'agent_prompted', agent: { label: 'codex', status: 'working' } };
  f.controller.native.send = async ({ verify }) => {
    await verify();
    f.calls.push('send');
    return receipt;
  };
  assert.deepEqual(await f.controller.submit(item, f.progress(item)), receipt);
  assert.deepEqual(item.rewindProgress.receipt, receipt);
  assert.equal(item.rewindProgress.phase, 'submitted');
  assert.equal(Object.hasOwn(item.rewindProgress.receipt, 'nativeUserMessageId'), false);
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
});

test('root, process and user-history changes fail before any native key', async () => {
  for (const change of ['scope', 'process', 'history']) {
    const f = fixture(),
      { preparation } = await f.prepare(),
      item = f.itemFor(preparation);
    if (change === 'scope') f.setScope('/private/root-two');
    if (change === 'process') f.pane.runtimeId = '43:200';
    if (change === 'history') f.setHistory({ ...f.original, revision: 'different-user-order' });
    await assert.rejects(f.controller.submit(item, f.progress(item)));
    assert.deepEqual(f.calls, []);
  }
});

test('edited slash and shell prefixes after every relevant Unicode whitespace reject before rewind', async () => {
  for (const text of [
    '/status',
    '!rm example',
    '\n\t/status',
    '\u0085/status',
    '\u3000!echo example',
    '\uFEFF/model',
  ]) {
    const f = fixture(),
      { preparation } = await f.prepare(),
      item = f.itemFor(preparation);
    item.text = text;
    await assert.rejects(f.controller.submit(item, f.progress(item)), {
      code: 'REWIND_LITERAL_MESSAGE_REQUIRED',
    });
    assert.deepEqual(f.calls, []);
  }
});

test('failed selection is cancelled only before the first irreversible Enter', async () => {
  const f = fixture({ fail: 'select' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)));
  assert.deepEqual(f.calls, ['select', 'cancel']);
  assert.equal(item.rewindProgress.revertAttempted, false);
  assert.equal(f.controller.busy.size, 0);
});

test('a failed durable marker prevents the irreversible Enter and safely cancels selection', async () => {
  const f = fixture({ persistFailure: 'revert_pending' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)));
  assert.deepEqual(f.calls, ['select', 'cancel']);
  assert.equal(item.rewindProgress.revertAttempted, false);
});

test('a lost revert reply is recovered by reads and cannot replay selection or confirmation after restart', async () => {
  const f = fixture({ fail: 'confirm' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)), {
    revertUncertain: true,
    deliveryUncertain: false,
    retryable: false,
  });
  assert.deepEqual(f.calls, ['select', 'confirm']);
  const restarted = new RewindInteraction(f.deps),
    observation = await restarted.recover(item);
  assert.equal(observation.reverted, true);
  assert.equal(observation.messageSubmitted, false);
  await assert.rejects(restarted.submit(item, f.progress(item)), {
    code: 'REWIND_RECOVERY_REQUIRED',
  });
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.calls.filter((call) => call === 'send').length, 0);
});

test('replacement failure preserves the reverted-but-unsent state and blocks ordinary input', async () => {
  const f = fixture({ fail: 'replace' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)), {
    reverted: true,
    deliveryUncertain: false,
    retryable: false,
  });
  assert.equal(item.rewindProgress.reverted, true);
  assert.equal(item.rewindProgress.sendAttempted, false);
  assert(f.controller.busy.has('pane'));
  assert(!f.calls.includes('cancel'));
  assert(!f.calls.includes('send'));
});

test('uncertain send retains the durable request and recovery performs only reads', async () => {
  const f = fixture({ fail: 'send' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)), {
    reverted: true,
    deliveryUncertain: true,
    retryable: false,
  });
  const count = f.calls.length;
  const restarted = new RewindInteraction(f.deps),
    observation = await restarted.recover(item);
  assert.equal(observation.deliveryUncertain, true);
  assert.equal(observation.messageSubmitted, null);
  assert.deepEqual(f.calls.slice(count), ['read']);
  assert(!f.calls.includes('cancel'));
});

test('transport acceptance survives a failed completion checkpoint without claiming the message was unsent', async () => {
  const f = fixture({ persistFailure: 'submitted' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)), {
    messageSubmitted: true,
    deliveryUncertain: true,
    retryable: false,
  });
  assert.equal(item.rewindProgress.sendAccepted, true);
  assert.equal(item.rewindProgress.receipt.nativeUserMessageId, 'new-native-message');
  const observation = await new RewindInteraction(f.deps).recover(item);
  assert.equal(observation.messageSubmitted, true);
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
  await assert.rejects(f.controller.submit(item, f.progress(item)), {
    code: 'REWIND_RECOVERY_REQUIRED',
  });
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
});

test('one preparation cannot be spent by another message ID, even for identical text', async () => {
  const f = fixture(),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await f.controller.submit(item, f.progress(item));
  const second = f.itemFor(preparation);
  second.id = 'different-send-id';
  await assert.rejects(f.controller.submit(second, f.progress(second)), {
    code: 'REWIND_PREPARATION_USED',
  });
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
});

test('pure preparations and failed prepare receipts are bounded', async () => {
  const f = fixture();
  f.controller.maxPreparations = 2;
  for (let i = 0; i < 6; i++) await f.controller.prepare({ ...f.body, requestId: `prepare-${i}` });
  assert(f.controller.preparations.size <= 2);
  assert(f.controller.prepareReceipts.size <= 2);
  await assert.rejects(
    f.controller.prepare({ ...f.body, messageId: 'missing', requestId: 'failure' }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    ![...f.controller.prepareReceipts.values()].some(
      (entry) =>
        entry.fingerprint === digest({ ...f.body, messageId: 'missing', requestId: 'failure' }),
    ),
  );
  assert.deepEqual(f.calls, []);
});

test('restart restores the durable input barrier and only a read of an empty main composer releases it', async () => {
  const f = fixture({ fail: 'replace' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)));
  const restarted = new RewindInteraction(f.deps);
  assert.equal(restarted.restore(item), true);
  assert(restarted.busy.has('pane'));
  const before = f.calls.length;
  await assert.rejects(restarted.ensureAvailable(f.pane), { code: 'REWIND_RECOVERY_REQUIRED' });
  assert.deepEqual(f.calls.slice(before), ['read']);
  f.state.mode = 'main';
  f.state.input = '';
  await restarted.ensureAvailable(f.pane);
  assert.equal(restarted.busy.size, 0);
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.calls.filter((call) => call === 'send').length, 0);
});

test('a fragment changing during a read is retried without repeating native confirmation', async () => {
  const f = fixture(),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  const read = f.controller.readHistory;
  let changedReads = 0;
  f.controller.readHistory = async (pane) => {
    if (f.calls.includes('confirm') && changedReads++ < 2)
      throw Object.assign(new Error('fragment changed'), { code: 'ARCHIVE_CHANGED' });
    return read(pane);
  };
  await f.controller.submit(item, f.progress(item));
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.calls.filter((call) => call === 'send').length, 1);
  assert(changedReads >= 2);
});

test('missing lineage and invalid history errors fail without readonly retry or native input', async () => {
  const f = fixture();
  let reads = 0;
  f.controller.readHistory = async () => {
    reads++;
    throw Object.assign(new Error('missing parent'), { code: 'ARCHIVE_PARENT_MISSING' });
  };
  await assert.rejects(f.prepare(), { code: 'ARCHIVE_PARENT_MISSING' });
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, []);
});

test('a failed read-only recovery cannot turn a known unsent rewind into uncertain message delivery', async () => {
  const f = fixture({ fail: 'confirm' }),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  await assert.rejects(f.controller.submit(item, f.progress(item)));
  f.deps.readHistory = async () => {
    throw Object.assign(new Error('missing parent'), { code: 'ARCHIVE_PARENT_MISSING' });
  };
  const restarted = new RewindInteraction(f.deps);
  await assert.rejects(restarted.submit(item, f.progress(item)), {
    code: 'REWIND_RECOVERY_REQUIRED',
    deliveryUncertain: false,
    retryable: false,
  });
  assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
  assert.equal(f.calls.filter((call) => call === 'send').length, 0);
});

test('a completed durable receipt is returned without depending on the native connection', async () => {
  const f = fixture(),
    { preparation } = await f.prepare(),
    item = f.itemFor(preparation);
  const receipt = await f.controller.submit(item, f.progress(item)),
    count = f.calls.length;
  f.deps.target = f.deps.readHistory = async () => {
    throw new Error('disconnected');
  };
  const restarted = new RewindInteraction(f.deps);
  assert.deepEqual(await restarted.submit(item, f.progress(item)), receipt);
  assert.equal(f.calls.length, count);
});

test('native observers close after success, failed writes and read-only recovery without extra input', async () => {
  for (const fail of [undefined, 'confirm']) {
    const f = fixture({ fail }),
      { preparation } = await f.prepare(),
      item = f.itemFor(preparation),
      closed = [];
    f.controller.native.close = async ({ pane }) => {
      closed.push(pane.paneId);
    };
    if (fail) await assert.rejects(f.controller.submit(item, f.progress(item)));
    else await f.controller.submit(item, f.progress(item));
    assert.deepEqual(closed, ['pane']);
    if (fail) {
      await f.controller.recover(item);
      assert.deepEqual(closed, ['pane', 'pane']);
    }
    assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
    assert.equal(f.calls.filter((call) => call === 'send').length, fail ? 0 : 1);
  }
});

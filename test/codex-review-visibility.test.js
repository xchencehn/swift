'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reviewVisibility,
  projectReviewVisibility,
  isHiddenNestedReviewTurn,
} = require('../lib/codex-review-visibility');
const Conversation = require('../lib/conversation-state');
const event = (payload) => ({ type: 'event_msg', payload });
const start = (turn_id) => event({ type: 'task_started', turn_id });
const done = (turn_id, fields = {}) => event({ type: 'task_complete', turn_id, ...fields });
const abort = (turn_id, fields = {}) =>
  event({ type: 'turn_aborted', turn_id, reason: 'review_ended', ...fields });
const receipt = (turn_id, id, content) =>
  event({
    type: 'item_completed',
    turn_id,
    item: {
      type: 'UserMessage',
      id,
      content: typeof content === 'string' ? text(content) : content,
    },
  });
const marker = (turn_id, id, type) =>
  event({ type: 'item_completed', turn_id, item: { type, id } });
const text = (text) => [{ type: 'text', text, text_elements: [] }];
const legacy = (message, extra = {}) => event({ type: 'user_message', message, ...extra });
const enter = (turn_id, item_id) =>
  event({ type: 'entered_review_mode', turn_id, item_id, target: { type: 'uncommittedChanges' } });
const exit = (turn_id, item_id) =>
  event({ type: 'exited_review_mode', turn_id, item_id, review_output: null });
const encode = (entries, mode = 'paginated') =>
  [{ type: 'session_meta', payload: { history_mode: mode } }, ...entries].map((entry, ordinal) =>
    JSON.stringify({ timestamp: '2026-10-24T00:00:00.000Z', ordinal, ...entry }),
  );
const summary = (projected) =>
  projected.users.map(({ turnId, nativeUserItemId, visible, isSteer, status }) => [
    turnId,
    nativeUserItemId,
    visible,
    isSteer,
    status,
  ]);
const reviewParent = (id = 'review') => [
  start(id),
  marker(id, 'review-enter', 'EnteredReviewMode'),
  marker(id, 'review-exit', 'ExitedReviewMode'),
  done(id),
];

test('canonical review hides its prompt and preserves ordinary messages before and after review', () => {
  const result = reviewVisibility(
    encode([
      start('before'),
      receipt('before', 'a', 'normal'),
      done('before'),
      start('review'),
      marker('review', 'enter', 'EnteredReviewMode'),
      receipt('review', 'hidden', 'arbitrary prompt text'),
      marker('review', 'exit', 'ExitedReviewMode'),
      done('review'),
      start('after'),
      receipt('after', 'b', 'normal'),
      done('after'),
    ]),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.users.map((user) => [user.nativeUserItemId, user.visible, user.editable]),
    [
      ['a', true, true],
      ['hidden', false, false],
      ['b', true, true],
    ],
  );
});

test('review state crosses turn boundaries and only an exited marker clears it', () => {
  const result = reviewVisibility(
    encode([
      start('a'),
      marker('a', 'enter', 'EnteredReviewMode'),
      done('a'),
      start('b'),
      receipt('b', 'hidden', 'not guessed from text'),
      done('b'),
      start('c'),
      marker('c', 'exit', 'ExitedReviewMode'),
      receipt('c', 'shown', 'after'),
      done('c'),
    ]),
  );
  assert.deepEqual(
    result.users.map((user) => [user.nativeUserItemId, user.visible]),
    [
      ['hidden', false],
      ['shown', true],
    ],
  );
});

test('two equal prompts are hidden only for the exact nested-review shape', () => {
  const result = reviewVisibility(
    encode([
      ...reviewParent(),
      start('child'),
      receipt('child', 'duplicate-a', 'any text'),
      receipt('child', 'duplicate-b', 'any text'),
      abort('child'),
      start('after'),
      receipt('after', 'after', 'continue'),
      done('after'),
    ]),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.users.map((user) => [
      user.nativeUserItemId,
      user.visible,
      user.isSteer,
      user.hiddenNestedReviewTurn,
    ]),
    [
      ['duplicate-a', false, false, true],
      ['duplicate-b', false, true, true],
      ['after', true, false, false],
    ],
  );
});

for (const [label, fields] of [
  ['positive timestamp', { completed_at: 1 }],
  ['zero timestamp', { completed_at: 0 }],
]) {
  test(`a real interrupted steer with ${label} stays visible and the first prompt remains editable`, () => {
    const result = reviewVisibility(
      encode([
        ...reviewParent(),
        start('child'),
        receipt('child', 'a', 'same'),
        receipt('child', 'b', 'same'),
        abort('child', fields),
      ]),
    );
    assert.deepEqual(
      result.users.map((user) => [user.visible, user.isSteer, user.editable]),
      [
        [true, false, true],
        [true, true, false],
      ],
    );
    assert(result.users.every((user) => !user.hiddenNestedReviewTurn));
  });
}

test('nested-review matching compares full UserInput values including attachments and elements', () => {
  const first = [...text('same'), { type: 'local_image', path: '/fixture/a.png' }];
  const second = [...text('same'), { type: 'local_image', path: '/fixture/b.png' }];
  const result = reviewVisibility(
    encode([
      ...reviewParent(),
      start('child'),
      receipt('child', 'a', first),
      receipt('child', 'b', second),
      abort('child'),
    ]),
  );
  assert(result.users.every((user) => user.visible && !user.hiddenNestedReviewTurn));
});

test('POSIX PathBuf equality ignores internal dots and repeated separators but preserves parent and leading dots', () => {
  const parent = {
    status: 'completed',
    items: [{ type: 'EnteredReviewMode' }, { type: 'ExitedReviewMode' }],
  };
  const child = (first, second) => ({
    status: 'interrupted',
    completedAt: null,
    items: [first, second].map((path) => ({
      type: 'UserMessage',
      content: [{ type: 'local_image', path }],
    })),
  });
  for (const [a, b] of [
    ['/tmp/a', '/tmp//a'],
    ['/tmp/a', '/tmp/./a'],
    ['a', 'a/'],
  ])
    assert.equal(isHiddenNestedReviewTurn(parent, child(a, b), { platform: 'linux' }), true);
  for (const [a, b] of [
    ['a', './a'],
    ['a', 'dir/../a'],
  ])
    assert.equal(isHiddenNestedReviewTurn(parent, child(a, b), { platform: 'linux' }), false);
});

test('only an otherwise equal Windows path variant requires additional native equality evidence', () => {
  const inputs = ['C:\\fixture\\a.png', 'C:/fixture/a.png'].map((path) => [
    { type: 'local_image', path },
  ]);
  const lines = encode([
    ...reviewParent(),
    start('child'),
    receipt('child', 'a', inputs[0]),
    receipt('child', 'b', inputs[1]),
    abort('child'),
  ]);
  const unresolved = reviewVisibility(lines, { platform: 'win32' });
  assert.equal(unresolved.complete, false);
  assert.equal(unresolved.issues[0].code, 'NESTED_REVIEW_PATH_EQUALITY_UNPROVEN');
  const exact = encode([
    ...reviewParent(),
    start('child'),
    receipt('child', 'a', inputs[0]),
    receipt('child', 'b', inputs[0]),
    abort('child'),
  ]);
  assert.equal(reviewVisibility(exact, { platform: 'win32' }).complete, true);
});

test('one, three, nonidentical, and completed prompts are not hidden as a nested review', () => {
  const parent = {
    id: 'parent',
    status: 'completed',
    completedAt: null,
    items: [{ type: 'EnteredReviewMode' }, { type: 'ExitedReviewMode' }],
  };
  const item = (value) => ({ type: 'UserMessage', content: text(value) });
  const cases = [
    { status: 'interrupted', items: [item('same')] },
    { status: 'interrupted', items: [item('same'), item('same'), item('same')] },
    { status: 'interrupted', items: [item('a'), item('b')] },
    { status: 'completed', items: [item('same'), item('same')] },
  ];
  for (const turn of cases)
    assert.equal(
      isHiddenNestedReviewTurn(parent, { id: 'child', completedAt: null, ...turn }),
      false,
    );
  assert.equal(
    isHiddenNestedReviewTurn(
      { ...parent, status: 'failed' },
      { status: 'interrupted', completedAt: null, items: [item('same'), item('same')] },
    ),
    false,
  );
});

test('a partial loaded page resets review state but clipped inputs still establish steer', () => {
  const turns = [
    {
      id: 'review',
      status: 'completed',
      completedAt: null,
      items: [
        { type: 'EnteredReviewMode', id: 'enter' },
        { type: 'UserMessage', id: 'first', content: text('one') },
        { type: 'UserMessage', id: 'second', content: text('two') },
        { type: 'ExitedReviewMode', id: 'exit' },
      ],
    },
  ];
  const clipped = projectReviewVisibility(turns, {
    startItem: { turnId: 'review', itemId: 'second' },
  });
  assert.equal(clipped.complete, true);
  assert.deepEqual(
    clipped.users.map((user) => [user.visible, user.isSteer]),
    [[true, true]],
  );
  assert.equal(
    projectReviewVisibility(turns, { startItem: { turnId: 'missing', itemId: 'missing' } })
      .complete,
    false,
  );
});

test('clipping either review marker from the predecessor prevents nested-review hiding', () => {
  const lines = encode([
    ...reviewParent(),
    start('child'),
    receipt('child', 'a', 'same'),
    receipt('child', 'b', 'same'),
    abort('child'),
  ]);
  const result = reviewVisibility(lines, {
    startItem: { turnId: 'review', itemId: 'review-exit' },
  });
  assert(result.users.every((user) => user.visible && !user.hiddenNestedReviewTurn));
});

test('empty inputs still establish steer while in-progress inputs stay visible but uneditable', () => {
  const result = reviewVisibility(
    encode([
      start('a'),
      receipt('a', 'empty', '\u001b[31m\u0000'),
      receipt('a', 'steer', 'second'),
      done('a'),
      start('b'),
      receipt('b', 'active', 'running'),
    ]),
  );
  assert.deepEqual(
    result.users.map((user) => [user.nativeUserItemId, user.visible, user.isSteer, user.editable]),
    [
      ['empty', false, false, false],
      ['steer', true, true, false],
      ['active', true, false, false],
    ],
  );
});

test('canonical histories ignore legacy user and review events and item_started snapshots', () => {
  const result = reviewVisibility(
    encode([
      start('a'),
      enter('a', 'legacy-enter'),
      legacy('legacy only'),
      event({
        type: 'item_started',
        turn_id: 'a',
        item: { type: 'UserMessage', id: 'started-only', content: text('uncompleted') },
      }),
      receipt('a', 'canonical', 'shown'),
      exit('a', 'legacy-exit'),
      done('a'),
    ]),
  );
  assert.deepEqual(summary(result), [['a', 'canonical', true, false, 'completed']]);
});

test('legacy histories use user_message and deduplicate canonical and legacy review markers by persisted ID', () => {
  const lines = encode(
    [
      start('a'),
      enter('a', 'enter'),
      marker('a', 'enter', 'EnteredReviewMode'),
      legacy('hidden'),
      receipt('a', 'canonical-duplicate', 'hidden'),
      exit('a', 'exit'),
      marker('a', 'exit', 'ExitedReviewMode'),
      done('a'),
      start('b'),
      legacy('shown'),
      receipt('b', 'canonical-duplicate-two', 'shown'),
      done('b'),
    ],
    'legacy',
  );
  const result = reviewVisibility(lines);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.users.map((user) => [user.turnId, user.visible, user.nativeUserItemId]),
    [
      ['a', false, null],
      ['b', true, null],
    ],
  );
  assert.equal(result.users[0].nativeReceiptRecordId, Conversation.stableId(lines[4]));
  assert.equal(
    result.turns[0].items.filter((item) =>
      ['EnteredReviewMode', 'ExitedReviewMode'].includes(item.type),
    ).length,
    2,
  );
});

test('legacy nested review duplicates are hidden and a following ordinary turn remains editable', () => {
  const result = reviewVisibility(
    encode(
      [
        start('review'),
        enter('review', 'enter'),
        exit('review', 'exit'),
        done('review'),
        start('child'),
        legacy('same'),
        legacy('same'),
        abort('child'),
        start('after'),
        legacy('normal'),
        done('after'),
      ],
      'legacy',
    ),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.users.map((user) => [user.visible, user.isSteer, user.editable]),
    [
      [false, false, false],
      [false, true, false],
      [true, false, true],
    ],
  );
});

test('legacy canonical review lifecycle can create the review turn without task_started', () => {
  const result = reviewVisibility(
    encode(
      [
        marker('review', 'enter', 'EnteredReviewMode'),
        marker('review', 'exit', 'ExitedReviewMode'),
        done('review'),
        start('normal'),
        legacy('normal'),
        done('normal'),
      ],
      'legacy',
    ),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.turns.map((turn) => turn.id),
    ['review', 'normal'],
  );
  assert.equal(result.users[0].editable, true);
});

test('legacy turn-scoped late review markers update their original completed turn', () => {
  const result = reviewVisibility(
    encode(
      [
        start('review'),
        done('review'),
        start('normal'),
        legacy('normal'),
        enter('review', 'enter'),
        exit('review', 'exit'),
        done('normal'),
      ],
      'legacy',
    ),
  );
  assert.equal(result.users[0].visible, true);
  assert.deepEqual(
    result.turns[0].items.map((item) => item.type),
    ['EnteredReviewMode', 'ExitedReviewMode'],
  );
});

test('legacy no-task-start users open separate implicit turns and abort preserves its timestamp', () => {
  const result = reviewVisibility(
    encode([legacy('one'), legacy('two'), abort(null, { completed_at: 4 })], 'legacy'),
  );
  assert.equal(result.turns.length, 2);
  assert(result.users.every((user) => user.visible && !user.isSteer));
  assert.equal(result.users[1].completedAt, 4);
  assert.equal(result.users[1].status, 'interrupted');
  assert.equal(result.users[0].turnId, 'rollout-1');
  assert.equal(result.users[0].turnIdSource, 'rollout-index');
  assert.equal(result.users[0].turnIdVerified, false);
});

test('legacy late scoped tool events do not create an implicit turn between review and its child', () => {
  for (const type of [
    'dynamic_tool_call_request',
    'dynamic_tool_call_response',
    'mcp_tool_call_begin',
    'mcp_tool_call_end',
    'exec_command_begin',
    'exec_command_end',
  ]) {
    const result = reviewVisibility(
      encode(
        [
          start('review'),
          enter('review', 'enter'),
          exit('review', 'exit'),
          done('review'),
          event({ type, turn_id: 'missing', call_id: 'late' }),
          start('child'),
          legacy('same'),
          legacy('same'),
          abort('child'),
        ],
        'legacy',
      ),
    );
    assert.equal(result.turns.length, 2, type);
    assert(
      result.users.every((user) => user.hiddenNestedReviewTurn),
      type,
    );
  }
});

test('legacy subagent and resume activity preserve a real implicit turn between review and duplicates', () => {
  for (const type of ['sub_agent_activity', 'collab_resume_begin', 'collab_resume_end']) {
    const result = reviewVisibility(
      encode(
        [
          start('review'),
          enter('review', 'enter'),
          exit('review', 'exit'),
          done('review'),
          event({ type, call_id: 'activity' }),
          start('child'),
          legacy('same'),
          legacy('same'),
          abort('child'),
        ],
        'legacy',
      ),
    );
    assert.equal(result.turns.length, 3, type);
    assert(
      result.users.every((user) => user.visible && !user.hiddenNestedReviewTurn),
      type,
    );
  }
});

test('legacy nonfatal control errors retain the completed review parent status', () => {
  for (const codex_error_info of [
    'thread_rollback_failed',
    { active_turn_not_steerable: { turn_kind: 'review' } },
  ]) {
    const result = reviewVisibility(
      encode(
        [
          start('review'),
          enter('review', 'enter'),
          event({ type: 'error', message: 'control error', codex_error_info }),
          exit('review', 'exit'),
          done('review'),
          start('child'),
          legacy('same'),
          legacy('same'),
          abort('child'),
        ],
        'legacy',
      ),
    );
    assert.equal(result.turns[0].status, 'completed');
    assert(result.users.every((user) => user.hiddenNestedReviewTurn));
  }
});

test('inline image wins a simultaneous file reference as in the Rust untagged image enum', () => {
  const result = reviewVisibility(
    encode([
      start('a'),
      receipt('a', 'image', [
        { type: 'image', image_url: 'fixture://inline', file_id: 'file-ignored' },
      ]),
      done('a'),
    ]),
  );
  assert.equal(result.users[0].visible, true);
});

test('canonical metadata order, terminal immutability, and orphan items match SQLite projection', () => {
  const result = reviewVisibility(
    encode([
      receipt('late-metadata', 'late', 'later turn'),
      receipt('orphan', 'orphan', 'not in a turn'),
      start('first'),
      receipt('first', 'first', 'first turn'),
      done('first', { completed_at: 3 }),
      abort('first'),
      done('late-metadata', { completed_at: 4 }),
    ]),
  );
  assert.deepEqual(
    result.turns.map((turn) => turn.id),
    ['first', 'late-metadata'],
  );
  assert.deepEqual(
    result.users.map((user) => [user.nativeUserItemId, user.completedAt, user.status]),
    [
      ['first', 3, 'completed'],
      ['late', 4, 'completed'],
    ],
  );
});

test('repeated completed snapshots keep first item position and identity while updating the snapshot', () => {
  const lines = encode([
    start('a'),
    receipt('a', 'first', 'old'),
    receipt('a', 'second', 'next'),
    receipt('a', 'first', 'new'),
    done('a'),
  ]);
  const result = reviewVisibility(lines);
  assert.equal(result.users.length, 2);
  assert.deepEqual(
    result.turns[0].items.map((item) => item.content[0].text),
    ['new', 'next'],
  );
  assert.equal(result.users[0].nativeReceiptRecordId, Conversation.stableId(lines[2]));
});

test('legacy whitespace text elements are discarded before canonical input construction', () => {
  const result = reviewVisibility(
    encode(
      [
        start('a'),
        legacy(' \n', { text_elements: [{ byte_range: { start: 0, end: 1 }, placeholder: 'x' }] }),
        legacy('next'),
        done('a'),
      ],
      'legacy',
    ),
  );
  assert.deepEqual(
    result.users.map((user) => [user.visible, user.isSteer]),
    [
      [false, false],
      [true, true],
    ],
  );
});

test('legacy rollback removes canonical turns rather than guessing from raw response text', () => {
  const result = reviewVisibility(
    encode(
      [
        start('first'),
        legacy('keep'),
        done('first'),
        enter('review', 'enter'),
        exit('review', 'exit'),
        done('review'),
        event({ type: 'thread_rolled_back', num_turns: 1 }),
      ],
      'legacy',
    ),
  );
  assert.deepEqual(
    result.turns.map((turn) => turn.id),
    ['first'],
  );
  assert.deepEqual(
    result.users.map((user) => user.visible),
    [true],
  );
});

test('head mode defaults to legacy and explicit mode can be supplied by a verified caller', () => {
  const lines = encode([start('a'), receipt('a', 'canonical', 'shown'), done('a')]).slice(1);
  assert.equal(reviewVisibility(lines).users.length, 0);
  assert.equal(reviewVisibility(lines, { historyMode: 'paginated' }).users.length, 1);
  assert.equal(reviewVisibility(lines, { historyMode: 'unknown' }).complete, false);
});

test('corrupt canonical items and missing ordinals are reported without suppressing unrelated normal cells', () => {
  const lines = encode([start('a'), receipt('a', 'good', 'normal'), done('a')]);
  lines.push(
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'item_completed', turn_id: 'a', item: { type: 'UserMessage' } },
    }),
  );
  const result = reviewVisibility(lines);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.users.map((user) => [user.nativeUserItemId, user.visible]),
    [['good', true]],
  );
  assert.equal(result.issues[0].code, 'MISSING_CANONICAL_ORDINAL');
});

test('a legacy hook envelope that could introduce a turn requires native XML projection evidence', () => {
  const hook = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '<hook_prompt hook_run_id="fixture">follow up</hook_prompt>' },
      ],
    },
  };
  const result = reviewVisibility(
    encode([hook, start('normal'), legacy('normal'), done('normal')], 'legacy'),
  );
  assert.equal(result.complete, false);
  assert.equal(result.issues[0].code, 'LEGACY_HOOK_XML_PROJECTION_UNPROVEN');
  const safe = reviewVisibility(
    encode([start('normal'), hook, legacy('normal'), done('normal')], 'legacy'),
  );
  assert.equal(safe.complete, true);
  assert.equal(safe.users[0].turnIdVerified, true);
});

test('an explicit null text_elements field is not silently rewritten into a valid native record', () => {
  const result = reviewVisibility(
    encode([
      start('normal'),
      receipt('normal', 'invalid', [{ type: 'text', text: 'normal', text_elements: null }]),
      done('normal'),
    ]),
  );
  assert.equal(result.complete, false);
  assert.equal(result.issues[0].code, 'UNSUPPORTED_USER_DISPLAY');
});

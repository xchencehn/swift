'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { NativeDiagnostics } = require('../lib/native-diagnostics');

test('native diagnostics retain only state enums and hashed identities, deduplicate and rotate within bounds', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state/events.jsonl');
  let time = 1000;
  const log = new NativeDiagnostics({ file, limit: 3, maxBytes: 250, clock: () => time });
  const event = {
    source: 'prewrite',
    binding: 'private-session-binding',
    requestId: 'private-request',
    terminalId: 'private-terminal',
    error: 'SECRET ERROR',
    rawScreen: 'SECRET ANSWER',
    interaction: {
      thread: 'unknown',
      inputTarget: 'unknown',
      reason: 'footer-not-visible',
      modal: { kind: 'selection', title: 'SECRET TITLE', key: 'SECRET KEY' },
    },
  };
  const first = log.observe(event);
  assert.equal(log.observe(event), first);
  time += 30001;
  assert.notEqual(log.observe(event), first);
  for (let i = 0; i < 5; i++)
    log.observe({
      ...event,
      binding: `private-session-${i}`,
      interaction: { thread: 'main', inputTarget: 'composer' },
    });
  await log.flush();
  assert.equal(log.recent().events.length, 3);
  assert.equal(log.recent(0).events.length, 0);
  const serialized =
    JSON.stringify(log.recent()) +
    (await fs.readFile(file, 'utf8')) +
    (await fs.readFile(file + '.1', 'utf8'));
  for (const privateText of ['private-', 'SECRET', 'rawScreen', 'title', 'modal'])
    assert(!serialized.includes(privateText));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert((await fs.stat(file)).size < 1500);
  assert.equal(log.recent().writeFailures, 0);
});

test('unrecognized strings cannot become log data; disk errors do not interrupt controls', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-log-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = new NativeDiagnostics({ file: directory });
  log.observe({
    source: 'SECRET',
    code: 'SECRET',
    interaction: { thread: 'SECRET', reason: 'SECRET', modal: { kind: 'SECRET' } },
  });
  await log.flush();
  assert(!JSON.stringify(log.recent()).includes('SECRET'));
  assert.equal(log.recent().writeFailures, 1);
});
test('worker diagnostics preserve standard failure codes and counts without an error message or archive path', () => {
  const log = new NativeDiagnostics();
  log.observe({
    source: 'archive',
    binding: '/private/archive/root',
    code: 'ARCHIVE_WORKER_FAILED',
    workerError: 'ERR_WORKER_OUT_OF_MEMORY',
    exitCode: 1,
    pendingReads: 4,
    error: 'SECRET',
    file: '/private/archive/session.jsonl',
  });
  const event = log.recent().events[0];
  assert.equal(event.workerError, 'ERR_WORKER_OUT_OF_MEMORY');
  assert.equal(event.pendingReads, 4);
  assert.equal(event.exitCode, 1);
  assert(!JSON.stringify(event).includes('/private'));
  assert(!JSON.stringify(event).includes('SECRET'));
});

test('diagnostics remain queryable after restart across rotation without duplicating live events', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  const first = new NativeDiagnostics({ file });
  const oldId = first.observe({
    source: 'screen',
    binding: 'private-old',
    interaction: { inputTarget: 'unknown', reason: 'model-not-visible' },
  });
  await first.flush();
  await fs.rename(file, file + '.1');
  const next = new NativeDiagnostics({ file });
  const newId = next.observe({
    source: 'prewrite',
    binding: 'private-new',
    requestId: 'new-request',
    interaction: { inputTarget: 'composer' },
  });
  await next.flush();
  assert.deepEqual(
    (await next.readRecent()).events.map((value) => value.id),
    [oldId, newId],
  );
  const restarted = new NativeDiagnostics({ file });
  assert.equal(restarted.recent().events.length, 0);
  const history = await restarted.readRecent();
  assert.deepEqual(
    history.events.map((value) => value.id),
    [oldId, newId],
  );
  assert.equal(history.history.filesRead, 2);
  assert.equal(history.readFailures, 0);
  assert.deepEqual(
    (await restarted.readRecent(1)).events.map((value) => value.id),
    [newId],
  );
  assert.equal((await restarted.readRecent(0)).events.length, 0);
});

test('persisted diagnostics are revalidated and incomplete lines cannot disclose arbitrary fields', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-history-sanitize-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl'),
    log = new NativeDiagnostics();
  log.observe({ source: 'screen', interaction: { inputTarget: 'unknown' } });
  const event = log.recent().events[0];
  await fs.writeFile(
    file,
    [
      JSON.stringify({
        ...event,
        target: 'PRIVATE PATH',
        reason: 'PRIVATE REASON',
        title: 'PRIVATE TITLE',
        error: 'PRIVATE ERROR',
        evidence: {
          sampleRows: 12,
          styled: true,
          placeholder: 'PRIVATE PLACEHOLDER',
          rawScreen: 'PRIVATE SCREEN',
          footerRows: -1,
        },
      }),
      JSON.stringify({ ...event, id: 'PRIVATE ID' }),
      '{"partial":',
    ].join('\n'),
  );
  const history = await new NativeDiagnostics({ file }).readRecent();
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].id, event.id);
  assert.equal(history.events[0].evidence.sampleRows, 12);
  assert.equal(history.events[0].evidence.styled, true);
  assert.equal(history.history.invalidRecords, 2);
  assert(!JSON.stringify(history).includes('PRIVATE'));
  assert(!JSON.stringify(history).includes('rawScreen'));
});

test('diagnostic history bounds oversized files and retains live observations when disk is unreadable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-history-bounds-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl'),
    first = new NativeDiagnostics();
  first.observe({ source: 'screen', interaction: { inputTarget: 'composer' } });
  const event = first.recent().events[0];
  await fs.writeFile(file, 'PRIVATE'.repeat(10000) + '\n' + JSON.stringify(event) + '\n');
  const bounded = await new NativeDiagnostics({ file, maxBytes: 1024 }).readRecent();
  assert.equal(bounded.history.truncatedFiles, 1);
  assert.deepEqual(
    bounded.events.map((value) => value.id),
    [event.id],
  );
  const failed = new NativeDiagnostics({ file: directory });
  const id = failed.observe({ source: 'prewrite', interaction: { inputTarget: 'composer' } });
  await failed.flush();
  const current = await failed.readRecent();
  assert.equal(current.readFailures, 1);
  assert.equal(current.writeFailures, 1);
  assert.deepEqual(
    current.events.map((value) => value.id),
    [id],
  );
});

test('history includes pending writes without waiting for the writer or logging native text', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-history-pending-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = new NativeDiagnostics({ file: path.join(directory, 'events.jsonl') });
  let release;
  log.pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await log.flush();
  });
  const id = log.observe({
    source: 'screen',
    interaction: {
      inputTarget: 'unknown',
      reason: 'model-not-visible',
      evidence: {
        composerVisible: true,
        styled: true,
        modelVisible: false,
        placeholder: 'main',
        footerRows: 1,
        sampleRows: 9,
        rawScreen: 'PRIVATE CONTENT',
      },
    },
  });
  const result = await log.readRecent();
  assert.equal(log.queued, 1);
  assert.equal(result.events[0].id, id);
  assert.deepEqual(result.events[0].evidence, {
    composerVisible: true,
    styled: true,
    modelVisible: false,
    placeholder: 'main',
    footerRows: 1,
    sampleRows: 9,
  });
  assert(!JSON.stringify(result).includes('PRIVATE'));
  release();
  await log.flush();
});

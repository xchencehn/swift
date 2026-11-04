'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  fss = require('node:fs'),
  path = require('node:path');
const { fixture } = require('./message-rewind-fixture');
const { RewindNative } = require('../../lib/codex-rewind-native');
const { RewindInteraction } = require('../../lib/rewind-interaction');
const { MessageQueue } = require('../../lib/message-queue');

async function runFixture(output) {
  return fixture(output, async (f) => {
    for (const text of [
      'REPEAT SAME 中文',
      '第二条中文第一行\n第二行保留  空格。',
      'REPEAT SAME 中文',
      'LATEST 保留定位',
    ])
      await f.send(text);
    await f.bindSession();
    const initial = await f.readHistory();
    const pane = await f.exactPane(),
      runtimeId = (await f.herdr.dashboard()).runtimeId;
    const binding = {
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      sessionId: pane.agent.session.value,
      runtimeId,
      clientId: 'rewind-native-queue-fixture',
    };
    const exact = async (body) => {
      const current = await f.exactPane();
      assert.equal(current.paneId, body.paneId);
      assert.equal(current.terminalId, body.terminalId);
      assert.equal(current.agent.session.value, body.sessionId);
      assert.equal(current.runtimeId, pane.runtimeId);
      return current;
    };
    const qfile = path.join(output, 'queue.json'),
      phases = [],
      durableWrites = [],
      cases = [];
    let activeId,
      finishBeforeEscape = null;
    const persisted = () =>
      JSON.parse(fss.readFileSync(qfile)).items.find((item) => item.id === activeId);
    const native = new RewindNative({
      herdr: f.herdr,
      readHistory: f.readHistory,
      paste: f.paste,
      press: async (target, keys) => {
        if (keys[0] === 'esc' && finishBeforeEscape) {
          const finish = finishBeforeEscape;
          finishBeforeEscape = null;
          finish();
          await f.wait(
            async () => /ANSWER \d+/.test((await f.text()).split('HOLD').at(-1)),
            'finish before escape',
          );
          await f.delay(180);
        }
        if (keys.includes('enter')) {
          assert.equal(persisted().rewindProgress.phase, 'revert_pending');
          durableWrites.push({
            id: activeId,
            key: 'revert Enter',
            phase: persisted().rewindProgress.phase,
          });
        }
        return f.press(target, keys);
      },
      sendMessage: async (target, text) => {
        assert.equal(persisted().rewindProgress.phase, 'send_pending');
        durableWrites.push({
          id: activeId,
          key: 'agent.prompt',
          phase: persisted().rewindProgress.phase,
        });
        return f.sendMessage(target, text);
      },
      onObservation: async ({ label, state }) => {
        await fs.appendFile(
          path.join(output, 'observations.jsonl'),
          JSON.stringify({
            id: activeId,
            label,
            mode: state.mode,
            input: state.input,
            selected: state.selected,
            cursor: state.cursor,
            frameSequence: state.frameSequence,
          }) + '\n',
        );
        await fs.writeFile(
          path.join(output, 'latest-state.json'),
          JSON.stringify({ label, state }, null, 2),
        );
      },
    });
    const controller = new RewindInteraction({ target: exact, readHistory: f.readHistory, native });
    const queue = new MessageQueue({
      file: qfile,
      getNativePane: () => f.exactPane(),
      readMessages: () => assert.fail('Native delivery must not read legacy baseline'),
      sendNative: async (item, persist) =>
        controller.submit(item, async (update) => {
          await persist(update);
          phases.push({ id: item.id, phase: update.rewindProgress.phase });
          assert.equal(persisted().rewindProgress.phase, update.rewindProgress.phase);
        }),
    });
    async function submitCase(id, index, text, { working = false, race = false } = {}) {
      const before = await f.readHistory(),
        original = before.targets[index],
        writeCount = f.writes.length;
      const prepared = await controller.prepare({
        ...binding,
        requestId: id + '-prepare',
        messageId: original.messageId,
      });
      assert.equal(f.writes.length, writeCount);
      assert.equal((await f.readHistory()).branch, before.branch);
      if (working)
        assert(/Working/.test(await f.text()), 'Pure preparation must leave work running');
      if (race) {
        const hold = [...f.held.entries()].at(-1);
        assert(hold);
        finishBeforeEscape = hold[1];
      }
      activeId = id;
      const body = {
        id,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        sessionId: pane.agent.session.value,
        runtimeId: pane.runtimeId,
        text,
        rewind: { preparationId: prepared.preparation.id },
      };
      const count = f.requests.length,
        result = await queue.submitNative(body);
      assert.equal(result.status, 'dispatched', JSON.stringify(result.error));
      assert.equal(result.nativeUserMessageId, null);
      assert.deepEqual(result.rewind, body.rewind);
      assert.equal(result.rewindProgress.receipt.type, 'agent_prompted');
      await f.wait(async () => {
        const h = await f.readHistory();
        return (
          h.targets.length === index + 1 &&
          h.targets.at(-1).sourceText === text &&
          f.requests.length === count + 1
        );
      }, id + ' archive');
      const after = await f.readHistory();
      assert.deepEqual(
        after.targets.slice(0, index).map((x) => x.messageId),
        before.targets.slice(0, index).map((x) => x.messageId),
      );
      assert.notEqual(after.branch, before.branch);
      const writes = f.writes.length,
        requests = f.requests.length;
      assert.deepEqual(await queue.submitNative(body), result);
      assert.equal(f.writes.length, writes);
      assert.equal(f.requests.length, requests);
      assert.deepEqual(
        await controller.submit(result, () => assert.fail('Completed receipt must not write')),
        result.rewindProgress.receipt,
      );
      await f.capture(id);
      cases.push({
        id,
        working,
        race,
        prepareZeroInput: true,
        prefixPreserved: true,
        duplicateNoReplay: true,
        transport: 'agent_prompted',
        archiveMessageId: after.targets.at(-1).messageId,
        sourceBytes: Buffer.byteLength(original.sourceText),
        sourceLines: original.sourceText.split('\n').length,
      });
    }
    await submitCase('01-duplicate', 2, 'EDITED duplicate 第三条\n保留中文。');
    await f.sendMessage(await f.exactPane(), 'HOLD integration editing while working');
    await f.wait(async () => /Working/.test(await f.text()), 'hold work');
    await submitCase('02-working', 2, 'EDITED while working 中文', { working: true });
    await f.sendMessage(await f.exactPane(), 'HOLD integration natural completion race');
    await f.wait(async () => /Working/.test(await f.text()), 'race work');
    await submitCase('03-finish-race', 2, 'EDITED finish race 中文', { working: true, race: true });
    const long = Array.from(
      { length: 60 },
      (_, index) =>
        `第${String(index + 1).padStart(3, '0')}行：检查中文长消息和多行缩进，保留  两个空格，并保留这条历史消息原文。`,
    ).join('\n');
    assert(Buffer.byteLength(long) > 4096 && Buffer.byteLength(long) < 8192);
    for (const text of ['NEAR DUPLICATE 中文', long, 'NEAR DUPLICATE 中文', 'LATEST long 定位'])
      await f.send(text);
    await submitCase('04-long', 4, 'EDITED LONG 中文\n用户重新发送新正文。');
    const report = {
      ok: true,
      version: require('node:child_process')
        .execFileSync('codex', ['--version'], { encoding: 'utf8' })
        .trim(),
      actualMessageQueueSubmitNative: true,
      legacyBaselineReads: 0,
      cases,
      durableWrites,
      phases,
      initial,
      productionInput: false,
      externalInference: false,
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  });
}
async function run(baseOutput) {
  await fs.mkdir(baseOutput, { recursive: true });
  const output = await fs.mkdtemp(path.join(baseOutput, 'run-'));
  const started = performance.now(),
    summaryFile = path.join(baseOutput, 'report.json');
  const location = { runDirectory: output, reportFile: path.join(output, 'report.json') };
  // Invalidate an earlier successful summary before this independent run starts.
  await fs.writeFile(
    summaryFile,
    JSON.stringify({ ok: false, running: true, ...location }, null, 2),
  );
  try {
    const report = await runFixture(output);
    const summary = {
      ok: true,
      ...location,
      elapsedMs: Math.round(performance.now() - started),
      version: report.version,
      actualMessageQueueSubmitNative: report.actualMessageQueueSubmitNative,
      legacyBaselineReads: report.legacyBaselineReads,
      cases: report.cases,
      productionInput: report.productionInput,
      externalInference: report.externalInference,
    };
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    const summary = {
      ok: false,
      ...location,
      elapsedMs: Math.round(performance.now() - started),
      error: { code: error.code || null, message: error.message },
    };
    await fs.writeFile(
      location.reportFile,
      JSON.stringify({ ...summary, stack: error.stack }, null, 2),
    );
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
    throw error;
  }
}
module.exports = { run };
if (require.main === module)
  run(path.resolve(process.argv[2] || 'artifacts/message-rewind/native'))
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });

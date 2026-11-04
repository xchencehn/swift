'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { CommandInteraction } = require('../../lib/command-interaction');
const { GoalActions } = require('../../lib/goal-actions');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/goal-command/native');
async function run(cols) {
  return fixture(
    path.join(output, String(cols)),
    async (f) => {
      await f.wait(
        async () => (await f.exactPane()).agent?.label === 'codex',
        'native Codex registered',
      );
      const original = await f.exactPane(),
        dashboard = await f.herdr.dashboard();
      const commands = new CommandInteraction({ herdr: f.herdr, exactPane: f.exactPane });
      const actions = new GoalActions({ commands });
      const binding = {
        paneId: f.paneId,
        terminalId: original.terminalId,
        sessionId: original.agent.session?.value || '',
        runtimeId: dashboard.runtimeId,
        clientId: 'goal-native-' + cols,
      };
      assert.equal(binding.sessionId, '');
      assert.equal(f.requests.length, 0, 'Goal must work before the first message');
      let serial = 0;
      async function act(action, extra = {}) {
        const preview = await actions.preview(binding),
          requestId = 'goal-native-' + cols + '-' + ++serial;
        const body = {
          ...binding,
          revision: preview.revision,
          processRuntimeId: preview.processRuntimeId,
          requestId,
          action,
          ...extra,
        };
        await actions.start(body);
        await f.wait(() => actions.get(requestId).status !== 'running', 'Goal ' + action, 15000);
        const job = actions.get(requestId);
        await fs.writeFile(path.join(f.output, requestId + '.json'), JSON.stringify(job, null, 2));
        await fs.writeFile(
          path.join(f.output, requestId + '.ansi'),
          await f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true }),
        );
        assert.equal(job.status, 'succeeded', job.message);
        return job;
      }
      const objective = '完成全部开发，保持会话与草稿。';
      assert.equal((await act('set', { objective })).goal.objective, objective);
      await f.bindSession();
      binding.sessionId = (await f.exactPane()).agent.session.value;
      await act('pause');
      const replacement = '新的开发目标\n核对真实状态与多行目标。';
      assert.equal(
        (await act('set', { objective: replacement, confirmReplace: true })).goal.objective,
        replacement,
      );
      await act('pause');
      await act('resume');
      await act('pause');
      assert.equal((await act('clear')).goal, null);
      assert.equal((await f.exactPane()).runtimeId, original.runtimeId);
      return {
        cols,
        goalBeforeFirstMessage: true,
        realGoalCreated: true,
        replacementConfirmed: true,
        multiline: true,
        pauseResumeClear: true,
        processPreserved: true,
      };
    },
    {
      cols,
      rows: 45,
      noAltScreen: false,
      noDaemon: true,
      codexConfig: ['tui.status_line=["model-with-reasoning","current-dir"]'],
    },
  );
}
(async () => {
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const cols of [140, 45]) {
    results.push(await run(cols));
    console.log(JSON.stringify(results.at(-1)));
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

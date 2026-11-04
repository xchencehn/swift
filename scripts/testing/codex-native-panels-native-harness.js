'use strict';
// All writes target a fresh private Herdr session and empty HOME. The model
// endpoint is the local Responses fixture; production panes are never opened.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { CodexSide } = require('../../lib/codex-side');
const { AgentQuestions } = require('../../lib/agent-questions');
const { codexInteraction } = require('../../lib/codex-footer');
const { stripAnsi } = require('../../public/ansi');
const { sendPaneKeys } = require('../../lib/herdr-input');
const output = path.resolve('artifacts/testing/codex-control-reliability/native-fixed');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function run(cols) {
  const directory = path.join(output, String(cols));
  return fixture(
    directory,
    async (f) => {
      await f.herdr.focusPane(f.paneId);
      let pane = await f.exactPane(),
        sessionReported = false;
      const exact = async () => {
        const current = await f.exactPane();
        return sessionReported
          ? current
          : { ...current, agent: { ...current.agent, session: null } };
      };
      const read = () =>
        f.herdr.readPane(f.paneId, { source: 'recent', lines: 120, ansi: true, exact: true });
      const side = new CodexSide({ herdr: f.herdr, exactPane: exact });
      const controllerKeys = [];
      const manager = new AgentQuestions({
        herdr: f.herdr,
        exactPane: exact,
        readLines: async () => {
          assert(sessionReported, 'Startup menus cannot depend on an unreported archive');
          return [];
        },
        requireProcess: true,
        keys: async (id, keys) => {
          controllerKeys.push(keys);
          return sendPaneKeys(id, keys, { socketFile: f.herdr.socketPath });
        },
        beforeAnswer: (target, q) =>
          manager.verifyQuestionThread(target, q, () => side.assertMain(target)),
      });
      const capture = async (name) => {
        const raw = await read();
        await fs.writeFile(path.join(directory, name + '.ansi'), raw);
        await fs.writeFile(path.join(directory, name + '.txt'), stripAnsi(raw));
        return raw;
      };
      const command = async (value) => {
        pane = await f.exactPane();
        await f.paste(pane, value);
        await f.delay(120);
        await f.press(pane, ['enter']);
      };
      const question = async (label) => {
        let q;
        await f.wait(async () => {
          q = await manager.read(await exact());
          return Boolean(q?.nativeModal);
        }, label);
        return q;
      };
      await f.wait(
        async () => codexInteraction(await read()).capabilities.compose,
        'native startup complete',
      );
      await capture('00-before-startup-choice');
      await command('/model');
      const model = await question('native model picker');
      await capture('02-model');
      assert.equal(model.toolId, 'native-selection');
      assert(model.options.length > 0);
      assert.equal(model.preSession, true);
      assert.equal(model.sessionId, '');
      await assert.rejects(side.assertMain(await f.exactPane()), { code: 'QUESTION_PENDING' });
      const startupBody = {
        ...model,
        requestId: 'startup-model-' + cols,
        choices: [model.selected],
      };
      assert.equal((await manager.answer(startupBody)).delivery, 'sent');
      const startupKeys = controllerKeys.length;
      assert.equal((await manager.answer(startupBody)).repeated, true);
      assert.equal(controllerKeys.length, startupKeys);
      for (let i = 0; i < 4 && codexInteraction(await read()).modal; i++) {
        await f.press(await f.exactPane(), ['esc']);
        await f.delay(100);
      }
      await f.wait(
        async () => codexInteraction(await read()).capabilities.compose,
        'model picker closed',
      );
      await f.send('SEED NATIVE PANEL FIXTURE');
      await f.bindSession();
      sessionReported = true;
      pane = await f.exactPane();
      const sessionId = pane.agent.session.value;
      const main = codexInteraction(await capture('01-main'));
      assert(main.capabilities.compose);

      await command('/goal Verify fixture popup lifecycle');
      await f.wait(async () => /Pursuing goal|Goal paused/.test(await read()), 'Goal exists');
      await command('/goal Replacement fixture objective');
      const replace = await question('native replacement dialog');
      await capture('03-replace');
      assert.equal(replace.toolId, 'goal-confirmation');
      await assert.rejects(side.assertMain(await f.exactPane()), { code: 'QUESTION_PENDING' });
      const cancelled = { ...replace, requestId: 'cancel-replacement-' + cols, choices: [1] };
      assert.equal((await manager.answer(cancelled)).delivery, 'sent');
      const cancelKeys = controllerKeys.length;
      assert.equal((await manager.answer(cancelled)).repeated, true);
      assert.equal(controllerKeys.length, cancelKeys);
      assert(
        !/Replacement fixture objective/.test((await read()).split('Goal:').at(-1).split('\n')[0]),
      );
      await command('/goal pause');
      await f.wait(async () => /Goal paused/.test(await read()), 'Goal paused');
      await f.press(await f.exactPane(), ['esc']);
      await f.delay(200);
      const info = await f.herdr.readProcessInfo(f.paneId),
        pid = info.foreground_processes.find((p) => p.name === 'codex').pid;
      const argv = (await fs.readFile('/proc/' + pid + '/cmdline', 'utf8'))
        .split('\0')
        .filter(Boolean);
      for (let n = 0; n < 4; n++) {
        if (
          !(await f.herdr.readProcessInfo(f.paneId)).foreground_processes.some(
            (p) => p.name === 'codex',
          )
        )
          break;
        // Shutdown may remove the named-agent registration before its process
        // exits. This isolated pane is ours; send the exit key to that pane.
        await sendPaneKeys(f.paneId, ['ctrl+c'], { socketFile: f.herdr.socketPath });
        await f.delay(350);
      }
      await f.wait(
        async () =>
          !(await f.herdr.readProcessInfo(f.paneId)).foreground_processes.some(
            (p) => p.name === 'codex',
          ),
        'fixture Codex exited',
      );
      await f.herdr.request('pane.send_input', {
        pane_id: f.paneId,
        text: [...argv, 'resume', sessionId].map(quote).join(' '),
        keys: ['enter'],
      });
      await f.wait(
        async () => /Resume paused goal\?/.test(await read()),
        'startup Goal confirmation',
      );
      await f.bindSession();
      const resume = await question('recognized startup Goal confirmation');
      await capture('04-resume-goal');
      assert.equal(resume.toolId, 'goal-confirmation');
      await assert.rejects(side.assertMain(await f.exactPane()), { code: 'QUESTION_PENDING' });
      const count = f.requests.length,
        body = { ...resume, requestId: 'leave-paused-' + cols, choices: [1] };
      assert.equal((await manager.answer(body)).delivery, 'sent');
      const submittedKeys = controllerKeys.length;
      assert.equal((await manager.answer(body)).repeated, true);
      assert.equal(controllerKeys.length, submittedKeys);
      const raw = await capture('05-after-leave-paused');
      assert(/Goal paused/.test(raw));
      assert.equal(f.requests.length, count);
      assert(codexInteraction(raw).capabilities.compose);
      await side.assertMain(await f.exactPane());
      return {
        requestedClientColumns: cols,
        capturedMaxLineCharacters: Math.max(
          ...stripAnsi(raw)
            .split('\n')
            .map((line) => [...line.trimEnd()].length),
        ),
        nativeModelPicker: true,
        replacementCancel: true,
        startupLeavePaused: true,
        mainWriteBlockedByDialog: true,
        startupSelectionBeforeSessionReport: true,
        startupReportDelaySimulated: true,
        duplicateRequestNoAdditionalKey: true,
        sameNativeSession: (await f.exactPane()).agent.session.value === sessionId,
        noNewModelRequestFromLeavePaused: true,
        productionInput: false,
        externalInference: false,
      };
    },
    { cols, rows: 45, noAltScreen: false },
  );
}

(async () => {
  const managed = path.resolve('.local/runtime/codex/current/bin');
  if (
    await fs.access(path.join(managed, 'codex')).then(
      () => true,
      () => false,
    )
  )
    process.env.PATH = managed + path.delimiter + process.env.PATH;
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const cols of [147, 45]) {
    results.push(await run(cols));
    console.log(JSON.stringify(results.at(-1)));
  }
  const after = sourceFingerprint(process.cwd());
  assert.equal(after.treeSha256, before.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { CommandInteraction, nativeInput } = require('../../lib/command-interaction');
const { CodexSide } = require('../../lib/codex-side');
const { codexInteraction } = require('../../lib/codex-footer');
const { readStatusArea } = require('../../lib/agent-composer');
const { accountOf } = require('../../public/chat/status-read');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve(
  process.env.SWIFT_OWNED_COMMAND_OUTPUT || 'artifacts/testing/statusbar-order/native-commands',
);

async function run(cols) {
  const directory = path.join(output, String(cols));
  return fixture(
    directory,
    async (f) => {
      const raw = () => f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true });
      await f.wait(
        async () => codexInteraction(await raw()).capabilities.compose,
        'native main composer',
      );
      const prompt = 'HOLD OWNED COMMAND';
      await f.paste(await f.exactPane(), prompt);
      await f.wait(
        async () => readStatusArea(await raw()).composer === prompt,
        'fixture prompt pasted',
      );
      await f.press(await f.exactPane(), ['enter']);
      await f.wait(() => f.held.has(prompt), 'running native turn');
      await f.bindSession();
      const pane = await f.exactPane(),
        count = f.requests.length,
        writes = [],
        contexts = [],
        observations = [];
      const side = new CodexSide({ herdr: f.herdr, exactPane: f.exactPane });
      let settingsBusy = false;
      const service = new CommandInteraction({
        herdr: f.herdr,
        exactPane: f.exactPane,
        settleMs: 80,
        beforeWrite: async (current, context) => {
          contexts.push(context);
          if (!context.continuingCommandInput) await side.assertMain(current);
          if (settingsBusy && !context.clearingCommandInput)
            throw Object.assign(Error('Fixture settings queued'), { code: 'SETTINGS_BUSY' });
        },
        press: async (_id, keys) => {
          writes.push({ keys });
          return f.press(await f.exactPane(), keys);
        },
        paste: async (_id, text) => {
          writes.push({ text });
          await f.paste(await f.exactPane(), text);
          await f.wait(
            async () => readStatusArea(await raw()).composer === text,
            'native command pasted',
          );
          const screen = await raw(),
            interaction = codexInteraction(screen);
          observations.push({
            text,
            threadAfterPaste: interaction.thread,
            prompt: interaction.footer.lines[interaction.footer.prompt]?.trim()[0],
          });
          await fs.writeFile(path.join(directory, `query-${observations.length}.ansi`), screen);
          if (text === '/status' && observations.length === 3) settingsBusy = true;
        },
      });
      const base = {
        runtimeId: f.herdr.normalizeSnapshot({}).runtimeId,
        paneId: f.paneId,
        terminalId: pane.terminalId,
        processRuntimeId: pane.runtimeId,
        sessionId: pane.agent.session.value,
        clientId: 'owned-native-' + cols,
      };
      const settle = async (view) => {
        for (let n = 0; view.pending && n < 40; n++) {
          await f.delay(100);
          const next = await service.handle({ ...base, action: 'read', leaseId: view.leaseId });
          if (!next.unchanged) view = next;
        }
        assert(!view.pending);
        assert.notEqual(view.mode, 'query');
        return view;
      };
      const statusBody = { ...base, text: '/status', requestId: 'native-status' };
      const status = await settle(await service.execute(statusBody));
      assert.equal(status.mode, 'result');
      assert.match(accountOf(status.rows), /connected@example\.test/);
      assert.equal(nativeInput(await raw()), '');
      const written = writes.length;
      await service.execute(statusBody);
      assert.equal(writes.length, written);
      const background = await settle(
        await service.execute({ ...base, text: '/ps', requestId: 'native-background' }),
      );
      assert.equal(background.mode, 'result');
      assert.match(
        background.rows
          .flat()
          .map((span) => span.text)
          .join(''),
        /background terminals/i,
      );
      assert.equal(nativeInput(await raw()), '');
      const blocked = { ...base, text: '/status', requestId: 'native-settings-queued' };
      await assert.rejects(service.execute(blocked), { code: 'SETTINGS_BUSY' });
      const aborted = await service.handle({ ...base, action: 'read' });
      assert.equal(aborted.draftCleared, true);
      assert.equal(aborted.submissionStarted, false);
      assert.equal(nativeInput(await raw()), '');
      const afterAbort = writes.length;
      await assert.rejects(service.execute(blocked), { code: 'SETTINGS_BUSY' });
      assert.equal(writes.length, afterAbort);
      settingsBusy = false;
      const retry = await settle(
        await service.execute({ ...base, text: '/status', requestId: 'native-status-after-clear' }),
      );
      assert.match(accountOf(retry.rows), /connected@example\.test/);
      assert.equal(nativeInput(await raw()), '');
      assert(
        observations.some((row) => row.threadAfterPaste === 'unknown'),
        'The fixture must actually reproduce the filled-composer recognition loss',
      );
      assert(contexts.some((row) => row.continuingCommandInput));
      assert(contexts.some((row) => row.clearingCommandInput));
      assert.equal(writes.filter((row) => row.keys?.includes('enter')).length, 3);
      assert.equal(writes.filter((row) => row.keys?.includes('ctrl+u')).length, 1);
      assert(!writes.some((row) => row.keys?.includes('esc')));
      assert.equal(f.requests.length, count);
      assert.equal(codexInteraction(await raw()).execution, 'running');
      const after = await f.exactPane();
      assert.equal(after.runtimeId, pane.runtimeId);
      assert.equal(after.agent.session.value, base.sessionId);
      await fs.writeFile(path.join(directory, 'after.ansi'), await raw());
      f.held.get(prompt)();
      return {
        cols,
        nativeStatusResult: true,
        nativeBackgroundResult: true,
        account: accountOf(status.rows),
        observations,
        ownContinuationVerified: true,
        queuedSettingsDraftCleared: true,
        duplicateRequestsDidNotWrite: true,
        successfulEnterCount: 3,
        targetedClearCount: 1,
        noEscape: true,
        runningTurnPreserved: true,
        sameProcessAndSession: true,
        modelRequestsAdded: f.requests.length - count,
        productionInput: false,
        externalInference: false,
      };
    },
    {
      accountEmail: 'connected@example.test',
      cols,
      rows: 45,
      noAltScreen: false,
      codexConfig: [
        'model="gpt-6-astra"',
        'model_reasoning_effort="ultra"',
        'tui.status_line=["model-with-reasoning","account"]',
      ],
    },
  );
}
(async () => {
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const cols of [180, 45]) {
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

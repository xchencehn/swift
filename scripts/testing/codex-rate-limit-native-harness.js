'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { AgentQuestions } = require('../../lib/agent-questions');
const { CodexSide } = require('../../lib/codex-side');
const { CommandInteraction } = require('../../lib/command-interaction');
const { codexInteraction } = require('../../lib/codex-footer');
const { herdrRequest, sendPaneKeys } = require('../../lib/herdr-input');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/codex-rate-limit-prompt/native');
async function run(cols, choice) {
  return fixture(
    path.join(output, `${cols}-${choice}`),
    async (f) => {
      const raw = () => f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true });
      await f.paste(await f.exactPane(), 'trigger local quota reminder');
      await f.delay(120);
      await herdrRequest(
        'pane.send_keys',
        { pane_id: f.paneId, keys: ['enter'] },
        { socketFile: f.herdr.socketPath },
      );
      await f.wait(
        async () => (await raw()).includes('Approaching rate limits'),
        'native quota prompt',
      );
      await f.bindSession();
      await fs.writeFile(path.join(f.output, 'prompt.ansi'), await raw());
      const pane = await f.exactPane(),
        side = new CodexSide({ herdr: f.herdr, exactPane: f.exactPane });
      const writes = [];
      const manager = new AgentQuestions({
        herdr: f.herdr,
        exactPane: f.exactPane,
        readLines: async () => [],
        requireProcess: true,
        keys: async (id, keys) => {
          writes.push(keys);
          return sendPaneKeys(id, keys, { socketFile: f.herdr.socketPath });
        },
        beforeAnswer: (target, q) =>
          manager.verifyQuestionThread(target, q, () => side.assertMain(target)),
      });
      const q = await manager.read(pane);
      assert.equal(q?.nativeModal?.kind, 'rate-limit', 'Quota prompt must have actionable choices');
      assert(q.question.includes('Approaching rate limits'));
      assert.equal(q.options.length, 3);
      const body = { ...q, choices: [choice], requestId: `quota-${cols}-${choice}` };
      assert.equal((await manager.answer(body)).delivery, 'sent');
      const count = writes.length;
      assert.equal((await manager.answer(body)).repeated, true);
      assert.equal(writes.length, count);
      await f.wait(
        async () => codexInteraction(await raw()).capabilities.compose,
        'composer restored',
      );
      assert.equal(await manager.read(pane), null);
      await side.assertMain(pane);
      const config = await fs
        .readFile(path.join(f.codeHome, 'config.toml'), 'utf8')
        .catch(() => '');
      assert.equal(/hide_rate_limit_model_nudge\s*=\s*true/.test(config), choice === 2);
      const commands = new CommandInteraction({
        herdr: f.herdr,
        exactPane: f.exactPane,
        settleMs: 60,
        press: (_id, keys) => f.press(pane, keys),
        paste: (_id, text) => f.paste(pane, text),
        beforeWrite: (target) => side.assertMain(target),
      });
      const base = {
        runtimeId: f.herdr.normalizeSnapshot({}).runtimeId,
        paneId: f.paneId,
        terminalId: pane.terminalId,
        processRuntimeId: pane.runtimeId,
        sessionId: pane.agent.session.value,
        clientId: 'quota-fixture',
      };
      let view = await commands.execute({
        ...base,
        text: '/status',
        requestId: 'status-after-quota',
      });
      for (let i = 0; view.pending && i < 50; i++) {
        await f.delay(100);
        view = await commands.handle({ ...base, action: 'read', leaseId: view.leaseId });
      }
      assert.equal(view.mode, 'result');
      assert(!view.pending);
      assert.equal(f.requests.length, 1, 'Selection and status must not send model requests');
      await f.send('exact message after quota choice');
      assert.equal(f.requests.at(-1).model, choice === 0 ? 'gpt-6-luna' : 'gpt-6.1-sol');
      assert.equal(
        f.requests
          .at(-1)
          .input.at(-1)
          .content.map((p) => p.text || '')
          .join(''),
        'exact message after quota choice',
      );
      assert.equal((await f.exactPane()).runtimeId, pane.runtimeId);
      await fs.writeFile(path.join(f.output, 'after.ansi'), await raw());
      return {
        cols,
        choice,
        statusRestored: true,
        exactMessage: true,
        duplicateDidNotWrite: true,
        productionInput: false,
      };
    },
    {
      cols,
      rows: 45,
      noAltScreen: false,
      noDaemon: true,
      responseHeaders: {
        'x-codex-primary-used-percent': '95',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
      },
    },
  );
}
(async () => {
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const cols of [140, 45])
    for (const choice of [0, 1, 2]) {
      results.push(await run(cols, choice));
      console.log(JSON.stringify(results.at(-1)));
    }
  const after = sourceFingerprint(process.cwd());
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

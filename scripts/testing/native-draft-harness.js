'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { NativeDraft } = require('../../lib/native-draft');
const { composerState } = require('../../lib/native-composer');
const { herdrRequest } = require('../../lib/herdr-input');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { binding } = require('../../lib/conversation-state');
const output = path.resolve('artifacts/testing/codex-rate-limit-prompt/draft-native');
async function run(cols) {
  return fixture(
    path.join(output, String(cols)),
    async (f) => {
      const raw = () => f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true });
      const manager = new NativeDraft({
        herdr: f.herdr,
        exactPane: f.exactPane,
        operate: (_id, work) => work(),
      });
      await f.wait(
        async () => (await f.exactPane()).agent?.label === 'codex',
        'startup provider identity',
      );
      await f.wait(
        async () => composerState(await raw(), 'codex').recognized,
        'startup composer recognized',
      );
      const startup = await f.exactPane();
      await fs.writeFile(path.join(f.output, 'startup.ansi'), await raw());
      await fs.writeFile(
        path.join(f.output, 'startup-state.json'),
        JSON.stringify(composerState(await raw(), 'codex')),
      );
      assert.equal(
        (await manager.handle({ action: 'prepare', paneId: f.paneId, binding: binding(startup) }))
          .text,
        '',
      );
      assert.equal(f.requests.length, 0, 'empty startup never submits');
      await f.paste(startup, '首条消息之前的原生草稿');
      await f.wait(async () => composerState(await raw(), 'codex').input, 'startup draft visible');
      const startupDraft = await manager.handle({
        action: 'prepare',
        paneId: f.paneId,
        binding: binding(await f.exactPane()),
      });
      assert.equal(startupDraft.text, '首条消息之前的原生草稿');
      await manager.handle({ ...startupDraft, action: 'clear' });
      assert.equal(f.requests.length, 0, 'startup draft migration never submits');
      await f.paste(await f.exactPane(), 'initialize draft fixture');
      await f.delay(150);
      await herdrRequest(
        'pane.send_keys',
        { pane_id: f.paneId, keys: ['enter'] },
        { socketFile: f.herdr.socketPath },
      );
      await f.wait(async () => (await raw()).includes('ANSWER 1'), 'initial answer');
      await f.bindSession();
      const pane = await f.exactPane(),
        initialRequests = f.requests.length;
      const drafts = ['终端中的未发送内容', '第一行中文\n第二行 draft'];
      for (const text of drafts) {
        await f.paste(pane, text);
        await f.wait(async () => composerState(await raw(), 'codex').input, 'draft visible');
        await fs.writeFile(
          path.join(f.output, 'before-' + drafts.indexOf(text) + '.ansi'),
          await raw(),
        );
        const prepared = await manager.handle({
          action: 'prepare',
          paneId: f.paneId,
          binding: binding(pane),
        });
        assert.equal(prepared.text, text);
        assert(composerState(await raw(), 'codex').input, 'prepare leaves terminal intact');
        await manager.handle({ ...prepared, action: 'clear' });
        assert.equal(composerState(await raw(), 'codex').input, '');
        assert.equal((await manager.handle({ ...prepared, action: 'clear' })).cleared, true);
      }
      assert.equal(f.requests.length, initialRequests, 'moving must not send anything');
      assert.equal((await f.exactPane()).runtimeId, pane.runtimeId);
      return {
        cols,
        emptyStartup: true,
        startupDraftMigratedWithoutSending: true,
        exactText: drafts.length,
        noMessageSent: true,
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
  assert.equal(before.treeSha256, after.treeSha256);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

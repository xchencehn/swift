'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { CommandInteraction } = require('../../lib/command-interaction');
const { CodexSide } = require('../../lib/codex-side');
const { codexInteraction } = require('../../lib/codex-footer');
const out = path.resolve('artifacts/testing/native-statusbar/native');
async function run(cols) {
  return fixture(
    path.join(out, String(cols)),
    async (f) => {
      const read = () =>
        f.herdr.readPane(f.paneId, { source: 'recent', lines: 160, ansi: true, exact: true });
      await f.wait(
        async () => codexInteraction(await read()).capabilities.compose,
        'startup ready',
      );
      await f.send('SEED STATUSBAR FIXTURE');
      await f.bindSession();
      const before = await f.exactPane(),
        baselineRequests = f.requests.length;
      const side = new CodexSide({ herdr: f.herdr, exactPane: f.exactPane });
      const writes = [],
        contexts = [];
      const service = new CommandInteraction({
        herdr: f.herdr,
        exactPane: f.exactPane,
        beforeWrite: async (pane, context) => {
          contexts.push(context.continuingStatusView || '');
          if (context.continuingStatusView !== 'warnings') await side.assertMain(pane);
        },
        press: async (id, keys) => {
          writes.push(keys);
          return f.press(await f.exactPane(), keys);
        },
        paste: async (_id, text) => f.paste(await f.exactPane(), text),
        settleMs: 80,
      });
      const base = {
        runtimeId: f.herdr.normalizeSnapshot({}).runtimeId,
        paneId: f.paneId,
        terminalId: before.terminalId,
        sessionId: before.agent.session.value,
        clientId: `statusbar-native-${cols}`,
      };
      let serial = 0;
      const call = (action, view, extra = {}) =>
        service.handle({
          ...base,
          action,
          leaseId: view.leaseId,
          revision: view.revision,
          requestId: `native-${++serial}`,
          ...extra,
        });
      const settle = async (view) => {
        for (let i = 0; view.pending && i < 40; i++) {
          await f.delay(100);
          view = await call('read', view);
        }
        assert(!view.pending, 'Native status operation must become observable');
        return view;
      };
      let view = await settle(
        await service.execute({ ...base, text: '/ps', requestId: 'native-background' }),
      );
      assert.equal(view.mode, 'result');
      assert.match(
        view.rows
          .flat()
          .map((span) => span.text)
          .join('\n'),
        /background terminals/i,
      );
      await fs.writeFile(
        path.join(out, String(cols), 'background.json'),
        JSON.stringify(view, null, 2),
      );
      view = await settle(
        await service.execute({ ...base, text: '/warnings', requestId: 'native-warnings' }),
      );
      assert.equal(view.surface, 'warnings');
      assert(view.warningCount >= 1);
      const warningCount = view.warningCount,
        parsed = codexInteraction(await read());
      assert.equal(parsed.modal?.kind, 'warnings');
      assert.equal(parsed.capabilities.compose, false);
      await fs.writeFile(path.join(out, String(cols), 'warnings.ansi'), await read());
      if (warningCount > 1) {
        view = await settle(await call('key', view, { key: 'right' }));
        assert.equal(view.warningIndex, 2);
      }
      const countBeforeClose = writes.length;
      for (let i = 0; view.mode === 'menu' && i < warningCount * 2 + 3; i++)
        view = await settle(await call('close', view));
      assert(!['menu', 'query'].includes(view.mode));
      assert(
        writes
          .slice(countBeforeClose)
          .every((keys) => keys.length === 1 && ['left', 'k'].includes(keys[0])),
      );
      assert.equal(
        writes.slice(countBeforeClose).filter((keys) => keys[0] === 'k').length,
        warningCount,
      );
      await f.wait(
        async () => codexInteraction(await read()).capabilities.compose,
        'warnings returned to composer',
      );
      await side.assertMain(await f.exactPane());
      assert.equal((await f.exactPane()).runtimeId, before.runtimeId);
      assert.equal(f.requests.length, baselineRequests);
      await fs.writeFile(path.join(out, String(cols), 'after.ansi'), await read());
      return {
        requestedClientColumns: cols,
        warningCount,
        backgroundResult: true,
        nativeWarningsRecognized: true,
        ownedWarningContinuation: contexts.includes('warnings'),
        normalCloseKeptEveryWarning: true,
        noEscapeOrPrompt: !writes.some((keys) => keys.includes('esc')),
        sameProcessAndSession: (await f.exactPane()).agent.session.value === base.sessionId,
        productionInput: false,
        externalInference: false,
      };
    },
    {
      cols,
      rows: 45,
      noAltScreen: false,
      codexConfig: ['mcp_servers.status_fixture.command="/nonexistent/swift-status-fixture"'],
    },
  );
}
(async () => {
  const before = sourceFingerprint(process.cwd()),
    results = [];
  for (const cols of [147, 45]) {
    results.push(await run(cols));
    console.log(JSON.stringify(results.at(-1)));
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify({ ok: true, before, after, results }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

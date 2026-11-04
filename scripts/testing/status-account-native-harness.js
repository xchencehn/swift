'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { CommandInteraction } = require('../../lib/command-interaction');
const { CodexSide } = require('../../lib/codex-side');
const { codexInteraction } = require('../../lib/codex-footer');
const { create } = require('../../public/chat/status-read');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/native-statusbar/native-account');
(async () => {
  const before = sourceFingerprint(process.cwd());
  const result = await fixture(
    output,
    async (f) => {
      const raw = () => f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true });
      await f.wait(
        async () => codexInteraction(await raw()).capabilities.compose,
        'native composer',
      );
      await f.paste(await f.exactPane(), 'HOLD ACCOUNT STATUS');
      await f.wait(
        async () => (await f.text()).includes('› HOLD ACCOUNT STATUS'),
        'fixture prompt pasted',
      );
      await f.press(await f.exactPane(), ['enter']);
      await f.wait(() => f.held.has('HOLD ACCOUNT STATUS'), 'running native turn');
      await f.bindSession();
      const pane = await f.exactPane(),
        count = f.requests.length,
        writes = [];
      const side = new CodexSide({ herdr: f.herdr, exactPane: f.exactPane });
      const service = new CommandInteraction({
        herdr: f.herdr,
        exactPane: f.exactPane,
        beforeWrite: (p) => side.assertMain(p),
        settleMs: 80,
        press: async (id, keys) => {
          writes.push({ keys });
          return f.press(await f.exactPane(), keys);
        },
        paste: async (id, text) => {
          writes.push({ text });
          return f.paste(await f.exactPane(), text);
        },
      });
      const target = {
        runtimeId: f.herdr.normalizeSnapshot({}).runtimeId,
        paneId: f.paneId,
        terminalId: pane.terminalId,
        sessionId: pane.agent.session.value,
        processRuntimeId: pane.runtimeId,
      };
      // This is synthetic fixture data. The running process must retain its own
      // connected account even when a future process's default file is different.
      await f.writeFixtureAccount('disk-default@example.test');
      const reader = create({
        identity: () => 'isolated-native',
        target: () => target,
        request: (body) =>
          body.action === 'execute' ? service.execute(body) : service.handle(body),
      });
      await reader.read();
      assert.equal(reader.view().phase, 'ready');
      assert.match(reader.view().account, /connected@example\.test/);
      await reader.read({ refresh: true });
      assert.equal(reader.view().phase, 'ready');
      assert.match(reader.view().account, /connected@example\.test/);
      assert(!reader.view().account.includes('disk-default'));
      assert.equal(f.requests.length, count);
      assert.equal(codexInteraction(await raw()).execution, 'running');
      assert.equal(writes.filter((row) => row.text === '/status').length, 2);
      assert(!writes.some((row) => row.keys?.includes('esc')));
      const after = await f.exactPane();
      assert.equal(after.runtimeId, pane.runtimeId);
      assert.equal(after.agent.session.value, target.sessionId);
      await assert.rejects(
        service.execute({
          ...target,
          processRuntimeId: 'stale-process',
          clientId: 'stale',
          requestId: 'stale',
          text: '/status',
        }),
        { code: 'SESSION_CHANGED' },
      );
      f.held.get('HOLD ACCOUNT STATUS')();
      return {
        account: reader.view().account,
        connectedAccountVerified: true,
        differsFromDiskDefault: true,
        runningTurnPreserved: true,
        sameProcessAndSession: true,
        nativeStatusExecutions: 2,
        modelRequestsAdded: f.requests.length - count,
        staleProcessRejected: true,
        productionInput: false,
        externalInference: false,
      };
    },
    { accountEmail: 'connected@example.test', cols: 180, rows: 45, noAltScreen: false },
  );
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: true, before, after, result }, null, 2),
  );
  console.log(JSON.stringify(result));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

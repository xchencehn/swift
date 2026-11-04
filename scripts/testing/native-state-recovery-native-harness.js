'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture } = require('./message-rewind-fixture');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { CodexTerminalRefresh } = require('../../lib/codex-terminal-refresh');
const { NativeWatch } = require('../../lib/codex-rewind-watch');
const { surface } = require('../../lib/codex-rewind-native');
const { parseCodexFooter, textOf } = require('../../public/native-status');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const root = path.resolve(__dirname, '../..');

async function oneCase(output, draft, working = false) {
  return fixture(
    output,
    async (f) => {
      await f.send('RECOVERY SEED 中文第一条');
      await f.send('RECOVERY SEED 中文第二条');
      await f.bindSession();
      let pane = await f.exactPane();
      await f.herdr.focusPane(pane.paneId);
      pane = await f.exactPane();
      const watch = new NativeWatch({ herdr: f.herdr, pane });
      const observe = async () => {
        const frame = await watch.read();
        return { frame, state: surface(frame) };
      };
      const capture = async (name) => {
        const view = await observe(),
          history = await f.readHistory(),
          dashboard = await f.herdr.dashboard(),
          snapshot = await f.herdr.snapshot();
        const record = {
          name,
          frame: view.frame,
          mode: view.state.mode,
          input: view.state.input,
          working: view.state.working,
          history,
          archiveHash: hash(await fs.readFile(history.branch)),
          modelRequests: f.requests.length,
          focusedPaneId: dashboard.focusedPaneId,
          focusedWorkspaceId: dashboard.focusedWorkspaceId,
          layouts: snapshot.layouts,
          runtimeId: (await f.exactPane()).runtimeId,
        };
        await fs.writeFile(path.join(output, name + '.json'), JSON.stringify(record, null, 2));
        await f.capture(name + '-herdr');
        return record;
      };
      try {
        if (working) {
          await f.sendMessage(pane, 'HOLD RECOVERY ACTIVE WORK');
          await f.wait(async () => /Working/.test(await f.text()), 'held native work');
        }
        if (draft) await f.paste(pane, draft);
        await f.wait(async () => {
          const view = await observe();
          return view.state.mode === 'main' && view.state.input === draft;
        }, 'native composer before refresh');
        const before = await capture('01-before');
        assert.equal(before.focusedPaneId, pane.paneId);
        const footer = parseCodexFooter(before.frame.rows.map(textOf));
        assert(footer.prompt >= 0 && footer.footerIndex >= 0);
        const pid = Number(pane.runtimeId.split(':')[0]);
        // Corrupt only the fixture's VT output, keeping Codex's internal backbuffer
        // intact. No input, archive mutation or production pane is involved.
        const fd = await fs.open(`/proc/${pid}/fd/1`, 'w');
        try {
          await fd.write(
            '\x1b7' +
              `\x1b[${footer.prompt + 1};1H\x1b[2K` +
              `\x1b[${footer.footerIndex + 1};1H\x1b[2K\x1b[100G00% left` +
              '\x1b8',
          );
        } finally {
          await fd.close();
        }
        await f.wait(
          async () => (await observe()).state.mode === 'unknown',
          'controlled native VT damage',
        );
        await capture('02-damaged');
        const writeCount = f.writes.length,
          requestCount = f.requests.length,
          rpc = [];
        const nativeRequest = f.herdr.request.bind(f.herdr);
        f.herdr.request = (...args) => {
          rpc.push(args[0]);
          return nativeRequest(...args);
        };
        const refresh = new CodexTerminalRefresh({
          herdr: f.herdr,
          exactPane: () => f.exactPane(),
        });
        const result = await refresh.refresh({
          pane,
          requestId: 'native-recovery-fixture',
          reason: 'prewrite-unknown',
          verify: async () => {
            const current = await f.exactPane();
            assert.equal(current.runtimeId, pane.runtimeId);
            assert.equal(current.agent.session.value, pane.agent.session.value);
          },
        });
        assert.equal(result.mainConfirmed, true);
        assert.equal(result.refreshed, true);
        assert(
          rpc.every((method) =>
            ['session.snapshot', 'pane.process_info', 'pane.read'].includes(method),
          ),
          'Recovery must use only read-only Herdr RPC',
        );
        assert.equal(f.writes.length, writeCount, 'Recovery sends no keys or agent input');
        assert.equal(f.requests.length, requestCount, 'Recovery submits no model request');
        const after = await capture('03-restored');
        assert.equal(after.mode, 'main');
        assert.equal(after.working, before.working);
        assert.equal(before.working, working);
        assert.equal(after.input, draft);
        assert.deepEqual(after.frame.cursor, before.frame.cursor);
        assert.equal(after.archiveHash, before.archiveHash);
        assert.equal(after.history.branch, before.history.branch);
        assert.equal(after.history.revision, before.history.revision);
        assert.equal(after.runtimeId, before.runtimeId);
        assert.equal(after.focusedPaneId, before.focusedPaneId);
        assert.equal(after.focusedWorkspaceId, before.focusedWorkspaceId);
        assert.deepEqual(after.layouts, before.layouts);
        for (const text of ['RECOVERY SEED 中文第一条', 'RECOVERY SEED 中文第二条'])
          assert(after.frame.rows.some((row) => textOf(row).includes(text)));
        return {
          ok: true,
          working,
          draft: draft ? 'multiline-chinese' : 'empty',
          result,
          noRecoveryKeys: true,
          noHerdrMutation: true,
          noModelRequest: true,
          archiveBytesPreserved: true,
          historyPreserved: true,
          cursorPreserved: true,
          focusAndLayoutPreserved: true,
          runtimeId: pane.runtimeId,
          sessionId: pane.agent.session.value,
          output,
        };
      } finally {
        await watch.close();
      }
    },
    { cols: 147, rows: 54, noAltScreen: false },
  );
}

async function run(baseOutput) {
  await fs.mkdir(baseOutput, { recursive: true });
  const output = await fs.mkdtemp(path.join(baseOutput, 'run-')),
    summaryFile = path.join(baseOutput, 'report.json');
  const before = sourceFingerprint(root);
  await fs.writeFile(summaryFile, JSON.stringify({ ok: false, running: true, output }, null, 2));
  try {
    const results = [];
    for (const [name, draft, working] of [
      ['empty', '', false],
      ['draft', 'DRAFT 中文第一行  双空格\n  第二行保留中文与标点。', false],
      ['working', 'WORKING 中文第一行\n  保留未发送草稿。', true],
    ])
      results.push(await oneCase(path.join(output, name), draft, working));
    const after = sourceFingerprint(root);
    assert.equal(before.treeSha256, after.treeSha256);
    const report = {
      ok: true,
      before,
      after,
      launchMode: 'default-owned',
      results,
      productionInput: false,
      externalInference: false,
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(
      summaryFile,
      JSON.stringify(
        { ok: true, output, reportFile: path.join(output, 'report.json'), results },
        null,
        2,
      ),
    );
    return report;
  } catch (error) {
    const failure = {
      ok: false,
      output,
      error: { code: error.code || null, message: error.message },
      before,
    };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(failure, null, 2));
    await fs.writeFile(summaryFile, JSON.stringify(failure, null, 2));
    throw error;
  }
}
module.exports = { run };
if (require.main === module)
  run(path.resolve(process.argv[2] || 'artifacts/native-state-recovery/native'))
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });

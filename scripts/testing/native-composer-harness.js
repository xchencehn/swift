'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { fixture } = require('./message-rewind-fixture');
const { clearNativeComposer, composerState } = require('../../lib/native-composer');
const { CommandInteraction } = require('../../lib/command-interaction');
const { CodexSide } = require('../../lib/codex-side');
const { CodexSettings, codexMenu } = require('../../lib/codex-settings');
const { codexInteraction } = require('../../lib/codex-footer');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const output = path.resolve('artifacts/testing/native-composer-clear/native');
async function run(cols) {
  return fixture(
    path.join(output, String(cols)),
    async (f) => {
      const raw = () => f.herdr.readPane(f.paneId, { lines: 160, ansi: true, exact: true });
      console.log('Initialize native fixture', cols);
      const initial = await f.exactPane();
      await f.paste(initial, 'initialize composer fixture');
      await f.wait(
        async () =>
          composerState(await raw(), 'codex').input.includes('initialize composer fixture'),
        'initial input',
      );
      await require('../../lib/herdr-input').herdrRequest(
        'pane.send_keys',
        { pane_id: f.paneId, keys: ['enter'] },
        { socketFile: f.herdr.socketPath },
      );
      await f.wait(() => f.requests.length === 1, 'initial model request');
      await f.wait(async () => (await raw()).includes('ANSWER 1'), 'initial answer');
      await f.bindSession();
      const pane = await f.exactPane(),
        initialRequests = f.requests.length;
      const clear = () =>
        clearNativeComposer({
          pane,
          herdr: f.herdr,
          exactPane: f.exactPane,
          press: (keys) => f.press(pane, keys),
          stepMs: 60,
        });
      const side = new CodexSide({ herdr: f.herdr, exactPane: f.exactPane });
      const commands = new CommandInteraction({
        herdr: f.herdr,
        exactPane: f.exactPane,
        settleMs: 60,
        press: (_id, keys) => f.press(pane, keys),
        paste: (_id, text) => f.paste(pane, text),
        beforeWrite: async (current, context) => {
          let composerCleared = false;
          if (!context.continuingCommandInput && !context.continuingStatusView) {
            composerCleared = await clear();
            await side.assertMain(current);
          }
          return { composerCleared };
        },
      });
      const base = {
        runtimeId: f.herdr.normalizeSnapshot({}).runtimeId,
        paneId: f.paneId,
        terminalId: pane.terminalId,
        processRuntimeId: pane.runtimeId,
        sessionId: pane.agent.session.value,
        clientId: 'composer-fixture',
      };
      const drafts = [
        '旧命令 /status',
        '第一行中文\n\n第三行 unfinished suffix',
        '很长的原生粘贴内容 '.repeat(90),
      ];
      const cases = [];
      for (let index = 0; index < drafts.length; index++) {
        console.log('Draft query', cols, index);
        await f.paste(pane, drafts[index]);
        await f.wait(async () => composerState(await raw(), 'codex').input, 'draft visible');
        await f.press(pane, ['left', 'left', 'left']);
        await fs.writeFile(path.join(output, String(cols), `draft-${index}.ansi`), await raw());
        const body = {
          ...base,
          text: index === 1 ? '/ps' : '/status',
          requestId: 'query-' + index,
        };
        let view = await commands.execute(body);
        for (let n = 0; view.pending && n < 50; n++) {
          await f.delay(100);
          view = await commands.handle({ ...base, action: 'read', leaseId: view.leaseId });
        }
        assert.equal(view.mode, 'result');
        assert(!view.pending);
        assert.equal(composerState(await raw(), 'codex').input, '');
        const writes = f.writes.length;
        await commands.execute(body);
        assert.equal(f.writes.length, writes);
        cases.push({ draft: index, query: body.text, duplicateDidNotWrite: true });
      }
      const catalog = {
        models: [
          {
            id: 'gpt-6-astra',
            label: 'GPT-6-Astra',
            efforts: ['low', 'medium', 'high', 'max', 'ultra'].map((id) => ({ id })),
          },
          {
            id: 'gpt-6.1-sol',
            label: 'GPT-6.1-Sol',
            efforts: ['low', 'medium', 'high', 'max', 'ultra'].map((id) => ({ id })),
          },
        ],
      };
      const settings = new CodexSettings({
        herdr: f.herdr,
        exactPane: f.exactPane,
        configFile: path.join(f.codeHome, 'config.toml'),
        beforeApply: async (current) => {
          await clear();
          await side.assertMain(current);
        },
      });
      console.log('Native settings', cols);
      for (const change of [{ effort: 'low' }, { model: 'gpt-6.1-sol', effort: 'high' }]) {
        await f.paste(pane, '未发送的设置草稿\n第二行');
        await f.wait(async () => composerState(await raw(), 'codex').input, 'settings draft');
        const applied = await settings.apply(pane, change, catalog);
        assert.equal(applied.effort, change.effort);
        if (change.model) assert.equal(applied.model, change.model);
        assert(!codexMenu(await raw()));
      }
      assert.equal(
        f.requests.length,
        initialRequests,
        'queries and settings must not submit the discarded draft',
      );
      await f.paste(pane, '不能拼到新消息前面的旧草稿');
      await f.wait(async () => composerState(await raw(), 'codex').input, 'send draft');
      await clear();
      await side.assertMain(pane);
      await f.send('new exact message');
      assert.equal(f.requests.length, initialRequests + 1);
      assert.equal(
        f.requests
          .at(-1)
          .input.at(-1)
          .content.map((x) => x.text || '')
          .join(''),
        'new exact message',
      );
      const active = 'HOLD clearing must not interrupt';
      await f.paste(pane, active);
      await f.delay(100);
      await f.press(pane, ['enter']);
      await f.wait(() => f.held.has(active), 'active turn');
      await f.paste(pane, '工作中残留输入\n第二行');
      await f.wait(async () => composerState(await raw(), 'codex').input, 'running draft');
      await clear();
      assert.equal(codexInteraction(await raw()).execution, 'running');
      f.held.get(active)();
      const current = await f.exactPane();
      assert.equal(current.runtimeId, pane.runtimeId);
      assert.equal(current.agent.session.value, pane.agent.session.value);
      return {
        cols,
        cases,
        modelAndEffort: true,
        exactMessage: true,
        workingTurnPreserved: true,
        productionInput: false,
      };
    },
    {
      cols,
      rows: 45,
      noAltScreen: false,
      codexConfig: [
        'model="gpt-6-astra"',
        'model_reasoning_effort="high"',
        'tui.status_line=["model-with-reasoning","current-dir","context-used"]',
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

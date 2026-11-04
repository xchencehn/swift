'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict'),
  { DatabaseSync } = require('node:sqlite');
const { firefox, expect } = require('@playwright/test');
const { createFixture, viewports } = require('./chat-harness');
const { locateTranscript } = require('../../lib/agent-transcript');
const { ConversationStore } = require('../../lib/conversation-store');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const ID = '01a16b68-2e81-7e13-a82c-0eda218fddf5';
const OLD = '/fixture/worktrees/scatter',
  CURRENT = '/fixture/retired-worktrees/scatter';
const record = (role, text) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  }) + '\n';

(async () => {
  const output = path.resolve('artifacts/testing/empty-running-transcript/browser');
  await fs.mkdir(output, { recursive: true });
  const before = sourceFingerprint(process.cwd()),
    browser = await firefox.launch(),
    results = [];
  try {
    for (const viewport of [
      ...viewports,
      { name: 'small-mobile', width: 320, height: 740, touch: true },
    ]) {
      for (const sync of [false, true]) {
        const name = `${viewport.name}-${sync ? 'sync' : 'poll'}`;
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-archive-directory-'));
        const root = path.join(home, '.codex'),
          directory = path.join(root, 'sessions/2026/10/24');
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `rollout-2026-10-24T08-55-52-${ID}.jsonl`);
        const header =
          JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: OLD } }) + '\n';
        await fs.writeFile(
          file,
          header +
            record('user', '请继续处理目录变化前的工作。') +
            record('assistant', '原生会话已有的历史消息。'),
        );
        const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
        db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)');
        db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(ID, file, OLD);
        const fixture = await createFixture();
        fixture.state.sync = sync;
        fixture.state.productionPresentation = true;
        const session = fixture.state.sessions['pane-codex'];
        session.pane.agent.session.value = ID;
        session.pane.cwd = CURRENT;
        session.pane.baseCwd = CURRENT;
        session.activity = '• Working (2h 54m 02s · esc to interrupt)';
        const store = new ConversationStore();
        const refresh = async () => {
          const current = locateTranscript('codex', ID, CURRENT, home);
          session.archivePending = !current;
          session.messages = current ? (await store.read(current, 'codex')).conversation : [];
          fixture.changed();
          if (sync) await fixture.synced();
        };
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.touch,
          serviceWorkers: 'block',
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await refresh();
          await page.goto(fixture.url + '/?token=fixture&pane=pane-codex');
          await expect(page.locator('.chat-welcome-caption')).toHaveText(
            '正在读取原生会话记录，消息会自动同步',
          );
          await expect(page.locator('#chatLog')).not.toContainText('从一条消息开始这个会话');
          await page.locator('#commandInput').fill('未发送的中文草稿');
          await page.screenshot({ path: path.join(output, name + '-pending.png') });
          db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(CURRENT, ID);
          await refresh();
          await expect(page.locator('#chatLog')).toContainText('原生会话已有的历史消息。');
          await expect(page.locator('.chat-welcome')).toHaveCount(0);
          await expect(page.locator('#commandInput')).toHaveValue('未发送的中文草稿');
          await fs.appendFile(file, record('assistant', '目录变化后的新增输出持续同步。'));
          await refresh();
          await expect(page.locator('#chatLog')).toContainText('目录变化后的新增输出持续同步。');
          await page.reload();
          await expect(page.locator('#chatLog')).toContainText('目录变化后的新增输出持续同步。');
          await expect(page.locator('#commandInput')).toHaveValue('未发送的中文草稿');
          const geometry = await page.locator('#chatView').evaluate((element) => ({
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
            viewport: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
          assert(!geometry.overflow);
          assert(geometry.left >= -1 && geometry.right <= geometry.viewport + 1);
          assert.equal(
            fixture.state.requests.filter((r) => r.route.startsWith('POST /api/messages')).length,
            0,
          );
          assert.equal(
            fixture.state.frames.filter((frame) => frame.includes('terminal.input')).length,
            0,
          );
          assert.equal((await fs.readFile(file, 'utf8')).split('\n')[0] + '\n', header);
          assert.deepEqual(errors, []);
          await page.screenshot({ path: path.join(output, name + '-recovered.png') });
          results.push({
            viewport,
            sync,
            nativeDirectoryResolved: true,
            existingHistoryRecovered: true,
            appendedOutputVisible: true,
            reloadPreservesHistory: true,
            draftPreserved: true,
            headerUnchanged: true,
            noNativeInput: true,
            geometry,
          });
        } catch (error) {
          await page.screenshot({ path: path.join(output, name + '-failure.png') }).catch(() => {});
          throw error;
        } finally {
          await context.close();
          await fixture.close();
          db.close();
          await fs.rm(home, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await browser.close();
  }
  const after = sourceFingerprint(process.cwd());
  assert.deepEqual(after, before);
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        before,
        after,
        results,
        fixture: 'native SQLite / archive resolver and parser with isolated browser transport',
        productionInput: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS directory changes, existing history, new output and draft recovery: ${results.length} browser scenarios.`,
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

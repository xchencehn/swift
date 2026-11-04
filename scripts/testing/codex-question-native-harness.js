#!/usr/bin/env node
'use strict';
// Real Codex UI + native archives, isolated HOME and local synthetic Responses.
// No production pane, credentials, external inference or app-server is used.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const pty = require('node-pty'),
  { Terminal } = require('@xterm/headless');
const { AgentQuestions } = require('../../lib/agent-questions'),
  codex = require('../../lib/questions/codex');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { CodexSide } = require('../../lib/codex-side');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate) {
  for (let i = 0; i < 100; i++) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  throw Error('Native question state timed out');
}
(async () => {
  const before = sourceFingerprint(process.cwd());
  const managed = path.resolve('.local/runtime/codex/current/bin/codex');
  const binary =
    process.env.SWIFT_CODEX_FIXTURE_BIN || (fs.existsSync(managed) ? managed : 'codex');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-codex-question-test-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    SWIFT_FIXTURE_KEY: 'fake-local-fixture-key',
  };
  fs.mkdirSync(env.CODEX_HOME);
  const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  const output = path.resolve(
    'artifacts/codex-questions-native',
    version.replace(/[^\w.-]+/g, '-'),
  );
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ ok: false, running: true, version, before }),
  );
  const requests = [],
    writes = [];
  const calls = [
    {
      id: 'first',
      questions: [
        { title: 'Which build target?', options: ['Desktop', 'Mobile'] },
        { title: 'What is the project name?' },
      ],
    },
    {
      id: 'second',
      questions: [
        { title: 'Which implementation?', options: ['Default', 'Custom'] },
        { title: 'Skip this optional question?', options: ['Yes', 'No'] },
      ],
    },
  ];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    requests.push(body);
    const id = 'fixture-response-' + requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sequence = 0;
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
      );
    event('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
    if (requests.length === 1) {
      const items = calls.map((call) => ({
        id: 'fc-' + call.id,
        type: 'function_call',
        call_id: call.id,
        name: 'request_user_input_async',
        namespace: 'functions',
        arguments: JSON.stringify({ questions: call.questions }),
      }));
      for (const [index, item] of items.entries()) {
        event('response.output_item.added', {
          output_index: index,
          item: { ...item, arguments: '' },
        });
        event('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: index,
          delta: item.arguments,
        });
        event('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: index,
          arguments: item.arguments,
        });
        event('response.output_item.done', { output_index: index, item });
      }
      event('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: items,
          usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
        },
      });
      res.end();
    } else {
      // Keep the native turn working while the user answers asynchronously.
      const timer = setTimeout(() => res.end(), 60000);
      timer.unref();
      res.once('close', () => clearTimeout(timer));
    }
  });
  let child;
  const terminal = new Terminal({ cols: 120, rows: 45, allowProposedApi: true });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    child = pty.spawn(
      binary,
      [
        '--no-alt-screen',
        '-a',
        'never',
        '--sandbox',
        'workspace-write',
        '-c',
        'model="gpt-6.1-sol"',
        '-c',
        'model_provider="fixture"',
        '-c',
        'model_providers.fixture.name="Fixture"',
        '-c',
        `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        '-c',
        'model_providers.fixture.env_key="SWIFT_FIXTURE_KEY"',
        '-c',
        'model_providers.fixture.wire_api="responses"',
        '-c',
        `projects."${home}".trust_level="trusted"`,
      ],
      { cwd: home, env, cols: 120, rows: 45 },
    );
    let exited = false;
    child.onExit(() => {
      exited = true;
    });
    child.onData((data) => terminal.write(data));
    const readScreen = async () => {
      await new Promise((resolve) => terminal.write('', resolve));
      const buffer = terminal.buffer.active;
      return Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) || '',
      ).join('\n');
    };
    const lines = async () => {
      const directory = path.join(env.CODEX_HOME, 'sessions');
      if (!fs.existsSync(directory)) return [];
      const file = fs
        .readdirSync(directory, { recursive: true })
        .find((name) => name.endsWith('.jsonl'));
      return file ? fs.readFileSync(path.join(directory, file), 'utf8').split('\n') : [];
    };
    await wait(async () => (await readScreen()).includes('OpenAI Codex'));
    child.write('\x1b[200~Exercise native asynchronous questions\x1b[201~');
    await delay(100);
    child.write('\r');
    await wait(async () => (await readScreen()).includes('to answer'));
    const pane = {
      paneId: 'fixture:p1',
      terminalId: 'fixture-terminal',
      runtimeId: `fixture:${child.pid}`,
      agent: { label: 'codex', name: 'fixture', session: { value: 'fixture-session' } },
    };
    const keys = {
      'shift+left': '\x1b[1;2D',
      'shift+right': '\x1b[1;2C',
      'alt+up': '\x1b[1;3A',
      'alt+down': '\x1b[1;3B',
      up: '\x1b[A',
      down: '\x1b[B',
      enter: '\r',
      'ctrl+]': '\x1d',
    };
    const options = {
      herdr: { readPane: readScreen },
      exactPane: async () => {
        assert(!exited);
        return pane;
      },
      readLines: lines,
      readQuestionState: async () => codex.questionState(await lines()),
      restoreMain: true,
      receiptFile: path.join(home, 'receipts.json'),
      keys: async (_id, list) => {
        writes.push({ keys: list });
        for (const key of list) {
          assert(keys[key], key);
          child.write(keys[key]);
        }
      },
      paste: async (_id, text) => {
        writes.push({ paste: text });
        child.write('\x1b[200~' + text + '\x1b[201~');
      },
    };
    const side = new CodexSide(options);
    const manager = new AgentQuestions({
      ...options,
      beforeAnswer: (pane, prompt) =>
        manager.verifyQuestionThread(pane, prompt, () => side.assertMain(pane)),
    });
    let prompt = await wait(async () => {
      const q = await manager.read(pane);
      return q?.remaining === 4 ? q : null;
    });
    let remaining = 4;
    const action = async (name, extra = {}) => {
      const body = {
        ...prompt,
        action: name,
        requestId: 'native-' + writes.length + '-' + name,
        ...extra,
      };
      const result = await manager.answer(body);
      assert.notEqual(result.delivery, 'uncertain', JSON.stringify(result));
      if (name === 'answer' || name === 'skip') remaining--;
      if (remaining)
        prompt = await wait(async () => {
          const q = await manager.read(pane);
          return q && q.remaining === remaining && (name === 'answer' ? q.collapsed : q.expanded)
            ? q
            : null;
        });
      else {
        await wait(async () => !(await manager.read(pane)) && (await readScreen()).includes('›'));
        prompt = null;
      }
      return { body, result };
    };
    await action('open');
    assert.equal(prompt.toolId, 'first');
    fs.writeFileSync(path.join(output, 'first-question.txt'), await readScreen());
    const first = await action('answer', { choices: [1] });
    assert(prompt.collapsed);
    await action('open');
    assert.equal(prompt.index, 1);
    await action('answer', { choices: [], text: 'SwiftFixture' });
    assert(prompt.collapsed);
    await action('open');
    assert.equal(prompt.toolId, 'second');
    assert.equal(prompt.index, 0);
    await action('answer', { choices: [], text: 'Alternative implementation' });
    assert(prompt.collapsed);
    await action('open');
    assert.equal(prompt.toolId, 'second');
    assert.equal(prompt.index, 1);
    const skipped = await action('skip');
    assert.equal(skipped.result.delivery, 'skipped');
    assert.equal(prompt, null);
    const count = writes.length,
      restarted = new AgentQuestions(options);
    await restarted.answer(first.body);
    await restarted.answer(skipped.body);
    assert.equal(writes.length, count);
    assert.equal(writes.filter((write) => write.keys?.includes('enter')).length, 3);
    const state = codex.questionState(await lines());
    for (const [toolId, index] of [
      ['first', 0],
      ['first', 1],
      ['second', 0],
    ])
      assert(codex.hasReceipt(state, { toolId, index }));
    assert(!codex.hasReceipt(state, { toolId: 'second', index: 1 }));
    fs.writeFileSync(path.join(output, 'after-skip.txt'), await readScreen());
    fs.writeFileSync(path.join(output, 'native-archive.jsonl'), (await lines()).join('\n'));
    const after = sourceFingerprint(process.cwd());
    assert.equal(before.treeSha256, after.treeSha256);
    const proof = {
      ok: true,
      version,
      before,
      after,
      multipleCalls: 2,
      options: true,
      textOnly: true,
      other: true,
      skip: true,
      restoreMain: true,
      mainThreadVerified: true,
      archiveReceipts: 3,
      nativeEnterCount: 3,
      restartWithoutReplay: true,
      productionInput: false,
      externalInference: false,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } catch (error) {
    await new Promise((resolve) => terminal.write('', resolve));
    const buffer = terminal.buffer.active;
    fs.writeFileSync(
      path.join(output, 'failure-screen.txt'),
      Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) || '',
      ).join('\n'),
    );
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify({ ok: false, version, before, error: error.stack, writes }, null, 2),
    );
    throw error;
  } finally {
    try {
      child?.kill();
    } catch {}
    terminal.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'),
  pty = require('node-pty');
const { TerminalScreen } = require('../../lib/terminal-screen');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-pending-')),
    out = path.resolve('artifacts/testing/codex-pending-messages/native');
  fs.mkdirSync(out, { recursive: true });
  const binary = process.env.SWIFT_CODEX_FIXTURE_BIN || 'codex';
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CODEX_SQLITE_HOME: path.join(home, '.codex'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    SWIFT_FIXTURE_KEY: 'local-fixture',
  };
  fs.mkdirSync(env.CODEX_HOME);
  const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
  let child,
    frame,
    held,
    requests = 0;
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
    const prompt =
      body.input
        ?.at(-1)
        ?.content?.map((p) => p.text || '')
        .join('') || '';
    const title = prompt.startsWith('Generate a concise, single-line task title');
    if (!title) requests++;

    if (!title && requests > 1) {
      held = res;
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let seq = 0;
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...value })}\n\n`,
      );
    const id = 'fixture-' + requests + (title ? '-title' : '');
    event('response.created', { response: { id, status: 'in_progress', output: [] } });
    const item = {
      id: 'answer-' + id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture ready.', annotations: [] }],
    };
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    });
    event('response.content_part.added', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    event('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'Fixture ready.',
    });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', {
      response: {
        id,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    });
    res.end();
  });
  const screen = new TerminalScreen({ cols: 160, rows: 45, onScreen: (v) => (frame = v) });
  const wait = async (fn, label) => {
    for (let i = 0; i < 200; i++) {
      await screen.pending;
      const v = await fn();
      if (v) return v;
      await delay(50);
    }
    fs.writeFileSync(path.join(out, 'native-failure.json'), JSON.stringify(frame || {}, null, 2));
    throw Error(label);
  };
  const text = () => frame?.rows.map((row) => row.map((s) => s.text).join('')).join('\n') || '';
  const send = async (message) => {
    child.write('\x1b[200~' + message + '\x1b[201~');
    await delay(150);
    child.write('\r');
  };
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    child = pty.spawn(
      binary,
      [
        '--no-daemon',
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
      { cwd: home, env, cols: 160, rows: 45 },
    );
    await screen.feed('', { full: true });
    child.onData((data) => screen.feed(data));
    await wait(() => text().includes('OpenAI Codex'), 'startup');
    await send('Start isolated pending input test');
    await wait(() => text().includes('Fixture ready.'), 'local response');
    await delay(500);
    await send('/compact');
    await wait(() => text().includes('Compacting context'), 'compacting');
    await send('PENDING_INPUT_FIXTURE 精度按任务书对齐');
    await wait(
      () =>
        frame?.projection.pendingInputs?.some((s) =>
          s.messages.some((t) => t.includes('PENDING_INPUT_FIXTURE')),
        ),
      'pending preview',
    );
    const wide = frame;
    fs.writeFileSync(path.join(out, 'native-wide.json'), JSON.stringify(wide, null, 2));
    screen.cols = 45;
    screen.terminal.resize(45, 45);
    child.resize(45, 45);
    await wait(
      () =>
        frame?.cols === 45 &&
        frame?.projection.pendingInputs?.some((s) =>
          s.messages.some((t) => t.includes('PENDING_INPUT_FIXTURE')),
        ),
      'narrow pending preview',
    );
    fs.writeFileSync(path.join(out, 'native-narrow.json'), JSON.stringify(frame || {}, null, 2));
    assert(held, 'Compaction is held by the local model fixture');
    fs.writeFileSync(
      path.join(out, 'native-report.json'),
      JSON.stringify(
        {
          ok: true,
          version,
          requests,
          pending: wide.projection.pendingInputs,
          narrow: frame.projection.pendingInputs,
          productionInput: false,
          externalInference: false,
        },
        null,
        2,
      ),
    );
    console.log('PASS real Codex pending preview at 160 and 45 columns');
  } finally {
    child?.kill();
    screen.close();
    held?.end();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

'use strict';
// Real Codex and Herdr, temporary HOME and local synthetic model only.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client');
const { herdrRequest, sendPaneMessage, pastePaneText } = require('../../lib/herdr-input');
const { CodexActiveSession } = require('../../lib/codex-active-session');
const { SessionIdentityRepair } = require('../../lib/session-identity-repair');
const { CodexSessionHook } = require('../../lib/codex-session-hook');
const { currentArchive } = require('../../lib/codex-archive');
const { ConversationStore } = require('../../lib/conversation-store');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read, label) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Native identity fixture timed out: ' + label);
}
(async () => {
  const hookCase = process.argv.includes('--session-hook');
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve(
      hookCase
        ? 'artifacts/testing/tab-session-mismatch/native-identity'
        : 'artifacts/testing/transcript-terminal-consistency/native-identity',
    );
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-native-identity-')),
    session = 'identity-fixture';
  const binary =
    process.env.SWIFT_CODEX_FIXTURE_BIN || require('../../lib/codex-runtime').managedCodexBinary();
  assert(binary, 'A verified native Codex binary is required for the isolated fixture');
  await fs.mkdir(path.join(home, 'bin'));
  await fs.symlink(binary, path.join(home, 'bin/codex'));
  const config = path.join(home, 'herdr.toml');
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env = {
    PATH: path.join(home, 'bin') + ':' + process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    HERDR_CONFIG_PATH: config,
    HERDR_SESSION: session,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    SWIFT_FIXTURE_KEY: 'fixture-only',
  };
  let requests = 0,
    client,
    drain,
    herdr,
    paneId;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      JSON.parse(raw);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const index = ++requests,
      id = 'fixture-response-' + index,
      label = raw.includes('SECOND NATIVE THREAD') ? 'SECOND' : 'FIRST';
    const text = `${label} NATIVE THREAD ANSWER. This is the independent current conversation with its own archive identity and verified contents.\n\nThe ${label} native conversation contains a second distinct paragraph to identify the current terminal without relying on launch arguments or modification time.`;
    const item = {
      id: 'msg-' + index,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    let sequence = 0;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
      );
    event('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
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
      delta: text,
    });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', {
      response: {
        id,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      },
    });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cli = (args) =>
    execFileSync('herdr', ['--session', session, ...args], {
      env,
      cwd: home,
      encoding: 'utf8',
      timeout: 45000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const json = (args) => JSON.parse(cli(args)).result;
  try {
    client = require('node-pty').spawn('herdr', ['--session', session], {
      env,
      cwd: home,
      cols: 110,
      rows: 40,
    });
    drain = client.onData(() => {});
    await wait(async () => {
      try {
        return json(['api', 'snapshot']).snapshot?.panes?.length;
      } catch {
        return false;
      }
    }, 'Herdr startup');
    paneId = json([
      'workspace',
      'create',
      '--label',
      'Identity fixture',
      '--cwd',
      home,
      '--no-focus',
    ]).root_pane.pane_id;
    const socketPath = path.join(home, '.config/herdr/sessions', session, 'herdr.sock');
    herdr = new HerdrClient({ session, socketPath });
    herdr.env = (extra) => ({ ...env, ...extra });
    const request = async (method, params) => {
      const result = await herdrRequest(method, params, { socketFile: socketPath });
      if (method === 'pane.report_agent_session')
        await fs.appendFile(
          path.join(output, 'reports.jsonl'),
          JSON.stringify({ params, result }) + '\n',
        );
      return result;
    };
    const args = [
      '--no-daemon',
      '--no-alt-screen',
      '--sandbox',
      'workspace-write',
      '-a',
      'never',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'model_provider="fixture"',
      '-c',
      'model="gpt-6.1-sol"',
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
    ];
    json([
      'agent',
      'start',
      'identity_fixture',
      '--kind',
      'codex',
      '--pane',
      paneId,
      '--',
      ...args,
    ]);
    const readPane = async () =>
      (await herdr.dashboard()).panes.find((pane) => pane.paneId === paneId);
    const activeSession = new CodexActiveSession({
      home: env.CODEX_HOME,
      readScreen: (pane) =>
        herdr.readPane(pane.paneId, { source: 'recent_unwrapped', lines: 160, ansi: true }),
    });
    const active = async () =>
      activeSession.read(await readPane(), await herdr.readProcessInfo(paneId));
    await sendPaneMessage(paneId, 'FIRST NATIVE THREAD', { socketFile: socketPath });
    await wait(
      async () =>
        (await herdr.readPane(paneId, { lines: 50 })).includes('FIRST NATIVE THREAD ANSWER'),
      'first reply',
    );
    const first = await wait(active, 'first archive');
    await pastePaneText(paneId, '/new', { socketFile: socketPath });
    await pause(150);
    await request('agent.send_keys', { target: paneId, keys: ['enter'] });
    await pause(600);
    await sendPaneMessage(paneId, 'SECOND NATIVE THREAD', { socketFile: socketPath });
    await wait(
      async () =>
        (await herdr.readPane(paneId, { lines: 50 })).includes('SECOND NATIVE THREAD ANSWER'),
      'new thread reply',
    );
    const second = await wait(async () => {
      const value = await active();
      return value?.sessionId !== first.sessionId && value;
    }, 'changed current archive');
    assert.equal(second.runtime, first.runtime, 'Native thread change must keep the same process');
    // Reproduce a background hook inheriting another client's pane. It runs
    // outside the foreground TUI, exactly the missing ownership check in the
    // shared-daemon failure, using only this fixture's real Herdr and archives.
    const inherited = {
      ...env,
      HERDR_ENV: '1',
      HERDR_PANE_ID: paneId,
      HERDR_SOCKET_PATH: socketPath,
    };
    const hook = path.join(env.CODEX_HOME, 'herdr-agent-state.sh');
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: first.sessionId,
      source: 'resume',
      transcript_path: first.file,
    });
    if (hookCase) {
      cli(['integration', 'install', 'codex']);
      execFileSync('sh', [hook, 'session'], { env: inherited, input: payload, timeout: 5000 });
    } else
      await request('pane.report_agent_session', {
        pane_id: paneId,
        source: 'herdr:codex',
        agent: 'codex',
        seq: Date.now() * 1e6,
        agent_session_id: first.sessionId,
      });
    const stale = await readPane();
    assert.equal(stale.agent.session.value, first.sessionId);
    const repair = new SessionIdentityRepair({
      herdr,
      activeSession,
      locate: (_, id, cwd) => currentArchive(env.CODEX_HOME, id, cwd).file,
      request,
    });
    assert.deepEqual(await repair.check([stale]), [true]);
    const repaired = await wait(async () => {
      const pane = await readPane();
      return pane.agent.session.value === second.sessionId && pane;
    }, 'Herdr applied current identity');
    assert.equal(repaired.terminalId, stale.terminalId);
    const store = new ConversationStore(),
      transcript = await store.read(second.file, 'codex');
    const text = JSON.stringify(transcript.conversation);
    assert(text.includes('SECOND NATIVE THREAD ANSWER'));
    assert(!text.includes('FIRST NATIVE THREAD'));
    if (hookCase) {
      await new CodexSessionHook().ensure(env.CODEX_HOME);
      execFileSync('sh', [hook, 'session'], { env: inherited, input: payload, timeout: 5000 });
      assert.equal(
        (await readPane()).agent.session.value,
        second.sessionId,
        'The same inherited hook must no longer overwrite the foreground conversation',
      );
      assert.equal((await readPane()).terminalId, stale.terminalId);
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
          first,
          second,
          sameProcess: true,
          herdrIdentityRepaired: true,
          currentTranscriptMatchesTerminal: true,
          inheritedHookReproducedAndBlocked: hookCase,
          productionInput: false,
          externalInference: false,
          requests,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS real Codex /new in the same process, stale Herdr identity repair and current transcript.',
    );
  } finally {
    if (herdr && paneId)
      try {
        await fs.writeFile(
          path.join(output, 'last-screen.txt'),
          await herdr.readPane(paneId, { lines: 100 }),
        );
      } catch {}
    if (herdr && paneId)
      try {
        const info = await herdr.readProcessInfo(paneId),
          evidence = [];
        for (const process of info.foreground_processes || [])
          if (process.name === 'codex') {
            for (const descriptor of await fs.readdir(`/proc/${process.pid}/fd`))
              try {
                const file = await fs.readlink(`/proc/${process.pid}/fd/${descriptor}`);
                if (!file.startsWith(home + '/') || !file.endsWith('.jsonl')) continue;
                const meta = JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]).payload;
                const fields = Object.fromEntries(
                  ['id', 'cwd', 'originator', 'source', 'thread_source', 'ephemeral'].map((key) => [
                    key,
                    meta[key],
                  ]),
                );
                evidence.push({
                  descriptor,
                  file,
                  fields,
                  flags: (
                    await fs.readFile(`/proc/${process.pid}/fdinfo/${descriptor}`, 'utf8')
                  ).match(/^flags:.*$/m)?.[0],
                  native: currentArchive(env.CODEX_HOME, meta.id, meta.cwd),
                });
              } catch {}
          }
        await fs.writeFile(
          path.join(output, 'descriptors.json'),
          JSON.stringify(evidence, null, 2),
        );
      } catch {}
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try {
      cli(['server', 'stop']);
    } catch {}
    drain?.dispose();
    try {
      client?.kill();
    } catch {}
    await pause(200);
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

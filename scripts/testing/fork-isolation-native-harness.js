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
  const sharedDaemon = process.argv.includes('--shared-daemon'),
    sideFork = process.argv.includes('--side');
  const before = sourceFingerprint(process.cwd()),
    output = path.resolve(
      (sideFork
        ? 'artifacts/testing/side-session-unification/fork-'
        : 'artifacts/testing/fork-isolation/native-') + (sharedDaemon ? 'daemon' : 'standalone'),
    );
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-')),
    session = 'swift';
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
  const requestBodies = [];
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
    const titleRequest = raw.includes('Generate a concise, single-line task title');
    if (!titleRequest) requestBodies.push(raw);
    await fs.writeFile(
      path.join(output, 'model-requests.json'),
      JSON.stringify(requestBodies, null, 2),
    );
    const index = titleRequest ? requests : ++requests,
      id = 'fixture-response-' + index;
    const payload = JSON.parse(raw),
      prompt =
        (payload.input || [])
          .findLast((item) => item.role === 'user')
          ?.content?.map((item) => item.text || '')
          .join('') || '';
    const label = prompt.includes('CHILD_ONLY_REQUEST')
      ? 'CHILD_ONLY'
      : prompt.includes('PARENT_ONLY_REQUEST')
        ? 'PARENT_ONLY'
        : prompt.includes('SIDE_CONTEXT_REQUEST')
          ? 'SIDE_CONTEXT'
          : 'SHARED_PREFIX';
    const text = titleRequest
      ? 'Fork isolation fixture'
      : `${label} NATIVE THREAD ANSWER. This is the independent current conversation with its own archive identity and verified contents.\n\nThe ${label} native conversation contains a second distinct paragraph to identify the current terminal without relying on launch arguments or modification time.`;
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
      ...(sharedDaemon ? [] : ['--no-daemon']),
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
    const readPane = async (id = paneId) =>
      (await herdr.dashboard()).panes.find((pane) => pane.paneId === id);
    const exactPane = async (id) => {
      const pane = await readPane(id);
      const processes = (await herdr.readProcessInfo(id)).foreground_processes.filter(
        (p) => p.name === 'codex',
      );
      if (processes.length === 1)
        pane.runtimeId = await require('../../lib/codex-restart').processStart(processes[0].pid);
      return pane;
    };
    await wait(
      async () =>
        require('../../lib/agent-composer').readStatusArea(
          await herdr.readPane(paneId, { lines: 40, ansi: true, exact: true }),
        ).composerHint,
      'native composer ready',
    );
    await sendPaneMessage(paneId, 'SHARED_PREFIX_REQUEST', { socketFile: socketPath });
    await wait(
      async () =>
        (await herdr.readPane(paneId, { lines: 100 })).includes(
          'SHARED_PREFIX NATIVE THREAD ANSWER',
        ),
      'seed reply',
    );
    const locate = (_, id, cwd) => currentArchive(env.CODEX_HOME, id, cwd).file;
    const discovery = new (require('../../lib/codex-session-discovery').CodexSessionDiscovery)({
      home: env.CODEX_HOME,
    });
    const activeSession = new CodexActiveSession({
      home: env.CODEX_HOME,
      readScreen: (pane) =>
        herdr.readPane(pane.paneId, { source: 'recent_unwrapped', lines: 160, ansi: true }),
    });
    const hook = new CodexSessionHook();
    const repair = new SessionIdentityRepair({
      herdr,
      activeSession,
      discovery,
      locate,
      request,
      retryMs: 0,
      prepare: () => hook.ensure(env.CODEX_HOME),
    });
    await wait(async () => {
      await repair.check([await readPane()]);
      return (await readPane()).agent?.session?.value;
    }, 'seed identity');
    // Native rename supplies the same candidate title to parent and fork.
    await pastePaneText(paneId, '/rename Fork isolation fixture', { socketFile: socketPath });
    await pause(150);
    await request('agent.send_keys', { target: paneId, keys: ['enter'] });
    await pause(500);
    const parent = await exactPane(paneId),
      parentId = parent.agent.session.value;
    let sideController, sideId;
    const sideAction = async (action, extra = {}) =>
      sideController.handle({
        ...(await sideController.read(parent)),
        action,
        requestId: require('node:crypto').randomUUID(),
        ...extra,
      });
    if (sideFork) {
      sideController = new (require('../../lib/codex-side').CodexSide)({ herdr, exactPane });
      await sideAction('open');
      const value = await sideController.read(parent);
      assert(value.structured && value.sideId);
      sideId = value.sideId;
      await sideAction('send', { sideId, text: 'SIDE_CONTEXT_REQUEST' });
      await wait(
        async () =>
          (await herdr.readPane(paneId, { lines: 100 })).includes(
            'SIDE_CONTEXT NATIVE THREAD ANSWER',
          ),
        'side reply',
      );
    }
    const beforeForkRequests = requests;
    const child = await new (require('../../lib/codex-fork').CodexFork)({
      herdr,
      exactPane,
      resolveBinary: async () => ({
        binary: await fs.realpath(binary),
        version: execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(),
      }),
    }).run(parent, { sideId });
    assert.notEqual(child.sessionId, parentId);
    assert.notEqual(child.terminalId, parent.terminalId);
    assert.equal(requests, beforeForkRequests, 'Fork itself must not call the model');
    await pause(500);
    const beforeRepair = await readPane(child.paneId);
    const screen = await herdr.readPane(child.paneId, {
      source: 'recent_unwrapped',
      lines: 160,
      ansi: true,
    });
    const candidates = await discovery.candidates(beforeRepair);
    await fs.writeFile(
      path.join(output, 'candidates.json'),
      JSON.stringify({ parent, child: beforeRepair, candidates }, null, 2),
    );
    await fs.writeFile(path.join(output, 'inherited-screen.txt'), screen);
    if (sideFork)
      assert(
        !require('../../public/ansi')
          .stripAnsi(screen)
          .includes('This conversation is open in another app'),
        'A new side fork must release its original native writer before the new Tab becomes ready',
      );
    assert(
      candidates.some((c) => c.sessionId === parentId) &&
        candidates.some((c) => c.sessionId === child.sessionId),
      'Native parent and child must both be identity candidates',
    );
    if (!sideFork)
      assert.equal(
        await discovery.discover(beforeRepair, screen),
        null,
        'Shared prefix cannot prove a unique identity',
      );
    for (let i = 0; i < 3; i++)
      await repair.check([await readPane(), await readPane(child.paneId)]);
    assert.equal((await readPane()).agent.session.value, parentId);
    assert.equal((await readPane(child.paneId)).agent.session.value, child.sessionId);
    const parentFile = locate('codex', parentId, home),
      parentBefore = await fs.readFile(parentFile);
    await sendPaneMessage(child.paneId, 'CHILD_ONLY_REQUEST', { socketFile: socketPath });
    await wait(
      async () =>
        (await herdr.readPane(child.paneId, { lines: 100 })).includes(
          'CHILD_ONLY NATIVE THREAD ANSWER',
        ),
      'child reply',
    );
    const childFile = locate('codex', child.sessionId, home);
    await wait(
      async () =>
        (await fs.readFile(childFile, 'utf8')).includes('CHILD_ONLY NATIVE THREAD ANSWER'),
      'child archive flush',
    );
    assert.deepEqual(
      await fs.readFile(parentFile),
      parentBefore,
      'Sending to the child must not write the parent archive',
    );
    const childBefore = await fs.readFile(childFile);
    if (sideFork) {
      assert.equal((await sideController.read(parent)).sideId, sideId);
      await sideAction('main');
    }
    await sendPaneMessage(paneId, 'PARENT_ONLY_REQUEST', { socketFile: socketPath });
    await wait(
      async () =>
        (await herdr.readPane(paneId, { lines: 100 })).includes('PARENT_ONLY NATIVE THREAD ANSWER'),
      'parent reply',
    );
    await wait(
      async () =>
        (await fs.readFile(parentFile, 'utf8')).includes('PARENT_ONLY NATIVE THREAD ANSWER'),
      'parent archive flush',
    );
    assert.deepEqual(
      await fs.readFile(childFile),
      childBefore,
      'Sending to the parent must not write the child archive',
    );
    const store = new ConversationStore();
    const parentText = JSON.stringify((await store.read(parentFile, 'codex')).conversation);
    const childText = JSON.stringify((await store.read(childFile, 'codex')).conversation);
    assert(
      parentText.includes('PARENT_ONLY_REQUEST') && !parentText.includes('CHILD_ONLY_REQUEST'),
    );
    assert(childText.includes('CHILD_ONLY_REQUEST') && !childText.includes('PARENT_ONLY_REQUEST'));
    assert(parentText.includes('SHARED_PREFIX') && childText.includes('SHARED_PREFIX'));
    assert(
      requestBodies[sideFork ? 2 : 1].includes('SHARED_PREFIX') &&
        !requestBodies[sideFork ? 3 : 2].includes('CHILD_ONLY_REQUEST'),
    );
    if (sideFork) {
      assert(childText.includes('SIDE_CONTEXT_REQUEST'));
      assert(!parentText.includes('SIDE_CONTEXT_REQUEST'));
      assert(requestBodies[2].includes('SIDE_CONTEXT_REQUEST'));
      assert(!requestBodies[2].includes('Side conversation boundary.'));
      assert(!requestBodies[2].includes('This thread is ephemeral'));
      assert(!childText.includes('Side conversation boundary.'));
    }
    for (let i = 0; i < 3; i++)
      await repair.check([await readPane(), await readPane(child.paneId)]);
    assert.equal((await readPane()).agent.session.value, parentId);
    assert.equal((await readPane(child.paneId)).agent.session.value, child.sessionId);
    assert.equal((await exactPane(paneId)).runtimeId, parent.runtimeId);
    const after = sourceFingerprint(process.cwd());
    assert.deepEqual(after, before);
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          sharedDaemon,
          sideFork,
          independentSessionIds: true,
          independentTerminals: true,
          identityStableAfterRepair: true,
          childSendPreservesParentArchiveBytes: true,
          parentSendPreservesChildArchiveBytes: true,
          inheritedContextPreserved: true,
          transcriptsIsolated: true,
          parentProcessPreserved: true,
          productionInput: false,
          externalInference: false,
          requests,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS native Fork, identity repair and bidirectional message isolation; shared daemon: ' +
        sharedDaemon,
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
    if (sharedDaemon)
      try {
        execFileSync(binary, ['app-server', 'daemon', 'stop'], {
          env,
          cwd: home,
          timeout: 15000,
          stdio: 'ignore',
        });
      } catch {}
    await pause(200);
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

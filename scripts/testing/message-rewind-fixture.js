'use strict';
const fs = require('node:fs/promises'),
  fss = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..');
const { HerdrClient } = require('../../lib/herdr-client');
const { processStart } = require('../../lib/codex-restart');
const { CodexLineage } = require('../../lib/codex-lineage');
const { parseTranscript } = require('../../lib/agent-transcript');
const { rewindHistory } = require('../../lib/codex-rewind-history');
const input = require('../../lib/herdr-input');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate, label, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(80);
  } while (performance.now() < deadline);
  throw Error('Timed out: ' + label);
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(
  output,
  work,
  {
    cols = 140,
    rows = 55,
    noAltScreen = true,
    noDaemon = false,
    codexConfig = [],
    accountEmail = '',
    responseHeaders = {},
    codexExecutable = '',
  } = {},
) {
  await fs.mkdir(output, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-rewind-herdr-'));
  const codeHome = path.join(home, '.codex'),
    session = `swift-rewind-${process.pid}`;
  await fs.mkdir(codeHome);
  await fs.mkdir(path.join(home, 'runtime'), { mode: 0o700 });
  const config = path.join(home, 'herdr.toml');
  await fs.writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codeHome,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    HERDR_CONFIG_PATH: config,
    HERDR_SESSION: session,
    SWIFT_FIXTURE_KEY: 'local-fixture-only',
    DISABLE_AUTOUPDATER: '1',
    ENV: '',
    BASH_ENV: '',
    SWIFT_CODEX_ROOT:
      process.env.SWIFT_CODEX_ROOT || path.join(os.homedir(), '.local/share/swift/codex'),
  };
  await fs.writeFile(path.join(output, 'isolated-home.txt'), home + '\n');
  const requests = [],
    writes = [],
    held = new Map(),
    receipts = [];
  const server = http.createServer(async (req, res) => {
    if (accountEmail && !req.url.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url.endsWith('/accounts/check')
            ? {
                accounts: [
                  {
                    id: 'fixture-account',
                    workspace_backend_origin: 'https://chatgpt.com',
                    account_routing_override: 'NO_CONSTRAINT',
                  },
                ],
              }
            : req.url.endsWith('/config/bundle')
              ? { requirements_toml: {} }
              : { object: 'list', data: [], models: [] },
        ),
      );
      return;
    }
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
        ?.content?.map((part) => part.text || '')
        .join('') || '';
    const title = prompt.startsWith('Generate a concise, single-line task title');
    if (!title) requests.push(body);
    const count = requests.length,
      id = 'fixture-' + count + (title ? '-title' : '');
    res.writeHead(200, { 'content-type': 'text/event-stream', ...responseHeaders });
    let seq = 0;
    const event = (type, value) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...value })}\n\n`,
      );
    event('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
    const finish = () => {
      const text = (title ? 'TITLE ' : 'ANSWER ') + count;
      const item = {
        id: 'answer-' + count + (title ? '-title' : ''),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
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
        delta: text,
      });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
    };
    if (!title && prompt.startsWith('HOLD')) held.set(prompt, finish);
    else finish();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const writeFixtureAccount = async (email) => {
    const claims = {
      email,
      exp: Math.floor(Date.now() / 1000) + 86400,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'fixture-user',
        chatgpt_account_id: 'fixture-account',
      },
    };
    const jwt = 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
    await fs.writeFile(
      path.join(codeHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: 'synthetic-fixture',
          account_id: 'fixture-account',
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  };
  if (accountEmail) {
    await writeFixtureAccount(accountEmail);
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = `http://127.0.0.1:${server.address().port}`;
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  const cli = (args) =>
    execFileSync('herdr', ['--session', session, ...args], {
      env,
      cwd: home,
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const json = (args) => {
    const result = JSON.parse(cli(args));
    if (result.error) throw Error(JSON.stringify(result.error));
    return result.result || result;
  };
  const client = require('node-pty').spawn('herdr', ['--session', session], {
    env,
    cwd: home,
    cols,
    rows,
  });
  const drain = client.onData(() => {});
  let herdr, paneId;
  try {
    await wait(async () => {
      try {
        return json(['api', 'snapshot']).snapshot?.panes?.length;
      } catch {
        return false;
      }
    }, 'Herdr startup');
    const created = json([
      'workspace',
      'create',
      '--cwd',
      home,
      '--label',
      'rewind fixture',
      '--no-focus',
    ]);
    paneId = created.root_pane.pane_id;
    async function findSocket(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name);
        if (entry.isSocket() && entry.name === 'herdr.sock') return name;
        if (entry.isDirectory()) {
          const found = await findSocket(name);
          if (found) return found;
        }
      }
      return null;
    }
    const socketPath = await findSocket(home);
    assert(socketPath);
    herdr = new HerdrClient({ session, socketPath });
    herdr.env = (extra) => ({ ...env, ...extra });
    herdr.resolveTarget = async (target) => ({ paneId: target });
    await wait(async () => {
      const info = await herdr.readProcessInfo(paneId);
      return (
        info.shell_pid &&
        info.foreground_processes?.length &&
        info.foreground_processes.every((item) => item.pid === info.shell_pid)
      );
    }, 'isolated Shell');
    const args = [
      ...(accountEmail || noDaemon ? ['--no-daemon'] : []),
      ...(noAltScreen ? ['--no-alt-screen'] : []),
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
      ...(accountEmail
        ? [
            '-c',
            'model_providers.fixture.requires_openai_auth=true',
            '-c',
            `chatgpt_base_url="http://127.0.0.1:${server.address().port}"`,
            '-c',
            'check_for_update_on_startup=false',
            '-c',
            'cli_auth_credentials_store="file"',
          ]
        : ['-c', 'model_providers.fixture.env_key="SWIFT_FIXTURE_KEY"']),
      '-c',
      'model_providers.fixture.wire_api="responses"',
      '-c',
      `projects."${home}".trust_level="trusted"`,
      ...codexConfig.flatMap((value) => ['-c', value]),
    ];
    cli([
      'pane',
      'run',
      paneId,
      [
        codexExecutable ||
          (accountEmail ? path.join(env.SWIFT_CODEX_ROOT, 'current/bin/codex') : 'codex'),
        ...args,
      ]
        .map(quote)
        .join(' '),
    ]);
    const text = () => herdr.readPane(paneId, { source: 'recent', lines: 160, exact: true });
    await wait(async () => /Ask Codex to do anything/.test(await text()), 'native composer');
    const exactPane = async () => {
      const pane = (await herdr.dashboard()).panes.find((item) => item.paneId === paneId);
      const process = (await herdr.readProcessInfo(paneId)).foreground_processes?.find(
        (item) => item.name === 'codex',
      );
      assert(process);
      pane.runtimeId = await processStart(process.pid);
      return pane;
    };
    const sendMessage = async (pane, body) => {
      writes.push({ method: 'agent.prompt', text: body });
      const receipt = await input.sendPaneMessage(pane.paneId, body, { socketFile: socketPath });
      receipts.push(receipt);
      return receipt;
    };
    const send = async (body) => {
      const expected = requests.length + 1;
      const pane = await exactPane();
      await sendMessage(pane, body);
      await wait(
        async () => requests.length >= expected && (await text()).includes('ANSWER ' + expected),
        'answer ' + expected,
      );
      await delay(250);
    };
    let sessionId;
    const bindSession = async () => {
      const files = (await fs.readdir(path.join(codeHome, 'sessions'), { recursive: true })).filter(
        (file) => file.endsWith('.jsonl'),
      );
      const metadata = JSON.parse(
        (await fs.readFile(path.join(codeHome, 'sessions', files[0]), 'utf8')).split('\n')[0],
      );
      sessionId = metadata.payload.id;
      await input.herdrRequest(
        'pane.report_agent_session',
        {
          pane_id: paneId,
          source: 'herdr:codex',
          agent: 'codex',
          seq: Date.now() * 1e6,
          agent_session_id: sessionId,
        },
        { socketFile: socketPath },
      );
    };
    const lineage = new CodexLineage({ home: codeHome });
    const readHistory = async () => {
      assert(sessionId);
      const deadline = performance.now() + 5000;
      do {
        const current = require('../../lib/codex-archive').currentArchive(
          codeHome,
          sessionId,
          home,
        );
        assert(current.file);
        try {
          const result = await lineage.read(current.file),
            lines =
              result?.lines ||
              (await fs.readFile(current.file, 'utf8')).split('\n').filter(Boolean);
          const messages = parseTranscript('codex', lines);
          return rewindHistory(lines, messages, { branch: current.file });
        } catch (error) {
          if (error.code !== 'ARCHIVE_CHANGED' || performance.now() >= deadline) throw error;
          await delay(40);
        }
      } while (performance.now() < deadline);
      throw Error('The isolated archive did not stabilize');
    };
    const capture = async (name) => {
      await fs.writeFile(
        path.join(output, name + '.ansi'),
        await herdr.readPane(paneId, { source: 'recent', lines: 160, ansi: true, exact: true }),
      );
      await fs.writeFile(path.join(output, name + '.txt'), await text());
      if (sessionId)
        await fs.writeFile(
          path.join(output, name + '-history.json'),
          JSON.stringify(await readHistory(), null, 2),
        );
    };
    const press = async (pane, keys) => {
      writes.push({ method: 'agent.send_keys', keys });
      return input.herdrRequest(
        'agent.send_keys',
        { target: pane.paneId, keys },
        { socketFile: socketPath },
      );
    };
    const paste = async (pane, body) => {
      writes.push({ method: 'pane.send_input', text: body });
      return input.pastePaneText(pane.paneId, body, { socketFile: socketPath });
    };
    return await work({
      home,
      codeHome,
      herdr,
      paneId,
      requests,
      writes,
      receipts,
      held,
      exactPane,
      send,
      sendMessage,
      bindSession,
      readHistory,
      capture,
      press,
      paste,
      text,
      wait,
      delay,
      output,
      writeFixtureAccount,
    });
  } catch (error) {
    if (herdr && paneId)
      await fs.writeFile(
        path.join(output, 'failure.ansi'),
        await herdr.readPane(paneId, { lines: 160, ansi: true, exact: true }).catch(() => ''),
      );
    await fs.writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify({ error: error.stack, writes, receipts }, null, 2),
    );
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try {
      cli(['server', 'stop']);
    } catch {}
    drain.dispose();
    try {
      client.kill();
    } catch {}
    await delay(250);
    for (const entry of await fs.readdir('/proc'))
      if (/^\d+$/.test(entry)) {
        try {
          const cwd = await fs.readlink('/proc/' + entry + '/cwd'),
            name = (await fs.readFile('/proc/' + entry + '/comm', 'utf8')).trim();
          if ((cwd === home || cwd.startsWith(home + '/')) && /^codex(?:-app-server)?$/.test(name))
            process.kill(Number(entry), 'SIGTERM');
        } catch {}
      }
    await fs.writeFile(path.join(output, 'writes.json'), JSON.stringify(writes, null, 2));
    await fs.writeFile(path.join(output, 'receipts.json'), JSON.stringify(receipts, null, 2));
    // The isolated HOME remains evidence; its processes and private Herdr stop.
  }
}

module.exports = { fixture, wait, delay };

'use strict';
// A real Claude CLI against a local deterministic model, with an isolated home.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const http = require('node:http'),
  { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { parseTranscript, textOnly } = require('../../lib/agent-transcript');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-claude-history-'));
const output = path.resolve(__dirname, '../../artifacts/consistency');
fs.mkdirSync(output, { recursive: true });
const cli = process.env.CLAUDE_NATIVE_BIN || path.join(os.homedir(), '.npm-global/bin/claude');
let child,
  terminal,
  tuiEvidence,
  count = 0;
const requests = [];
const model = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  if (!req.url.startsWith('/v1/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  const body = JSON.parse(raw);
  requests.push(body.messages);
  const n = ++count,
    text = `NATIVE_CLAUDE_REPLY_${n}`;
  const message = {
    id: `msg_probe_${n}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(message));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ])
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
});
const run = (args, env) =>
  new Promise((resolve, reject) => {
    args.splice(args.length - 1, 0, '--');
    child = spawn(cli, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(Error(`exit ${code}: ${err} ${out}`));
    });
  });
async function main() {
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
    ANTHROPIC_API_KEY: 'isolated-local-probe',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
  };
  for (const key of Object.keys(env))
    if (
      /^(HERDR_|CLAUDECODE|CLAUDE_CODE_SESSION|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)/.test(
        key,
      )
    )
      delete env[key];
  const args = [
    '-p',
    '--model',
    'claude-sonnet-4-6',
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{"disableAllHooks":true}',
    '--tools',
    '',
  ];
  const first = JSON.parse(await run([...args, 'NATIVE_CLAUDE_USER_1'], env));
  const id = first.session_id;
  assert(id);
  await run([...args, '--resume', id, 'NATIVE_CLAUDE_USER_2'], env);
  await run([...args, '--resume', id, 'NATIVE_CLAUDE_USER_3'], env);
  const file = path.join(home, '.claude/projects', home.replace(/\//g, '-'), `${id}.jsonl`);
  const before = fs.readFileSync(file, 'utf8').trim().split('\n');
  if (process.env.CLAUDE_TUI_PROBE === '1') {
    const config = {
      customApiKeyResponses: { approved: ['isolated-local-probe'], rejected: [] },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.258',
      theme: 'dark',
      numStartups: 5,
      projects: { [home]: { hasTrustDialogAccepted: true } },
    };
    for (const configPath of [
      path.join(home, '.claude.json'),
      path.join(home, '.claude', '.claude.json'),
    ])
      fs.writeFileSync(configPath, JSON.stringify(config));
    const hookFile = path.join(home, 'record-hook.cjs'),
      hookLog = path.join(output, 'claude-native-hooks.jsonl');
    fs.writeFileSync(hookLog, '');
    fs.writeFileSync(
      hookFile,
      `let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(hookLog)},JSON.stringify(JSON.parse(b))+'\\n'));`,
    );
    const hooks = Object.fromEntries(
      ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification'].map((e) => [
        e,
        [{ hooks: [{ type: 'command', command: 'node ' + hookFile }] }],
      ]),
    );
    const pty = require('node-pty'),
      { TerminalLines } = require('../../public/terminal-lines');
    const screen = new TerminalLines({ maxRows: 80, maxCols: 150 });
    let raw = '';
    terminal = pty.spawn(
      cli,
      [
        '--resume',
        id,
        '--model',
        'claude-sonnet-4-6',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        JSON.stringify({ hooks }),
      ],
      { cwd: home, env: { ...env, TERM: 'xterm-256color' }, cols: 120, rows: 40 },
    );
    terminal.onData((data) => {
      raw += data;
      screen.feed(data);
    });
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const dump = () =>
      [...screen.rows.keys()]
        .sort((a, b) => a - b)
        .map((r) => screen.text(r))
        .join('\n');
    await pause(1800);
    fs.writeFileSync(path.join(output, 'claude-tui-start.txt'), dump());
    terminal.write('\r');
    await pause(700);
    terminal.write('\r');
    await pause(1000);
    fs.writeFileSync(path.join(output, 'claude-tui-ready.txt'), dump());
    terminal.write('/rewind');
    await pause(300);
    terminal.write('\r');
    await pause(1200);
    fs.writeFileSync(path.join(output, 'claude-tui-rewind.txt'), dump());
    terminal.write('\x1b[A');
    await pause(150);
    terminal.write('\r');
    await pause(700);
    fs.writeFileSync(path.join(output, 'claude-tui-action.txt'), dump());
    terminal.write('\r');
    await pause(1000);
    fs.writeFileSync(path.join(output, 'claude-tui-after.txt'), dump());
    fs.writeFileSync(
      path.join(output, 'claude-before-send-files.json'),
      JSON.stringify(fs.readdirSync(path.dirname(file))),
    );
    const settling = [];
    for (let i = 0; i < 10; i++) {
      await pause(1000);
      const raw = fs.readFileSync(file, 'utf8');
      settling.push({
        seconds: i + 1,
        size: raw.length,
        ids: textOnly(parseTranscript('claude', raw.split('\n'))).map((m) => m.id),
      });
    }
    fs.writeFileSync(path.join(output, 'claude-rewind-settling.json'), JSON.stringify(settling));
    fs.writeFileSync(path.join(output, 'claude-tui-before-send.jsonl'), fs.readFileSync(file));
    const walk = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
        );
    const files = walk(path.join(home, '.claude')).filter((p) => !p.endsWith('.jsonl'));
    fs.writeFileSync(
      path.join(output, 'claude-tui-local-files.json'),
      JSON.stringify(
        files.map((p) => ({
          path: p.slice(home.length),
          ...(p.endsWith('.json') ? { content: fs.readFileSync(p, 'utf8') } : {}),
        })),
        null,
        2,
      ),
    );
    terminal.write('\x15NATIVE_CLAUDE_TUI_BRANCH');
    await pause(300);
    terminal.write('\r');
    await pause(2000);
    fs.writeFileSync(path.join(output, 'claude-tui-branch-screen.txt'), dump());
    const tuiMessages = textOnly(
      parseTranscript('claude', fs.readFileSync(file, 'utf8').split('\n')),
    );
    const tuiText = JSON.stringify(tuiMessages);
    assert(tuiText.includes('NATIVE_CLAUDE_TUI_BRANCH'));
    assert(!tuiText.includes('NATIVE_CLAUDE_USER_3'));
    assert(!JSON.stringify(requests.at(-1)).includes('NATIVE_CLAUDE_USER_3'));
    assert(
      settling.every((sample) => sample.ids.length === 6),
      '记录未落盘窗口的原生能力边界',
    );
    tuiEvidence = {
      restoredTerminalTurns: 2,
      journalMessagesBeforeNextPrompt: 6,
      unchangedForSeconds: 10,
      branchMatchesNative: true,
    };
    fs.writeFileSync(path.join(output, 'claude-tui-after.jsonl'), fs.readFileSync(file));
    const archives = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.jsonl'));
    for (const name of archives)
      fs.copyFileSync(path.join(path.dirname(file), name), path.join(output, 'tui-' + name));
    fs.writeFileSync(path.join(output, 'claude-tui-archives.json'), JSON.stringify(archives));
    terminal.write('/effort low');
    await pause(200);
    terminal.write('\r');
    await pause(700);
    assert(dump().includes('Change effort level?'));
    terminal.write('\r');
    await pause(700);
    fs.writeFileSync(path.join(output, 'claude-effort-low.jsonl'), fs.readFileSync(file));
    fs.writeFileSync(path.join(output, 'claude-effort-low-screen.txt'), dump());
    terminal.kill();
    terminal = null;
    await pause(500);
  }

  const messages = textOnly(parseTranscript('claude', before));
  const anchor = messages.find((m) => m.blocks.some((b) => b.text === 'NATIVE_CLAUDE_REPLY_1'));
  assert(anchor);
  await run(
    [...args, '--resume', id, '--resume-session-at', anchor.id, 'NATIVE_CLAUDE_NEW_BRANCH'],
    env,
  );
  const after = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(path.join(output, 'native-claude-branch.jsonl'), after.join('\n') + '\n');
  const projected = textOnly(parseTranscript('claude', after))
    .flatMap((m) => m.blocks.map((b) => b.text || ''))
    .filter((t) => t.includes('NATIVE_CLAUDE_'));
  const lastInput = JSON.stringify(requests.at(-1));
  assert(!lastInput.includes('NATIVE_CLAUDE_USER_2'));
  assert(!lastInput.includes('NATIVE_CLAUDE_USER_3'));
  assert(!projected.some((t) => t.includes('NATIVE_CLAUDE_USER_2')));
  assert(!projected.some((t) => t.includes('NATIVE_CLAUDE_USER_3')));
  const result = {
    tuiEvidence,
    requests: count,
    beforeMessages: messages.length,
    projected,
    nativeResumeAt: anchor.id,
  };
  fs.writeFileSync(
    path.join(output, 'native-claude-observations.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    terminal?.kill();
    if (child?.exitCode === null) child.kill('SIGKILL');
    model.closeAllConnections();
    await new Promise((r) => model.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });

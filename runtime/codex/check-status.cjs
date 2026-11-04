const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const pty = require('node-pty');

const binary = path.resolve(process.argv[2]);
const baseline = process.argv.includes('--baseline');
const quick = process.argv.includes('--quick');
const remoteIndex = process.argv.indexOf('--official-server');
const officialBinary = remoteIndex >= 0 ? path.resolve(process.argv[remoteIndex + 1]) : null;
const cases = baseline || quick || officialBinary ? [['first@example.test', 'chen', 100]] : [
  ['first@example.test', 'chen', 100],
  ['second@example.test', 'lj', 100],
  ['third@example.test', 'hh', 100],
  ['fourth@example.test', 'wwh', 100],
  ['unlisted@example.test', 'unlisted', 80],
];
const plain = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({method: req.method, url: req.url});
  res.writeHead(200, {'content-type': 'application/json'});
  if (req.url.endsWith('/accounts/check')) {
    res.end(JSON.stringify({accounts: [{id: 'fixture-account', workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT'}]}));
  } else if (req.url.endsWith('/config/bundle')) {
    res.end(JSON.stringify({requirements_toml: {}}));
  } else {
    res.end(JSON.stringify({object: 'list', data: [], models: []}));
  }
});
server.on('connect', (req, socket) => {
  requests.push({method: 'CONNECT', url: req.url});
  socket.end('HTTP/1.1 502 Fixture blocks external connections\r\n\r\n');
});

async function checkCase(email, alias, cols) {
  const dir = fs.mkdtempSync(path.join(__dirname, baseline ? 'baseline-' : 'display-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, {mode: 0o700});
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = `model = "gpt-6-astra"
model_provider = "account-fixture"
chatgpt_base_url = "${base}"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
[features]
daemon_auto_start = false
[analytics]
enabled = false
[model_providers.account-fixture]
name = "Account display fixture"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = true
[tui]
animations = false
${quick ? '' : 'status_line = ["model-with-reasoning", "account", "run-state"]'}
account_aliases = {"first@example.test" = "chen", "second@example.test" = "lj", "third@example.test" = "hh", "fourth@example.test" = "wwh"}
[projects."${dir}"]
trust_level = "trusted"
`;
  fs.writeFileSync(path.join(home, 'config.toml'), config, {mode: 0o600});
  const claims = {
    email, exp: Math.floor(Date.now() / 1000) + 86400,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro', chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account',
    },
  };
  const jwt = 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: {id_token: jwt, access_token: jwt, refresh_token: 'synthetic-fixture', account_id: 'fixture-account'},
    last_refresh: new Date().toISOString(),
  }), {mode: 0o600});
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', ...(process.env.SWIFT_CODEX_ROOT ? {SWIFT_CODEX_ROOT: process.env.SWIFT_CODEX_ROOT} : {}) };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_') || key.startsWith('HERDR_') || key.startsWith('OPENAI_') || key.toLowerCase().endsWith('proxy')) delete env[key];
  }
  Object.assign(env, {CODEX_HOME: home, TERM: 'xterm-256color', HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost'});
  delete env.TERM_PROGRAM;
  let officialServer;
  let socketDir;
  let officialOutput = '';
  async function stopOfficialServer() {
    if (officialServer && officialServer.exitCode === null && !officialServer.signalCode) {
      officialServer.kill('SIGTERM');
      for (let i = 0; i < 20 && officialServer.exitCode === null && !officialServer.signalCode; i++) await delay(100);
      if (officialServer.exitCode === null && !officialServer.signalCode) officialServer.kill('SIGKILL');
    }
    if (officialServer) fs.writeFileSync(path.join(dir, 'official-server.log'), officialOutput);
    if (socketDir) fs.rmSync(socketDir, {recursive: true, force: true});
  }
  let launchArgs = ['--no-daemon', '--no-alt-screen', '--cd', dir];
  if (officialBinary) {
    const serverHome = path.join(dir, 'server-home');
    fs.cpSync(home, serverHome, {recursive: true});
    // The client disk deliberately holds another account. Only the server's identity may win.
    const clientClaims = {...claims, email: 'second@example.test'};
    const clientJwt = 'e30.' + Buffer.from(JSON.stringify(clientClaims)).toString('base64url') + '.fixture';
    const clientAuth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json')));
    clientAuth.tokens.id_token = clientAuth.tokens.access_token = clientJwt;
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(clientAuth), {mode: 0o600});
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-check-'));
    const socket = path.join(socketDir, 'rpc.sock');
    const remote = `unix://${socket}`;
    officialServer = spawn(officialBinary, ['app-server', '--listen', remote],
      {env: {...env, CODEX_HOME: serverHome}, cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
    officialServer.stdout.on('data', data => {officialOutput += data;});
    officialServer.stderr.on('data', data => {officialOutput += data;});
    officialServer.on('error', error => {officialOutput += error.stack;});
    try {
      for (let i = 0; i < 100 && !fs.existsSync(socket) && officialServer.exitCode === null; i++) await delay(100);
      assert.ok(fs.existsSync(socket), 'isolated official app-server must start');
    } catch (error) {
      await stopOfficialServer();
      throw error;
    }
    launchArgs = ['--remote', remote, '--no-alt-screen', '--cd', dir];
  }
  let output = '';
  let exited = false;
  let child;
  try {
    child = pty.spawn(binary, launchArgs, {env, cwd: dir, cols, rows: 35});
  } catch (error) {
    await stopOfficialServer();
    throw error;
  }
  child.onExit(() => {exited = true;});
  child.onData(data => {
    output += data;
    if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
    if (data.includes('\x1b]11;?')) child.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
  });
  try {
    const pattern = new RegExp(`·\\s*${alias}\\s*·`);
    const matches = () => pattern.test(plain(output));
    for (let i = 0; i < 100 && !exited; i++) {
      if (baseline ? plain(output).includes('Ready') : matches()) break;
      await delay(250);
    }
    const text = plain(output);
    if (baseline) {
      assert.ok(text.includes('Ready'), 'baseline composer should start with the added configuration');
      assert.ok(!matches(), 'baseline should not support the account field');
    } else {
      assert.ok(matches(), `account alias ${alias} should appear beside the model`);
      assert.ok(!text.includes(email), 'footer should not expose the complete email');
      assert.ok(!text.includes('Ignored invalid status line'), 'account should be a recognized status item');
      if (officialBinary) assert.ok(!/·\s*lj\s*·/.test(text), 'client disk account must not replace the connected server identity');
    }
    const status = text.split(/[\r\n]+/).filter(line => baseline ? line.includes('Ready') : pattern.test(line)).pop();
    fs.writeFileSync(path.join(dir, 'screen.txt'), text);
    return {alias, cols, passed: true, status, evidence: dir};
  } finally {
    fs.writeFileSync(path.join(__dirname, 'last-requests.json'), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(dir, 'terminal.ansi'), output);
    if (!exited) {
      child.write('/exit\r');
      for (let i = 0; i < 12 && !exited; i++) await delay(100);
      if (!exited) child.kill();
    }
    await stopOfficialServer();
  }
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const results = [];
    for (const c of cases) results.push(await checkCase(...c));
    assert.equal(requests.filter(r => /\/(?:responses|chat\/completions)(?:\?|$)/.test(r.url)).length, 0);
    const report = {passed: true, baseline, binary, officialBinary, results, modelRequests: 0, requests};
    fs.writeFileSync(path.join(__dirname, officialBinary ? 'remote-display.json' : baseline ? 'baseline.json' : quick ? 'installed-display.json' : 'display.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
  }
})();

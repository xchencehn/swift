const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const pty = require('node-pty');
const binary = path.resolve(process.argv[2]);
const dir = fs.mkdtempSync(path.join(__dirname, 'native-'));
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: [] }));
});
server.on('connect', (req, socket) => {
  requests.push({ method: 'CONNECT', url: req.url });
  socket.end('HTTP/1.1 502 Fixture blocks external connections\r\n\r\n');
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
let output = '';
let child;
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(dir, 'home'));
    fs.mkdirSync(path.join(dir, 'bin'));
    const cwd = dir;
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dir, 'home/config.toml'), `model = "gpt-6-astra"
model_provider = "hfork-fixture"
chatgpt_base_url = "${base}"
check_for_update_on_startup = false
[analytics]
enabled = false
[model_providers.hfork-fixture]
name = "hfork fixture"
base_url = "${base}/v1"
wire_api = "responses"
env_key = "HFORK_TEST_API_KEY"
[projects."${cwd}"]
trust_level = "trusted"
`);
    fs.writeFileSync(path.join(dir, 'bin/herdr'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(dir,'report-call.json'))},JSON.stringify(process.argv.slice(2)));`, {mode:0o755});
    const helper = path.join(dir, 'bin/herdr-codex-fork-right');
    fs.writeFileSync(helper, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'calls.json'))},JSON.stringify(args));\nconsole.log(JSON.stringify({sourceSession:args[3],newPane:'fixture:p2',newSession:'12345678-1234-1234-1234-123456789abc',commandSent:true}));\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), LANG: 'C.UTF-8', ...(process.env.SWIFT_CODEX_ROOT ? {SWIFT_CODEX_ROOT: process.env.SWIFT_CODEX_ROOT} : {}) };
    for (const key of Object.keys(env)) {
      if (key.startsWith('HERDR_') || key.startsWith('CODEX_') || key.startsWith('OPENAI_') || key.toLowerCase().endsWith('proxy')) delete env[key];
    }
    Object.assign(env, { CODEX_HOME: path.join(dir, 'home'), HFORK_TEST_API_KEY: 'isolated-fixture',
      PATH: path.join(dir, 'bin') + ':' + process.env.PATH, TERM: 'xterm-256color',
      HERDR_ENV: '1', HERDR_PANE_ID: 'fixture:p1', HERDR_SESSION: 'hfork-validation',
      HERDR_SOCKET_PATH: path.join(dir, 'no-server.sock'), HTTP_PROXY: base, HTTPS_PROXY: base,
      ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost' });
    delete env.TERM_PROGRAM;
    child = pty.spawn(binary, ['--no-daemon', '--no-alt-screen', '--cd', cwd], { env, cwd, cols: 160, rows: 45 });
    child.onData(data => {
      output += data;
      if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
      if (data.includes('\x1b]11;?')) child.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
    });
    for (let i = 0; i < 120 && !plain(output).includes('Tip:'); i++) await delay(500);
    assert.ok(plain(output).includes('Tip:'), 'composer must become ready');
    await delay(1200);
    child.write('/hfork');
    await delay(700);
    const before = output.length;
    child.write('\r');
    for (let i = 0; i < 60 && !plain(output.slice(before)).includes('Fork started in right pane'); i++) await delay(250);
    const result = plain(output.slice(before));
    assert.ok(result.includes('Fork started in right pane'), 'native command must report the local helper result');
    assert.ok(!result.includes('Unrecognized command'));
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json')));
    assert.deepEqual(args.slice(0, 3), ['--pane', 'fixture:p1', '--expected-session-id']);
    assert.match(args[3], /^[0-9a-f-]{36}$/i);
    const reportArgs = JSON.parse(fs.readFileSync(path.join(dir,'report-call.json')));
    assert.deepEqual(reportArgs.slice(0,9), ['pane','report-agent-session','fixture:p1','--source','herdr:codex','--agent','codex','--agent-session-id',args[3]]);
    assert.equal(requests.filter(req => req.method === 'POST').length, 0, 'no model request may be sent');
    const report = { passed: true, helperCalls: 1, sourceSession: args[3], modelRequests: 0, requests };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence: dir }));
  } catch (error) {
    console.error(error.stack, plain(output).slice(-5000));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(dir, 'terminal.ansi'), output);
    fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify(requests));
    if (child) child.kill();
    server.close();
  }
})();

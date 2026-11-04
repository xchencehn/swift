'use strict';
// Real disposable PTYs behind the Windows fixture's synthetic chat records.
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { HerdrClient } = require('../../lib/herdr-client');
const { attachShellTerminal } = require('../../lib/shell-terminal');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function createNativeTerminalFixture(
  binary,
  { homeScreen = false, messageBackground = false, stateFormat = 'cells-v1' } = {},
) {
  binary = path.resolve(binary);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-windows-pty-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    HERDR_SESSION: 'fixture',
  };
  const server = spawn(binary, ['--session', 'fixture', 'server'], { env, stdio: 'ignore' });
  const json = (args) => JSON.parse(execFileSync(binary, args, { env, encoding: 'utf8' })).result;
  const close = async () => {
    try {
      execFileSync(binary, ['server', 'stop'], { env, stdio: 'ignore' });
    } catch {}
    for (let i = 0; i < 50 && server.exitCode == null; i++) await pause(50);
    if (server.exitCode == null) server.kill('SIGTERM');
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    let socketPath;
    for (let attempt = 0; attempt < 100 && !socketPath; attempt++) {
      for (const name of ['herdr', 'herdr-dev']) {
        const candidate = path.join(home, 'config', name, 'sessions/fixture/herdr.sock');
        if (
          await fs.access(candidate).then(
            () => true,
            () => false,
          )
        )
          socketPath = candidate;
      }
      if (!socketPath) await pause(50);
    }
    if (!socketPath) throw new Error('Isolated Windows PTY fixture did not start');
    env.HERDR_SOCKET_PATH = socketPath;
    const bindings = [];
    for (const provider of ['codex', 'claude']) {
      const pane = json([
        'workspace',
        'create',
        '--cwd',
        home,
        '--label',
        provider,
        '--no-focus',
      ]).root_pane;
      const program = path.join(home, provider + '.py'),
        input = path.join(home, provider + '.input');
      const logo = homeScreen
        ? await fs.readFile(
            path.join(__dirname, '../../test/fixtures/terminal-home-logo.txt'),
            'utf8',
          )
        : '';
      const graphics = homeScreen
        ? `cols,rows=os.get_terminal_size()\nart=${JSON.stringify(logo)}.splitlines()\nfor y,line in enumerate(art):\n os.write(1,('\\x1b[%d;%dH%s'%(max(3,(rows-len(art))//2)+y,max(1,(cols-50)//2),line)).encode())\nos.write(1,('\\x1b[%d;1H> Ask Codex to do anything\\x1b[%d;1HGPT-6-Astra high - weekly 41%% left\\x1b[%d;1H? for shortcuts\\x1b[%d;3H'%(rows-3,rows-1,rows,rows-3)).encode())\n`
        : '';
      const background = messageBackground
        ? `import signal\ndef draw_background(*args):\n os.write(1,'\\x1b[4;1H\\x1b[48;5;8m\\x1b[2K\\x1b[5;1H\\x1b[2K> 用户消息整行背景 · spaces between words\\x1b[6;1H\\x1b[2K\\x1b[0m\\x1b[8;1H'.encode())\nsignal.signal(signal.SIGWINCH,draw_background)\ndraw_background()\n`
        : '';
      await fs.writeFile(
        program,
        `import os,tty\ntty.setraw(0)\nos.write(1,'\\x1b[2J\\x1b[HNATIVE_WINDOWS_${provider}\\r\\n共享终端 · 中文输入 · 本地历史\\r\\n\\x1b[6 q'.encode())\n${graphics}${background}while True:\n data=os.read(0,4096)\n with open(${JSON.stringify(input)},'ab') as stream:stream.write(data)\n os.write(1,b'RECEIVED_'+data)\n`,
      );
      execFileSync(binary, ['pane', 'run', pane.pane_id, 'python3 -u ' + program], {
        env,
        stdio: 'ignore',
      });
      bindings.push({
        alias: 'pane-' + provider,
        paneId: pane.pane_id,
        terminalId: pane.terminal_id,
        input,
      });
    }
    const herdr = new HerdrClient({ bin: binary, session: 'fixture', socketPath });
    herdr.env = (extra) => ({ ...env, ...extra });
    const snapshot = herdr.normalizeSnapshot(await herdr.snapshot());
    const formats = new Set(),
      actions = [];
    return {
      herdr,
      close,
      actions,
      bind(state) {
        state.runtimeId = snapshot.runtimeId;
        state.terminalChannelVersion = 2;
        for (const binding of bindings) {
          const session = state.sessions[binding.alias];
          delete state.sessions[binding.alias];
          Object.assign(session.pane, { paneId: binding.paneId, terminalId: binding.terminalId });
          state.sessions[binding.paneId] = session;
        }
        state.focusedPaneId = bindings[0].paneId;
      },
      attach(options) {
        options.ws.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (['terminal.key', 'terminal.input', 'terminal.focus'].includes(message.type))
            actions.push({
              type: message.type,
              key: message.key,
              kind: message.kind,
              focused: message.focused,
            });
        });
        const send = options.ws.send.bind(options.ws);
        options.ws.send = (data, ...args) => {
          if (typeof data === 'string') {
            const message = JSON.parse(data);
            if (message.type === 'terminal.ready') formats.add(message.stateFormat);
          }
          return send(data, ...args);
        };
        return attachShellTerminal({ ...options, herdr, env, maxInputBytes: 64 * 1024 });
      },
      async verify() {
        const inputs = await Promise.all(
          bindings.map((binding) =>
            fs.readFile(binding.input).catch((error) => {
              if (error.code === 'ENOENT') return Buffer.alloc(0);
              throw error;
            }),
          ),
        );
        if (formats.size !== 1 || !formats.has(stateFormat))
          throw new Error(
            'Windows client did not use the expected terminal format: ' + stateFormat,
          );
        if (inputs[0].toString('hex') !== '1b5b4178e4b8ad' || inputs[1].length)
          throw new Error(
            'Windows native input was missing, repeated or sent to another PTY: ' +
              inputs.map((input) => input.toString('hex')).join(',') +
              '; actions=' +
              JSON.stringify(actions),
          );
        return {
          ok: true,
          stateFormat,
          realPty: true,
          key: 'ArrowUp',
          text: 'x中',
          inputHex: '1b5b4178e4b8ad',
          inputExactlyOnce: true,
          otherTerminalUntouched: true,
          productionInput: false,
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { createNativeTerminalFixture };

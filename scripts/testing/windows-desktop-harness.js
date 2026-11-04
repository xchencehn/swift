'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { once } = require('node:events');
const { createHash } = require('node:crypto');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const { createTokenFixture } = require('./fixtures/token-server');
const { runGuest, inspectGuest } = require('./windows-vm');
async function main() {
  const root = path.resolve(__dirname, '../..');
  inspectGuest();
  const source = sourceFingerprint(root),
    build = JSON.parse(
      fs.readFileSync(path.join(root, 'artifacts/validation/windows-build.json'), 'utf8'),
    );
  const sameSource = (value) =>
    value?.revision === source.revision &&
    value?.dirty === source.dirty &&
    value?.treeSha256 === source.treeSha256;
  if (!build.ok || !sameSource(build.before) || !sameSource(build.after) || !build.executable)
    throw new Error(
      'Windows validation requires a successful build of the current source. Run npm run validate -- desktop first.',
    );
  const executable = path.join(
    root,
    process.platform === 'win32'
      ? 'desktop/target/release/swift-desktop.exe'
      : 'desktop/target/x86_64-pc-windows-msvc/release/swift-desktop.exe',
  );
  const binary = fs.readFileSync(executable);
  if (
    createHash('sha256').update(binary).digest('hex') !== build.executable.sha256 ||
    !binary.includes(fs.readFileSync(path.join(root, 'desktop/dist/VERSION.json')))
  )
    throw new Error(
      'Windows executable or embedded frontend differs from the verified build. Rebuild the desktop client.',
    );
  const terminalRuntime = process.env.SWIFT_WINDOWS_RUNTIME_BIN
    ? await require('./herdr-windows-fixture').createNativeTerminalFixture(
        process.env.SWIFT_WINDOWS_RUNTIME_BIN,
        {
          homeScreen: process.env.SWIFT_WINDOWS_TERMINAL_GRAPHICS === '1',
          messageBackground: process.env.SWIFT_WINDOWS_TERMINAL_BACKGROUND === '1',
          stateFormat: process.env.SWIFT_WINDOWS_TERMINAL_ANSI === '1' ? 'ansi' : 'cells-v1',
        },
      )
    : null;
  let fixture, tokenFixture, workspaceDirectory;
  try {
    const workspaceFiles = process.env.SWIFT_WINDOWS_FILES === '1';
    if (workspaceFiles) {
      workspaceDirectory = fs.mkdtempSync(
        path.join(require('node:os').tmpdir(), 'swift-windows-files-'),
      );
      fs.writeFileSync(
        path.join(workspaceDirectory, 'windows-file.md'),
        '# Windows 文件验收\n\n读取与修改临时文件。\n\n```javascript\nconst answer = "中文高亮";\nconsole.log(answer, 42);\n```\n\n## 保存操作\n\n这里是第二节。\n',
      );
    }
    tokenFixture = await createTokenFixture({
      terminalRuntime,
      sideSession: process.env.SWIFT_WINDOWS_SIDE === '1',
      workspaceDirectory,
    });
    fixture = tokenFixture.fixture;
    const goalCommand = process.env.SWIFT_WINDOWS_GOAL === '1';
    if (goalCommand)
      Object.values(fixture.state.sessions).find(
        (session) => session.pane.agent?.label === 'codex',
      ).webStatus = {
        goal: require('../../lib/agent-goal').codexGoal({
          objective: 'Windows Goal：完成开发并核对真实状态。',
          status: 'paused',
        }),
      };
    fixture.state.terminalPreview = true;
    if (process.env.SWIFT_WINDOWS_CHAT_HIGHLIGHTING === '1') {
      Object.values(fixture.state.sessions)
        .find((session) => session.pane.agent.label === 'codex')
        .messages.push({
          id: 'native-chat-colors',
          role: 'assistant',
          blocks: [
            {
              kind: 'text',
              text: 'Windows 聊天配色验收\n\n```javascript\nconst answer = "中文高亮";\nconsole.log(answer, 42);\n```',
            },
            {
              kind: 'tools',
              items: [
                {
                  id: 'native-color-command',
                  name: 'exec_command',
                  action: { verb: 'Ran', command: 'python3 verify.py --verbose' },
                  input: { text: '{"cmd":"python3 verify.py --verbose"}' },
                  result: {
                    text: JSON.stringify({
                      exit_code: 0,
                      output: '\x1b[1;32mPASS\x1b[0m normal \x1b[38;5;214mWARN\x1b[0m',
                    }),
                  },
                  outcome: { exitCode: 0 },
                },
              ],
            },
          ],
        });
    }
    const htmlPreview = process.env.SWIFT_WINDOWS_HTML_PREVIEW === '1';
    const composerHeight = process.env.SWIFT_WINDOWS_COMPOSER_HEIGHT === '1';
    const direct = true;
    if (htmlPreview) {
      fixture.state.htmlPreview = true;
      Object.values(fixture.state.sessions)
        .find((session) => session.pane.agent.label === 'codex')
        .messages.push({
          id: 'native-html-report',
          role: 'assistant',
          blocks: [{ kind: 'text', text: '[打开 HTML 报告](/fixture/workdir/native-report.html)' }],
        });
    }
    const output =
      process.env.SWIFT_WINDOWS_OUTPUT || path.join(root, 'artifacts/validation/windows-native');
    fs.mkdirSync(output, { recursive: true });
    const vm = await runGuest({
      executable,
      fixtureUrl: tokenFixture.url,
      fixtureToken: 'fixture-direct-token',
      output,
      htmlPreview,
      composerHeight,
      goalCommand,
      sideSession: process.env.SWIFT_WINDOWS_SIDE === '1',
      direct,
      nativeRuntime: !!terminalRuntime,
      workspaceFiles,
    });
    const initial = JSON.parse(
      fs
        .readFileSync(path.join(output, 'native-connect-result.json'), 'utf8')
        .replace(/^\uFEFF/, ''),
    );
    const guide = JSON.parse(
      fs.readFileSync(path.join(output, 'native-guide-result.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    if (
      !initial.ok ||
      !initial.singleInstance ||
      !initial.multipleWindows ||
      !initial.closeMainPreservesOther ||
      !initial.newWindowMenu ||
      !guide.ok ||
      !guide.returnWithoutToken
    )
      throw new Error('A native lifecycle phase lacks its verification receipt.');
    const proofFile = path.join(output, 'native-result.json');
    const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8').replace(/^\uFEFF/, ''));
    if (
      !proof.tokenRequired ||
      !proof.tokenColdRestore ||
      !proof.credentialsOutsideMetadata ||
      !tokenFixture.state.authenticated
    )
      throw Error('Windows token connection lacks a cold-restore receipt.');
    proof.freshAutomationClientPerLifetime = true;
    proof.windowsTarget = vm.target;
    proof.wecomProcessesPreserved = vm.wecomProcessesPreserved;
    proof.nativeProcess = initial.nativeProcess;
    proof.multipleWindows = initial.multipleWindows;
    proof.closeMainPreservesOther = initial.closeMainPreservesOther;
    proof.newWindowMenu = initial.newWindowMenu;
    for (const key of [
      'desktopReconnect',
      'messageNavigation',
      'htmlPreview',
      'htmlInteraction',
      'htmlSourceToggle',
      'composerHeight',
      'sideSession',
      'goalCommand',
      'workspaceFiles',
      'chatHighlighting',
    ])
      if (Object.hasOwn(initial, key)) proof[key] = initial[key];
    if (
      workspaceFiles &&
      (!initial.workspaceFiles?.ok ||
        fs.readFileSync(path.join(workspaceDirectory, 'windows-file.md'), 'utf8') !==
          '# Windows 文件验收\n\nWindows 文件编辑已保存。\n\n## 保存操作\n\n这里是第二节。\n')
    )
      throw Error('Native Windows file editing lacks its matching filesystem result.');
    if (
      goalCommand &&
      (!initial.goalCommand?.ok ||
        fixture.state.requests.some((row) =>
          ['POST /api/agents/goal', 'POST /api/command-interaction'].includes(row.route),
        ))
    )
      throw Error('Native Windows Goal view must open without sending control input.');
    if (
      process.env.SWIFT_WINDOWS_SIDE === '1' &&
      (!initial.sideSession?.ok ||
        fixture.state.sideSends?.length !== 1 ||
        fixture.state.sideForks?.length !== 1 ||
        !fixture.state.sideSends[0].text.includes('第二行') ||
        fixture.state.sideForks[0].sideId !== '01900000-0000-7000-8000-000000000182')
    )
      throw new Error('Native Windows side session operations lack their exact fixture receipts.');
    fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n');
    if (!fixture.state.shellConnections)
      throw new Error('Native Windows client did not open its Pane terminal');
    if (terminalRuntime)
      fs.writeFileSync(
        path.join(output, 'native-runtime.json'),
        JSON.stringify(await terminalRuntime.verify(), null, 2) + '\n',
      );
    console.log(fs.readFileSync(path.join(output, 'native.log'), 'utf8').trim());
  } finally {
    try {
      await tokenFixture?.close();
    } finally {
      await terminalRuntime?.close();
      if (workspaceDirectory) fs.rmSync(workspaceDirectory, { recursive: true, force: true });
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

'use strict';
// The attendance guest is the only Windows runtime target. No host fallback.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..');
const consoleTool = process.env.SWIFT_WINDOWS_VM_CONSOLE;
const evidenceNames = [
  'native-chat-code-colors.png',
  'native-chat-color-result.json',
  'native-files.png',
  'native-file-editor.png',
  'native-install-result.json',
  'native-vault.json',
  'native-reconnected.png',
  'native-message-navigation.png',
  'native-goal.png',
  'native-goal-edit.png',
  'native-side-session.png',
  'native-multi-window.png',
  'native-connect.png',
  'native-chat.png',
  'native-restored.png',
  'native-settings.png',
  'native-settings-font.png',
  'native-settings-terminal.png',
  'native-add-server.png',
  'native-edit-server.png',
  'native-server-switch.png',
  'native-html.png',
  'native-composer.png',
  'native-result.json',
  'native-connect-result.json',
  'native-guide-result.json',
  'native-failure-controls.json',
  'native.log',
  'vm-result.json',
];
evidenceNames.push(
  'native-chat-colors.png',
  'native-client-updates.png',
  'native-server-updates.png',
  'native-startup.json',
  'native-startup-empty.png',
  'native-startup-saved.png',
  'native-startup-many.png',
);
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

function inspectGuest() {
  if (!consoleTool || !fs.existsSync(consoleTool))
    throw Error(
      'Set SWIFT_WINDOWS_VM_CONSOLE to the console helper for the existing Windows test VM.',
    );
  if (process.platform !== 'linux')
    throw Error(
      'Windows tests must be launched from WSL into wecom-desktop; host Windows execution is disabled.',
    );
  const status = JSON.parse(
    execFileSync('sudo', ['-n', 'python3', consoleTool, 'status'], {
      encoding: 'utf8',
      timeout: 25000,
    }),
  );
  if (!status.vm.running || !status.kvm.enabled)
    throw Error('The existing attendance VM must be running with KVM. Do not replace or reset it.');
  const network = execFileSync(
    'docker',
    [
      'inspect',
      'wecom-desktop',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.Gateway}}{{end}}',
    ],
    { encoding: 'utf8', timeout: 10000 },
  )
    .trim()
    .split(' ');
  if (network.length !== 2 || network.some((ip) => net.isIP(ip) !== 4))
    throw Error('Cannot identify the attendance VM Docker bridge.');
  return { container: 'wecom-desktop', address: network[0], gateway: network[1], ...status };
}

async function consoleCommand(action, value) {
  const child = spawn('sudo', ['-n', 'python3', consoleTool, action, ...(value ? [value] : [])], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  child.stderr.on('data', (chunk) => (error += chunk));
  const [code] = await once(child, 'exit');
  if (code !== 0) throw Error(`VM console ${action} failed: ${error}`);
}

async function runGuest({
  executable,
  fixtureUrl,
  fixtureToken,
  output,
  htmlPreview,
  composerHeight,
  goalCommand = false,
  sideSession = false,
  direct,
  vaultProbe,
  installerSequence,
  nativeRuntime = false,
  workspaceFiles = false,
  startup = false,
  probe = false,
}) {
  const guest = inspectGuest();
  const canonical = process.env.SWIFT_WINDOWS_LOCK_ROOT || root;
  const lock = path.join(
    fs.existsSync(path.join(canonical, 'AGENTS.md')) ? canonical : root,
    '.local/state/windows-vm-validation.lock',
  );
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(
        `Another Swift VM test owns ${lock}. Wait for it; check its PID before removing a stale lock.`,
      );
    throw error;
  }
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
  );
  const servers = [],
    sockets = new Set();
  let timer;
  try {
    fs.mkdirSync(output, { recursive: true });
    for (const name of [...evidenceNames, 'vm-transport.json', 'transport.log'])
      fs.rmSync(path.join(output, name), { force: true });
    const listen = async (server) => {
      servers.push(server);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(0, guest.gateway);
      await once(server, 'listening');
      return `http://${guest.gateway}:${server.address().port}`;
    };
    const relay = async (url) => {
      const target = new URL(url);
      return listen(
        net.createServer((client) => {
          if (client.remoteAddress !== guest.address) return client.destroy();
          const upstream = net.connect(Number(target.port), '127.0.0.1');
          sockets.add(upstream);
          upstream.on('close', () => sockets.delete(upstream));
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          client.on('close', () => upstream.destroy());
          upstream.on('close', () => client.destroy());
          client.pipe(upstream).pipe(client);
        }),
      );
    };
    const guestFixture = probe && !installerSequence ? '' : await relay(fixtureUrl);
    const runId = randomUUID();
    let bootstrap;
    let finish;
    const complete = new Promise((resolve) => {
      finish = resolve;
    });
    const serverUrl = await listen(
      http.createServer((req, res) => {
        fs.appendFileSync(
          path.join(output, 'transport.log'),
          req.method + ' ' + req.socket.remoteAddress + '\n',
        );
        if (req.socket.remoteAddress !== guest.address || !req.url.startsWith('/' + runId + '/')) {
          res.writeHead(403).end();
          return;
        }
        const name = req.url.slice(runId.length + 2);
        if (req.method === 'GET') {
          if (name === 'run.ps1') {
            res.end(bootstrap);
            return;
          }
          const index = /^installer-(\d+)\.exe$/.exec(name);
          const file =
            index && installerSequence
              ? installerSequence[Number(index[1])]?.file
              : name === 'install-smoke.ps1' && installerSequence
                ? path.join(root, 'scripts/testing/windows-install-smoke.ps1')
                : name === 'vault-check.exe' && vaultProbe
                  ? vaultProbe
                  : name === 'swift.exe'
                    ? executable
                    : name === 'smoke.ps1'
                      ? path.join(
                          root,
                          startup
                            ? 'scripts/testing/windows-startup-smoke.ps1'
                            : 'scripts/testing/windows-desktop-smoke.ps1',
                        )
                      : null;
          if (!file) {
            res.writeHead(404).end();
            return;
          }
          const stream = fs.createReadStream(file);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        if (req.method !== 'POST' || (!evidenceNames.includes(name) && name !== 'done')) {
          res.writeHead(404).end();
          return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', () => {
          const bytes = Buffer.concat(chunks);
          if (name === 'done') {
            res.end('ok');
            finish(Number(bytes.toString()));
          } else {
            fs.writeFileSync(path.join(output, name), bytes);
            res.end('ok');
          }
        });
      }),
    );
    const url = serverUrl + '/' + runId;
    bootstrap = `
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$base=${quote(url)}
$dir=Join-Path $env:LOCALAPPDATA ${quote('SwiftDevelopment\\vm-' + runId)}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$client=New-Object Net.WebClient
$client.Proxy=$null
$result=1
$before=@(Get-Process WXWork,WeCom -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
try {
 $system=Get-CimInstance Win32_ComputerSystem
 if($system.Manufacturer -notmatch 'QEMU|Red Hat' -and $system.Model -notmatch 'QEMU|Standard PC'){throw 'Expected the QEMU attendance guest.'}
 $webview=@(Get-ChildItem 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\msedgewebview2.exe' -ErrorAction SilentlyContinue)
 $proof=[ordered]@{target='wecom-desktop';manufacturer=$system.Manufacturer;model=$system.Model;windows=[Environment]::OSVersion.Version.ToString();webView2Available=($webview.Count -gt 0);probeOnly=${probe && !installerSequence ? '$true' : '$false'}}
 ${
   installerSequence
     ? `
 $env:SWIFT_WINDOWS_TEST_TARGET='wecom-desktop'
 $env:SWIFT_INSTALL_FIXTURE=${quote(guestFixture)}
 Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
 $sequence=@(${installerSequence.map((item, index) => `@{file='installer-${index}.exe';version=${quote(item.version)};sha256=${quote(require('node:crypto').createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'))}}`).join(',')})
 foreach($item in $sequence){$client.DownloadFile($base+'/'+$item.file,(Join-Path $dir $item.file))}
 $client.DownloadFile($base+'/install-smoke.ps1',(Join-Path $dir 'install-smoke.ps1'))
 & (Join-Path $dir 'install-smoke.ps1') -Directory $dir -Sequence $sequence
 `
     : ''
 }
 ${
   probe
     ? ''
     : `
 $env:SWIFT_WINDOWS_TEST_TARGET='wecom-desktop'
 $env:SWIFT_WINDOWS_NATIVE_RUNTIME=${quote(nativeRuntime ? '1' : '0')}
 $env:SWIFT_WINDOWS_FILES=${quote(workspaceFiles ? '1' : '0')}
 $env:SWIFT_WINDOWS_CHAT_HIGHLIGHTING=${quote(process.env.SWIFT_WINDOWS_CHAT_HIGHLIGHTING === '1' ? '1' : '0')}
 ${
   startup
     ? `$env:SWIFT_WINDOWS_STARTUP_SAMPLES=${quote(process.env.SWIFT_STARTUP_SAMPLES || '5')}
 $env:SWIFT_WINDOWS_STARTUP_PROGRESS=$base+'/native-startup.json'`
     : ''
 }
 $client.DownloadFile($base+'/swift.exe',(Join-Path $dir 'swift.exe'))
 ${
   vaultProbe
     ? `$client.DownloadFile($base+'/vault-check.exe',(Join-Path $dir 'vault-check.exe'))
 & (Join-Path $dir 'vault-check.exe') --vault-check | Set-Content -LiteralPath (Join-Path $dir 'native-vault.json') -Encoding UTF8
 if($LASTEXITCODE -ne 0){throw ('Windows vault migration probe failed; exit code: '+$LASTEXITCODE)}
 $client.UploadFile($base+'/native-vault.json','POST',(Join-Path $dir 'native-vault.json'))|Out-Null`
     : ''
 }
 if((Get-FileHash (Join-Path $dir 'swift.exe') -Algorithm SHA256).Hash -ne ${quote(require('node:crypto').createHash('sha256').update(fs.readFileSync(executable)).digest('hex'))}){throw 'Transferred EXE hash mismatch.'}
 $client.DownloadFile($base+'/smoke.ps1',(Join-Path $dir 'smoke.ps1'))
 $evidence=Join-Path $dir 'evidence'
 foreach($phase in @(${(startup ? ['startup'] : ['connect', 'guide', 'restored']).map(quote).join(',')})) {
  $arguments=@('-NoProfile','-MTA','-ExecutionPolicy','Bypass','-File',(Join-Path $dir 'smoke.ps1'),'-Executable',(Join-Path $dir 'swift.exe'),'-FixtureUrl',${quote(guestFixture)},'-OutputDirectory',$evidence,'-ServerToken',${quote(fixtureToken)},'-Phase',$phase,'-DataDirectory',(Join-Path $evidence 'isolated-data-shared'))
  ${htmlPreview ? "$arguments+='-HtmlPreview'" : ''}
  ${composerHeight ? "$arguments+='-ComposerHeight'" : ''}
  ${goalCommand ? "$arguments+='-GoalCommand'" : ''}
  ${sideSession ? "$arguments+='-SideSession'" : ''}
  ${direct ? "$arguments+='-Direct'" : ''}
  'Native phase: '+$phase | Out-File (Join-Path $dir 'native.log') -Append -Encoding utf8
  & powershell.exe @arguments 2>&1 | Out-File (Join-Path $dir 'native.log') -Append -Encoding utf8
  if($LASTEXITCODE -ne 0){throw "Native phase failed: $phase ($LASTEXITCODE)"}
 }
 `
 }
 $result=0
} catch { $_ | Out-String | Out-File (Join-Path $dir 'native.log') -Append -Encoding utf8 }
finally {
 $after=@(Get-Process WXWork,WeCom -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
 if(-not $proof){$proof=[ordered]@{target='wecom-desktop';probeOnly=${probe && !installerSequence ? '$true' : '$false'}}}
 $proof.wecomProcessesPreserved=((($before | Sort-Object) -join ',') -eq (($after | Sort-Object) -join ','))
 $proof.ok=($result -eq 0)
 $proof | ConvertTo-Json | Set-Content (Join-Path $dir 'vm-result.json') -Encoding utf8
 foreach($name in @(${evidenceNames.map(quote).join(',')})) {
  $file=Join-Path $dir $name
  if(-not (Test-Path $file)){$file=Join-Path (Join-Path $dir 'evidence') $name}
  if(Test-Path $file){$client.UploadData($base+'/'+$name,'POST',[IO.File]::ReadAllBytes($file)) | Out-Null}
 }
 $client.UploadString($base+'/done','POST',[string]$result) | Out-Null
}
`;
    // Only QMP receives keystrokes. No host PowerShell, mouse or clipboard access.
    const command = `powershell -NoP -W Hidden -C "$w=New-Object Net.WebClient;$w.Proxy=$null;iex($w.DownloadString('${url}/run.ps1'))"`;
    await consoleCommand('key', 'meta_l-r');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await consoleCommand('key', 'ctrl-a');
    await consoleCommand('type', command);
    await consoleCommand('key', 'ret');
    const code = await Promise.race([
      complete,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                'Attendance guest did not finish; inspect its console and task evidence. Host fallback is disabled.',
              ),
            ),
          probe && !installerSequence ? 60000 : 10 * 60 * 1000,
        );
      }),
    ]);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(output, 'vm-result.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    fs.writeFileSync(
      path.join(output, 'vm-transport.json'),
      JSON.stringify(
        {
          target: guest.container,
          at: new Date().toISOString(),
          kvm: guest.kvm.enabled,
          ...receipt,
        },
        null,
        2,
      ) + '\n',
    );
    if (code !== 0)
      throw Error(`Attendance guest test failed (${code}); see ${path.join(output, 'native.log')}`);
    return receipt;
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

module.exports = { runGuest, inspectGuest };
if (require.main === module) {
  if (!process.argv.includes('--probe'))
    throw Error(
      'Use --probe to verify the guest transport, or npm run validate -- windows for native tests.',
    );
  runGuest({ probe: true, output: path.join(root, 'artifacts/validation/windows-vm-probe') })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

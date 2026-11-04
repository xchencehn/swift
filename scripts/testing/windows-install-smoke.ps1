#requires -version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][array]$Sequence)
$ErrorActionPreference='Stop'
if($env:SWIFT_WINDOWS_TEST_TARGET -ne 'wecom-desktop'){throw 'Use only the protected attendance guest transport.'}
if(Get-Process swift-desktop -ErrorAction SilentlyContinue){throw 'Wait for other Swift clients to exit; installer validation will not stop them.'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SwiftInstallWindow {
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
$target=Join-Path $env:LOCALAPPDATA 'Swift'
$executable=Join-Path $target 'swift-desktop.exe'
if(-not(Test-Path $executable)){throw 'An existing Swift installation is required for the upgrade/rollback test.'}
$backup=Join-Path $Directory 'installed-swift-backup.exe'
Copy-Item -LiteralPath $executable -Destination $backup
$previousVersion=(Get-Item $backup).VersionInfo.ProductVersion
$previousHash=(Get-FileHash $backup -Algorithm SHA256).Hash
$data=Join-Path $Directory 'installer-validation-data'
New-Item -ItemType Directory -Force -Path $data|Out-Null
$id='a'*64
$metadata=[ordered]@{profiles=@([ordered]@{id=$id;name='升级回退免费直连';mode='direct';address=$env:SWIFT_INSTALL_FIXTURE;remote_base=''});active=$id}|ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $data 'connections.json'),$metadata,[Text.UTF8Encoding]::new($false))
$env:SWIFT_DESKTOP_DATA_DIR=$data
$records=@()
function Record-Installed([string]$expected,[string]$phase){
 $version=(Get-Item $executable).VersionInfo.ProductVersion
 if($version -ne $expected -and $version -ne ($expected+'.0')){throw ('Installed version mismatch: '+$version)}
 $app=Start-Process -FilePath $executable -PassThru
 try {
  for($n=0;$n -lt 80;$n++){ $app.Refresh(); if($app.HasExited){throw 'Installed client exited during startup.'}; if($app.MainWindowHandle -ne 0){break};Start-Sleep -Milliseconds 250 }
  if($app.MainWindowHandle -eq 0){throw 'Installed client window did not appear.'}
  Start-Sleep -Seconds 3
  $app.Refresh();if($app.HasExited){throw 'Installed client did not remain running.'}
  $retained=Get-Content (Join-Path $data 'connections.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($retained.profiles.Count -ne 1 -or $retained.profiles[0].id -ne $id -or $retained.active -ne $id){throw 'Upgrade or rollback lost the legacy direct profile.'}
  $script:records+=@{phase=$phase;version=$version;nativeWindow=$true;profilePreserved=$true;exeSha256=(Get-FileHash $executable -Algorithm SHA256).Hash.ToLowerInvariant()}
 } finally {
  $app.Refresh();if(-not $app.HasExited){[SwiftInstallWindow]::SendMessage($app.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null; if(-not $app.WaitForExit(10000)){throw 'Installed test client did not exit cleanly.'}}
 }
}
$item=$Sequence[0]
$installer=Join-Path $Directory $item.file
if((Get-FileHash $installer -Algorithm SHA256).Hash -ne $item.sha256){throw 'Installer transfer checksum mismatch.'}
Record-Installed $previousVersion 'existing'
$process=Start-Process -FilePath $installer -ArgumentList @('/S',('/D='+$target)) -Wait -PassThru
if($process.ExitCode -ne 0){throw ('Swift upgrade failed: '+$process.ExitCode)}
Record-Installed $item.version 'upgrade'
if((Get-FileHash $backup -Algorithm SHA256).Hash -ne $previousHash){throw 'Installed rollback backup checksum mismatch.'}
Copy-Item -LiteralPath $backup -Destination $executable -Force
Record-Installed $previousVersion 'rollback'
$process=Start-Process -FilePath $installer -ArgumentList @('/S',('/D='+$target)) -Wait -PassThru
if($process.ExitCode -ne 0){throw ('Swift upgrade after rollback failed: '+$process.ExitCode)}
Record-Installed $item.version 'upgrade-after-rollback'
@{ok=$true;target='wecom-desktop';actualInstallers=$true;rollbackMethod='installed-executable-backup';sequence=$records;finalVersion=$item.version;productionTerminalInput=$false}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $Directory 'native-install-result.json') -Encoding UTF8

[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$FixtureUrl, [Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$HtmlPreview, [switch]$ComposerHeight, [switch]$SideSession, [switch]$GoalCommand, [string]$ServerToken, [switch]$Direct, [ValidateSet('all','connect','guide','restored')][string]$Phase='all', [string]$DataDirectory)
$ErrorActionPreference = 'Stop'
if($env:SWIFT_WINDOWS_TEST_TARGET -ne 'wecom-desktop'){throw 'Run Windows tests through the WSL attendance VM harness; host desktop testing is disabled.'}
$testMachine=Get-CimInstance Win32_ComputerSystem
if($testMachine.Manufacturer -notmatch 'QEMU|Red Hat' -and $testMachine.Model -notmatch 'QEMU|Standard PC'){throw 'Windows tests require the QEMU attendance guest.'}
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SwiftWindow {
 public delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, System.Text.StringBuilder text, int count);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle,uint message,IntPtr wparam,IntPtr lparam);
 public static IntPtr MainWindow(int pid) {
  IntPtr result=IntPtr.Zero;
  EnumWindows((handle, parameter)=>{uint owner;GetWindowThreadProcessId(handle,out owner);var title=new System.Text.StringBuilder(256);GetWindowText(handle,title,256);if(owner==pid && title.ToString().Contains("Swift")){result=handle;return false;}return true;},IntPtr.Zero);
  return result;
 }
 public static IntPtr[] Windows(int pid) {
  var result=new System.Collections.Generic.List<IntPtr>();
  EnumWindows((handle, parameter)=>{uint owner;GetWindowThreadProcessId(handle,out owner);var title=new System.Text.StringBuilder(256);GetWindowText(handle,title,256);if(owner==pid && title.ToString().Contains("Swift")){result.Add(handle);}return true;},IntPtr.Zero);
  return result.ToArray();
 }
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit, Size=32)] public struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard; }
 [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,Input[] input,int size);
 public static void Shortcut(ushort key) {
  var events=new Input[4];
  for(int i=0;i<4;i++) { events[i].type=1; events[i].data.keyboard.key=(i==0||i==3)?(ushort)0x11:key; events[i].data.keyboard.flags=i>=2?(uint)2:0; }
  if(SendInput(4,events,Marshal.SizeOf(typeof(Input)))!=4)throw new System.ComponentModel.Win32Exception();
 }
 public static void SendText(string text) {
  foreach(char character in text) {
   var events=new Input[2];
   for(int i=0;i<2;i++){events[i].type=1;events[i].data.keyboard.scan=character;events[i].data.keyboard.flags=(uint)(4+i*2);}
   if(SendInput(2,events,Marshal.SizeOf(typeof(Input)))!=2)throw new System.ComponentModel.Win32Exception();
  }
 }
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle,ref Point point);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle,IntPtr deviceContext,uint flags);
}
'@
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$installDirectory = Join-Path $OutputDirectory 'isolated-program'
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$isolatedExecutable=Join-Path $installDirectory 'swift-desktop.exe'
# All lifecycle phases use the same verified EXE; avoid rewriting identical bytes
# while Windows is finishing process teardown after the previous phase.
if(-not (Test-Path -LiteralPath $isolatedExecutable) -or (Get-FileHash -LiteralPath $Executable).Hash -ne (Get-FileHash -LiteralPath $isolatedExecutable).Hash){
 Copy-Item -LiteralPath $Executable -Destination $isolatedExecutable -Force
}
$dataDirectory = if($DataDirectory){$DataDirectory}else{Join-Path $OutputDirectory ('isolated-data-'+[Guid]::NewGuid().ToString('N'))}
if(-not [IO.Path]::GetFullPath($dataDirectory).StartsWith([IO.Path]::GetFullPath($OutputDirectory)+[IO.Path]::DirectorySeparatorChar)){throw 'Native fixture data must remain inside its isolated output directory.'}
$env:SWIFT_DESKTOP_DATA_DIR = $dataDirectory
$process = $null
function Find-Control([string]$Name, [string]$Type='') {
 $nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name)
 $condition=$nameCondition
 if($Type){$condition=[Windows.Automation.AndCondition]::new($nameCondition,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::$Type))}
 for($attempt=0;$attempt -lt 60;$attempt++) {
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $element=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
  if($element -and -not $element.Current.IsOffscreen) { return $element }
  Start-Sleep -Milliseconds 250
 }
 throw "Expected application control is unavailable: $Name"
}
function Find-ServerSwitch {
 # The current profile is part of the accessible name, including after rename.
 # This file belongs to the isolated fixture directory checked above.
 $saved=Get-Content -LiteralPath (Join-Path $dataDirectory 'connections.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 return (Find-Control ('当前服务器：'+$saved.profiles[0].name+'，切换服务器') 'Button')
}
function Find-ExecutionControl([string]$Name,[string]$Type) {
 # Long settings forms must be scrolled through the native accessibility API.
 $condition=[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Name),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::$Type))
 for($attempt=0;$attempt -lt 60;$attempt++) {
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $element=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
  if($element){
   $pattern=$null
   if($element.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern,[ref]$pattern)){$pattern.ScrollIntoView()}
   elseif($element.Current.IsKeyboardFocusable){$element.SetFocus()}
   if(-not $element.Current.IsOffscreen){return $element}
  }
  Start-Sleep -Milliseconds 250
 }
 throw "Execution settings control could not be scrolled into view: $Name"
}
function Assert-TerminalPage {
 # UIA invocation and the first Pane snapshot are asynchronous. A switch label
 # alone is not completion: require the terminal and its mode control together.
 $wait=[Diagnostics.Stopwatch]::StartNew()
 $invoked=$false;$structuredSamples=0;$terminalSamples=0;$ready=$false
 while($wait.ElapsedMilliseconds -lt 30000) {
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  # Read UIA properties in one cached request. Repeated remote FindFirst calls
  # can consume the entire deadline before a second stable observation.
  $request=[Windows.Automation.CacheRequest]::new()
  $request.Add([Windows.Automation.AutomationElement]::NameProperty)
  $request.Add([Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $request.Add([Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cache=$request.Activate()
  try {$entries=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)}
  finally {$cache.Dispose()}
  $visible=@{};$named=@{};$terminalStatus=$null
  foreach($entry in $entries) {
   $name=$entry.Cached.Name
   if($name -and -not $named.ContainsKey($name)){$named[$name]=$entry}
   if(-not $entry.Cached.IsOffscreen){
    if($name){$visible[$name]=$entry}
    if($entry.Cached.ControlType -eq [Windows.Automation.ControlType]::StatusBar){$terminalStatus=$entry}
   }
  }
  $toggle=$visible['切换到终端模式'];$restored=$visible['切换到结构化模式'];$terminal=$visible['会话终端']
  $structuredVisible=$null -ne $toggle;$terminalVisible=$null -ne $terminal;$restoredVisible=$null -ne $restored
  $terminalInput=$named['Terminal input'];$connectedSurface=$visible['会话交互终端，已连接']
  $connecting=$visible['正在连接终端…'];$terminalRetry=$visible['重新连接']
  # xterm creates its input before connecting. Wait for the terminal region
  # to report a painted connected frame; there is no reconnect notice.
  # A restored terminal is intentionally read-only until user interaction.
  # Its unfocused textarea can be offscreen. The region becomes connected only
  # after the current socket's frame has finished painting.
  $surfaceReady=$null -ne $connectedSurface
  $statusVisible=$null -ne $terminalStatus
  $connectingVisible=$null -ne $connecting
  $retryVisible=$null -ne $terminalRetry
  if($terminalVisible -and $restoredVisible -and -not $structuredVisible -and $terminalInput -and $surfaceReady -and -not $statusVisible -and -not $connectingVisible -and -not $retryVisible){$terminalSamples++}else{$terminalSamples=0}
  if($terminalSamples -ge 3){$ready=$true;break}
  if($structuredVisible -and -not $restoredVisible){$structuredSamples++}else{$structuredSamples=0}
  # Confirm the source mode before the sole invocation, then only observe its
  # result. Repeated invocations could toggle a delayed UI action back again.
  if(-not $invoked -and $structuredSamples -ge 2){
   $invoked=$true
   $pattern=$null
   if($toggle.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke()}
   else{$toggle.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle()}
  }
  Start-Sleep -Milliseconds 250
 }
 if(-not $ready){throw ('The visible session terminal and terminal-mode control did not stabilize within 30 seconds; invoked='+$invoked+'; structuredSamples='+$structuredSamples+'; terminalSamples='+$terminalSamples)}
 Find-Control '会话终端' | Out-Null
 if(-not $terminalInput){throw 'The native terminal input element is missing.'}
 if($env:SWIFT_WINDOWS_NATIVE_RUNTIME -eq '1' -and $Phase -in @('all','connect') -and -not $script:nativeRuntimeInputSent) {
  [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
  $terminalInput.SetFocus()
  Start-Sleep -Milliseconds 150
  if([SwiftWindow]::GetForegroundWindow() -ne $script:mainWindow -or -not $terminalInput.Current.HasKeyboardFocus){throw 'The isolated terminal does not own native keyboard focus.'}
  # Use a physical virtual key, including keyup, rather than SendKeys journal
  # playback, which can silently miss WebView2 in the MTA automation process.
  [SwiftWindow]::keybd_event(0x26,0x48,1,[UIntPtr]::Zero)
  [SwiftWindow]::keybd_event(0x26,0x48,3,[UIntPtr]::Zero)
  [SwiftWindow]::SendText('x中')
  $script:nativeRuntimeInputSent=$true
  Start-Sleep -Milliseconds 300
 }

 $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
 foreach($name in @('切换到 Terminal','打开 Herdr 终端','Herdr 交互终端','终端按键')){
  $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name)
  if($root.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)){throw "Unexpected terminal control: $name"}
 }
}
function Invoke-Control($element) {
 $pattern=$null
 Write-Output ("Invoke control: " + $element.Current.Name)
 if($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke()}
 elseif($element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle()}
 elseif($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select()}
 elseif($element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){
  if($pattern.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded){$pattern.Collapse()}else{$pattern.Expand()}
 }
 else{throw ("Control has no action pattern: " + $element.Current.Name + "; patterns=" + (($element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName}) -join ','))}
}
function Set-Control($element,[string]$value,[switch]$Secret) {
 $pattern=$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
 $pattern.SetValue($value)
 # Password controls deliberately do not expose their value through UI
 # Automation. The fixture's successful authentication verifies this input.
 if($Secret -or $element.Current.IsPassword){return}
 # Read back the WebView value before invoking form submission.
 for($attempt=0;$attempt -lt 40;$attempt++) {
  if($pattern.Current.Value.Replace("`r`n","`n") -eq $value.Replace("`r`n","`n")){return}
  Start-Sleep -Milliseconds 50
 }
 throw 'The isolated form input did not retain the expected value.'
}
function Set-CodeEditor($element,[string]$value) {
 # CodeMirror uses contenteditable. Paste through the real guest keyboard and clipboard.
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
 $null=& powershell.exe -NoProfile -STA -Command "`$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encoded'));Set-Clipboard -Value `$expected;if((Get-Clipboard -Raw) -cne `$expected){exit 1}"
 if($LASTEXITCODE -ne 0){throw 'The guest clipboard did not retain the exact editor text.'}
 [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
 $element.SetFocus()
 Start-Sleep -Milliseconds 150
 if([SwiftWindow]::GetForegroundWindow() -ne $script:mainWindow -or -not $element.Current.HasKeyboardFocus){throw 'The isolated code editor does not own keyboard focus.'}
 [SwiftWindow]::Shortcut(0x41)
 Start-Sleep -Milliseconds 100
 $selection=$null
 if($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$selection)){
  Write-Output ('Code editor native selection length: '+(($selection.GetSelection() | ForEach-Object {$_.GetText(-1)}) -join '').Length)
 }
 [SwiftWindow]::Shortcut(0x56)
 $save=Find-Control '保存' 'Button'
 for($attempt=0;$attempt -lt 40;$attempt++){if($save.Current.IsEnabled){return};Start-Sleep -Milliseconds 100}
 throw 'The code editor did not accept the isolated multiline paste.'
}
function Start-Client {
 $executable=Join-Path $installDirectory 'swift-desktop.exe'
 $existing=Get-Process swift-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable } | Select-Object -First 1
 $script:process=if($existing){$existing}else{Start-Process -FilePath $executable -PassThru}
 for($attempt=0;$attempt -lt 80;$attempt++) { $script:process.Refresh(); $script:mainWindow=[SwiftWindow]::MainWindow($script:process.Id); if($script:process.HasExited) { throw 'Native client exited before displaying its window.' }; if($script:mainWindow -ne 0) { break }; Start-Sleep -Milliseconds 250 }
 if($script:mainWindow -eq 0) { throw 'Native application window is unavailable.' }
 [SwiftWindow]::ShowWindow($script:mainWindow,9) | Out-Null
 [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
}
function Capture-Window([string]$name) {
 Start-Sleep -Milliseconds 700
 $rect=[SwiftWindow+Rect]::new()
 [SwiftWindow]::GetClientRect($script:mainWindow,[ref]$rect) | Out-Null
 $bitmap=[Drawing.Bitmap]::new($rect.Right,$rect.Bottom);$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
 try {$captured=[SwiftWindow]::PrintWindow($script:mainWindow,$dc,3)} finally {$graphics.ReleaseHdc($dc)}
 try {if(-not $captured){throw 'The isolated native window could not be captured.'};$bitmap.Save((Join-Path $OutputDirectory $name),[Drawing.Imaging.ImageFormat]::Png)} finally {$graphics.Dispose();$bitmap.Dispose()}
}
function Read-HighlightColors($element,[string]$screenshot) {
 $origin=[SwiftWindow+Point]::new();[SwiftWindow]::ClientToScreen($script:mainWindow,[ref]$origin)|Out-Null
 $box=$element.Current.BoundingRectangle
 $bitmap=[Drawing.Bitmap]::new((Join-Path $OutputDirectory $screenshot))
 try {
  $left=[Math]::Max(0,[int][Math]::Floor($box.Left-$origin.X));$top=[Math]::Max(0,[int][Math]::Floor($box.Top-$origin.Y))
  $right=[Math]::Min($bitmap.Width,[int][Math]::Ceiling($box.Right-$origin.X));$bottom=[Math]::Min($bitmap.Height,[int][Math]::Ceiling($box.Bottom-$origin.Y))
  $purple=0;$green=0;$yellow=0
  for($y=$top;$y -lt $bottom;$y++){for($x=$left;$x -lt $right;$x++){
   $c=$bitmap.GetPixel($x,$y)
   if($c.R -gt $c.G+25 -and $c.B -gt $c.G+25){$purple++}
   if($c.G -gt $c.R+15 -and $c.G -gt $c.B+15){$green++}
   if($c.R -gt $c.B+50 -and $c.G -gt $c.B+30){$yellow++}
  }}
  return @{purple=$purple;green=$green;yellow=$yellow;pixels=[Math]::Max(0,($right-$left)*($bottom-$top))}
 }finally{$bitmap.Dispose()}
}
$chatColorProof=$null
try {
 if(Get-Process swift-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $installDirectory 'swift-desktop.exe') }) { throw 'An existing desktop client is running; native fixture will not modify it.' }
 $firstPort=if(Test-Path (Join-Path $dataDirectory 'development-port')){[int](Get-Content -LiteralPath (Join-Path $dataDirectory 'development-port') -Raw)}else{$null}
 $composerProof=$null
 if($Phase -in @('all','connect')){
 Start-Client
 $firstPort=[int](Get-Content -LiteralPath (Join-Path $dataDirectory 'development-port') -Raw)
 Invoke-Control (Find-Control '添加服务器' 'Button')
 Find-Control '添加并连接' | Out-Null
 Capture-Window 'native-connect.png'
 Set-Control (Find-Control '服务器连接链接' 'Edit') $(if($ServerToken){$FixtureUrl.TrimEnd('/')+'/?token='+[Uri]::EscapeDataString($ServerToken)}else{$FixtureUrl})
 Invoke-Control (Find-Control '添加并连接' 'Button')
 Assert-TerminalPage
 Capture-Window 'native-chat.png'
 Invoke-Control (Find-Control '切换到结构化模式' 'Button')
 $navigationMark=$null
 for($attempt=0;$attempt -lt 60;$attempt++) {
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $all=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
  foreach($item in $all){if($item.Current.Name -like '跳转到用户消息 *'){$navigationMark=$item;break}}
  if($navigationMark){break};Start-Sleep -Milliseconds 100
 }
 if(-not $navigationMark){throw 'User-message navigation is missing from the native WebView.'}
 $navigationMark.SetFocus()
 Invoke-Control $navigationMark
 Capture-Window 'native-message-navigation.png'
 $lastNavigationMark=$null
 $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
 $all=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
 foreach($item in $all){if($item.Current.Name -like '跳转到用户消息 *'){$lastNavigationMark=$item}}
 if(-not $lastNavigationMark){throw 'The latest user-message dot is missing from the native WebView.'}
 $lastNavigationMark.SetFocus()
 Invoke-Control $lastNavigationMark
 if($env:SWIFT_WINDOWS_CHAT_HIGHLIGHTING -eq '1') {
  $copyCode=Find-Control '复制代码' 'Button'
  [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
  $copyCode.SetFocus()
  [SwiftWindow]::keybd_event(0x20,0,0,[UIntPtr]::Zero)
  [SwiftWindow]::keybd_event(0x20,0,2,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  $copied=& powershell.exe -NoProfile -STA -Command 'Get-Clipboard -Raw'
  if(($copied -join "`n").Replace("`r`n","`n").TrimEnd() -ne "const answer = `"中文高亮`";`nconsole.log(answer, 42);"){throw 'Highlighted code changed in the Windows clipboard.'}
  Start-Sleep -Seconds 5
  Capture-Window 'native-chat-code-colors.png'
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $texts=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text))
  $syntaxColors=@{purple=0;green=0;yellow=0;pixels=0}
  foreach($item in $texts){if(-not $item.Current.IsOffscreen -and ($item.Current.Name -eq 'const' -or $item.Current.Name -like '*中文高亮*')){
   $colors=Read-HighlightColors $item 'native-chat-code-colors.png'
   foreach($name in @('purple','green','yellow','pixels')){$syntaxColors[$name]+=$colors[$name]}
  }}
  if($syntaxColors.yellow -lt 3 -or $syntaxColors.green -lt 3){throw 'Native code block has no amber keyword or green string colors.'}
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $buttons=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
  $colorCommand=$null
  foreach($item in $buttons){if($item.Current.Name -like '*Ran python3 verify.py*'){$colorCommand=$item;break}}
  if(-not $colorCommand){throw 'The highlighted output command is missing.'}
  Invoke-Control $colorCommand
  $colorCommand.SetFocus()
  Start-Sleep -Milliseconds 250
  [SwiftWindow]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[SwiftWindow]::keybd_event(0x23,0,0,[UIntPtr]::Zero)
  [SwiftWindow]::keybd_event(0x23,0,2,[UIntPtr]::Zero);[SwiftWindow]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
  Find-Control '执行结果' | Out-Null
  Capture-Window 'native-chat-colors.png'
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $texts=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text))
  $outputGreen=0;$outputYellow=0
  foreach($item in $texts){if($item.Current.Name -like '*PASS*' -or $item.Current.Name -like '*WARN*'){$colors=Read-HighlightColors $item 'native-chat-colors.png';$outputGreen+=$colors.green;$outputYellow+=$colors.yellow}}
  if($outputGreen -lt 3 -or $outputYellow -lt 3){throw 'Native terminal output lost its ANSI foreground colors.'}
  $chatColorProof=@{copiedSource=$true;syntax=$syntaxColors;output=@{green=$outputGreen;yellow=$outputYellow}}
  $chatColorProof|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-chat-color-result.json') -Encoding UTF8
 }
 $draftField=Find-Control '发送消息' 'Edit'
 Set-Control $draftField '断线自动恢复保留的草稿'
 $sendControl=Find-Control '发送消息' 'Button'
 for($attempt=0;$attempt -lt 60 -and -not $sendControl.Current.IsEnabled;$attempt++){Start-Sleep -Milliseconds 100}
 if(-not $sendControl.Current.IsEnabled){throw 'The native fixture send button was not ready before interruption.'}
 $testHttp=New-Object Net.WebClient;$testHttp.Proxy=$null
 $testHttp.UploadString($FixtureUrl.TrimEnd('/')+'/__fixture/disconnect','POST','')|Out-Null
 $wasOffline=$false
 for($attempt=0;$attempt -lt 60;$attempt++) {
  if(-not $sendControl.Current.IsEnabled){$wasOffline=$true;break};Start-Sleep -Milliseconds 50
 }
 if(-not $wasOffline){throw 'Expected the isolated native WebView to observe the connection interruption.'}
 $recovered=$false
 for($attempt=0;$attempt -lt 100;$attempt++) {
  $sendControl=Find-Control '发送消息' 'Button'
  if($sendControl.Current.IsEnabled){$recovered=$true;break};Start-Sleep -Milliseconds 100
 }
 if(-not $recovered){throw 'Native WebView did not reconnect automatically after normal upstream close.'}
 $draftField=Find-Control '发送消息' 'Edit'
 $restoredDraft=$draftField.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
 if($restoredDraft -ne '断线自动恢复保留的草稿'){throw 'Draft changed across native reconnection.'}
 Capture-Window 'native-reconnected.png'
 Set-Control $draftField ''
 Invoke-Control (Find-Control '切换到终端模式' 'Button')
 $composerProof=$null
 if($ComposerHeight) {
  Invoke-Control (Find-Control '切换到结构化模式' 'Button')
  $field=Find-Control '发送消息' 'Edit'
  Set-Control $field 'short'; Start-Sleep -Milliseconds 250
  $initialHeight=$field.Current.BoundingRectangle.Height
  if($initialHeight -le 0){throw 'Composer geometry is unavailable.'}
  Set-Control $field ((1..20 | ForEach-Object {"Line $_"}) -join "`n")
  for($attempt=0;$attempt -lt 60;$attempt++) {
   $expandedHeight=$field.Current.BoundingRectangle.Height
   if([Math]::Abs($expandedHeight-$initialHeight*3) -le 2){break}
   Start-Sleep -Milliseconds 100
  }
  if([Math]::Abs($expandedHeight-$initialHeight*3) -gt 2){throw 'Composer did not expand to its three-times cap.'}
  Capture-Window 'native-composer.png'
  Set-Control $field ''
  for($attempt=0;$attempt -lt 60;$attempt++) {
   $restoredHeight=$field.Current.BoundingRectangle.Height
   if([Math]::Abs($restoredHeight-$initialHeight) -le 2){break}
   Start-Sleep -Milliseconds 100
  }
  if([Math]::Abs($restoredHeight-$initialHeight) -gt 2){throw 'Composer did not shrink after clearing.'}
  $composerProof=[ordered]@{initialHeight=$initialHeight;expandedHeight=$expandedHeight;restoredHeight=$restoredHeight;maximumRatio=3}
  Assert-TerminalPage
 }
 if($HtmlPreview) {
  Invoke-Control (Find-Control '切换到结构化模式' 'Button')
  Invoke-Control (Find-Control '打开 HTML 报告' 'Hyperlink')
  Find-Control 'HTML 原生渲染通过' | Out-Null
  Invoke-Control (Find-Control '验证 HTML 交互' 'Button')
  Find-Control 'HTML 页面交互通过' | Out-Null
  Invoke-Control (Find-Control '源码' 'Button')
  Invoke-Control (Find-Control '预览' 'Button')
  Find-Control 'HTML 页面交互通过' | Out-Null
  Capture-Window 'native-html.png'
  Invoke-Control (Find-Control '返回文件列表' 'Button')
  Invoke-Control (Find-Control '收起会话文件' 'Button')
  Assert-TerminalPage
 }
 $filesProof=$null
 if($env:SWIFT_WINDOWS_FILES -eq '1') {
  Invoke-Control (Find-Control 'files' 'TabItem')
  Invoke-Control (Find-Control 'windows-file.md' 'TreeItem')
  Find-Control 'Windows 文件验收' | Out-Null
  $fileCopyCode=Find-Control '复制代码' 'Button'
  [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
  $fileCopyCode.SetFocus()
  Start-Sleep -Milliseconds 150
  if([SwiftWindow]::GetForegroundWindow() -ne $script:mainWindow -or -not $fileCopyCode.Current.HasKeyboardFocus){throw 'The isolated Markdown code copy button does not own keyboard focus.'}
  [SwiftWindow]::keybd_event(0x20,0,0,[UIntPtr]::Zero)
  [SwiftWindow]::keybd_event(0x20,0,2,[UIntPtr]::Zero)
  Find-Control '复制代码，已复制' 'Button' | Out-Null
  $copiedCode=& powershell.exe -NoProfile -STA -Command 'Get-Clipboard -Raw'
  if(($copiedCode -join "`n").Replace("`r`n","`n").TrimEnd() -ne "const answer = `"中文高亮`";`nconsole.log(answer, 42);"){throw 'Markdown code copy changed the Windows clipboard content.'}
  Find-Control 'Markdown 阅读宽度，左右键调整，Home 恢复默认' | Out-Null
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $outlineCondition=[Windows.Automation.AndCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'保存操作'),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
  $outlineEntry=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$outlineCondition)
  if(-not $outlineEntry -or $outlineEntry.Current.IsOffscreen){Invoke-Control (Find-Control '目录' 'Button')}
  Invoke-Control (Find-Control '保存操作' 'Button')
  Capture-Window 'native-files.png'
  # Exercise clipboard access with native keyboard activation, as for code copy above.
  $fileCopyAll=Find-Control '复制全文' 'Button'
  [SwiftWindow]::SetForegroundWindow($script:mainWindow) | Out-Null
  $fileCopyAll.SetFocus()
  Start-Sleep -Milliseconds 150
  if([SwiftWindow]::GetForegroundWindow() -ne $script:mainWindow -or -not $fileCopyAll.Current.HasKeyboardFocus){throw 'The isolated full-file copy button does not own keyboard focus.'}
  [SwiftWindow]::keybd_event(0x20,0,0,[UIntPtr]::Zero)
  [SwiftWindow]::keybd_event(0x20,0,2,[UIntPtr]::Zero)
  Find-Control '复制全文，已复制' 'Button' | Out-Null
  $copied=& powershell.exe -NoProfile -STA -Command 'Get-Clipboard -Raw'
  $originalFile="# Windows 文件验收`n`n读取与修改临时文件。`n`n"+'```javascript'+"`nconst answer = `"中文高亮`";`nconsole.log(answer, 42);`n"+'```'+"`n`n## 保存操作`n`n这里是第二节。`n"
  if(($copied -join "`n").Replace("`r`n","`n").TrimEnd() -ne $originalFile.TrimEnd()){throw 'Native full-file copy did not reach the guest clipboard intact.'}
  Invoke-Control (Find-Control '编辑' 'Button')
  $fileText="# Windows 文件验收`n`nWindows 文件编辑已保存。`n`n## 保存操作`n`n这里是第二节。`n"
  $codeField=Find-Control '编辑 windows-file.md' 'Edit'
  $codeRuntimeId=($codeField.GetRuntimeId() -join ',')
  Set-CodeEditor $codeField $fileText
  Capture-Window 'native-file-editor.png'
  Invoke-Control (Find-Control '保存' 'Button')
  Find-Control '文件已保存。' | Out-Null
  Find-Control 'Windows 文件编辑已保存。' | Out-Null
  $codeField=Find-Control '编辑 windows-file.md' 'Edit'
  if(($codeField.GetRuntimeId() -join ',') -ne $codeRuntimeId){throw 'Saving replaced the visible code editor.'}
  Set-CodeEditor $codeField ($fileText+'未保存内容')
  Invoke-Control (Find-Control '取消' 'Button')
  Find-Control '放弃未保存的修改？' | Out-Null
  Invoke-Control (Find-Control '放弃修改' 'Button')
  Invoke-Control (Find-Control '预览' 'Button')
  Find-Control 'Windows 文件编辑已保存。' | Out-Null
  Invoke-Control (Find-Control '返回会话' 'Button')
  Assert-TerminalPage
  $filesProof=[ordered]@{ok=$true;preview=$true;outline=$true;widthControl=$true;fullCopy=$true;inlineCodeEditor=$true;markdownSourceMode=$true;nativeMultilinePaste=$true;saved=$true;sameEditorAfterSave=$true;discardConfirmed=$true;fixtureOnly=$true}
 }
 $goalProof=$null
 if($GoalCommand) {
  Invoke-Control (Find-Control '切换到结构化模式' 'Button')
  Set-Control (Find-Control '发送消息' 'Edit') '/goal'
  Invoke-Control (Find-Control '确认原生命令' 'Button')
  Find-Control '已暂停' | Out-Null
  Find-Control 'Windows Goal：完成开发并核对真实状态。' | Out-Null
  Capture-Window 'native-goal.png'
  Invoke-Control (Find-Control '修改' 'Button')
  Set-Control (Find-Control 'Goal 目标' 'Edit') "Windows 多行修改`n关闭时不提交。"
  Find-Control '保存修改' 'Button' | Out-Null
  Capture-Window 'native-goal-edit.png'
  Invoke-Control (Find-Control '取消' 'Button')
  Set-Control (Find-Control '发送消息' 'Edit') 'Windows Goal 主会话草稿'
  Invoke-Control (Find-Control '查看完整 goal' 'Button')
  Find-Control 'Windows Goal：完成开发并核对真实状态。' | Out-Null
  Invoke-Control (Find-Control '关闭' 'Button')
  $value=(Find-Control '发送消息' 'Edit').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
  if($value -ne 'Windows Goal 主会话草稿'){throw 'Goal view changed the main draft.'}
  Set-Control (Find-Control '发送消息' 'Edit') ''
  $goalProof=[ordered]@{ok=$true;structuredStatus=$true;multilineEditor=$true;draftPreserved=$true;closeWritesNothing=$true}
  Assert-TerminalPage
 }
 $sideProof=$null
 if($SideSession) {
  Invoke-Control (Find-Control '切换到结构化模式' 'Button')
  Set-Control (Find-Control '发送消息' 'Edit') 'Windows 主会话草稿'
  Invoke-Control (Find-Control '打开临时会话' 'Button')
  Find-Control 'Windows 临时会话结构化回答' | Out-Null
  Set-Control (Find-Control '发送消息' 'Edit') 'Windows 临时草稿'
  Invoke-Control (Find-Control '主会话' 'Button')
  $value=(Find-Control '发送消息' 'Edit').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
  if($value -ne 'Windows 主会话草稿'){throw 'Main draft changed during side navigation.'}
  Invoke-Control (Find-Control '临时会话' 'Button')
  $value=(Find-Control '发送消息' 'Edit').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
  if($value -ne 'Windows 临时草稿'){throw 'Side draft changed during main navigation.'}
  Invoke-Control (Find-Control '切换到终端模式' 'Button')
  Invoke-Control (Find-Control '切换到结构化模式' 'Button')
  Find-Control 'Windows 临时会话结构化回答' | Out-Null
  Invoke-Control (Find-Control '将临时会话 Fork 为独立会话' 'Button')
  Set-Control (Find-Control '发送消息' 'Edit') "Windows 临时消息`n第二行"
  Invoke-Control (Find-Control '发送消息' 'Button')
  for($attempt=0;$attempt -lt 60;$attempt++) {
   $value=(Find-Control '发送消息' 'Edit').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
   if(-not $value){break};Start-Sleep -Milliseconds 100
  }
  if($value){throw 'Side message did not finish its unique submission.'}
  Capture-Window 'native-side-session.png'
  Invoke-Control (Find-Control '主会话' 'Button')
  Set-Control (Find-Control '发送消息' 'Edit') ''
  $sideProof=[ordered]@{ok=$true;chatAndTerminal=$true;independentDrafts=$true;fork=$true;multilineSend=$true}
  Assert-TerminalPage
 }
 # Leave a real WebView2 draft for the cold-start phase; never send it.
 Invoke-Control (Find-Control '切换到结构化模式' 'Button')
 Set-Control (Find-Control '发送消息' 'Edit') 'Windows 草稿冷启动保留'
 Capture-Window 'native-draft.png'
 Assert-TerminalPage
 # A second launch opens a window in the same process and gateway.
 $second=Start-Process -FilePath (Join-Path $installDirectory 'swift-desktop.exe') -PassThru
 if(-not $second.WaitForExit(10000)) { throw 'Second invocation did not hand over to the existing instance.' }
 $originalPid=$process.Id
 $firstWindow=$script:mainWindow
 for($attempt=0;$attempt -lt 80;$attempt++) {
  $windows=[SwiftWindow]::Windows($process.Id)
  if($windows.Count -eq 2){break}
  Start-Sleep -Milliseconds 250
 }
 if($windows.Count -ne 2){throw 'The second launch did not create a second native window.'}
 $script:mainWindow=@($windows | Where-Object {$_ -ne $firstWindow})[0]
 Invoke-Control (Find-Control '继续会话' 'Button')
 Assert-TerminalPage
 Capture-Window 'native-multi-window.png'
 # Closing the original main window must preserve the new window and gateway.
 [SwiftWindow]::SendMessage($firstWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 Start-Sleep -Milliseconds 400
 if($process.HasExited -or [SwiftWindow]::Windows($process.Id).Count -ne 1){throw 'Closing the original window stopped another window.'}
 Assert-TerminalPage
 $remainingWindow=$script:mainWindow
 Invoke-Control (Find-ServerSwitch)
 Invoke-Control (Find-Control '新建窗口' 'Button')
 for($attempt=0;$attempt -lt 80;$attempt++) {
  $windows=[SwiftWindow]::Windows($process.Id)
  if($windows.Count -eq 2){break}
  Start-Sleep -Milliseconds 250
 }
 if($windows.Count -ne 2){throw 'The new-window menu did not create a native window.'}
 $script:mainWindow=@($windows | Where-Object {$_ -ne $remainingWindow})[0]
 Find-Control '添加服务器' 'Button' | Out-Null
 [SwiftWindow]::SendMessage($script:mainWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 $script:mainWindow=$remainingWindow
 [SwiftWindow]::SendMessage($script:mainWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 if(-not $process.WaitForExit(10000)) { throw 'Native client did not exit cleanly.' }
 # Reproduce the previous client's cleared active connection. Returning from
 # the guide must use the saved connection without filling a token form.
 $connectionFile=Join-Path $dataDirectory 'connections.json'
 $saved=Get-Content -LiteralPath $connectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
 $saved.active=$null
 [IO.File]::WriteAllText($connectionFile,($saved|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
 if($Phase -eq 'connect'){
  $initial=[ordered]@{ok=$true;messageNavigation=$true;desktopReconnect=$true;phase='connect';singleInstance=$true;multipleWindows=$true;closeMainPreservesOther=$true;newWindowMenu=$true;terminalPreview=$true;firstPort=$firstPort;nativeProcess=$originalPid;nativeRuntimeRequested=($env:SWIFT_WINDOWS_NATIVE_RUNTIME -eq '1');nativeRuntimeInputSent=[bool]$script:nativeRuntimeInputSent}
  if($HtmlPreview){$initial.htmlPreview=$true;$initial.htmlInteraction=$true;$initial.htmlSourceToggle=$true}
  if($ComposerHeight){$initial.composerHeight=$composerProof}
  if($SideSession){$initial.sideSession=$sideProof}
  if($GoalCommand){$initial.goalCommand=$goalProof}
  if($filesProof){$initial.workspaceFiles=$filesProof}
  if($chatColorProof){$initial.chatHighlighting=$chatColorProof}
  $initial|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-connect-result.json') -Encoding UTF8
  return
 }
 }
 if($Phase -in @('all','guide')){
 Start-Client
 $saved=Get-Content -LiteralPath (Join-Path $dataDirectory 'connections.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 Invoke-Control (Find-Control ('连接到 '+$saved.profiles[0].name) 'Button')
 Assert-TerminalPage
 [SwiftWindow]::SendMessage($script:mainWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 if(-not $process.WaitForExit(10000)) { throw 'Native client did not exit after returning from the guide.' }
 if($Phase -eq 'guide'){
  @{ok=$true;phase='guide';returnWithoutToken=$true;terminalPreview=$true}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-guide-result.json') -Encoding UTF8
  return
 }
 }
 Start-Client
 if(-not $originalPid){$originalPid=$process.Id}
 Assert-TerminalPage
 Invoke-Control (Find-Control '切换到结构化模式' 'Button')
 $draftField=Find-Control '发送消息' 'Edit'
 $draftValue=$draftField.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value
 if($draftValue -ne 'Windows 草稿冷启动保留'){throw 'WebView2 did not restore the saved draft after cold start.'}
 Capture-Window 'native-draft-restored.png'
 Set-Control $draftField ''
 Assert-TerminalPage
 Invoke-Control (Find-Control '设置' 'Button')
 Find-Control '主题' 'Button' | Out-Null
 Capture-Window 'native-settings.png'
 Invoke-Control (Find-Control '界面字号' 'Button')
 Find-Control '界面字号预览' | Out-Null
 Find-Control '字体大小' 'Slider' | Out-Null
 Capture-Window 'native-settings-font.png'
 Invoke-Control (Find-Control '返回设置' 'Button')
 Invoke-Control (Find-Control '终端字号' 'Button')
 Find-Control '终端字号预览' | Out-Null
 Find-Control '终端字体大小' 'Slider' | Out-Null
 Capture-Window 'native-settings-terminal.png'
 Invoke-Control (Find-Control '返回设置' 'Button')
 Invoke-Control (Find-Control '客户端更新' 'Button')
 Find-Control ('当前客户端版本：'+(Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion) | Out-Null
 Find-Control '检查更新' 'Button' | Out-Null
 Capture-Window 'native-client-updates.png'
 Invoke-Control (Find-Control '返回设置' 'Button')
 Invoke-Control (Find-Control '服务器' 'Button')
 Find-Control '已保存的服务器' | Out-Null
 $savedServer=Get-Content -LiteralPath (Join-Path $dataDirectory 'connections.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 Invoke-Control (Find-Control ('管理服务器：'+$savedServer.profiles[0].name) 'Button')
 Invoke-Control (Find-Control '编辑服务器' 'MenuItem')
 Find-Control '根目录' 'Edit' | Out-Null
 Invoke-Control (Find-ExecutionControl '检查更新' 'Button')
 Find-ExecutionControl '当前服务器已是最新版本。' 'Text' | Out-Null
 Capture-Window 'native-server-updates.png'
 Capture-Window 'native-edit-server.png'
 Set-Control (Find-ExecutionControl '服务器名称（可选）' 'Edit') '原生编辑服务器'
 Invoke-Control (Find-ExecutionControl '保存' 'Button')
 Find-Control '管理服务器：原生编辑服务器' 'Button' | Out-Null
 Capture-Window 'native-restored.png'
 Invoke-Control (Find-ExecutionControl '添加服务器' 'Button')
 Find-Control '服务器名称（可选）' 'Edit' | Out-Null
 Capture-Window 'native-add-server.png'
 Invoke-Control (Find-Control '取消' 'Button')
 Find-Control '已保存的服务器' | Out-Null
 if([int](Get-Content -LiteralPath (Join-Path $dataDirectory 'development-port') -Raw) -ne $firstPort){throw 'Cold start changed the WebView storage origin.'}
 $metadata=Get-Content -LiteralPath (Join-Path $dataDirectory 'connections.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 $expectedMode='direct'
 if($ServerToken -and ((Get-Content -LiteralPath (Join-Path $dataDirectory 'connections.json') -Raw).Contains($ServerToken) -or $metadata.profiles[0].address.Contains('token='))){throw 'Token leaked into connection metadata.'}
 if($metadata.profiles.Count -ne 1 -or $metadata.profiles[0].mode -ne $expectedMode) { throw 'Saved connection is inconsistent.' }
 Invoke-Control (Find-Control '返回设置' 'Button')
 Invoke-Control (Find-Control '返回会话' 'Button')
 Invoke-Control (Find-ServerSwitch)
 $connectionDetail=$metadata.profiles[0].address
 Find-Control ($metadata.profiles[0].name + ' ' + $connectionDetail + ' 当前') 'Button' | Out-Null
 Capture-Window 'native-server-switch.png'
 $proof=[ordered]@{ok=$true;serverSwitcher=$true;returnWithoutToken=$true;directConnection=[bool]$Direct;tencentManagementEntry=$false;installed=$false;isolatedExecutable=$true;nativeWebView=$true;connectionsInSettings=$true;singleInstance=$true;coldStart=$true;stableOrigin=$true;tokenRequired=[bool]$ServerToken;tokenColdRestore=[bool]$ServerToken;credentialsOutsideMetadata=$true;isolatedData=$true;fixtureOnly=$true;terminalPreview=$true;nativePaneTerminal=$true;executableBytes=(Get-Item $Executable).Length;nativeProcess=$originalPid}
 $proof.draftColdStart=$true
 $proof.updateSettings=@{clientGlobal=$true;serverSpecific=$true;serverCheck=$true}
 if($HtmlPreview -and $Phase -eq 'all'){$proof.htmlPreview=$true;$proof.htmlInteraction=$true;$proof.htmlSourceToggle=$true}
 if($ComposerHeight -and $Phase -eq 'all'){$proof.composerHeight=$composerProof}
 $proof | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-result.json') -Encoding UTF8
 $proof | ConvertTo-Json -Compress
} catch {
 # Only the isolated fixture window is inspected; never another application.
 try {
  $root=[Windows.Automation.AutomationElement]::FromHandle($script:mainWindow)
  $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
   [ordered]@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;offscreen=$_.Current.IsOffscreen}
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-failure-controls.json') -Encoding UTF8
 } catch { Write-Output 'Could not capture the isolated window controls.' }
 Write-Output $_.ScriptStackTrace
 throw
} finally {
 if($process -and -not $process.HasExited) {[SwiftWindow]::SendMessage($script:mainWindow,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null;if(-not $process.WaitForExit(10000)){Stop-Process -Id $process.Id}}
 Remove-Item Env:SWIFT_DESKTOP_DATA_DIR -ErrorAction SilentlyContinue
 Remove-Item Env:SWIFT_DESKTOP_FIXTURE_MANAGEMENT -ErrorAction SilentlyContinue
}

[CmdletBinding()]
param([string]$Executable,[string]$FixtureUrl,[string]$OutputDirectory,[string]$ManagementUrl,[string]$ServerToken,[string]$Phase,[string]$DataDirectory,[switch]$Direct)
$ErrorActionPreference='Stop'
trap { @{ok=$false;error=$_.Exception.ToString()}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'native-startup.json'); exit 1 }
if($env:SWIFT_WINDOWS_TEST_TARGET -ne 'wecom-desktop'){throw 'Startup measurements require the attendance VM.'}
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;
public static class SwiftStartup {
 delegate bool Callback(IntPtr handle,IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,System.Text.StringBuilder text,int size);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr handle,out Rect rect);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out Rect rect);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle,IntPtr dc,uint flags);
 [DllImport("user32.dll")] static extern IntPtr PostMessage(IntPtr handle,uint message,IntPtr wparam,IntPtr lparam);
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 public class Frame { public long at; public double white; public int colors; public int width,height,x,y; }
 public class Sample { public long visibleMs=-1,pageTitleMs=-1,contentMs=-1; public bool exited,geometryStable,closedCleanly; public List<Frame> frames=new List<Frame>(); }
 static IntPtr Window(int pid) {
  IntPtr result=IntPtr.Zero;
  EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var title=new System.Text.StringBuilder(256);GetWindowText(h,title,256);if(owner==pid && IsWindowVisible(h) && title.ToString().StartsWith("Swift")){result=h;return false;}return true;},IntPtr.Zero);
  return result;
 }
 public static bool CloseDuringStartup(string executable) {
  var process=Process.Start(executable);var watch=Stopwatch.StartNew();
  try {
   while(!process.HasExited && watch.ElapsedMilliseconds<10000){var window=Window(process.Id);if(window!=IntPtr.Zero){PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero);return process.WaitForExit(10000);}Thread.Sleep(5);}
   return false;
  } finally {if(!process.HasExited){try{process.Kill();}catch(System.ComponentModel.Win32Exception){if(!process.WaitForExit(5000))throw;}}process.Dispose();}
 }
 public static Sample Measure(string executable,string filmstrip) {
  var result=new Sample();var watch=Stopwatch.StartNew();var process=Process.Start(executable);IntPtr window=IntPtr.Zero;
  var images=new List<Bitmap>();long nextImage=0;
  try {
   while(watch.ElapsedMilliseconds<20000) {
    if(process.HasExited){result.exited=true;break;}
    if(window==IntPtr.Zero)window=Window(process.Id);
    if(window==IntPtr.Zero){Thread.Sleep(5);continue;}
    if(result.visibleMs<0)result.visibleMs=watch.ElapsedMilliseconds;
    var title=new System.Text.StringBuilder(256);GetWindowText(window,title,256);
    if(result.pageTitleMs<0 && title.ToString()!="Swift")result.pageTitleMs=watch.ElapsedMilliseconds;
    // Continuous PrintWindow is deliberately limited to one visual sample.
    // Timing samples wait for the real document title before the first capture.
    if(String.IsNullOrEmpty(filmstrip) && result.pageTitleMs<0){Thread.Sleep(5);continue;}
    Rect rect,bounds;GetClientRect(window,out rect);GetWindowRect(window,out bounds);
    int width=rect.Right,height=rect.Bottom;if(width<64 || height<64){Thread.Sleep(5);continue;}
    using(var bitmap=new Bitmap(width,height)) {
     using(var graphics=Graphics.FromImage(bitmap)){var dc=graphics.GetHdc();try{PrintWindow(window,dc,3);}finally{graphics.ReleaseHdc(dc);}}
     var colors=new HashSet<int>();int white=0,total=0;
     for(int y=16;y<height-16;y+=16)for(int x=16;x<width-16;x+=16){var color=bitmap.GetPixel(x,y);colors.Add(color.ToArgb());if(color.R>250 && color.G>250 && color.B>250)white++;total++;}
     long at=watch.ElapsedMilliseconds;
     result.frames.Add(new Frame{at=at,white=(double)white/total,colors=colors.Count,width=width,height=height,x=bounds.Left,y=bounds.Top});
     if(result.contentMs<0 && colors.Count>8)result.contentMs=at;
     if(!String.IsNullOrEmpty(filmstrip) && at-result.visibleMs>=nextImage && images.Count<12){images.Add(new Bitmap(bitmap,new Size(320,215)));nextImage+=200;}
    }
    if(String.IsNullOrEmpty(filmstrip) && result.contentMs>=0)break;
    if(result.contentMs>=0 && watch.ElapsedMilliseconds-result.contentMs>600 && watch.ElapsedMilliseconds-result.visibleMs>1500)break;
    if(watch.ElapsedMilliseconds-result.visibleMs>10000)break;
    Thread.Sleep(16);
   }
   result.geometryStable=result.frames.Count>0 && result.frames.TrueForAll(f=>f.width==result.frames[0].width && f.height==result.frames[0].height && f.x==result.frames[0].x && f.y==result.frames[0].y);
   if(images.Count>0)using(var strip=new Bitmap(320*4,215*3)){using(var g=Graphics.FromImage(strip)){g.Clear(Color.FromArgb(23,23,26));for(int i=0;i<images.Count;i++)g.DrawImageUnscaled(images[i],(i%4)*320,(i/4)*215);}strip.Save(filmstrip,ImageFormat.Png);}
  } finally {
   foreach(var image in images)image.Dispose();
   if(!process.HasExited && window!=IntPtr.Zero){PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero);result.closedCleanly=process.WaitForExit(10000);if(!result.closedCleanly){try{process.Kill();}catch(System.ComponentModel.Win32Exception){if(!process.WaitForExit(5000))throw;}}}
   process.Dispose();
  }
  return result;
 }
}
'@
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
function Percentile($values,[double]$fraction){$sorted=@($values|Sort-Object);return $sorted[[Math]::Max(0,[Math]::Ceiling($sorted.Count*$fraction)-1)]}
$scenarios=@()
foreach($kind in @('empty','saved','many')) {
 $directory=Join-Path $OutputDirectory ('startup-'+$kind)
 New-Item -ItemType Directory -Force $directory | Out-Null
 $env:SWIFT_DESKTOP_DATA_DIR=$directory
 if($kind -ne 'empty') {
  $profiles=@();$count=if($kind -eq 'many'){25}else{1}
  for($i=0;$i -lt $count;$i++){$profiles+=@{id=('{0:x64}' -f ($i+1));name=('启动验证 '+$i);mode='direct';address=($FixtureUrl+'/');remote_base=''}}
  @{profiles=$profiles;active=$profiles[0].id}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $directory 'connections.json')
  # Store uses UTF-8 without BOM, matching the application's persisted format.
  $file=Join-Path $directory 'connections.json';[IO.File]::WriteAllText($file,(Get-Content $file -Raw),[Text.UTF8Encoding]::new($false))
 }
 $samples=@()
 $sampleCount=if($env:SWIFT_WINDOWS_STARTUP_SAMPLES){[int]$env:SWIFT_WINDOWS_STARTUP_SAMPLES}else{5}
 for($i=0;$i -lt $sampleCount;$i++) {
  $filmstrip=if($i -eq 0){Join-Path $OutputDirectory ('native-startup-'+$kind+'.png')}else{$null}
  $sample=[SwiftStartup]::Measure($Executable,$filmstrip)
  $samples+=$sample
  if($env:SWIFT_WINDOWS_STARTUP_PROGRESS){
   $progress=[Net.WebClient]::new();$progress.Proxy=$null
   try{$progress.UploadString($env:SWIFT_WINDOWS_STARTUP_PROGRESS,(@{inProgress=$true;scenario=$kind;samples=$samples}|ConvertTo-Json -Depth 8))|Out-Null}finally{$progress.Dispose()}
  }
  Start-Sleep -Milliseconds 300
 }
 $timed=if($samples.Count -gt 1){@($samples|Select-Object -Skip 1)}else{$samples}
 $whiteFrames=@($samples|ForEach-Object {$_.frames}|Where-Object {$_.white -gt .85}).Count
 $scenarios+=@{name=$kind;samples=$samples;timingSamples=$timed.Count;firstRunVisibleMs=$samples[0].visibleMs;firstRunContentMs=$samples[0].contentMs;visibleP50Ms=(Percentile @($timed.visibleMs) .5);visibleP95Ms=(Percentile @($timed.visibleMs) .95);contentP50Ms=(Percentile @($timed.contentMs) .5);contentP95Ms=(Percentile @($timed.contentMs) .95);whiteFrames=$whiteFrames;geometryStable=(@($samples|Where-Object {-not $_.geometryStable}).Count -eq 0)}
}
$closedDuringStartup=[SwiftStartup]::CloseDuringStartup($Executable)
$ok=$closedDuringStartup -and @($scenarios|ForEach-Object {$_.samples}|Where-Object {$_.contentMs -lt 0 -or $_.exited -or -not $_.closedCleanly}).Count -eq 0
@{ok=$ok;closedDuringStartup=$closedDuringStartup;target='wecom-desktop';frameCapture='PrintWindow of the isolated Swift client area; no screen capture';scenarios=$scenarios}|ConvertTo-Json -Depth 8|Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'native-startup.json')
# Keep the complete receipt even when startup or early-close acceptance fails.
# The Node runner reports failure after preserving all samples.

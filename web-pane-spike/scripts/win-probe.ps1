# Windows measurements for the web pane spike, from an ordinary (not elevated) shell.
#   win-probe.ps1 shot <window-title-part> <out.png>   PrintWindow with PW_RENDERFULLCONTENT: the window as DWM composes it,
#                                                       child windows from other processes included, even when covered
#   win-probe.ps1 tree <root-pid> [seconds]            the process tree under a pid: count, private working set, commit,
#                                                       CPU over [seconds], and which GPU driver each process loaded
#   win-probe.ps1 left <dist-folder>                   processes still running from the dist folder
#   win-probe.ps1 post <window-title-part> "<steps>"   posts input messages to the window (or its deepest child with
#                                                       -Child), without taking the foreground from whoever has it.
#                                                       Steps: "move x y; down; up; type text; key vk; wait ms", client pixels
param([string]$Cmd, [string]$A, [string]$B)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class WP {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr r);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static IntPtr Deepest(IntPtr parent, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == cls) found = h; return true; }, IntPtr.Zero);
    return found;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { var s = new StringBuilder(256); GetWindowText(h, s, 256);
      if (IsWindowVisible(h) && s.ToString().Contains(part)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Children(IntPtr parent) {
    var sb = new StringBuilder();
    EnumChildWindows(parent, (h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256); uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r); sb.AppendFormat("{0:X} {1} pid={2} {3}x{4}\n", h.ToInt64(), c, pid, r.R - r.L, r.B - r.T); return true; }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
switch ($Cmd) {
  "shot" {
    Add-Type -AssemblyName System.Drawing
    [void][WP]::SetProcessDpiAwarenessContext([IntPtr]-4)  # per-monitor v2: whole window, in physical pixels
    $h = [WP]::Find($A); if ($h -eq [IntPtr]::Zero) { throw "no window titled *$A*" }
    $top = $h
    # WP_SHOT_CHILD=<class>: capture that child window alone (CEF's child is drawn by its own process).
    if ($env:WP_SHOT_CHILD) { $c = [WP]::Deepest($h, $env:WP_SHOT_CHILD); if ($c -ne [IntPtr]::Zero) { $h = $c } }
    $r = New-Object WP+RECT; [void][WP]::GetWindowRect($h, [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    if ($env:WP_SHOT_SCREEN) { $g.ReleaseHdc($dc); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $ok = "screen" }  # what is on the glass, if the window is on top
    else { $ok = [WP]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc) }
    $g.Dispose()
    $bmp.Save($B, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    "shot ok=$ok $($r.R - $r.L)x$($r.B - $r.T) -> $B"
    [WP]::Children($top)
  }
  "tree" {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $ids = New-Object System.Collections.Generic.List[int]; $todo = @([int]$A)
    while ($todo.Count) { $p = $todo[0]; $todo = @($todo | Select-Object -Skip 1); $ids.Add($p); $todo += @($all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { [int]$_.ProcessId }) }
    $seconds = if ($B) { [double]$B } else { 0 }
    $cpu0 = @{}; foreach ($i in $ids) { try { $cpu0[$i] = (Get-Process -Id $i).TotalProcessorTime.TotalMilliseconds } catch {} }
    if ($seconds -gt 0) { Start-Sleep -Milliseconds ($seconds * 1000) }
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess }
    $rows = foreach ($i in $ids) {
      try { $gp = Get-Process -Id $i } catch { continue }
      $type = ($all | Where-Object { $_.ProcessId -eq $i }).CommandLine -replace '.*--type=([\w-]+).*', '$1'
      if ($type -match '\s') { $type = "browser" }
      $gpu = try { @($gp.Modules | Where-Object { $_.ModuleName -match '^(nvwgf2umx|nvldumdx|nvd3dumx|igd10iumd64|igd12umd64|igdumdim64)\.dll$' } | ForEach-Object { $_.ModuleName }) -join "," } catch { "unreadable: $($_.Exception.Message)" }
      [pscustomobject]@{ pid = $i; type = $type; private_ws_mb = [math]::Round((($perf | Where-Object { [int]$_.IDProcess -eq $i }).WorkingSetPrivate) / 1MB, 1);
        ws_mb = [math]::Round($gp.WorkingSet64 / 1MB, 1); commit_mb = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1);
        cpu_ms = if ($seconds -gt 0) { [math]::Round($gp.TotalProcessorTime.TotalMilliseconds - $cpu0[$i]) } else { $null }; gpu_driver = $gpu }
    }
    [pscustomobject]@{ processes = @($rows).Count; private_ws_mb = [math]::Round(($rows | Measure-Object private_ws_mb -Sum).Sum, 1);
      commit_mb = [math]::Round(($rows | Measure-Object commit_mb -Sum).Sum, 1); cpu_percent_of_one_core = if ($seconds -gt 0) { [math]::Round(($rows | Measure-Object cpu_ms -Sum).Sum / ($seconds * 10), 1) } else { $null };
      rows = $rows } | ConvertTo-Json -Depth 4
  }
  "post" {
    $h = [WP]::Find($A); if ($h -eq [IntPtr]::Zero) { throw "no window titled *$A*" }
    if ($env:WP_POST_CLASS) { $c = [WP]::Deepest($h, $env:WP_POST_CLASS); if ($c -ne [IntPtr]::Zero) { $h = $c } else { throw "no child $($env:WP_POST_CLASS)" } }
    $x = 0; $y = 0; $lp = { [IntPtr](($y -shl 16) -bor ($x -band 0xffff)) }
    foreach ($step in ($B -split ';')) {
      $w = $step.Trim() -split ' ', 2
      switch ($w[0]) {
        "move" { $x, $y = $w[1] -split ' ' | ForEach-Object { [int]$_ }; [void][WP]::PostMessage($h, 0x200, [IntPtr]0, (& $lp)) }
        "down" { [void][WP]::PostMessage($h, 0x201, [IntPtr]1, (& $lp)) }
        "up" { [void][WP]::PostMessage($h, 0x202, [IntPtr]0, (& $lp)) }
        "key" { $vk = [int]$w[1]; [void][WP]::PostMessage($h, 0x100, [IntPtr]$vk, [IntPtr]1); Start-Sleep -Milliseconds 30; [void][WP]::PostMessage($h, 0x101, [IntPtr]$vk, [IntPtr]0xC0000001) }
        "type" { foreach ($ch in $w[1].ToCharArray()) { $vk = [int][char]::ToUpper($ch); if ($ch -eq ' ') { $vk = 0x20 }
            [void][WP]::PostMessage($h, 0x100, [IntPtr]$vk, [IntPtr]1); [void][WP]::PostMessage($h, 0x102, [IntPtr][int]$ch, [IntPtr]1)
            Start-Sleep -Milliseconds 30; [void][WP]::PostMessage($h, 0x101, [IntPtr]$vk, [IntPtr]0xC0000001); Start-Sleep -Milliseconds 30 } }
        "wait" { Start-Sleep -Milliseconds ([int]$w[1]) }
      }
      Start-Sleep -Milliseconds 60
    }
    "posted to {0:X}" -f $h.ToInt64()
  }
  "respond" {
    # Polls the window's own thread every 100 ms for $B ms: how long a WM_NULL takes to be answered, and whether
    # Windows calls the window hung. Prints one line per poll slower than 50 ms, then a summary.
    $h = [WP]::Find($A); if ($h -eq [IntPtr]::Zero) { throw "no window titled *$A*" }
    $t0 = [Diagnostics.Stopwatch]::StartNew(); $worst = 0; $hung = 0; $n = 0
    while ($t0.ElapsedMilliseconds -lt [int]$B) {
      $sw = [Diagnostics.Stopwatch]::StartNew(); $res = [IntPtr]::Zero
      [void][WP]::SendMessageTimeout($h, 0, [IntPtr]0, [IntPtr]0, 2, 5000, [ref]$res); $ms = $sw.ElapsedMilliseconds
      if ([WP]::IsHungAppWindow($h)) { $hung++ }
      if ($ms -gt 50) { "{0,6} ms after start: WM_NULL answered in {1} ms" -f $t0.ElapsedMilliseconds, $ms }
      if ($ms -gt $worst) { $worst = $ms }; $n++
      Start-Sleep -Milliseconds 100
    }
    "polls=$n worst_ms=$worst hung_polls=$hung"
  }
  "uia" {
    # What a screen reader can reach: the window's UI Automation tree (control view), as Narrator walks it.
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $h = [WP]::Find($A); if ($h -eq [IntPtr]::Zero) { throw "no window titled *$A*" }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $rows = New-Object System.Collections.Generic.List[string]
    $walk = $null
    $walk = { param($e, $d) if ($rows.Count -ge 400) { return }
      $c = $e.Current; $rows.Add(("{0}{1} '{2}' [{3}]" -f ("  " * $d), $c.ControlType.ProgrammaticName.Replace("ControlType.", ""), $c.Name, $c.ClassName))
      $k = $walker.GetFirstChild($e); while ($k -ne $null) { & $walk $k ($d + 1); $k = $walker.GetNextSibling($k) } }
    & $walk $root 0
    # Chromium turns its tree on when a UI Automation client first asks; ask twice.
    if ($B -eq "twice") { Start-Sleep 2; $rows.Clear(); & $walk $root 0 }
    $rows
    "elements=$($rows.Count) has_press_me=$([bool]($rows | Where-Object { $_ -match "Press me" }))"
  }
  "left" {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($A.TrimEnd("\") + "\", "OrdinalIgnoreCase") } | Select-Object ProcessId, Name) | ConvertTo-Json
  }
}

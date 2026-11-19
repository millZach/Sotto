# Windows: CEF's own child window, created by the helper process as a child of the window process's HWND.
# Captures the parent and the child, posts a click and typing into the child, and (with -Hang) blocks the helper's
# UI thread for 6 s after a click has given the child focus, while polling the window process and clicking its
# native sidebar, to see whether a stuck helper stalls Sotto's own window.
# Usage: powershell -File childx.ps1 <run-name> [-Hang] [NAME=value ...]
param([string]$Name, [switch]$Hang, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Vars)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = if ($env:DIST) { $env:DIST } else { "D:\sotto-webpane-work\dist" }
$run = Join-Path "D:\sotto-webpane-work\runs" $Name
if (Test-Path $run) { Remove-Item -Recurse -Force $run }
New-Item -ItemType Directory -Force $run | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $dist "webpane.exe"; $psi.WorkingDirectory = $dist; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
foreach ($kv in @{ WP_MODE = "embed"; WP_REMOTE = "child"; WP_REMOTE_HOLD_S = "22"; WP_EMBED_SECONDS = "30"; WP_MENU = "1"; WP_RUN_DIR = $run; WP_NO_SANDBOX = "1" }.GetEnumerator()) { $psi.EnvironmentVariables[$kv.Key] = $kv.Value }
if ($Hang) { $psi.EnvironmentVariables["WP_HANG_MS"] = "6000" }
foreach ($v in $Vars) { $k, $val = $v -split "=", 2; $psi.EnvironmentVariables[$k] = $val }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
$probe = Join-Path $here "win-probe.ps1"
Start-Sleep 3
# Focus the page: a click in its field, as logical pixels inside the child.
$env:WP_POST_CLASS = "Chrome_RenderWidgetHostHWND"
& powershell -NoProfile -File $probe post "web pane spike" "move 80 20; down; up; wait 200" | Out-File "$run\post.txt"
$env:WP_POST_CLASS = $null
if ($Hang) {
  # The helper blocks its UI thread 3 s after load (about now) for 6 s. Meanwhile click Sotto's own sidebar and poll.
  $job = Start-Job { param($probe) & powershell -NoProfile -File $probe respond "web pane spike" 9000 } -ArgumentList $probe
  Start-Sleep -Milliseconds 1500
  & powershell -NoProfile -File $probe post "web pane spike" "move 120 300; down; up" | Out-Null
  Wait-Job $job | Out-Null; Receive-Job $job | Out-File "$run\respond.txt"; Remove-Job $job
} else {
  $env:WP_POST_CLASS = "Chrome_RenderWidgetHostHWND"
  & powershell -NoProfile -File $probe post "web pane spike" "type across processes" | Out-File -Append "$run\post.txt"
  $env:WP_POST_CLASS = $null
  Start-Sleep 1
  & powershell -NoProfile -File $probe shot "web pane spike" "$run\parent.png" | Out-File "$run\windows.txt"
  $env:WP_SHOT_CHILD = "CefBrowserWindow"; & powershell -NoProfile -File $probe shot "web pane spike" "$run\child.png" | Out-Null; $env:WP_SHOT_CHILD = $null
  & powershell -NoProfile -File $probe respond "web pane spike" 3000 | Out-File "$run\respond.txt"
}
if (-not $p.WaitForExit(60000)) { & taskkill /T /F /PID $p.Id | Out-Null; "timed out" }
[IO.File]::WriteAllText("$run\stdout.log", $out.Result); [IO.File]::WriteAllText("$run\stderr.log", $err.Result)
Start-Sleep -Milliseconds 800
"exit $($p.ExitCode) -> $run; left: $(& powershell -NoProfile -File $probe left $dist)"

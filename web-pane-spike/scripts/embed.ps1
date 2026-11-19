# Windows embed run: opens the window for a fixed time, captures it, posts a click and typing into the page's field,
# a wheel-free click on the native sidebar, then measures the tree's CPU and memory over 10 s of an animating page.
# Usage: powershell -File embed.ps1 <run-name> [-Seconds 26] [-NoInput] [NAME=value ...]   (WP_PATH, WP_VIEW, WP_SCALE, ...)
param([string]$Name, [int]$Seconds = 26, [switch]$NoInput, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Vars)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = if ($env:DIST) { $env:DIST } else { "D:\sotto-webpane-work\dist" }
$run = Join-Path $(if ($env:RUNS) { $env:RUNS } else { "D:\sotto-webpane-work\runs" }) $Name
if (Test-Path $run) { Remove-Item -Recurse -Force $run }
New-Item -ItemType Directory -Force $run | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $dist "webpane.exe"; $psi.WorkingDirectory = $dist; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.EnvironmentVariables["WP_MODE"] = if ($env:WP_MODE_OVERRIDE) { $env:WP_MODE_OVERRIDE } else { "embed" }
$psi.EnvironmentVariables["WP_RUN_DIR"] = $run; $psi.EnvironmentVariables["WP_EMBED_SECONDS"] = "$Seconds"
$psi.EnvironmentVariables["WP_NO_SANDBOX"] = "1"
foreach ($v in $Vars) { $k, $val = $v -split "=", 2; $psi.EnvironmentVariables[$k] = $val }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
$probe = Join-Path $here "win-probe.ps1"
Start-Sleep 6
& powershell -NoProfile -File $probe shot "web pane spike" "$run\1-loaded.png" | Out-File "$run\windows.txt"
if (-not $NoInput) {
  # Page rect starts at logical (240,56); the field is at page (20..320, 8..34). Client pixels are logical x scale.
  $s = [double]$(if ($env:WP_WINDOW_SCALE) { $env:WP_WINDOW_SCALE } else { 1 })
  $fx = [int]((240 + 80) * $s); $fy = [int]((56 + 20) * $s); $sx = [int](120 * $s); $sy = [int](300 * $s)
  & powershell -NoProfile -File $probe post "web pane spike" "move $sx $sy; wait 200; move $fx $fy; wait 200; down; up; wait 400; type hello pane; wait 300" | Out-Null
  Start-Sleep -Milliseconds 600
  & powershell -NoProfile -File $probe shot "web pane spike" "$run\2-typed.png" | Out-Null
  & powershell -NoProfile -File $probe post "web pane spike" "move $sx $sy; wait 100; down; up; wait 300; type zz" | Out-Null
  Start-Sleep -Milliseconds 600
  & powershell -NoProfile -File $probe shot "web pane spike" "$run\3-native-focus.png" | Out-Null
}
& powershell -NoProfile -File $probe tree $p.Id 10 2>"$run\tree.err" | Out-File -Encoding utf8 "$run\tree.json"
if (-not $p.WaitForExit(($Seconds + 30) * 1000)) { & taskkill /T /F /PID $p.Id | Out-Null; "timed out" }
$p.WaitForExit()
[IO.File]::WriteAllText("$run\stdout.log", $out.Result); [IO.File]::WriteAllText("$run\stderr.log", $err.Result)
Start-Sleep -Milliseconds 800
"exit $($p.ExitCode) -> $run; left: $(& powershell -NoProfile -File $probe left $dist)"

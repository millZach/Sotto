# Question 6 on Windows: start the component when a pane shows, stop it when the last closes. Copies the dist folder
# to a new folder first, so the first start meets files Defender has never scanned (an install's first run), then
# starts the pane process -Runs times from it. Without elevation the file cache cannot be emptied, so "cold" here
# means "new files", not "files not in memory".
# Usage: powershell -File lifecycle.ps1 <run-name> [-Runs 4]
param([string]$Name, [int]$Runs = 4)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = "D:\sotto-webpane-work\dist"
$run = "D:\sotto-webpane-work\runs\$Name"; $dist = "D:\sotto-webpane-work\dist-$Name"
foreach ($d in $run, $dist) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
New-Item -ItemType Directory -Force $run | Out-Null
Copy-Item -Recurse $src $dist
$probe = Join-Path $here "win-probe.ps1"
$rows = @()
for ($i = 0; $i -lt $Runs; $i++) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$dist\webpane.exe"; $psi.WorkingDirectory = $dist; $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables["WP_MODE"] = "pane"; $psi.EnvironmentVariables["WP_RUN_DIR"] = "$run\$i"; $psi.EnvironmentVariables["WP_NO_SANDBOX"] = "1"
  $psi.EnvironmentVariables["WP_URL"] = "http://127.0.0.1:8765/anim.html"
  New-Item -ItemType Directory -Force "$run\$i" | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $err = $p.StandardError.ReadToEndAsync()
  $line = $p.StandardOutput.ReadLine(); $first = $sw.ElapsedMilliseconds
  Start-Sleep 3
  $showing = & powershell -NoProfile -File $probe tree $p.Id | ConvertFrom-Json
  $p.StandardInput.WriteLine("close"); $closedLine = $p.StandardOutput.ReadLine()
  Start-Sleep 2
  $closed = & powershell -NoProfile -File $probe tree $p.Id | ConvertFrom-Json
  $sw2 = [Diagnostics.Stopwatch]::StartNew(); $p.StandardInput.WriteLine("quit")
  if (-not $p.WaitForExit(30000)) { & taskkill /T /F /PID $p.Id | Out-Null }
  $stop = $sw2.ElapsedMilliseconds
  Start-Sleep -Milliseconds 500
  $left = @(& powershell -NoProfile -File $probe left $dist | ConvertFrom-Json)
  [IO.File]::WriteAllText("$run\$i\stderr.log", $err.Result)
  $row = [pscustomobject]@{ run = $i; first_files = ($i -eq 0); first_paint_wall_ms = $first; pane_line = $line;
    processes_showing = $showing.processes; private_ws_mb_showing = $showing.private_ws_mb; commit_mb_showing = $showing.commit_mb;
    processes_no_browser = $closed.processes; private_ws_mb_no_browser = $closed.private_ws_mb; stop_ms = $stop; exit = $p.ExitCode; left = $left.Count }
  $row | ConvertTo-Json -Compress
  $rows += $row
}
$rows | ConvertTo-Json | Out-File -Encoding utf8 "$run\lifecycle.json"
Remove-Item -Recurse -Force $dist

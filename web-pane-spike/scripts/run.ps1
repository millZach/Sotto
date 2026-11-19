# Runs one spike mode on Windows with its own run folder (CEF's root cache, records, logs), then checks that nothing
# from the dist folder is still running. Usage: powershell -File run.ps1 <mode> <run-name> [-Timeout s] [NAME=value ...]
param([string]$Mode, [string]$Name, [int]$Timeout = 300, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Vars)
$ErrorActionPreference = "Stop"
$dist = if ($env:DIST) { $env:DIST } else { "D:\sotto-webpane-work\dist" }
$runs = if ($env:RUNS) { $env:RUNS } else { "D:\sotto-webpane-work\runs" }
$run = Join-Path $runs $Name
if (Test-Path $run) { Remove-Item -Recurse -Force $run }
New-Item -ItemType Directory -Force $run | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $dist "webpane.exe"
$psi.WorkingDirectory = $dist
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables["WP_MODE"] = $Mode
$psi.EnvironmentVariables["WP_RUN_DIR"] = $run
foreach ($v in $Vars) { $k, $val = $v -split "=", 2; $psi.EnvironmentVariables[$k] = $val }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($Timeout * 1000)) { & taskkill /T /F /PID $p.Id | Out-Null; "timed out after $Timeout s" }
$p.WaitForExit()
[IO.File]::WriteAllText("$run\stdout.log", $out.Result); [IO.File]::WriteAllText("$run\stderr.log", $err.Result)
Start-Sleep -Milliseconds 500
$left = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dist.TrimEnd("\") + "\", "OrdinalIgnoreCase") }
"exit $($p.ExitCode) -> $run; processes left from the dist folder: $(@($left).Count)"

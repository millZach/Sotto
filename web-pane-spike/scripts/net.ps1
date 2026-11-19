# Windows network run, from an ordinary shell: CEF with no page for WP_IDLE_S (default 600), with a NetLog, while
# every 2 s the OS's own tables are read for any TCP connection or UDP socket a process in the tree holds (no
# elevation needed; it misses packets a socket sends and closes between two reads, which only a capture would see).
# Usage: powershell -File net.ps1 <run-name> [-Hardened] [-IdleSeconds 600] [-Extra "switch;switch"]
param([string]$Name, [switch]$Hardened, [int]$IdleSeconds = 600, [string]$Extra = "")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = if ($env:DIST) { $env:DIST } else { "D:\sotto-webpane-work\dist" }
$run = Join-Path $(if ($env:RUNS) { $env:RUNS } else { "D:\sotto-webpane-work\runs" }) $Name
if (Test-Path $run) { Remove-Item -Recurse -Force $run }
New-Item -ItemType Directory -Force $run | Out-Null
$switches = @("log-net-log=$run\netlog.json", "net-log-capture-mode=Default")
if ($Hardened) { $switches += Get-Content (Join-Path $here "..\config\hardened-switches.txt") | Where-Object { $_.Trim() } }
if ($Extra) { $switches += $Extra -split ";" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $dist "webpane.exe"; $psi.WorkingDirectory = $dist; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.EnvironmentVariables["WP_MODE"] = "net"; $psi.EnvironmentVariables["WP_RUN_DIR"] = $run; $psi.EnvironmentVariables["WP_NO_SANDBOX"] = "1"
$psi.EnvironmentVariables["WP_IDLE_S"] = "$IdleSeconds"; $psi.EnvironmentVariables["WP_PAGE_S"] = "5"
$psi.EnvironmentVariables["WP_SWITCHES"] = ($switches -join ";")
if ($Hardened) { $psi.EnvironmentVariables["WP_PREFS"] = (Resolve-Path (Join-Path $here "..\config\hardened-prefs.json")).Path }
$p = [System.Diagnostics.Process]::Start($psi)
$out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
$seen = @{}; $t0 = Get-Date
while (-not $p.HasExited) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $ids = @($p.Id); $i = 0
  while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { [int]$_.ProcessId }); $i++ }
  $s = [math]::Round(((Get-Date) - $t0).TotalSeconds)
  foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess })) {
    $k = "tcp $($c.LocalAddress):$($c.LocalPort) -> $($c.RemoteAddress):$($c.RemotePort) $($c.State)"
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $s } }
  foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess })) {
    $k = "udp bound $($u.LocalAddress):$($u.LocalPort)"
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $s } }
  Start-Sleep 2
}
[IO.File]::WriteAllText("$run\stdout.log", $out.Result); [IO.File]::WriteAllText("$run\stderr.log", $err.Result)
$seen.GetEnumerator() | Sort-Object Value | ForEach-Object { "{0,5}s  {1}" -f $_.Value, $_.Key } | Out-File -Encoding utf8 "$run\sockets.txt"
"exit $($p.ExitCode) -> $run; left: $(& powershell -NoProfile -File (Join-Path $here 'win-probe.ps1') left $dist)"

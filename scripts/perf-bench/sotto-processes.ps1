# Each Sotto process on this Windows computer: its kind, the CPU it used over 30 seconds as a share of one core, and its working set.
# Run it in PowerShell, or from another machine: ssh laptop "powershell -NoProfile -EncodedCommand <this file as UTF-16LE base64>".
# It reads the process list and prints kinds and sizes, never a command line.
$ErrorActionPreference = 'SilentlyContinue'
$seconds = 30

function Read-SottoProcesses {
  Get-CimInstance Win32_Process -Filter "Name like 'Sotto%'" | ForEach-Object {
    $kind = 'main'
    if ($_.CommandLine -match '--type=([a-z-]+)') { $kind = $Matches[1] }
    if ($_.CommandLine -match 'utility-sub-type=([a-z._]+)') { $kind = $kind + ':' + $Matches[1] }
    [pscustomobject]@{ Id = $_.ProcessId; Name = $_.Name; Kind = $kind; CpuSeconds = ($_.KernelModeTime + $_.UserModeTime) / 1e7; WorkingSetMb = [math]::Round($_.WorkingSetSize / 1MB) }
  }
}

$before = Read-SottoProcesses
Start-Sleep -Seconds $seconds
$after = Read-SottoProcesses
foreach ($process in $after) {
  $earlier = $before | Where-Object Id -eq $process.Id
  if ($earlier) {
    "{0,-22} {1,-28} pid {2,6} cpu% {3,6:N1} ws {4,5} MB" -f $process.Name, $process.Kind, $process.Id, (($process.CpuSeconds - $earlier.CpuSeconds) / $seconds * 100), $process.WorkingSetMb
  }
}
"cores: " + (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

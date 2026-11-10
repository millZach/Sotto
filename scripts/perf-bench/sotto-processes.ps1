# Each Sotto process on this Windows computer: its kind, the CPU it used over 30 seconds as a share of one core, and its working set.
# Run it in PowerShell, or from another machine: ssh laptop "powershell -NoProfile -EncodedCommand <this file as UTF-16LE base64>".
$ErrorActionPreference='SilentlyContinue'
function Snap { Get-CimInstance Win32_Process -Filter "Name like 'Sotto%'" | ForEach-Object { $t='main'; if ($_.CommandLine -match '--type=([a-z-]+)') { $t=$Matches[1] }; if ($_.CommandLine -match 'utility-sub-type=([a-z._]+)') { $t=$t+':'+$Matches[1] }; [pscustomobject]@{Id=$_.ProcessId; Name=$_.Name; Type=$t; Cpu=($_.KernelModeTime+$_.UserModeTime)/1e7; WS=[math]::Round($_.WorkingSetSize/1MB)} } }
$a=Snap; Start-Sleep -Seconds 30; $b=Snap
foreach ($p in $b) { $q=$a | Where-Object Id -eq $p.Id; if ($q) { "{0,-22} {1,-28} pid {2,6} cpu% {3,6:N1} ws {4,5} MB" -f $p.Name,$p.Type,$p.Id,(($p.Cpu-$q.Cpu)/30*100),$p.WS } }
"cores: " + (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

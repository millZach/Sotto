# Windows seal run, from an ordinary shell: the hostile page (WP_HOSTILE, its second address pointed at a canary on
# another machine) on sotto-visual:// with ADR-0060's layers, a NetLog of every request and lookup the network
# service saw, and every canary hit logged while it ran. No packet capture or firewall (both need elevation).
# The local canary is server/testserver.py logging to D:\sotto-webpane-work\server.log; the remote one is the same
# script on forge, bound to its tailnet address, logging to /tmp/wp-canary/canary.log.
# Usage: powershell -File seal.ps1 <run-name> <layers> <hostile.html> [-Hardened]
param([string]$Name, [string]$Layers, [string]$Hostile, [switch]$Hardened)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$run = "D:\sotto-webpane-work\runs\$Name"
$hard = ""; $prefs = @()
if ($Hardened) {
  $hard = ";" + ((Get-Content "$here\..\config\hardened-switches.txt" | Where-Object { $_.Trim() }) -join ";")
  $prefs = @("WP_PREFS=" + (Resolve-Path "$here\..\config\hardened-prefs.json").Path)
}
$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
& powershell -NoProfile -File "$here\run.ps1" seal $Name -Timeout 150 WP_NO_SANDBOX=1 "WP_SEAL=$Layers" "WP_HOSTILE=$Hostile" "WP_SWITCHES=log-net-log=$run\netlog.json;net-log-capture-mode=Default$hard" @prefs
Start-Sleep 2
$t1 = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$inRun = { $_ -match '"t": ([\d.]+)' -and [double]$Matches[1] -ge $t0 -and [double]$Matches[1] -le $t1 }
Get-Content "D:\sotto-webpane-work\server.log" | Where-Object $inRun | Out-File -Encoding utf8 "$run\canary-loopback.log"
ssh -o BatchMode=yes forge "cat /tmp/wp-canary/canary.log" | Where-Object $inRun | Out-File -Encoding utf8 "$run\canary-forge.log"
python -I -X utf8 "$here\seal_summary_win.py" $run | Tee-Object "$run\summary.txt"

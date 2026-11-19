# Opens a pane with the command test page and asks UI Automation what it can see, as Narrator would.
# Usage: powershell -File uia.ps1 <run-name> [NAME=value ...]   (WP_MODE_OVERRIDE=child for CEF's child window)
param([string]$Name, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Vars)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$run = "D:\sotto-webpane-work\runs\$Name"
$job = Start-Job { param($here, $Name, $Vars) & powershell -NoProfile -File "$here\embed.ps1" $Name -Seconds 22 -NoInput WP_URL=http://127.0.0.1:8765/cdp.html @Vars } -ArgumentList $here, $Name, $Vars
Start-Sleep 9
& powershell -NoProfile -File "$here\win-probe.ps1" uia "web pane spike" twice | Out-File -Encoding utf8 "D:\sotto-webpane-work\$Name-uia.txt"
Wait-Job $job | Out-Null; Receive-Job $job; Remove-Job $job
Move-Item -Force "D:\sotto-webpane-work\$Name-uia.txt" "$run\uia.txt"
Get-Content "$run\uia.txt" | Select-Object -Last 1

# Time from saving a UI source edit to seeing it on screen, without hot reload:
# the edit, an incremental cargo build, relaunching the app, and its first painted frame.
#   powershell -File tools/edit-to-screen.ps1 -File src/composer.rs -From 'a' -To 'b' [-Profile release] [-Variant A]
param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$From,
    [Parameter(Mandatory = $true)][string]$To,
    [ValidateSet('release', 'debug')][string]$Profile = 'release',
    [string]$Variant = 'A'
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:CARGO_TARGET_DIR = 'D:\sotto-cargo-target'
Get-Process sotto-gpui -ErrorAction SilentlyContinue | Stop-Process -Force
$path = Join-Path $root $File
$text = [System.IO.File]::ReadAllText($path)
if (-not $text.Contains($From)) { Write-Error "The text to replace is not in $File"; exit 1 }
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$at = $text.IndexOf($From)
[System.IO.File]::WriteAllText($path, $text.Substring(0, $at) + $To + $text.Substring($at + $From.Length), (New-Object System.Text.UTF8Encoding $false))
$flag = if ($Profile -eq 'release') { '--release' } else { '' }
cargo build $flag -j 8 --bin sotto-gpui 2>&1 | Out-Null
$built = $clock.Elapsed.TotalMilliseconds
$exe = "D:\sotto-cargo-target\$Profile\sotto-gpui.exe"
$job = Start-Job -ArgumentList $exe, $Variant { param($exe, $variant) $env:SOTTO_GPUI_VARIANT = $variant; & 'D:\sotto-cargo-target\release\probe.exe' launch $exe --title "=Sotto (GPUI)" }
Wait-Job $job -Timeout 120 | Out-Null
$launch = Receive-Job $job
$painted = [double]([regex]::Match($launch, 'first painted frame: (\d+) ms').Groups[1].Value)
"{0}: save to build done {1:N0} ms, then launch to first painted frame {2:N0} ms, total {3:N0} ms" -f $Profile, $built, $painted, ($built + $painted)
Start-Sleep -Seconds 2
Get-Process sotto-gpui -ErrorAction SilentlyContinue | Stop-Process -Force

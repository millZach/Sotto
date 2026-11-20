# Start the Slint build with a renderer and arguments, wait, capture its window as it is on screen
# (the composed desktop, so child windows and anything DWM draws are included), print its log, and
# stop it. Windows only. Nothing is left running.
#   powershell -File tools/windows/run-shot.ps1 -Out shot.png [-Backend winit-skia-opengl] [-Wait 5] -- --size 1600x1000 --finished
# SOTTO_TERM_CWD is set to a neutral folder so the terminal's prompt names no one's home folder.
# Defaults put the window on the laptop's panel (physical x 1920 and up, 150%), where the GPUI build was measured.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Backend = 'winit-skia-opengl',
    [double]$Wait = 5,
    [string]$Exe = 'D:\sotto-cargo-target-slint\release\sotto-slint.exe',
    [string]$Shot = 'D:\sotto-cargo-target-slint\gpui-probe\tools\shot.ps1',
    [string]$Position = '1960,40',
    [string]$Log = '',
    # Capture with PrintWindow (the window draws itself), so a window on top cannot get into the capture.
    [switch]$Print,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs
)
if ($Backend -eq 'default') { Remove-Item Env:SLINT_BACKEND -ErrorAction SilentlyContinue } else { $env:SLINT_BACKEND = $Backend }
if (-not $Log) { $Log = [System.IO.Path]::ChangeExtension($Out, '.log') }
# Start-Process joins its arguments with spaces, so quote any that hold a space or a line break, and pass an empty one as "".
if (-not $env:SOTTO_TERM_CWD) { $env:SOTTO_TERM_CWD = 'D:\sotto-cargo-target-slint\lantern' }
$all = (@('--position', $Position) + $AppArgs) | ForEach-Object { if ($_ -eq '') { '""' } elseif ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
$p = Start-Process -FilePath $Exe -ArgumentList $all -PassThru -RedirectStandardError $Log
Start-Sleep -Milliseconds ([int]($Wait * 1000))
$shotArgs = @('-NoProfile', '-File', $Shot, '-Title', 'Sotto: Shelf', '-Out', $Out, '-ProcessId', $p.Id, '-NoActivate')
if ($Print) { $shotArgs += '-Print' }
& powershell @shotArgs
# The loaded graphics DLLs say which API the renderer took.
$mods = (Get-Process -Id $p.Id).Modules | ForEach-Object { $_.ModuleName.ToLower() } | Where-Object { $_ -in @('opengl32.dll', 'd3d12.dll', 'd3d11.dll', 'vulkan-1.dll', 'dxgi.dll', 'dcomp.dll') }
"graphics modules: " + (($mods | Sort-Object -Unique) -join ', ')
Stop-Process -Id $p.Id -Force
Start-Sleep -Milliseconds 400
Get-Content $Log
if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { "still running: $($p.Id)" }

# Launch to first painted frame on Windows, by the GPUI note's outside method (`probe launch`: start the
# process, find its window, poll its pixels every 2 ms until 0.5% of samples differ from the most common
# colour). The window opens on the laptop's panel at 1600x1000 without taking the foreground.
#   powershell -File tools/windows/launch.ps1 -Out launch.txt [-Renderers winit-skia-opengl,winit] [-Runs 5]
# The probe's output goes to a file: the app inherits the probe's standard handles and would otherwise
# hold a pipe open until it exits. Each app is stopped after its run; nothing is left running.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string[]]$Renderers = @('winit-skia-opengl', 'winit-femtovg', 'skia-wgpu-dx12', 'winit'),
    [int]$Runs = 5,
    [string]$Exe = 'D:\sotto-cargo-target-slint\release\sotto-slint.exe',
    [string]$Probe = 'D:\sotto-cargo-target-slint\probe-target\release\probe.exe'
)
$s = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 2).CounterSamples | Measure-Object CookedValue -Average
"cpu at start: $([math]::Round($s.Average))%" | Out-File -Encoding utf8 $Out
$tmp = Join-Path $env:TEMP 'slint-launch-probe.txt'
foreach ($r in $Renderers) {
    Remove-Item Env:WGPU_BACKEND -ErrorAction SilentlyContinue
    if ($r -eq 'skia-wgpu-dx12') { $env:SLINT_BACKEND = 'winit-skia-wgpu'; $env:WGPU_BACKEND = 'dx12' } else { $env:SLINT_BACKEND = $r }
    for ($i = 1; $i -le $Runs; $i++) {
        $p = Start-Process -FilePath $Probe -ArgumentList 'launch', $Exe, '--position', '1960,40', '--size', '1600x1000', '--no-activate', '--title', 'Sotto: Shelf' -PassThru -NoNewWindow -RedirectStandardOutput $tmp -RedirectStandardError "$tmp.err"
        $p.WaitForExit(70000) | Out-Null
        "$r run$i " + (Get-Content $tmp -Raw).Trim() | Out-File -Encoding utf8 -Append $Out
        Start-Sleep -Milliseconds 1200
        Get-Process sotto-slint -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 800
    }
}
Remove-Item Env:WGPU_BACKEND -ErrorAction SilentlyContinue
Get-Content $Out

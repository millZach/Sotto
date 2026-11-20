# The streaming figures on Windows, the GPUI note's way where it can be: the window at 1600x1000 on
# the laptop's panel (150%), dark, the reply streamed 20 characters every 16 ms, frames timed in the
# app by the rendering notifier (src/metrics.rs), and memory read from outside 3 s after the stream
# ends, summed over the process and its descendants (the GPUI note's `probe mem --tree`).
#   powershell -File tools/windows/bench.ps1 -Out <folder> [-Renderers winit-skia-opengl,winit-femtovg] [-Runs 3]
# A renderer named "skia-wgpu-dx12" runs winit-skia-wgpu with WGPU_BACKEND=dx12. Nothing is left running.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string[]]$Renderers = @('winit-skia-opengl', 'winit-femtovg', 'skia-wgpu-dx12'),
    [int]$Runs = 3,
    [string]$Exe = 'D:\sotto-cargo-target-slint\release\sotto-slint.exe',
    [string]$Probe = 'D:\sotto-cargo-target-slint\probe-target\release\probe.exe'
)
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($r in $Renderers) {
    Remove-Item Env:WGPU_BACKEND -ErrorAction SilentlyContinue
    if ($r -eq 'skia-wgpu-dx12') { $env:SLINT_BACKEND = 'winit-skia-wgpu'; $env:WGPU_BACKEND = 'dx12' } else { $env:SLINT_BACKEND = $r }
    for ($i = 1; $i -le $Runs; $i++) {
        $cpu = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 1).CounterSamples[0].CookedValue, 0)
        $free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
        $name = "$r-run$i"
        $log = Join-Path $Out "$name.log"
        $p = Start-Process -FilePath $Exe -ArgumentList '--position', '1960,40', '--size', '1600x1000', '--no-activate', '--bench', '--exit', '--out', (Join-Path $Out "$name.json") -PassThru -RedirectStandardError $log
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and -not ((Get-Content $log -ErrorAction SilentlyContinue) -match 'event=stream-ended')) { Start-Sleep -Milliseconds 100 }
        Start-Sleep -Seconds 3
        $mem = & $Probe mem --tree $p.Id
        $alone = & $Probe mem --name sotto-slint.exe
        $p.WaitForExit(30000) | Out-Null
        if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; $mem += ' (stopped by the script)' }
        "$name cpu_at_start=$cpu% free_gb=$free mem: $mem app alone: $alone" | Tee-Object -FilePath (Join-Path $Out 'runs.txt') -Append
        Start-Sleep -Seconds 2
    }
}
Remove-Item Env:WGPU_BACKEND -ErrorAction SilentlyContinue

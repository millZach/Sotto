# Every capture the Windows note cites that needs no input, retaken in one pass on the laptop's panel
# (150%). All but the child-window test use PrintWindow, so no other window can get into a capture;
# the child-window test reads the composed screen, since that is the question it asks.
#   powershell -File tools/windows/captures.ps1 -Out artifacts/native-ui-bake-off-slint/windows
param([Parameter(Mandatory = $true)][string]$Out)
$rs = Join-Path $PSScriptRoot 'run-shot.ps1'
function Shot($name, $backend, $wait, [string[]]$appArgs, [switch]$Screen) {
    $extra = @(); if (-not $Screen) { $extra += '-Print' }
    $r = & powershell -NoProfile -File $rs -Out (Join-Path $Out "$name.png") -Backend $backend -Wait $wait @extra @appArgs
    $r | Where-Object { $_ -match 'event=(shared|web-child|first-frame)|graphics modules|still running' } | ForEach-Object { "${name}: $_" }
    Remove-Item (Join-Path $Out "$name.log") -ErrorAction SilentlyContinue
}
# The composer texts, kept in a UTF-8 file: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
$texts = Get-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'rtl-texts.txt')
$ar = $texts[0]
$mixed = $texts[1] -replace '\n', "`n"
Shot 'streaming-1600x1000-dark' 'winit-skia-opengl' 6 @('--size', '1600x1000', '--stream', '--no-activate')
Shot 'rtl-transcript-and-composer' 'winit-skia-opengl' 4 @('--size', '1600x1000', '--no-activate', '--composer-text', $ar)
Shot 'rtl-composer-mixed' 'winit-skia-opengl' 4 @('--size', '1600x1000', '--no-activate', '--composer-text', $mixed)
foreach ($c in @(@('1600x1000', 'dark'), @('1600x1000', 'light'), @('1280x800', 'dark'), @('1280x800', 'light'), @('820x560', 'dark'), @('820x560', 'light'))) {
    $a = @('--size', $c[0], '--finished', '--no-activate'); if ($c[1] -eq 'light') { $a += '--light' }
    Shot "screen-$($c[0])-$($c[1])" 'winit-skia-opengl' 4 $a
}
Shot 'screen-below-minimum-request-600x400' 'winit-skia-opengl' 4 @('--size', '600x400', '--finished', '--no-activate')
foreach ($b in @('winit-skia-opengl', 'winit-femtovg', 'default')) {
    Shot "web-child-$b" $b 5 @('--size', '1600x1000', '--finished', '--web-surface', 'child') -Screen
    Shot "web-shared-$b" $b 7 @('--size', '1600x1000', '--finished', '--no-activate', '--web-surface', 'shared')
}

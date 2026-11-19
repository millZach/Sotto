# Read or set Windows' "Animation effects" (SPI_GETCLIENTAREAANIMATION / SPI_SETCLIENTAREAANIMATION).
#   powershell -File tools/motion.ps1            -> prints On or Off
#   powershell -File tools/motion.ps1 -Set Off   -> turns animation effects off (reduced motion)
param([ValidateSet('', 'On', 'Off')][string]$Set = '')
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Motion {
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint flags);
}
"@
if ($Set) {
    $on = if ($Set -eq 'On') { [IntPtr]1 } else { [IntPtr]0 }
    [Motion]::SystemParametersInfo(0x1043, 0, $on, 3) | Out-Null
}
$v = $false
[Motion]::SystemParametersInfo(0x1042, 0, [ref]$v, 0) | Out-Null
if ($v) { 'On' } else { 'Off' }

# Read or set the Windows caret blink time (ms). -1 means no blinking.
#   powershell -File tools/caret.ps1            -> prints the current value
#   powershell -File tools/caret.ps1 -Set -1    -> stops the caret blinking (Chromium follows this)
param([int]$Set = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Caret {
    [DllImport("user32.dll")] public static extern uint GetCaretBlinkTime();
    [DllImport("user32.dll")] public static extern bool SetCaretBlinkTime(uint ms);
}
"@
if ($Set -ne 0) {
    $v = if ($Set -lt 0) { [uint32]::MaxValue } else { [uint32]$Set }
    [Caret]::SetCaretBlinkTime($v) | Out-Null
}
$now = [Caret]::GetCaretBlinkTime()
if ($now -eq [uint32]::MaxValue) { -1 } else { $now }

# Press keys one at a time into the window and print what UI Automation says has focus after each,
# the way Narrator would announce it. Windows only.
#   powershell -Command "& tools/windows/focus-walk.ps1 -Probe <probe.exe> -Uia <uia.ps1> -Keys tab,tab,shift-tab,enter,esc"
# The probe and uia.ps1 are the GPUI note's outside measurer (tools/probe.rs, tools/uia.ps1 on
# prototype/native-ui-gpui), built and run unchanged from outside this build.
# The probe brings the window to the front before every key; the walk stops as soon as another
# window is found in front, so a stray key cannot go on reaching another app.
param(
    [Parameter(Mandatory = $true)][string]$Probe,
    [Parameter(Mandatory = $true)][string]$Uia,
    [string]$Title = 'Sotto: Shelf',
    [Parameter(Mandatory = $true)][string[]]$Keys
)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Front {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    public static string Title() { var sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
}
"@
"start: " + (& powershell -NoProfile -File $Uia -Title $Title -Mode focus)
foreach ($k in $Keys) {
    & $Probe keys --title $Title $k
    Start-Sleep -Milliseconds 200
    $front = [Front]::Title()
    if ($front -notlike "*$Title*") { "stopped: another window is in front"; break }
    "$k -> " + (& powershell -NoProfile -File $Uia -Title $Title -Mode focus)
}

# Reduced motion on Windows: stream the reply, capture the region of "Writing a reply" and its breathing
# dot six times with Animation effects on, turn Animation effects off (SPI_SETCLIENTAREAANIMATION), capture
# six more, put the setting back as it was, capture six more. Writes the crops and a log; the breathing
# shows as a range of the dot's brightness. Nothing is left running and the setting is restored.
#   powershell -File tools/windows/motion-check.ps1 -Out <folder>
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Exe = 'D:\sotto-cargo-target-slint\release\sotto-slint.exe',
    [string]$Backend = 'winit-skia-opengl'
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MotionCheck {
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint flags);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static bool Get() { bool v = true; SystemParametersInfo(0x1042, 0, ref v, 0); return v; }
    public static void Set(bool on) { SystemParametersInfo(0x1043, 0, (IntPtr)(on ? 1 : 0), 3); }
    public static RECT Rect(uint pid) {
        SetThreadDpiAwarenessContext((IntPtr)(-4));
        RECT r = new RECT(); IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
        if (found != IntPtr.Zero) DwmGetWindowAttribute(found, 9, out r, 16);
        return r;
    }
}
"@
New-Item -ItemType Directory -Force $Out | Out-Null
$original = [MotionCheck]::Get()
"animation effects at start: $original" | Tee-Object -FilePath "$Out\motion.txt"
$env:SLINT_BACKEND = $Backend
$p = Start-Process -FilePath $Exe -ArgumentList '--position', '1960,40', '--size', '1600x1000', '--no-activate', '--stream' -PassThru -RedirectStandardError "$Out\motion.log"
try {
    Start-Sleep -Seconds 4
    function Grab($tag) {
        [void][MotionCheck]::SetThreadDpiAwarenessContext([IntPtr](-4))
        $r = [MotionCheck]::Rect([uint32]$p.Id)
        # The "Writing a reply" row sits at the transcript's foot, above the composer, while the stream follows.
        $x = $r.Left + 200; $y = $r.Top + 1170; $w = 300; $h = 110
        for ($i = 1; $i -le 6; $i++) {
            $bmp = New-Object System.Drawing.Bitmap $w, $h
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
            $bmp.Save("$Out\motion-$tag-$i.png", [System.Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
            Start-Sleep -Milliseconds 230
        }
    }
    [MotionCheck]::Set($true); Start-Sleep -Milliseconds 1200; Grab 'on'
    [MotionCheck]::Set($false); Start-Sleep -Milliseconds 1200; Grab 'off'
    [MotionCheck]::Set($true); Start-Sleep -Milliseconds 1200; Grab 'on-again'
} finally {
    [MotionCheck]::Set($original)
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    "animation effects at end: $([MotionCheck]::Get())" | Tee-Object -FilePath "$Out\motion.txt" -Append
}
Start-Sleep -Milliseconds 300
Get-Content "$Out\motion.log" | Select-String 'reduced-motion' | ForEach-Object { $_.Line } | Tee-Object -FilePath "$Out\motion.txt" -Append

# Capture a top-level window by title substring to a PNG, exactly as it is on screen.
# Usage: powershell -File tools/shot.ps1 -Title "Sotto (GPUI)" -Out shot.png [-NoActivate]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Out,
    [switch]$NoActivate,
    [int]$ProcessId = 0,
    [switch]$Exact,
    # Ask the window to draw itself (PrintWindow), so windows on top of it do not show.
    [switch]$Print
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ShotNative {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static IntPtr Find(string part, uint wantPid, bool exact) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (wantPid != 0 && pid != wantPid) return true;
            bool hit = exact ? sb.ToString() == part : sb.ToString().Contains(part);
            if (hit) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
$h = [ShotNative]::Find($Title, [uint32]$ProcessId, [bool]$Exact)
if ($h -eq [IntPtr]::Zero) { Write-Error "No visible window titled like '$Title'"; exit 1 }
if (-not $NoActivate) { [ShotNative]::ShowWindow($h, 9) | Out-Null; [ShotNative]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 400 }
$r = New-Object ShotNative+RECT
[ShotNative]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
$w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($Print) {
    $hdc = $g.GetHdc()
    [ShotNative]::PrintWindow($h, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
} else {
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$w x $hgt -> $Out"

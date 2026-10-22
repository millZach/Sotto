import type { PasteInvocation } from './pasteCommand'

const PASTE_TYPE_DEFINITION = `using System;
using System.Runtime.InteropServices;

public static class SottoPaste
{
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint numberOfInputs, INPUT[] inputs, int inputSize);

    private static INPUT CreateKeyboardInput(ushort virtualKey, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki = new KEYBDINPUT
        {
            wVk = virtualKey,
            dwFlags = flags
        };
        return input;
    }

    public static bool SendCtrlV()
    {
        INPUT[] inputs = new INPUT[]
        {
            CreateKeyboardInput(VK_CONTROL, 0),
            CreateKeyboardInput(VK_V, 0),
            CreateKeyboardInput(VK_V, KEYEVENTF_KEYUP),
            CreateKeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP)
        };

        uint accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        return accepted == (uint)inputs.Length;
    }
}`

const PASTE_SCRIPT = `Add-Type -TypeDefinition @'
${PASTE_TYPE_DEFINITION}
'@

if (-not [SottoPaste]::SendCtrlV()) { exit 1 }
exit 0`

// The delivered app (ADR-0100): the display name of the process that owns the
// foreground window, from its file description, then its product name, then
// its file name. Nothing is read from the window or the app itself, no title
// and no contents, and no permission is involved. A UWP app's window belongs to
// Application Frame Host, so its hosted process is named instead.
// It compiles in the helper's one Add-Type, after the usings it adds.
const FOREGROUND_USINGS = `using System.Diagnostics;
using System.IO;
using System.Text;`

const FOREGROUND_TYPE_DEFINITION = `public static class SottoForeground
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string ImagePath(uint processId)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            StringBuilder path = new StringBuilder(1024);
            uint size = (uint)path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref size) ? path.ToString() : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static string AppName()
    {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return null;
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        if (processId == 0) return null;
        string path = ImagePath(processId);
        if (path == null) return null;
        if (string.Equals(Path.GetFileName(path), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
        {
            uint hosted = 0;
            EnumChildWindows(window, delegate (IntPtr child, IntPtr parameter)
            {
                uint childProcess;
                GetWindowThreadProcessId(child, out childProcess);
                if (childProcess == 0 || childProcess == processId) return true;
                hosted = childProcess;
                return false;
            }, IntPtr.Zero);
            string hostedPath = hosted == 0 ? null : ImagePath(hosted);
            if (hostedPath != null) path = hostedPath;
        }
        string name = null;
        try
        {
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(path);
            name = string.IsNullOrWhiteSpace(info.FileDescription) ? info.ProductName : info.FileDescription;
        }
        catch
        {
            name = null;
        }
        if (string.IsNullOrWhiteSpace(name)) name = Path.GetFileNameWithoutExtension(path);
        return name;
    }
}`

// Long-lived helper: pays the Add-Type compile (~750 ms) once at spawn, then
// answers 'paste' commands over stdin in a few milliseconds each, and 'app'
// with the delivered app's name in base64 UTF-8, or 'app' alone without one.
const PASTE_HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${FOREGROUND_USINGS}
${PASTE_TYPE_DEFINITION}

${FOREGROUND_TYPE_DEFINITION}
'@

$reader = [Console]::In
$writer = [Console]::Out
$writer.WriteLine('ready')
$writer.Flush()
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  if ($line -eq 'app') {
    $name = $null
    try { $name = [SottoForeground]::AppName() } catch { $name = $null }
    if ([string]::IsNullOrWhiteSpace($name)) { $writer.WriteLine('app') }
    else { $writer.WriteLine('app ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))) }
    $writer.Flush()
    continue
  }
  if ($line -ne 'paste') { continue }
  $accepted = $false
  try { $accepted = [SottoPaste]::SendCtrlV() } catch { $accepted = $false }
  if ($accepted) { $writer.WriteLine('ok') } else { $writer.WriteLine('fail') }
  $writer.Flush()
}
exit 0`

function buildPowerShellInvocation(script: string): Readonly<PasteInvocation> {
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const args = Object.freeze([
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ])

  return Object.freeze({ executable: 'powershell.exe', args })
}

export function buildPasteInvocation(): Readonly<PasteInvocation> {
  return buildPowerShellInvocation(PASTE_SCRIPT)
}

export function buildPasteHelperInvocation(): Readonly<PasteInvocation> {
  return buildPowerShellInvocation(PASTE_HELPER_SCRIPT)
}

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

// Long-lived helper: pays the Add-Type compile (~750 ms) once at spawn, then
// answers 'paste' commands over stdin in a few milliseconds each.
const PASTE_HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${PASTE_TYPE_DEFINITION}
'@

$reader = [Console]::In
$writer = [Console]::Out
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  if ($line -ne 'paste') { continue }
  $accepted = $false
  try { $accepted = [SottoPaste]::SendCtrlV() } catch { $accepted = $false }
  if ($accepted) { $writer.WriteLine('ok') } else { $writer.WriteLine('fail') }
  $writer.Flush()
}
exit 0`

export interface PasteInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

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

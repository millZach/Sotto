const PASTE_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TalkTypePaste
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
}
'@

if (-not [TalkTypePaste]::SendCtrlV()) { exit 1 }
exit 0`

export interface PasteInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

export function buildPasteInvocation(): Readonly<PasteInvocation> {
  const encodedScript = Buffer.from(PASTE_SCRIPT, 'utf16le').toString('base64')
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

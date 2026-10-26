// Real mouse and keyboard input for the launch video's takes, so the cursor on screen is the
// system's own and the global dictation shortcut reaches Sotto the way a person's press does.
//   input move <x> <y> <ms>     eased move to physical pixel x, y
//   input click [shift]         left click where the cursor is, with Shift held if asked
//   input drag <x> <y> <ms>     press, eased move to x, y, release
//   input window <title> <x> <y> <w> <h>   move the first window whose title contains <title>, and bring it forward
//   input close-window <title>  ask that window to close
//   input keys <chord>          e.g. ctrl+shift+space, enter, ctrl+v
//   input type <text>           types text as Unicode key presses
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

static class Input {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

  static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new System.Text.StringBuilder(512); GetWindowText(hwnd, text, 512);
      if (text.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static void Move(int x, int y, int ms) {
    POINT start; GetCursorPos(out start);
    int steps = Math.Max(1, ms / 8);
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
      SetCursorPos((int)Math.Round(start.X + (x - start.X) * e), (int)Math.Round(start.Y + (y - start.Y) * e));
      Thread.Sleep(8);
    }
  }
  static INPUT Mouse(uint flags) { var input = new INPUT { type = 0 }; input.u.mi = new MOUSEINPUT { flags = flags }; return input; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> {
    { "ctrl", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "space", 0x20 }, { "enter", 0x0D }, { "escape", 0x1B },
    { "tab", 0x09 }, { "backspace", 0x08 }, { "end", 0x23 }, { "home", 0x24 }, { "down", 0x28 }, { "up", 0x26 },
    { "plus", 0xBB }, { "minus", 0xBD }, { "zero", 0x30 },
  };

  static INPUT Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) {
    var input = new INPUT { type = 1 };
    input.u.ki = new KEYBDINPUT { vk = vk, scan = scan, flags = (up ? 2u : 0u) | (unicode ? 4u : 0u) };
    return input;
  }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  static int Main(string[] args) {
    SetProcessDPIAware();
    switch (args[0]) {
      case "move": {
        Move(int.Parse(args[1]), int.Parse(args[2]), args.Length > 3 ? int.Parse(args[3]) : 400);
        return 0;
      }
      case "click": {
        bool shift = args.Length > 1 && args[1] == "shift";
        if (shift) { Send(Key(0x10, false)); Thread.Sleep(40); }
        Send(Mouse(0x0002)); Thread.Sleep(70); Send(Mouse(0x0004));
        if (shift) { Thread.Sleep(40); Send(Key(0x10, true)); }
        return 0;
      }
      case "drag": {
        Send(Mouse(0x0002)); Thread.Sleep(120);
        Move(int.Parse(args[1]), int.Parse(args[2]), args.Length > 3 ? int.Parse(args[3]) : 600);
        Thread.Sleep(120); Send(Mouse(0x0004));
        return 0;
      }
      case "window": {
        IntPtr hwnd = Find(args[1]);
        if (hwnd == IntPtr.Zero) return 1;
        ShowWindow(hwnd, 9);
        SetWindowPos(hwnd, IntPtr.Zero, int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]), 0x0040);
        SetForegroundWindow(hwnd);
        return 0;
      }
      case "close-window": {
        IntPtr hwnd = Find(args[1]);
        if (hwnd != IntPtr.Zero) PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
        return 0;
      }
      case "keys": {
        var chord = new List<ushort>();
        foreach (var part in args[1].ToLowerInvariant().Split('+')) {
          ushort vk; if (!Keys.TryGetValue(part, out vk)) vk = (ushort)char.ToUpperInvariant(part[0]);
          chord.Add(vk);
        }
        foreach (var vk in chord) { Send(Key(vk, false)); Thread.Sleep(25); }
        Thread.Sleep(60);
        for (int i = chord.Count - 1; i >= 0; i--) { Send(Key(chord[i], true)); Thread.Sleep(15); }
        return 0;
      }
      case "type": {
        int delay = args.Length > 2 ? int.Parse(args[2]) : 35;
        foreach (char c in args[1]) {
          if (c == '\n') { Send(Key(0x0D, false), Key(0x0D, true)); }
          else Send(Key(0, false, c, true), Key(0, true, c, true));
          Thread.Sleep(delay);
        }
        return 0;
      }
    }
    return 2;
  }
}

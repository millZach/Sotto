// Sotto's Windows key listener. Main loads it with Add-Type and calls Run; it
// speaks the helper line protocol on stdin and stdout and prints nothing else.
// C# 5 only: Windows PowerShell 5.1 compiles this with the .NET Framework compiler.
// Uses only mscorlib types, so Add-Type needs no referenced assemblies.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SottoKeyListener
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int LLKHF_EXTENDED = 0x01;
    private const int LLKHF_INJECTED = 0x10;

    private const int KeyItem = 0;
    private const int KeysItem = 1;
    private const int RecordItem = 2;
    private const int QuitItem = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private sealed class Item
    {
        public int Kind;
        public int Vk;
        public bool Extended;
        public bool Down;
        public string[] Tokens;
        public bool On;
    }

    private static readonly Dictionary<int, string> KeyTokens = BuildKeyTokens();
    // Kept in a field so the garbage collector never frees the delegate Windows calls.
    private static readonly LowLevelKeyboardProc Callback = HookCallback;
    private static readonly ConcurrentQueue<Item> Queue = new ConcurrentQueue<Item>();
    private static readonly SemaphoreSlim QueueCount = new SemaphoreSlim(0);
    private static readonly ManualResetEvent HookReady = new ManualResetEvent(false);

    private static bool acceptInjected;
    private static IntPtr hook = IntPtr.Zero;
    private static StreamWriter output;

    // Owned by the writer thread only.
    private static Dictionary<string, bool> watched = new Dictionary<string, bool>();
    private static bool recording;
    private static int modifiersDown;
    // Keyed by vk | 0x100 when LLKHF_EXTENDED, so numpad Enter and Enter are separate keys.
    private static readonly Dictionary<int, bool> physicallyDown = new Dictionary<int, bool>();
    private static readonly Dictionary<int, string> reportedByVk = new Dictionary<int, string>();
    private static readonly Dictionary<string, int> reportedCount = new Dictionary<string, int>();

    private static Dictionary<int, string> BuildKeyTokens()
    {
        Dictionary<int, string> t = new Dictionary<int, string>();
        // Frozen key table; tests compare these entries with WIN32_KEY_TOKENS.
        t[0x41] = "A"; t[0x42] = "B"; t[0x43] = "C"; t[0x44] = "D";
        t[0x45] = "E"; t[0x46] = "F"; t[0x47] = "G"; t[0x48] = "H";
        t[0x49] = "I"; t[0x4A] = "J"; t[0x4B] = "K"; t[0x4C] = "L";
        t[0x4D] = "M"; t[0x4E] = "N"; t[0x4F] = "O"; t[0x50] = "P";
        t[0x51] = "Q"; t[0x52] = "R"; t[0x53] = "S"; t[0x54] = "T";
        t[0x55] = "U"; t[0x56] = "V"; t[0x57] = "W"; t[0x58] = "X";
        t[0x59] = "Y"; t[0x5A] = "Z"; t[0x30] = "0"; t[0x31] = "1";
        t[0x32] = "2"; t[0x33] = "3"; t[0x34] = "4"; t[0x35] = "5";
        t[0x36] = "6"; t[0x37] = "7"; t[0x38] = "8"; t[0x39] = "9";
        t[0x70] = "F1"; t[0x71] = "F2"; t[0x72] = "F3"; t[0x73] = "F4";
        t[0x74] = "F5"; t[0x75] = "F6"; t[0x76] = "F7"; t[0x77] = "F8";
        t[0x78] = "F9"; t[0x79] = "F10"; t[0x7A] = "F11"; t[0x7B] = "F12";
        t[0x7C] = "F13"; t[0x7D] = "F14"; t[0x7E] = "F15"; t[0x7F] = "F16";
        t[0x80] = "F17"; t[0x81] = "F18"; t[0x82] = "F19"; t[0x83] = "F20";
        t[0x84] = "F21"; t[0x85] = "F22"; t[0x86] = "F23"; t[0x87] = "F24";
        t[0x20] = "Space"; t[0x0D] = "Enter"; t[0x09] = "Tab"; t[0x08] = "Backspace";
        t[0x2E] = "Delete"; t[0x26] = "Up"; t[0x28] = "Down"; t[0x25] = "Left";
        t[0x27] = "Right"; t[0x24] = "Home"; t[0x23] = "End"; t[0x21] = "PageUp";
        t[0x22] = "PageDown"; t[0x1B] = "Escape"; t[0xA2] = "CommandOrControl"; t[0xA3] = "CommandOrControl";
        t[0xA4] = "Alt"; t[0xA5] = "Alt"; t[0xA0] = "Shift"; t[0xA1] = "Shift";
        t[0x5B] = "Super"; t[0x5C] = "Super";
        return t;
    }

    public static void Run(bool acceptSynthetic)
    {
        acceptInjected = acceptSynthetic;
        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        output.NewLine = "\n";

        Thread hookThread = new Thread(HookLoop);
        hookThread.IsBackground = true;
        hookThread.Start();
        HookReady.WaitOne();
        if (hook == IntPtr.Zero)
        {
            Environment.Exit(1);
        }

        Thread writer = new Thread(Drain);
        writer.IsBackground = true;
        writer.Start();
        Thread reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        reader.Start();
        writer.Join();
        Environment.Exit(0);
    }

    private static void HookLoop()
    {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, Callback, GetModuleHandle(null), 0);
        HookReady.Set();
        if (hook == IntPtr.Zero)
        {
            return;
        }
        MSG message;
        // Windows calls the low-level hook from inside GetMessage on this thread.
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
        }
    }

    // Windows removes a hook that answers slowly, so this only enqueues.
    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
            int flags = Marshal.ReadInt32(lParam, 8);
            if ((down || up) && (acceptInjected || (flags & LLKHF_INJECTED) == 0))
            {
                Item item = new Item();
                item.Kind = KeyItem;
                item.Vk = Marshal.ReadInt32(lParam, 0);
                item.Extended = (flags & LLKHF_EXTENDED) != 0;
                item.Down = down;
                Enqueue(item);
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                Item item = new Item();
                if (line == "keys" || line.StartsWith("keys ", StringComparison.Ordinal))
                {
                    item.Kind = KeysItem;
                    item.Tokens = line.Substring(4).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                }
                else if (line == "record on" || line == "record off")
                {
                    item.Kind = RecordItem;
                    item.On = line == "record on";
                }
                else
                {
                    // `request` is macOS only; unknown lines are ignored.
                    continue;
                }
                Enqueue(item);
            }
        }
        catch (IOException)
        {
        }
        Item quit = new Item();
        quit.Kind = QuitItem;
        Enqueue(quit);
    }

    private static void Enqueue(Item item)
    {
        Queue.Enqueue(item);
        QueueCount.Release();
    }

    private static void Drain()
    {
        try
        {
            Emit("permission granted");
            while (true)
            {
                // The 500 ms poll runs only on an idle wait, on the thread that owns the key state:
                // the queue is empty then, so a release can never overtake a queued event.
                if (!QueueCount.Wait(500))
                {
                    Reconcile();
                    continue;
                }
                Item item;
                Queue.TryDequeue(out item);
                if (item.Kind == QuitItem)
                {
                    return;
                }
                if (item.Kind == KeysItem)
                {
                    watched = new Dictionary<string, bool>();
                    foreach (string token in item.Tokens)
                    {
                        watched[token] = true;
                    }
                }
                else if (item.Kind == RecordItem)
                {
                    recording = item.On;
                }
                else if (item.Down)
                {
                    KeyDown(item.Vk, item.Extended);
                }
                else
                {
                    KeyUp(item.Vk, item.Extended);
                }
            }
        }
        catch (IOException)
        {
        }
    }

    // Windows never delivers some ups (Win+L, Ctrl+Alt+Del, UAC, sleep): release every
    // tracked key the keyboard no longer holds, through KeyUp so the refcount still pairs lines.
    // Read by vk, so numpad and dedicated twins share one reading; the release keeps the extended bit.
    private static void Reconcile()
    {
        foreach (int key in new List<int>(physicallyDown.Keys))
        {
            if ((GetAsyncKeyState(key & 0xFF) & 0x8000) == 0)
            {
                KeyUp(key & 0xFF, (key & 0x100) != 0);
            }
        }
    }

    // Numpad Enter is extended; with NumLock off the numpad sends the navigation VKs without the flag.
    private static string TokenFor(int vk, bool extended)
    {
        string token;
        if ((vk == 0x0D && extended) || (!extended && ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E))
            || !KeyTokens.TryGetValue(vk, out token))
        {
            return "Other";
        }
        return token;
    }

    private static void KeyDown(int vk, bool extended)
    {
        int key = extended ? vk | 0x100 : vk;
        if (physicallyDown.ContainsKey(key))
        {
            return; // auto-repeat
        }
        physicallyDown[key] = true;
        string token = TokenFor(vk, extended);
        bool modifier = IsModifier(token);
        bool report;
        if (modifier || recording)
        {
            report = true;
        }
        else if (modifiersDown > 0)
        {
            if (!watched.ContainsKey(token))
            {
                token = "Other";
            }
            report = true;
        }
        else
        {
            report = IsFunctionKey(token) && watched.ContainsKey(token);
        }
        if (modifier)
        {
            modifiersDown++;
        }
        if (!report)
        {
            return;
        }
        reportedByVk[key] = token;
        int count;
        reportedCount.TryGetValue(token, out count);
        reportedCount[token] = count + 1;
        if (count == 0)
        {
            Emit("down " + token);
        }
    }

    private static void KeyUp(int vk, bool extended)
    {
        int key = extended ? vk | 0x100 : vk;
        if (!physicallyDown.Remove(key))
        {
            return; // went down before the hook was installed
        }
        string token;
        if (KeyTokens.TryGetValue(vk, out token) && IsModifier(token))
        {
            modifiersDown--;
        }
        if (!reportedByVk.TryGetValue(key, out token))
        {
            return;
        }
        reportedByVk.Remove(key);
        int count = reportedCount[token] - 1;
        reportedCount[token] = count;
        if (count == 0)
        {
            Emit("up " + token);
        }
    }

    private static bool IsModifier(string token)
    {
        return token == "CommandOrControl" || token == "Alt" || token == "Shift" || token == "Super";
    }

    private static bool IsFunctionKey(string token)
    {
        return token.Length > 1 && token[0] == 'F' && char.IsDigit(token[1]);
    }

    // The only place anything reaches stdout.
    private static void Emit(string line)
    {
        output.Write(line + "\n");
    }
}

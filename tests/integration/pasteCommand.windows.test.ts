import { spawn } from 'node:child_process'

import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

import { buildPasteInvocation } from '../../src/main/output/pasteCommand'
import { createSpawnProcessAdapter } from '../../src/main/output/outputService'
import { createWarmPasteAdapter } from '../../src/main/output/pasteHelper'

const SMOKE_TEXT = 'talktype-sendinput-smoke'
const EDGE_TITLE = 'TalkType Edge native paste smoke'
const TARGET_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TalkTypeSmokeForeground
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr window);

    public static bool EstablishForeground(IntPtr window)
    {
        IntPtr previous = GetForegroundWindow();
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(previous, IntPtr.Zero);
        bool attached = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        try
        {
            BringWindowToTop(window);
            SetForegroundWindow(window);
            return GetForegroundWindow() == window;
        }
        finally
        {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
}
'@

$originalClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'TalkType native paste smoke'
$form.Width = 440
$form.Height = 140
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Name = 'PasteTarget'
$textBox.Left = 20
$textBox.Top = 24
$textBox.Width = 380
$form.Controls.Add($textBox)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$started = [System.Diagnostics.Stopwatch]::StartNew()
$script:result = 'TIMEOUT'
$timer.Add_Tick({
    if ($textBox.Text -eq '${SMOKE_TEXT}') {
        $script:result = 'PASS'
        $form.Close()
    } elseif ($started.ElapsedMilliseconds -ge 7000) {
        $form.Close()
    }
})

$form.Add_Shown({
    $form.Activate()
    [void][TalkTypeSmokeForeground]::EstablishForeground($form.Handle)
    [void]$textBox.Focus()
    [System.Windows.Forms.Application]::DoEvents()
    if ([TalkTypeSmokeForeground]::GetForegroundWindow() -ne $form.Handle -or -not $textBox.Focused) {
        $script:result = 'HARNESS_FOCUS_FAILED'
        [Console]::Out.WriteLine('HARNESS_FOCUS_FAILED')
        [Console]::Out.Flush()
        $form.Close()
        return
    }
    [System.Windows.Forms.Clipboard]::SetText('${SMOKE_TEXT}')
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    $timer.Start()
})

try {
    [void]$form.ShowDialog()
} finally {
    $timer.Stop()
    if ($null -ne $originalClipboard) {
        [System.Windows.Forms.Clipboard]::SetDataObject($originalClipboard, $true)
    }
    $timer.Dispose()
    $form.Dispose()
}

[Console]::Out.WriteLine("RESULT:$script:result")
[Console]::Out.Flush()`

const CLIPBOARD_GUARDIAN_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
$originalClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
try {
    [System.Windows.Forms.Clipboard]::SetText('${SMOKE_TEXT}')
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
} finally {
    if ($null -ne $originalClipboard) {
        [System.Windows.Forms.Clipboard]::SetDataObject($originalClipboard, $true)
    }
}`

const EDGE_FOREGROUND_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TalkTypeSmokeWindow
{
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    public static IntPtr FindVisibleWindow(string title)
    {
        IntPtr match = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;
            int length = GetWindowTextLength(window);
            if (length == 0) return true;
            StringBuilder text = new StringBuilder(length + 1);
            GetWindowText(window, text, text.Capacity);
            if (text.ToString().Contains(title)) { match = window; return false; }
            return true;
        }, IntPtr.Zero);
        return match;
    }

    public static bool EstablishForeground(IntPtr window)
    {
        IntPtr previous = GetForegroundWindow();
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(previous, IntPtr.Zero);
        bool attached = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        try
        {
            BringWindowToTop(window);
            SetForegroundWindow(window);
            return GetForegroundWindow() == window;
        }
        finally
        {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
}
'@

$window = [TalkTypeSmokeWindow]::FindVisibleWindow('${EDGE_TITLE}')
if ($window -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('HARNESS_WINDOW_NOT_FOUND'); exit 2 }
if (-not [TalkTypeSmokeWindow]::EstablishForeground($window)) { [Console]::Out.WriteLine('HARNESS_FOCUS_FAILED'); exit 3 }
[Console]::Out.WriteLine('READY')`

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function observeMarkers(child: ReturnType<typeof spawn>): {
  waitFor(markers: readonly string[]): Promise<string>
} {
  let output = ''
  let ended = false
  const waiters = new Set<{
    readonly markers: readonly string[]
    readonly resolve: (marker: string) => void
    readonly reject: (error: Error) => void
    readonly timeout: ReturnType<typeof setTimeout>
  }>()

  const settleWaiters = (): void => {
    for (const waiter of waiters) {
      const marker = waiter.markers.find((candidate) => output.includes(candidate))
      if (marker !== undefined) {
        clearTimeout(waiter.timeout)
        waiters.delete(waiter)
        waiter.resolve(marker)
      }
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    output += chunk
    settleWaiters()
  })
  child.once('error', () => {
    ended = true
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('native paste smoke target failed to start'))
    }
    waiters.clear()
  })
  child.once('exit', () => {
    ended = true
    settleWaiters()
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('native paste smoke target exited before reporting status'))
    }
    waiters.clear()
  })

  return {
    waitFor(markers): Promise<string> {
      const existing = markers.find((candidate) => output.includes(candidate))
      if (existing !== undefined) return Promise.resolve(existing)
      if (ended) {
        return Promise.reject(
          new Error('native paste smoke target exited before reporting status'),
        )
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          markers,
          resolve,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('native paste smoke timed out'))
          }, 10_000),
        }
        waiters.add(waiter)
      })
    },
  }
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', () => reject(new Error('foreground helper failed to start')))
    child.once('exit', () => resolve(output.trim()))
  })
}

const shouldRun =
  process.platform === 'win32' && process.env.TALKTYPE_NATIVE_PASTE_SMOKE === '1'

describe.runIf(shouldRun)('Windows native paste integration', () => {
  it('pastes the clipboard into an established ordinary foreground text field', async () => {
    const target = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        encodePowerShell(TARGET_SCRIPT),
      ],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const targetMarkers = observeMarkers(target)

    try {
      await expect(
        targetMarkers.waitFor(['READY', 'HARNESS_FOCUS_FAILED']),
      ).resolves.toBe('READY')

      const invocation = buildPasteInvocation()
      expect(invocation.args.join(' ')).not.toContain(SMOKE_TEXT)

      const adapter = createSpawnProcessAdapter((executable, args, options) =>
        spawn(executable, [...args], options),
      )
      await expect(adapter.run(invocation)).resolves.toBe(true)
      await expect(targetMarkers.waitFor(['RESULT:PASS', 'RESULT:TIMEOUT'])).resolves.toBe(
        'RESULT:PASS',
      )
    } finally {
      if (target.exitCode === null) target.kill()
    }
  }, 20_000)

  it('pastes through the warm helper process without using the fallback', async () => {
    const target = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        encodePowerShell(TARGET_SCRIPT),
      ],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const targetMarkers = observeMarkers(target)
    let fallbackUsed = false
    const adapter = createWarmPasteAdapter({
      spawnHelper: (invocation) =>
        spawn(invocation.executable, [...invocation.args], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        }),
      fallback: {
        run(): boolean {
          fallbackUsed = true
          return false
        },
      },
    })

    try {
      adapter.start()
      await expect(
        targetMarkers.waitFor(['READY', 'HARNESS_FOCUS_FAILED']),
      ).resolves.toBe('READY')

      // The warm helper pastes within milliseconds; give the target window the
      // same focus-settle time OutputService provides via pasteDelayMs.
      await new Promise((resolve) => setTimeout(resolve, 150))
      await expect(adapter.run(buildPasteInvocation())).resolves.toBe(true)
      await expect(targetMarkers.waitFor(['RESULT:PASS', 'RESULT:TIMEOUT'])).resolves.toBe(
        'RESULT:PASS',
      )
      expect(fallbackUsed).toBe(false)
    } finally {
      adapter.dispose()
      if (target.exitCode === null) target.kill()
    }
  }, 20_000)
})

const shouldRunEdge =
  process.platform === 'win32' && process.env.TALKTYPE_BROWSER_PASTE_SMOKE === '1'

describe.runIf(shouldRunEdge)('Windows Edge paste integration', () => {
  it('pastes the clipboard into a natively focused Edge textarea', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: false })
    const guardian = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        encodePowerShell(CLIPBOARD_GUARDIAN_SCRIPT),
      ],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    )
    const guardianMarkers = observeMarkers(guardian)

    try {
      await expect(guardianMarkers.waitFor(['READY'])).resolves.toBe('READY')
      const page = await browser.newPage()
      await page.setContent(
        `<title>${EDGE_TITLE}</title><label for="target">Paste target</label><textarea id="target" autofocus></textarea>`,
      )
      await page.locator('#target').focus()
      await page.bringToFront()

      await expect(runPowerShell(EDGE_FOREGROUND_SCRIPT)).resolves.toBe('READY')
      await expect(page.evaluate("document.activeElement?.id === 'target'")).resolves.toBe(true)

      const invocation = buildPasteInvocation()
      const adapter = createSpawnProcessAdapter((executable, args, options) =>
        spawn(executable, [...args], options),
      )
      await expect(adapter.run(invocation)).resolves.toBe(true)
      await page.waitForFunction(
        "(expected) => document.querySelector('#target')?.value === expected",
        SMOKE_TEXT,
      )
      await expect(page.locator('#target').inputValue()).resolves.toBe(SMOKE_TEXT)
    } finally {
      guardian.stdin?.end('\n')
      await browser.close()
      if (guardian.exitCode === null) guardian.kill()
    }
  }, 30_000)
})

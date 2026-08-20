// Regression test: Windows 11 silently drops BrowserWindow's constructor
// alwaysOnTop (and setAlwaysOnTop's default 'floating' level), leaving the
// dictation pill buried under other windows. The widget must reassert
// always-on-top at the explicit 'normal' level, and the OS window must
// actually carry WS_EX_TOPMOST — the Electron flag alone can lie.
import { execFileSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test.skip(process.platform !== 'win32', 'WS_EX_TOPMOST probe is Windows-only')
test.describe.configure({ timeout: 120_000 })

async function reachFinalOnboardingStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/standard model is included and ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
}

interface NativeTopmostProbe {
  readonly topmost: boolean
  readonly nonTopmostAbove: number
}

function nativeTopmostProbe(hwnd: string): NativeTopmostProbe {
  // GW_HWNDPREV = 3 walks toward the user. A TOPMOST widget should never have a
  // visible non-TOPMOST window above it; that is the "buried under Chrome" bug.
  const scriptPath = join(tmpdir(), `sotto-topmost-probe-${process.pid}-${Date.now()}.ps1`)
  const script = `
Add-Type -Namespace Probe -Name U -MemberDefinition @'
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
$hwnd = [IntPtr]${hwnd}
$style = [Probe.U]::GetWindowLongPtr($hwnd, -20).ToInt64()
$topmost = ($style -band 8) -ne 0
$above = 0
$current = [Probe.U]::GetWindow($hwnd, 3)
while ($current -ne [IntPtr]::Zero) {
  $visible = [Probe.U]::IsWindowVisible($current)
  $currentStyle = [Probe.U]::GetWindowLongPtr($current, -20).ToInt64()
  $currentTopmost = ($currentStyle -band 8) -ne 0
  if ($visible -and -not $currentTopmost) { $above++ }
  $current = [Probe.U]::GetWindow($current, 3)
}
Write-Output ("{0}|{1}" -f $topmost, $above)
`
  writeFileSync(scriptPath, script, 'utf8')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-File', scriptPath], {
      encoding: 'utf8',
    }).trim()
    const [topmostRaw, aboveRaw] = out.split('|')
    return {
      topmost: topmostRaw === 'True',
      nonTopmostAbove: Number(aboveRaw),
    }
  } finally {
    unlinkSync(scriptPath)
  }
}

async function widgetTopmostState(app: ElectronApplication): Promise<{
  electronAlwaysOnTop: boolean
  visible: boolean
  hwnd: string
} | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    if (target === undefined) return null
    return {
      electronAlwaysOnTop: target.isAlwaysOnTop(),
      visible: target.isVisible(),
      hwnd: target.getNativeWindowHandle().readBigUInt64LE(0).toString(),
    }
  })
}

async function assertWidgetNativeTopmost(app: ElectronApplication, label: string): Promise<void> {
  const state = await widgetTopmostState(app)
  if (state === null) throw new Error(`${label}: Widget BrowserWindow unavailable`)
  expect(state.visible, `${label}: visible`).toBe(true)
  expect(state.electronAlwaysOnTop, `${label}: electron alwaysOnTop`).toBe(true)
  const probe = nativeTopmostProbe(state.hwnd)
  expect(probe.topmost, `${label}: WS_EX_TOPMOST`).toBe(true)
  expect(probe.nonTopmostAbove, `${label}: non-topmost windows above widget`).toBe(0)
}

async function triggerShortcut(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.triggerShortcut(),
  )
}

test('revealed widget stays above other windows via WS_EX_TOPMOST', async () => {
  const launched = await launchSotto()
  try {
    await reachFinalOnboardingStep(launched.page)
    await launched.page.getByLabel('Paste test').focus()
    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await assertWidgetNativeTopmost(launched.app, 'initial reveal')
  } finally {
    await closeSotto(launched)
  }
})

// Auto-paste used to hide the pill for the keystroke and never restore it, so
// showWidgetWhenIdle users lost the idle sliver until restart. Dictate a few
// times and require the pill to stay natively topmost afterward.
test('idle widget returns after auto-paste and stays WS_EX_TOPMOST', async () => {
  const launched = await launchSotto()
  try {
    await reachFinalOnboardingStep(launched.page)
    await launched.page.getByRole('button', { name: /finish setup/i }).click()
    await expect(launched.page.getByRole('heading', { name: 'Home' })).toBeVisible()

    const idleWidget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (idleWidget === undefined) throw new Error('Idle widget window unavailable')
    await expect(idleWidget.locator('.widget-shell')).toBeVisible()
    await assertWidgetNativeTopmost(launched.app, 'idle after onboarding')

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await triggerShortcut(launched.page)
      const listening = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
      if (listening === undefined) throw new Error('Listening widget unavailable')
      await expect(listening.locator('.widget-shell[data-status="listening"]')).toBeVisible()
      await assertWidgetNativeTopmost(launched.app, `dictation reveal ${cycle}`)

      await triggerShortcut(launched.page)
      await expect(launched.page.getByRole('heading', { name: 'Text pasted' })).toBeVisible({
        timeout: 15_000,
      })
      await expect.poll(async () => {
        const state = await widgetTopmostState(launched.app)
        return state?.visible === true
      }, { timeout: 10_000 }).toBe(true)
      await assertWidgetNativeTopmost(launched.app, `idle after paste ${cycle}`)
    }

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await launched.app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith('/index.html'),
        )
        if (main === undefined) throw new Error('Main window unavailable')
        main.show()
        main.focus()
      })
      await assertWidgetNativeTopmost(launched.app, `main foreground cycle ${cycle}`)
    }

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await launched.app.evaluate(async ({ BrowserWindow }, competitorCycle) => {
        const competitor = new BrowserWindow({
          width: 640,
          height: 480,
          show: true,
          frame: true,
          alwaysOnTop: false,
        })
        competitor.setTitle(`sotto-topmost-competitor-${competitorCycle}`)
        competitor.show()
        competitor.focus()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }, cycle)
      await assertWidgetNativeTopmost(launched.app, `competitor foreground idle ${cycle}`)

      await launched.app.evaluate(({ BrowserWindow }) => {
        for (const candidate of BrowserWindow.getAllWindows()) {
          if (candidate.getTitle().startsWith('sotto-topmost-competitor-')) {
            candidate.destroy()
          }
        }
      })
    }
  } finally {
    await closeSotto(launched)
  }
})

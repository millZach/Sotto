// Regression test: Windows 11 silently drops BrowserWindow's constructor
// alwaysOnTop (and setAlwaysOnTop's default 'floating' level), leaving the
// dictation pill buried under other windows. The widget must reassert
// always-on-top at the explicit 'normal' level, and the OS window must
// actually carry WS_EX_TOPMOST — the Electron flag alone can lie.
import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

import type { SottoE2EBridge } from '../../src/shared/e2e'
import { closeSotto, launchSotto } from './support/sottoLaunch'

async function reachFinalOnboardingStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/balanced model is included and ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
}

function nativeTopmostBit(hwnd: string): boolean {
  const script = [
    'Add-Type -Namespace Probe -Name U -MemberDefinition',
    '\'[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);\';',
    `$style = [Probe.U]::GetWindowLongPtr([IntPtr]${hwnd}, -20).ToInt64();`,
    'Write-Output (($style -band 8) -ne 0)',
  ].join(' ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim()
  return out === 'True'
}

test('revealed widget stays above other windows via WS_EX_TOPMOST', async () => {
  const launched = await launchSotto()
  try {
    await reachFinalOnboardingStep(launched.page)
    await launched.page.getByLabel('Paste test').focus()
    await launched.page.evaluate(() =>
      (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.triggerShortcut(),
    )
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()

    const state = await launched.app.evaluate(({ BrowserWindow }) => {
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
    if (state === null) throw new Error('Widget BrowserWindow unavailable')

    expect(state.visible).toBe(true)
    expect(state.electronAlwaysOnTop).toBe(true)
    expect(nativeTopmostBit(state.hwnd)).toBe(true)
  } finally {
    await closeSotto(launched)
  }
})

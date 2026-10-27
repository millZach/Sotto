import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'

import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { captureSotto } from './support/sottoCapture'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

/**
 * The see-through window (ADR-0149) on the Windows 11 machine it runs on: Glass's Owl feature forced on, Glass chosen
 * for both halves, and the window captured from the screen over a desktop of colour, then over pure black and white
 * stripes, in light and dark, in Threads and in Watcher's room. A capture shows whatever is behind the window, so it
 * runs only when asked: SOTTO_GLASS_EVIDENCE=1, with the captures in artifacts/glass-theme/.
 */

/** A desktop behind the window: a field of colour, or the hard case, black and white side by side. */
const DESKS = {
  bloom: 'radial-gradient(circle at 18% 22%, #ff7a59 0 18%, transparent 42%), radial-gradient(circle at 78% 30%, #5b8cff 0 16%, transparent 44%), radial-gradient(circle at 55% 85%, #ffd166 0 14%, transparent 40%), linear-gradient(135deg, #3a1c71, #d76d77 55%, #ffaf7b)',
  stripes: 'repeating-linear-gradient(45deg, #000 0 26px, #fff 26px 52px)',
} as const

async function showDesk(app: ElectronApplication, desk: keyof typeof DESKS): Promise<boolean> {
  return app.evaluate(async ({ BrowserWindow, screen }, css) => {
    const main = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    const holder = globalThis as unknown as { glassDesk?: Electron.BrowserWindow }
    if (holder.glassDesk === undefined || holder.glassDesk.isDestroyed()) {
      const area = screen.getDisplayMatching(main.getBounds()).workArea
      holder.glassDesk = new BrowserWindow({ ...area, frame: false, show: false, skipTaskbar: true, focusable: false, backgroundColor: '#000000' })
    }
    await holder.glassDesk.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;background:${css}"></body>`)}`)
    holder.glassDesk.showInactive()
    // Windows draws Acrylic only behind the active window, and the system keeps a process that did not start from a
    // click from taking the foreground: a minimise and restore hands the window the focus it needs.
    main.minimize(); main.restore(); main.moveTop(); main.focus()
    await new Promise(resolve => setTimeout(resolve, 400))
    return main.isFocused()
  }, DESKS[desk])
}

test('Glass lets the desktop through the window on Windows 11', async () => {
  test.skip(process.platform !== 'win32' || process.env.SOTTO_GLASS_EVIDENCE !== '1', 'Run with SOTTO_GLASS_EVIDENCE=1 on Windows 11')
  test.setTimeout(240_000)
  const evidence = evidenceDirectory('artifacts/glass-theme')
  await mkdir(evidence, { recursive: true })
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'glass-theme=1'
  const profile = await ownedE2EProfile({ settings: { onboardingComplete: true, appearance: 'light', lightTheme: 'glass', darkTheme: 'glass', reducedMotion: 'on' } })
  const launched = await launchSotto('success', profile.directory)
  const { app, page } = launched
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ x: 120, y: 60, width: 1280, height: 800 })
    })
    await openThreads(page)
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect(page.locator('html')).toHaveAttribute('data-glass', 'see-through')
      for (const desk of ['bloom', 'stripes'] as const) {
        expect(await showDesk(app, desk), 'the window is active, so Windows draws its material').toBe(true)
        await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Threads', exact: true }).click()
        await captureSotto(launched, join(evidence, `threads-${appearance}-${desk}.png`), { mode: 'desktop-cropped', settleMs: 1200 })
        await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
        await expect(page.locator('.watcher-room')).toBeVisible()
        await captureSotto(launched, join(evidence, `watcher-${appearance}-${desk}.png`), { mode: 'desktop-cropped', settleMs: 1500 })
      }
    }
    // Leaving Glass turns the material off in place: the room is solid again, with no new window.
    await page.evaluate(async () => { await window.sotto!.updateSettings({ darkTheme: 't3-code' }) })
    await expect(page.locator('html')).not.toHaveAttribute('data-glass', /.+/u)
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await captureSotto(launched, join(evidence, 'threads-dark-left-glass.png'), { mode: 'desktop-cropped', settleMs: 1200 })
  } finally {
    await closeSotto(launched).catch(() => undefined)
    await removeOwnedE2EProfile(profile.directory).catch(() => undefined)
    if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES
    else process.env.SOTTO_OWL_FEATURES = previous
  }
})

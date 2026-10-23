import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, sottoWidget, type LaunchedSotto } from './support/sottoLaunch'

const VERSION = '9.9.9'
const REFUSAL = 'A test run does not install updates.'

const phaseOf = (page: Page) => async (): Promise<string> =>
  page.evaluate(async () => { const status = await window.sotto!.getUpdateStatus(); return 'phase' in status ? status.phase.phase : 'unavailable' })

/**
 * Restart now on a Mac: the installer fetches the update, announces the restart, asks every window to close and quits
 * once they are gone. The main window hides to the tray when closed, so unless Sotto lets it go the update never comes
 * and the window only hides. This run's stand-in installer (`SOTTO_E2E_APP_UPDATE`) does the same and then refuses, as a
 * Mac's can, after every window has closed.
 */
test('Restart now lets every window close, and a refused restart brings Sotto back as it was', async () => {
  const previous = process.env['SOTTO_E2E_APP_UPDATE']
  process.env['SOTTO_E2E_APP_UPDATE'] = VERSION
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto()
  } finally {
    if (previous === undefined) delete process.env['SOTTO_E2E_APP_UPDATE']
    else process.env['SOTTO_E2E_APP_UPDATE'] = previous
  }
  const { app, page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await sottoWidget(app)
    await page.evaluate(() => window.sotto!.checkForUpdates())
    await expect.poll(phaseOf(page)).toBe('available')
    await page.evaluate(() => window.sotto!.downloadUpdate())
    await expect.poll(phaseOf(page), { timeout: 10_000 }).toBe('downloaded')

    const original = await app.evaluate(({ BrowserWindow }) => {
      const record = { closed: [] as string[], uncaught: [] as string[], logs: [] as string[] }
      Object.assign(globalThis, { sottoRestart: record })
      process.on('uncaughtException', error => record.uncaught.push(error.message))
      const log = console.error.bind(console)
      console.error = (...args: unknown[]) => { record.logs.push(args.map(String).join(' ')); log(...args) }
      const windows = BrowserWindow.getAllWindows().map(window => ({ id: window.id, name: window.webContents.getURL().split('/').pop() ?? '' }))
      for (const { id, name } of windows) BrowserWindow.fromId(id)?.once('closed', () => record.closed.push(name))
      return windows
    })
    expect(original.map(window => window.name).sort()).toEqual(['index.html', 'widget.html'])

    await page.evaluate(() => window.sotto!.installUpdate()).catch(() => undefined)

    // Both windows close for real, then the installer refuses and the main window is made again.
    const originalIds = original.map(window => window.id)
    await expect.poll(() => app.evaluate(({ BrowserWindow }, ids) => {
      const record = (globalThis as unknown as { sottoRestart: { closed: string[] } }).sottoRestart
      const fresh = BrowserWindow.getAllWindows().filter(window => !ids.includes(window.id) && window.webContents.getURL().endsWith('/index.html') && window.isVisible())
      return { closed: [...record.closed].sort(), fresh: fresh.length }
    }, originalIds), { timeout: 15_000 }).toEqual({ closed: ['index.html', 'widget.html'], fresh: 1 })
    const { uncaught, logs } = await app.evaluate(() => (globalThis as unknown as { sottoRestart: { uncaught: string[]; logs: string[] } }).sottoRestart)
    expect(uncaught).toEqual([])
    expect(logs).not.toContain('[Sotto] renderer-cleanup-failed')

    // The refusal is on the update card's status, and the restart is off: closing the window hides it again, even when
    // Electron announces a restart once more, as it does whenever the last window next closes after a refusal.
    await expect.poll(() => app.windows().filter(candidate => !candidate.isClosed() && candidate.url().endsWith('/index.html')).length).toBe(1)
    const restored = app.windows().find(candidate => !candidate.isClosed() && candidate.url().endsWith('/index.html'))!
    await restored.waitForLoadState('domcontentloaded')
    expect(await restored.evaluate(async () => { const status = await window.sotto!.getUpdateStatus(); return 'phase' in status ? status.phase : null }))
      .toEqual({ phase: 'downloaded', version: VERSION, problem: REFUSAL })
    await app.evaluate(({ autoUpdater }) => { autoUpdater.emit('before-quit-for-update') })
    const afterClose = await app.evaluate(({ BrowserWindow }, ids) => new Promise<{ destroyed: boolean; visible: boolean }>(resolve => {
      const main = BrowserWindow.getAllWindows().find(window => !ids.includes(window.id) && window.webContents.getURL().endsWith('/index.html'))!
      const read = (): void => resolve({ destroyed: main.isDestroyed(), visible: main.isDestroyed() ? false : main.isVisible() })
      main.once('hide', read)
      setTimeout(read, 5_000)
      main.close()
    }), originalIds)
    expect(afterClose).toEqual({ destroyed: false, visible: false })
  } finally { await closeSotto(launched) }
})

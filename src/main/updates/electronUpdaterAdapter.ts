import { autoUpdater } from 'electron-updater'

import type { UpdaterAdapter, UpdaterEvent } from './updateService'

/**
 * The only module in Sotto that knows electron-updater exists. It is bundled
 * into the main chunk rather than shipped as a runtime dependency, so the
 * packaged `dependencies` manifest stays exactly `zod`.
 *
 * Everything the app decides about updating is set here, once:
 *
 * - `autoDownload = false` — an update is offered, never taken. Sotto asks
 *   before spending someone's bandwidth.
 * - `autoInstallOnAppQuit = false` — a downloaded update installs only when
 *   the user chooses to restart into it. Closing Sotto never runs an installer
 *   behind the window.
 * - `allowPrerelease = false` — this repository marks superseded releases as
 *   pre-releases, so the updater must only ever see the newest stable one.
 *
 * The logger is silenced because no update failure is worth a console line the
 * user cannot act on; the service turns each one into a phase instead.
 */
export function createElectronUpdaterAdapter(): UpdaterAdapter {
  const updater = autoUpdater
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.logger = null

  return {
    subscribe(listener: (event: UpdaterEvent) => void): void {
      updater.on('checking-for-update', () => listener({ type: 'checking' }))
      updater.on('update-available', (info) => listener({ type: 'available', version: info.version }))
      updater.on('update-not-available', () => listener({ type: 'not-available' }))
      updater.on('download-progress', (progress) => listener({ type: 'progress', percent: progress.percent }))
      updater.on('update-downloaded', (event) => listener({ type: 'downloaded', version: event.version }))
      // Without a listener an EventEmitter turns 'error' into a thrown
      // exception, which is exactly the crash this feature must never cause.
      updater.on('error', (error) => listener({ type: 'error', message: error?.message }))
    },
    async check(): Promise<void> {
      await updater.checkForUpdates()
    },
    async download(): Promise<void> {
      await updater.downloadUpdate()
    },
    quitAndInstall(): void {
      // Silent install, then relaunch: the user already confirmed the restart,
      // so the NSIS wizard has nothing left to ask. `app.quit()` runs Sotto's
      // ordinary before-quit path, which lets the tray-hidden window close.
      updater.quitAndInstall(true, true)
    },
  }
}

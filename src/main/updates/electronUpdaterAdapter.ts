import { rm } from 'node:fs/promises'
import type { OutgoingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { autoUpdater, type AppUpdater } from 'electron-updater'

import { getReleaseTrack } from '../../shared/releaseTrack'
import { OwlGitHubProvider } from './owlGitHubProvider'
import type { UpdaterAdapter, UpdaterEvent } from './updateService'

/**
 * The only module in Sotto that knows electron-updater exists. It is bundled
 * into the main chunk rather than shipped as a runtime dependency, so it never
 * joins the packaged `dependencies` manifest.
 *
 * Everything the app decides about updating is set here, once:
 *
 * - `autoDownload = false` — an update is offered, never taken. Sotto asks
 *   before spending someone's bandwidth.
 * - `autoInstallOnAppQuit = false` — a downloaded update installs only when
 *   the user chooses to restart into it. Closing Sotto never runs an installer
 *   behind the window.
 * - Stable keeps `allowPrerelease = false` and the packaged GitHub feed.
 *   Owl selects only the owl tag channel and validates its manifest.
 *
 * - No install ID. See `withoutInstallId`.
 *
 * The logger is silenced because no update failure is worth a console line the
 * user cannot act on; the service turns each one into a phase instead.
 */
export function createElectronUpdaterAdapter(updater = autoUpdater): UpdaterAdapter {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.logger = null
  const leftoverIdRemoved = withoutInstallId(updater)
  if (getReleaseTrack(updater.currentVersion.version) === 'owl') {
    updater.allowPrerelease = true
    updater.channel = 'owl'
    // Setting channel silently enables downgrades in electron-updater.
    updater.allowDowngrade = false
    updater.setFeedURL({ provider: 'custom', updateProvider: OwlGitHubProvider })
  }

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
      await leftoverIdRemoved
      await updater.checkForUpdates()
    },
    async download(): Promise<void> {
      await updater.downloadUpdate()
    },
    quitAndInstall(): void {
      // Silent install, then relaunch: the user already confirmed the restart,
      // so the NSIS wizard has nothing left to ask. On a Mac the arguments are
      // ignored; Squirrel.Mac takes the downloaded zip only now, because
      // autoInstallOnAppQuit is off, then replaces the app and relaunches it.
      // Windows quits through `app.quit()`, Sotto's ordinary before-quit path.
      // A Mac does not. The call returns while Squirrel is still fetching the
      // zip; then Electron announces `before-quit-for-update`, closes every
      // window and quits only once they are all gone. Main hears the
      // announcement and lets the main window, which hides to the tray when
      // closed, close for real.
      updater.quitAndInstall(true, true)
    },
  }
}

/** The header electron-updater adds to every check, carrying the install's ID. */
export const STAGING_ID_HEADER = 'x-user-staging-id'
/** The file electron-updater keeps that ID in, in Sotto's data folder. */
export const STAGING_ID_FILE = '.updaterId'

type StagingInternals = {
  app: { userDataPath: string }
  stagingUserIdPromise: { readonly value: Promise<string> }
  computeFinalHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders
}

/**
 * electron-updater makes a random ID for each install, keeps it in
 * `.updaterId` and sends it to GitHub with every check as
 * `x-user-staging-id`, for staged rollouts. Sotto publishes none, so the ID
 * only lets GitHub tie one install's checks together. This keeps it on the
 * computer, for stable and for Owl's provider alike:
 *
 * - The ID is never read or made: a fixed nil UUID stands in for it.
 * - Every release counts as rolled out to everyone, so a `stagingPercentage`
 *   in a manifest never reads it either.
 * - The header is taken out of every header set the updater builds, so
 *   nothing goes rather than a constant every install would share.
 * - A `.updaterId` an earlier Sotto left behind is removed before the first
 *   check, which waits for it.
 *
 * These are electron-updater internals. `tests/unit/main/owlUpdates.test.ts`
 * drives the real updater and checks the headers it sends and that no file
 * appears, so an electron-updater update that moves them goes red there.
 */
function withoutInstallId(updater: AppUpdater): Promise<void> {
  const internals = updater as unknown as StagingInternals
  internals.stagingUserIdPromise = { value: Promise.resolve('00000000-0000-0000-0000-000000000000') }
  updater.isUserWithinRollout = () => true
  const computeFinalHeaders = internals.computeFinalHeaders.bind(updater)
  internals.computeFinalHeaders = (headers) => {
    const merged = computeFinalHeaders(headers)
    delete merged[STAGING_ID_HEADER]
    return merged
  }
  return rm(join(internals.app.userDataPath, STAGING_ID_FILE), { force: true }).catch(() => undefined)
}

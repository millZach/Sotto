import { getReleaseTrack, isWatcherEnabled } from '../shared/releaseTrack'

/**
 * The running app's version. Packaging writes it into the app's own manifest, which `app.getVersion()` reads, so a
 * Sotto Owl package reports its Owl version while the source manifest stays as it is (ADR-0072). A run started on the
 * bare main script, as the e2e and design runs are, has no manifest: Electron then reports its own version, and the
 * source manifest's version, bundled at build time, stands in for it.
 */
export function runningVersion(reported: string, electronVersion: string, bundledVersion: string): string {
  return reported === electronVersion ? bundledVersion : reported
}

/** Only an unpackaged run can override the version-derived Watcher gate. */
export function watcherEnabledForRun(options: { version: string; isPackaged: boolean; override?: string | undefined }): boolean {
  if (!options.isPackaged && (options.override === '1' || options.override === '0')) return options.override === '1'
  return isWatcherEnabled(getReleaseTrack(options.version))
}

import { getReleaseTrack } from '../shared/releaseTrack'
import { owlFeaturesForTrack, type OwlFeatureId, type OwlFeatureStates } from '../shared/owlFeatures'

/**
 * The running app's version. Packaging writes it into the app's own manifest, which `app.getVersion()` reads, so a
 * Sotto Owl package reports its Owl version while the source manifest stays as it is (ADR-0072). A run started on the
 * bare main script, as the e2e and design runs are, has no manifest: Electron then reports its own version, and the
 * source manifest's version, bundled at build time, stands in for it.
 */
export function runningVersion(reported: string, electronVersion: string, bundledVersion: string): string {
  return reported === electronVersion ? bundledVersion : reported
}

interface OwlFeaturesRunOptions {
  version: string
  isPackaged: boolean
  overrides?: string | undefined
  watcherOverride?: string | undefined
}

/** Read once at startup. Packaged builds ignore all feature overrides. */
export function owlFeaturesForRun(options: OwlFeaturesRunOptions): OwlFeatureStates {
  const states = { ...owlFeaturesForTrack(getReleaseTrack(options.version)) }
  if (!options.isPackaged) {
    if (options.watcherOverride === '1' || options.watcherOverride === '0') states.watcher = options.watcherOverride === '1'
    // Explicit entries win over the old Watcher alias; the last valid entry wins over earlier ones.
    for (const entry of options.overrides?.split(',') ?? []) {
      const match = /^([a-z][a-z0-9-]*)\s*=\s*([01])$/u.exec(entry.trim())
      if (match && Object.hasOwn(states, match[1]!)) states[match[1] as OwlFeatureId] = match[2] === '1'
    }
  }
  return Object.freeze(states)
}

/** Compatibility wrapper around the Owl feature list for Watcher branches in flight. */
export function watcherEnabledForRun(options: { version: string; isPackaged: boolean; override?: string | undefined; overrides?: string | undefined }): boolean {
  return owlFeaturesForRun({ ...options, watcherOverride: options.override }).watcher
}

import type { MenuBarOwlBody, MenuBarOwlEyes } from '../../shared/menuBarOwl'
import type { AppSettings } from '../../shared/settings'
import type { SottoPlatform } from '../../shared/platform'
import type { OwlFeatureStates } from '../../shared/owlFeatures'
import { TrayOwlAnimator, type OwlEvent, type OwlTimers } from './owl/animator'
import { owlFramePngs, owlPaletteFile, parseOwlManifest, type OwlManifest } from './owl/frames'

/**
 * The menu bar owl on a Mac running an Owl build (ADR-0113): the glue between the settings, the system and the animator.
 * Nothing here imports Electron, so it is tested with plain stand-ins; `menuBarOwlElectron.ts` supplies the real ones.
 */

/** How many palettes' finished frames stay in memory (73 images each). */
const KEPT_PALETTES = 3

/** What the menu bar owl needs from its surroundings. */
export interface MenuBarOwlEnvironment<Image> {
  /** A file under `resources/tray/owl`, or null when it is not there. */
  readonly readOwlFile: (name: string) => Uint8Array | null
  /** One frame as an image with a 1x and a 2x picture. Throws when the pictures cannot be read. */
  readonly createImage: (png1x: Buffer, png2x: Buffer) => Image
  /** Whether the system asks for reduced motion now. */
  readonly systemPrefersReducedMotion: () => boolean
  /** Calls `listener` when that may have changed; returns how to stop. */
  readonly watchSystemReducedMotion: (listener: () => void) => () => void
  /** Calls `listener(true)` while the screen is locked or the Mac sleeps and `listener(false)` once neither is so; returns how to stop. */
  readonly watchPower: (listener: (paused: boolean) => void) => () => void
  readonly random?: () => number
  readonly timers?: OwlTimers
  readonly log?: (event: OwlEvent) => void
}

/** The part of the settings the owl reads. */
export type MenuBarOwlSettings = Pick<AppSettings, 'menuBarOwlBody' | 'menuBarOwlEyes' | 'reducedMotion'>

/** Neither method throws: the owl is decoration, so a failure inside it stops the owl and goes no further. */
export interface MenuBarOwl {
  /** Follows a settings change: swaps the frames when the colours changed, and stops or resumes for reduced motion. */
  applySettings(settings: MenuBarOwlSettings): void
  dispose(): void
}

/** Whether this run shows the menu bar owl: a Mac, the Owl feature on, and not an end-to-end run (which has no tray). */
export function menuBarOwlWanted(platform: SottoPlatform, owlFeatures: OwlFeatureStates, endToEnd: boolean): boolean {
  return platform === 'darwin' && owlFeatures['menu-bar-owl'] && !endToEnd
}

/**
 * Starts the menu bar owl on `tray`, or returns null and leaves the tray as it is when it cannot start (its frames cannot
 * be read, or the system will not answer), so a missing file costs the user nothing but the animation. Once running, a
 * failure stops the owl where it is rather than reach the startup or the settings save that called it.
 */
export function startMenuBarOwl<Image>(tray: { setImage(image: Image): void }, settings: MenuBarOwlSettings, env: MenuBarOwlEnvironment<Image>): MenuBarOwl | null {
  let manifest: OwlManifest
  try {
    const raw = env.readOwlFile('manifest.json')
    if (raw === null) throw new Error('missing')
    manifest = parseOwlManifest(JSON.parse(Buffer.from(raw).toString('utf8')))
  } catch {
    env.log?.('owl-frames-unavailable')
    return null
  }
  // A palette's frames take a few milliseconds to make, so the last few stay made: pressing between colours is instant.
  const made = new Map<string, readonly Image[]>()
  const frames = (body: MenuBarOwlBody, eyes: MenuBarOwlEyes): readonly Image[] => {
    const file = owlPaletteFile(manifest, body, eyes)
    const kept = made.get(file)
    if (kept !== undefined) return kept
    const bytes = env.readOwlFile(file)
    if (bytes === null) throw new Error('missing')
    const images = owlFramePngs(bytes, manifest).map(frame => env.createImage(frame.png1x, frame.png2x))
    made.set(file, images)
    if (made.size > KEPT_PALETTES) made.delete(made.keys().next().value as string)
    return images
  }
  const reduced = (now: MenuBarOwlSettings): boolean => now.reducedMotion === 'on' || env.systemPrefersReducedMotion()

  // What to undo, in order: the animator first, so its timer is gone even when a watcher will not let go.
  const cleanups: Array<() => void> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // The rest still stop.
      }
    }
    made.clear()
  }
  const failed = (): void => {
    dispose()
    env.log?.('owl-failed')
  }
  const guarded = <Args extends unknown[]>(run: (...args: Args) => void) => (...args: Args): void => {
    if (disposed) return
    try {
      run(...args)
    } catch {
      failed()
    }
  }

  try {
    let latest = settings
    // The colours last asked for, so a palette that will not load is tried again only when the choice changes.
    let requested = { body: settings.menuBarOwlBody, eyes: settings.menuBarOwlEyes }
    // The animator stops itself when the tray refuses a picture or the schedule throws, and says so with `owl-failed`: the
    // watchers and the kept frames go with it.
    const log = (event: OwlEvent): void => {
      env.log?.(event)
      if (event === 'owl-failed') dispose()
    }
    const animator = new TrayOwlAnimator<Image>(
      { setImage: image => tray.setImage(image), frames, log, ...(env.random ? { random: env.random } : {}), ...(env.timers ? { timers: env.timers } : {}) },
      { ...requested, reducedMotion: reduced(settings) },
    )
    cleanups.push(() => animator.dispose())
    if (!animator.start()) {
      dispose()
      return null
    }
    cleanups.push(env.watchSystemReducedMotion(guarded(() => animator.setReducedMotion(reduced(latest)))))
    cleanups.push(env.watchPower(guarded((paused: boolean) => animator.setPaused(paused))))
    return {
      applySettings: guarded((next: MenuBarOwlSettings) => {
        latest = next
        if (next.menuBarOwlBody !== requested.body || next.menuBarOwlEyes !== requested.eyes) {
          requested = { body: next.menuBarOwlBody, eyes: next.menuBarOwlEyes }
          animator.setLook(requested.body, requested.eyes)
        }
        animator.setReducedMotion(reduced(next))
      }),
      dispose,
    }
  } catch {
    failed()
    return null
  }
}

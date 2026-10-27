/**
 * Watcher's scenes (ADR-0148): the place Watcher's night scene is set in. Shared by the settings, which keep the
 * choice, and the renderer, which draws the place and lists it in Settings → Appearance under its name, which the
 * renderer's catalog translates. A place brings its own drawing and never its own colours: the scene's inks are the
 * theme's.
 */
export type WatcherScene = 'night-wood' | 'harbour' | 'snowfield' | 'desert'
export const WATCHER_SCENES = ['night-wood', 'harbour', 'snowfield', 'desert'] as const satisfies readonly WatcherScene[]
/** Today's scene, the one every install had before the choice. */
export const DEFAULT_WATCHER_SCENE: WatcherScene = 'night-wood'

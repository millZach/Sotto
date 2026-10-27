import { z } from 'zod'

/**
 * The see-through window (ADR-0149): while the Glass theme paints the main window, the operating system draws a blurred
 * material behind the room, Acrylic on Windows 11 and window vibrancy on macOS, and the room's tints let it through.
 * Glass is an Owl feature (`glass-theme`): main gives the window this bridge only while the startup answers turn it on,
 * so on stable the window has no way to ask for the material and is never see-through.
 */
export const GLASS_WINDOW_SET = 'sotto:glass-window:set'
/** Main to the main window: the system took the material away (false) or gave it back (true). */
export const GLASS_WINDOW_CHANGED = 'sotto:glass-window:changed'

/** The material main can draw behind the main window here, decided once at start. */
export type GlassWindowMaterial = 'acrylic' | 'vibrancy'

/** `--sotto-glass-window=<acrylic|vibrancy|in-app>`: Glass is on, and what this computer can draw behind the window. */
export const GLASS_WINDOW_ARGUMENT_PREFIX = '--sotto-glass-window='
/** Present when main made the window see-through, so the first frame paints the room clear, as main drew it. */
export const GLASS_WINDOW_SEE_THROUGH_ARGUMENT = '--sotto-glass-window-see-through'

export const glassWindowRequestSchema = z.boolean()
export const glassWindowResultSchema = z.boolean()

/** What the window knows of the see-through window when it is made. */
export interface GlassWindowState {
  /** Null where nothing is drawn behind a window (Linux, Windows 10): Glass paints its own backdrop there. */
  readonly material: GlassWindowMaterial | null
  /** Whether main made the window see-through. */
  readonly seeThrough: boolean
}

export interface GlassWindowBridge extends GlassWindowState {
  /** Ask main to turn the material on or off; resolves whether the window is see-through now. */
  readonly setSeeThrough: (on: boolean) => Promise<boolean>
  /** Hear when the system takes the material away or gives it back while Glass paints; returns the unsubscribe. */
  readonly onChanged: (listener: (seeThrough: boolean) => void) => () => void
}

export function glassWindowArguments(material: GlassWindowMaterial | null, seeThrough: boolean): string[] {
  return [`${GLASS_WINDOW_ARGUMENT_PREFIX}${material ?? 'in-app'}`, ...(material !== null && seeThrough ? [GLASS_WINDOW_SEE_THROUGH_ARGUMENT] : [])]
}

/** Null when main gave no Glass argument: the Owl feature is off, and nothing of Glass exists in the window. */
export function parseGlassWindowArguments(arguments_: readonly string[]): GlassWindowState | null {
  const matches = arguments_.filter(argument => argument.startsWith(GLASS_WINDOW_ARGUMENT_PREFIX))
  if (matches.length !== 1) return null
  const value = matches[0]!.slice(GLASS_WINDOW_ARGUMENT_PREFIX.length)
  if (value !== 'acrylic' && value !== 'vibrancy' && value !== 'in-app') return null
  const material = value === 'in-app' ? null : value
  return { material, seeThrough: material !== null && arguments_.includes(GLASS_WINDOW_SEE_THROUGH_ARGUMENT) }
}

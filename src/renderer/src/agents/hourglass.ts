/**
 * Three grains of sand, top chamber and bottom, each row top to bottom. The glass is held out clear of
 * the body (which reaches x=28): a translucent vessel over a solid body would be the same colour as it,
 * so like the loupe's ring it reads by sitting against the surface with a bright outline.
 */
export const TOP_ROWS = [[31, 10, 5], [31, 11, 5], [32, 12, 3]] as const
export const BOTTOM_ROWS = [[32, 16, 3], [31, 17, 5], [31, 18, 5]] as const
/** A path that draws nothing, for a chamber with no sand in it and a grain that is not falling. */
export const EMPTY_PATH = 'M0 0h0v0z'
export const sandPath = (rows: readonly (readonly [number, number, number])[]): string =>
  rows.map(([x, y, width]) => `M${x} ${y}h${width}v1h-${width}z`).join(' ') || EMPTY_PATH
/** A full turn of the glass, and the part of it spent flipping rather than running. */
export const GLASS_PERIOD = 6, GLASS_FLIP = 0.5
/** The glass's vessel (drawn faint, over whatever it is held against) and its bright outline, in its own units. */
export const HOURGLASS_VESSEL = 'M31 10h5v2h-5z M32 12h3v1h-3z M33 13h1v3h-1z M32 16h3v1h-3z M31 17h5v2h-5z'
export const HOURGLASS_OUTLINE = 'M30 9h7v1h-7z M30 19h7v1h-7z M30 10h1v2h-1z M36 10h1v2h-1z M31 12h1v1h-1z M35 12h1v1h-1z M32 13h1v3h-1z M34 13h1v3h-1z M31 16h1v1h-1z M35 16h1v1h-1z M30 17h1v2h-1z M36 17h1v2h-1z'
/** The point the glass turns about in a flip, and a falling grain's column and rows. */
export const HOURGLASS_CENTRE = '33.5 14.5'
export const grainPath = (time: number): string => `M33 ${13 + Math.floor(time * 8) % 3}h1v1h-1z`

/** One frame of the glass every creature holds: its turn, the sand in each chamber and the falling grain. */
export interface GlassFrame {
  readonly turn: string
  readonly top: string
  readonly bottom: string
  readonly grain: string
  /** True during the flip, when a creature may glance at it. */
  readonly spinning: boolean
}

/**
 * The glass `time` seconds into its cycle. Held motion keeps a half-run glass: the pose still reads as waiting without a
 * frame of movement. The rotation only ever runs during the flip, and never carries over: the sand rows live in the
 * rotated group, so a half turn that outlasted the flip would empty the chamber the reader sees filling, and the sand
 * would climb. Because the vessel is symmetric, ending a flip at half a turn looks exactly like starting the next cycle
 * upright, so the full chamber stays where the eye left it.
 */
export function glassFrame(time: number, still: boolean): GlassFrame {
  const phase = still ? GLASS_PERIOD / 2 : time % GLASS_PERIOD
  const running = GLASS_PERIOD - GLASS_FLIP
  const drain = Math.min(1, phase / running)
  const spin = phase > running ? (phase - running) / GLASS_FLIP : 0
  const gone = Math.min(3, Math.floor(drain * 3))
  return {
    turn: `rotate(${spin * 180} ${HOURGLASS_CENTRE})`,
    top: sandPath(TOP_ROWS.slice(gone)),
    bottom: sandPath(BOTTOM_ROWS.slice(3 - gone)),
    grain: drain < 1 && !still ? grainPath(time) : EMPTY_PATH,
    spinning: spin > 0,
  }
}

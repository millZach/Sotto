/**
 * What passes between Sotto and the sealed page of an interactive visual (ADR-0057). Sotto's guest preload imports this
 * file and nothing else, so it has no imports of its own: a sandboxed preload is one file, and a module it shared with
 * the window's preload would be split into a chunk it cannot load.
 */

/** Sotto's window to its guest preload, through the `<webview>` element. */
export const VISUAL_IPC_STEP = 'sotto-visual:step'
export const VISUAL_IPC_THEME = 'sotto-visual:theme'
/** The guest preload to Sotto's window: the page's measured height, and Escape pressed inside the page. */
export const VISUAL_IPC_HEIGHT = 'sotto-visual:height'
export const VISUAL_IPC_ESCAPE = 'sotto-visual:escape'

/** The message types a page listens for with `addEventListener('message', ...)`. */
export const VISUAL_STEP_MESSAGE = 'sotto-visual-step'
export const VISUAL_THEME_MESSAGE = 'sotto-visual-theme'

/** The colours Sotto gives a page as CSS variables, by name, each a `#rrggbb` hex colour. */
export const VISUAL_THEME_TOKENS = [
  '--sotto-text', '--sotto-muted', '--sotto-line', '--sotto-background', '--sotto-surface', '--sotto-border',
  '--sotto-group', '--sotto-note', '--sotto-accent',
] as const
export type VisualThemeToken = typeof VISUAL_THEME_TOKENS[number]
/** The font a page is given, as a CSS variable. Figtree travels with the page, so nothing is fetched to show it. */
export const VISUAL_FONT_TOKEN = '--sotto-font'
export const VISUAL_FONT_STACK = '"Figtree", ui-sans-serif, system-ui, sans-serif'

export interface VisualTheme {
  readonly tokens: Readonly<Record<VisualThemeToken, string>>
  readonly mode: 'light' | 'dark'
  readonly reducedMotion: boolean
}

/** Sent when the walkthrough moves: `step` counts from 1, and 0 means Read all shows every step at once. */
export interface VisualStepMessage {
  readonly type: typeof VISUAL_STEP_MESSAGE
  readonly step: number
  readonly total: number
  readonly highlight: readonly string[]
}
/** Where the walkthrough stands, as the card holds it: a step message without its type. */
export type VisualStepPlace = Omit<VisualStepMessage, 'type'>
export interface VisualThemeMessage extends VisualTheme {
  readonly type: typeof VISUAL_THEME_MESSAGE
}

/** The height Sotto gives a page, whatever the page measures: at least 160 pixels, at most 640, whole pixels. */
export const VISUAL_PAGE_HEIGHT_MIN = 160
export const VISUAL_PAGE_HEIGHT_MAX = 640
/**
 * Whether a key gives focus back to Sotto: Escape, pressed by the user. A key the page made itself (`isTrusted` false)
 * moves nothing, so a page cannot take focus away from it, close Expand or flood Sotto with messages (ADR-0057).
 */
export function returnsFocus(event: { readonly key: string; readonly repeat: boolean; readonly isTrusted: boolean }): boolean {
  return event.isTrusted && event.key === 'Escape' && !event.repeat
}
export function clampVisualPageHeight(measured: unknown): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return VISUAL_PAGE_HEIGHT_MIN
  return Math.min(VISUAL_PAGE_HEIGHT_MAX, Math.max(VISUAL_PAGE_HEIGHT_MIN, Math.ceil(measured)))
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/u
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A theme as the guest takes it, or null: every token a lowercase hex colour, so nothing else reaches the page's CSS. */
export function readVisualTheme(value: unknown): VisualTheme | null {
  if (!isRecord(value) || (value.mode !== 'light' && value.mode !== 'dark') || typeof value.reducedMotion !== 'boolean' || !isRecord(value.tokens)) return null
  const tokens: Partial<Record<VisualThemeToken, string>> = {}
  for (const name of VISUAL_THEME_TOKENS) {
    const colour = value.tokens[name]
    if (typeof colour !== 'string' || !HEX_COLOUR.test(colour)) return null
    tokens[name] = colour
  }
  return { tokens: tokens as Record<VisualThemeToken, string>, mode: value.mode, reducedMotion: value.reducedMotion }
}

/** A step as the guest takes it, or null. Highlight names are kept as the agent wrote them, at most 12 of 120 characters. */
export function readVisualStep(value: unknown): VisualStepMessage | null {
  if (!isRecord(value)) return null
  const { step, total, highlight } = value
  if (typeof step !== 'number' || typeof total !== 'number' || !Number.isInteger(step) || !Number.isInteger(total)) return null
  if (total < 0 || total > 12 || step < 0 || step > total) return null
  if (!Array.isArray(highlight) || highlight.length > 12 || !highlight.every(name => typeof name === 'string' && name.length <= 120)) return null
  return { type: VISUAL_STEP_MESSAGE, step, total, highlight: [...highlight as string[]] }
}

/** The CSS Sotto puts before the agent's page and rewrites when the theme changes: the variables and the frame's colours. */
export function visualThemeCss(theme: VisualTheme): string {
  const variables = VISUAL_THEME_TOKENS.map(name => `${name}:${theme.tokens[name]}`).join(';')
  return `:root{${variables};${VISUAL_FONT_TOKEN}:${VISUAL_FONT_STACK};color-scheme:${theme.mode}}`
    + 'html{background:var(--sotto-background);color:var(--sotto-text);font-family:var(--sotto-font)}'
    + (theme.reducedMotion ? '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}' : '')
}

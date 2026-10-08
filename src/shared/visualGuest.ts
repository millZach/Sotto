import { FIGTREE_FONT_STACK } from './figtreeFaces'

/**
 * What passes between Sotto and the sealed page of an interactive visual (ADR-0060). Sotto's guest preload imports this
 * file, which imports only `figtreeFaces.ts`, which imports nothing: a sandboxed preload is one file, and a module it
 * shared with the window's preload would be split into a chunk it cannot load. The window's preload imports neither.
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
  '--sotto-group-fill', '--sotto-note-fill', '--sotto-accent',
] as const
export type VisualThemeToken = typeof VISUAL_THEME_TOKENS[number]
/**
 * What each colour is for, as an agent is told it. A live page took `--sotto-note`, then a fill behind Mermaid's notes,
 * for note text and drew words that could hardly be read, so every name says whether it is for text or a fill.
 */
export const VISUAL_THEME_TOKEN_ROLES: Readonly<Record<VisualThemeToken, string>> = {
  '--sotto-text': 'text',
  '--sotto-muted': 'secondary text',
  '--sotto-line': 'lines and axes',
  '--sotto-background': 'the page background',
  '--sotto-surface': 'the fill of boxes and bars that are not lit',
  '--sotto-border': 'box borders',
  '--sotto-group-fill': 'the fill behind a group of parts',
  '--sotto-note-fill': 'the fill behind a note, with --sotto-text on it',
  '--sotto-accent': 'the one highlight colour, for what a step lights',
}
/** The font a page is given, as a CSS variable. Figtree travels with the page, so nothing is fetched to show it. */
export const VISUAL_FONT_TOKEN = '--sotto-font'
export const VISUAL_FONT_STACK = FIGTREE_FONT_STACK

export interface VisualTheme {
  readonly tokens: Readonly<Record<VisualThemeToken, string>>
  readonly mode: 'light' | 'dark'
  readonly reducedMotion: boolean
}

/** The step a page is told while Read all shows every step at once, with no names. Shown steps count from 1. */
export const READ_ALL_STEP = 0

/**
 * Where the walkthrough stands, as a page is told it: `step` counts from 1, or is `READ_ALL_STEP`; `total` is the
 * number of steps; `highlight` is the names the step lists. The walkthrough's own place counts its index from 0
 * (`WalkthroughPlace` in the renderer); `pageStepFor` turns one into the other.
 */
export interface VisualStepPlace {
  readonly step: number
  readonly total: number
  readonly highlight: readonly string[]
}
/** A step as the page receives it in a window message. */
export interface VisualStepMessage extends VisualStepPlace {
  readonly type: typeof VISUAL_STEP_MESSAGE
}

/**
 * The most a kept visual may hold: `agentVisualSchema`'s steps, names per step and characters per name in visuals.ts.
 * Written out here because this file may import nothing a window's preload also imports; a test holds them equal.
 */
export const GUEST_STEPS_MAX = 24
export const GUEST_HIGHLIGHTS_MAX = 24
export const GUEST_HIGHLIGHT_MAX = 240

/** The height Sotto gives a page, whatever the page measures: at least 160 pixels, at most 640, whole pixels. */
export const VISUAL_PAGE_HEIGHT_MIN = 160
export const VISUAL_PAGE_HEIGHT_MAX = 640
/**
 * How tall a page's content is: the larger of the root's own box and the body's scroll height. A body set to fill the
 * frame (`height: 100%`) still reports content that runs past it, so a page so sized grows to its content rather than
 * staying at the frame's height. Content sized by `vh` follows the frame and cannot be measured; the tool's description
 * tells agents to size by content.
 */
export function measuredPageHeight(rootHeight: number, bodyScrollHeight: number | undefined): number {
  return Math.max(rootHeight, bodyScrollHeight ?? 0)
}
/**
 * Whether a key gives focus back to Sotto: Escape, pressed by the user. A key the page made itself (`isTrusted` false)
 * moves nothing, so a page cannot take focus away from it, close Expand or flood Sotto with messages (ADR-0060).
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

/** A step as the guest takes it, or null, within what a kept visual may hold. Highlight names are kept as written. */
export function readVisualStep(value: unknown): VisualStepMessage | null {
  if (!isRecord(value)) return null
  const { step, total, highlight } = value
  if (typeof step !== 'number' || typeof total !== 'number' || !Number.isInteger(step) || !Number.isInteger(total)) return null
  if (total < 0 || total > GUEST_STEPS_MAX || step < READ_ALL_STEP || step > total) return null
  if (!Array.isArray(highlight) || highlight.length > GUEST_HIGHLIGHTS_MAX || !highlight.every(name => typeof name === 'string' && name.length <= GUEST_HIGHLIGHT_MAX)) return null
  return { type: VISUAL_STEP_MESSAGE, step, total, highlight: [...highlight as string[]] }
}

/** The CSS Sotto puts before the agent's page and rewrites when the theme changes: the variables and the frame's colours. */
export function visualThemeCss(theme: VisualTheme): string {
  const variables = VISUAL_THEME_TOKENS.map(name => `${name}:${theme.tokens[name]}`).join(';')
  return `:root{${variables};${VISUAL_FONT_TOKEN}:${VISUAL_FONT_STACK};color-scheme:${theme.mode}}`
    + 'html{background:var(--sotto-background);color:var(--sotto-text);font-family:var(--sotto-font)}'
    + (theme.reducedMotion ? '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}' : '')
}

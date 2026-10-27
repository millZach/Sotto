/*
 * Glass, the see-through built-in (ADR-0150; Zach's pick on October 26, 2026, `THEMES.glass` in the
 * `prototype/appearance-rework` tag's appearance-prototype-kit.js): the room is a tint over the desktop, blurred by
 * the operating system, with frosted panes and an azure accent.
 *
 * A theme role is always opaque here. The roles below are the room as it reads over a quiet desktop (the tints
 * flattened over #e0e0e0 by day and #202020 by night, the prototype's glow), so everything that reads a role, the
 * menus, dialogs, code, the terminal, the Sotto mark, the widget, a duplicate of the theme and the words' contrast
 * tokens, gets a solid colour. The see-through part is the tints: the room's own translucent colours, which
 * appearance.ts writes on the root as `--theme-glass-*` only while Glass paints, and which tokens.css puts under the
 * room, the sidebar, the cards and the user's messages. They are not roles, so no imported or custom theme can carry
 * them.
 *
 * Every line of words keeps 4.5:1 over the tints with pure white or pure black behind the window, the worst any
 * desktop can show before the blur softens it (tests/unit/shared/glassTheme.test.ts).
 */

import type { ThemeAppearance, ThemeColors } from './palettes'

export const GLASS_THEME_ID = 'glass'

/** The translucent colours the see-through room paints, each over the layer under it. */
export interface GlassTints {
  /** The room, painted once over whatever is behind the window. */
  readonly room: string
  /** The Threads sidebar and the docked panels, over the room. */
  readonly sidebar: string
  /** Cards and the composer, over the room. */
  readonly raised: string
  /** The user's own messages, over the room. */
  readonly message: string
  /** A sidebar row pointed at, chosen and current, over the sidebar. */
  readonly rowHover: string
  readonly rowActive: string
  readonly rowSelected: string
  /**
   * In-app glass: where nothing is drawn behind the window (Linux, Windows 10, or reduced transparency), the room's
   * tints sit on this quiet gradient in the theme's hues instead of the desktop.
   */
  readonly backdrop: readonly [string, string, string]
}

export const GLASS_TINTS: Readonly<Record<ThemeAppearance, GlassTints>> = {
  light: {
    room: 'oklch(0.975 0.006 250 / 0.8)',
    sidebar: 'oklch(1 0 0 / 0.42)',
    raised: 'oklch(1 0 0 / 0.62)',
    message: 'oklch(0.9 0.03 250 / 0.7)',
    rowHover: 'oklch(0.2 0.02 255 / 0.06)',
    rowActive: 'oklch(0.55 0.15 252 / 0.14)',
    rowSelected: 'oklch(0.55 0.15 252 / 0.2)',
    backdrop: ['oklch(0.9 0.04 250)', 'oklch(0.93 0.03 300)', 'oklch(0.94 0.035 200)'],
  },
  dark: {
    room: 'oklch(0.17 0.012 255 / 0.76)',
    sidebar: 'oklch(0.3 0.012 255 / 0.36)',
    raised: 'oklch(0.33 0.012 255 / 0.5)',
    message: 'oklch(0.42 0.06 250 / 0.45)',
    rowHover: 'oklch(1 0 0 / 0.06)',
    rowActive: 'oklch(0.6 0.12 238 / 0.18)',
    rowSelected: 'oklch(0.6 0.12 238 / 0.24)',
    backdrop: ['oklch(0.24 0.05 265)', 'oklch(0.2 0.06 300)', 'oklch(0.22 0.05 210)'],
  },
}

/** By day: frosted white over a pale azure room, ink-blue words, an azure accent. */
export const GLASS_LIGHT_THEME_COLORS: ThemeColors = {
  canvas: 'oklch(0.961 0.006 260)',
  chrome: 'oklch(0.961 0.006 260)',
  toolbar: 'oklch(0.961 0.006 260)',
  toolbarForeground: 'oklch(0.19 0.012 255)',
  toolbarBorder: 'oklch(0.86 0.012 255)',
  toolbarControl: 'oklch(0.935 0.01 255)',
  toolbarControlHover: 'oklch(0.905 0.014 255)',
  toolbarControlForeground: 'oklch(0.19 0.012 255)',
  surface: 'oklch(0.985 0.003 250)',
  surfaceRaised: 'oklch(0.985 0.002 250)',
  surfaceOverlay: 'oklch(0.98 0.004 250)',
  text: 'oklch(0.19 0.012 255)',
  textMuted: 'oklch(0.4 0.014 255)',
  border: 'oklch(0.86 0.012 255)',
  input: 'oklch(0.78 0.018 255)',
  focus: 'oklch(0.5 0.17 252)',
  accent: 'oklch(0.5 0.17 252)',
  accentForeground: 'oklch(0.99 0 0)',
  secondary: 'oklch(0.935 0.01 255)',
  secondaryForeground: 'oklch(0.19 0.012 255)',
  muted: 'oklch(0.94 0.008 255)',
  mutedForeground: 'oklch(0.4 0.014 255)',
  placeholder: 'oklch(0.42 0.014 255)',
  secondaryLabel: 'oklch(0.4 0.014 255)',
  iconMuted: 'oklch(0.4 0.014 255)',
  error: 'oklch(0.55 0.2 27)',
  errorForeground: 'oklch(0.44 0.17 27)',
  errorSurface: 'oklch(0.94 0.025 25)',
  warning: 'oklch(0.772406 0.172798 65.367)',
  warningForeground: 'oklch(0.4 0.1 55)',
  warningSurface: 'oklch(0.95 0.03 80)',
  update: 'oklch(0.5 0.17 252)',
  updateForeground: 'oklch(0.39 0.15 254)',
  updateSurface: 'oklch(0.92 0.035 252)',
  accentSurface: 'oklch(0.92 0.035 252)',
  accentSurfaceForeground: 'oklch(0.19 0.012 255)',
  messageSurface: 'oklch(0.92 0.022 250)',
  messageForeground: 'oklch(0.19 0.012 255)',
  messageAction: 'oklch(0.5 0.17 252)',
  messageActionForeground: 'oklch(0.99 0 0)',
  messageActionHover: 'oklch(0.39 0.15 252)',
  codeBackground: 'oklch(0.982 0.002 250)',
  codeForeground: 'oklch(0.19 0.012 255)',
  sidebar: 'oklch(0.978 0.003 250)',
  sidebarForeground: 'oklch(0.19 0.012 255)',
  sidebarMutedForeground: 'oklch(0.4 0.014 255)',
  sidebarControlSurface: 'oklch(0.99 0.002 250)',
  sidebarRowHover: 'oklch(0.94 0.012 252)',
  sidebarRowActive: 'oklch(0.91 0.025 252)',
  sidebarRowSelected: 'oklch(0.89 0.031 248)',
  sidebarBorder: 'oklch(0.86 0.012 255)',
  terminalBackground: 'oklch(0.975 0.004 252)',
  terminalForeground: 'oklch(0.19 0.012 255)',
  terminalCursor: 'oklch(0.5 0.17 252)',
  terminalSelection: 'oklch(0.9 0.04 252)',
  terminalScrollbar: 'oklch(0.84 0.01 255)',
  terminalScrollbarHover: 'oklch(0.76 0.012 255)',
}

/** By night: smoked glass over a deep blue room, near-white words, a sky-blue accent. */
export const GLASS_DARK_THEME_COLORS: ThemeColors = {
  canvas: 'oklch(0.19 0.009 256)',
  chrome: 'oklch(0.19 0.009 256)',
  toolbar: 'oklch(0.19 0.009 256)',
  toolbarForeground: 'oklch(0.985 0.003 255)',
  toolbarBorder: 'oklch(0.32 0.012 255)',
  toolbarControl: 'oklch(0.25 0.01 255)',
  toolbarControlHover: 'oklch(0.29 0.012 255)',
  toolbarControlForeground: 'oklch(0.985 0.003 255)',
  surface: 'oklch(0.235 0.01 255)',
  surfaceRaised: 'oklch(0.263 0.011 254)',
  surfaceOverlay: 'oklch(0.255 0.011 255)',
  text: 'oklch(0.985 0.003 255)',
  textMuted: 'oklch(0.86 0.012 255)',
  border: 'oklch(0.32 0.012 255)',
  input: 'oklch(0.4 0.016 255)',
  focus: 'oklch(0.8 0.12 235)',
  accent: 'oklch(0.8 0.12 235)',
  accentForeground: 'oklch(0.2 0.04 250)',
  secondary: 'oklch(0.25 0.01 255)',
  secondaryForeground: 'oklch(0.985 0.003 255)',
  muted: 'oklch(0.25 0.01 255)',
  mutedForeground: 'oklch(0.86 0.012 255)',
  placeholder: 'oklch(0.84 0.012 255)',
  secondaryLabel: 'oklch(0.86 0.012 255)',
  iconMuted: 'oklch(0.86 0.012 255)',
  error: 'oklch(0.7 0.18 23)',
  errorForeground: 'oklch(0.87 0.08 22)',
  errorSurface: 'oklch(0.3 0.045 22)',
  warning: 'oklch(0.772406 0.172798 65.367)',
  warningForeground: 'oklch(0.9 0.11 85)',
  warningSurface: 'oklch(0.32 0.035 80)',
  update: 'oklch(0.8 0.12 235)',
  updateForeground: 'oklch(0.89 0.07 235)',
  updateSurface: 'oklch(0.3 0.05 240)',
  accentSurface: 'oklch(0.34 0.055 240)',
  accentSurfaceForeground: 'oklch(0.985 0.003 255)',
  messageSurface: 'oklch(0.296 0.035 252)',
  messageForeground: 'oklch(0.985 0.003 255)',
  messageAction: 'oklch(0.8 0.12 235)',
  messageActionForeground: 'oklch(0.2 0.04 250)',
  messageActionHover: 'oklch(0.9 0.08 235)',
  codeBackground: 'oklch(0.155 0.009 260)',
  codeForeground: 'oklch(0.985 0.003 255)',
  sidebar: 'oklch(0.23 0.011 258)',
  sidebarForeground: 'oklch(0.985 0.003 255)',
  sidebarMutedForeground: 'oklch(0.86 0.012 255)',
  sidebarControlSurface: 'oklch(0.29 0.01 255)',
  sidebarRowHover: 'oklch(0.28 0.012 255)',
  sidebarRowActive: 'oklch(0.32 0.03 240)',
  sidebarRowSelected: 'oklch(0.358 0.04 236)',
  sidebarBorder: 'oklch(0.33 0.012 255)',
  terminalBackground: 'oklch(0.16 0.01 258)',
  terminalForeground: 'oklch(0.985 0.003 255)',
  terminalCursor: 'oklch(0.8 0.12 235)',
  terminalSelection: 'oklch(0.34 0.055 240)',
  terminalScrollbar: 'oklch(0.33 0.01 255)',
  terminalScrollbarHover: 'oklch(0.43 0.01 255)',
}

/**
 * The lowest Contrast Glass paints at. Below 100% the words mix toward the solid room colour, which is not what is
 * behind them when the desktop shows through, and over pure black by day a link on the selected row falls to 1.4:1 at
 * 50%. So Glass holds its words at full strength or stronger; the slider's higher values still apply.
 */
export const GLASS_CONTRAST_FLOOR = 100

/** The custom properties appearance.ts writes on the root while Glass paints, and removes when it stops. */
export const GLASS_TINT_VARIABLES = {
  room: '--theme-glass-room',
  sidebar: '--theme-glass-sidebar',
  raised: '--theme-glass-raised',
  message: '--theme-glass-message',
  rowHover: '--theme-glass-row-hover',
  rowActive: '--theme-glass-row-active',
  rowSelected: '--theme-glass-row-selected',
} as const satisfies Record<Exclude<keyof GlassTints, 'backdrop'>, string>

export const GLASS_BACKDROP_VARIABLES = ['--theme-glass-backdrop-1', '--theme-glass-backdrop-2', '--theme-glass-backdrop-3'] as const

/** Every custom property Glass writes, with its value for one half. */
export function glassTintDeclarations(appearance: ThemeAppearance): ReadonlyArray<readonly [string, string]> {
  const tints = GLASS_TINTS[appearance]
  return [
    ...Object.entries(GLASS_TINT_VARIABLES).map(([key, variable]) => [variable, tints[key as keyof typeof GLASS_TINT_VARIABLES]] as const),
    ...GLASS_BACKDROP_VARIABLES.map((variable, index) => [variable, tints.backdrop[index]!] as const),
  ]
}

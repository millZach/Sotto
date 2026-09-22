/* PROTOTYPE, throwaway: a theme drawn as Sotto's voice sphere, and a theme's colours as CSS variables. */

import React, { type CSSProperties, type ReactNode } from 'react'

import { themeBrand } from '../../../../../../shared/themeBranding'
import type { ThemeAppearance, ThemeColors, ThemeDefinition } from '../../../../../../shared/themes/library'
import { colorsFor } from './prototypeState'

/** The colours a theme paints a half with, falling back to its other half when it has only one. */
export function paint(theme: ThemeDefinition, mode: ThemeAppearance): { colors: ThemeColors; mode: ThemeAppearance } {
  const own = colorsFor(theme, mode)
  if (own) return { colors: own, mode }
  const other = mode === 'light' ? 'dark' : 'light'
  return { colors: colorsFor(theme, other) ?? theme.colors, mode: other }
}

/** A theme's roles as `--r-*` variables, so a stylesheet can draw a miniature of the room in it. */
export function roomVars(colors: ThemeColors): CSSProperties {
  return {
    '--r-canvas': colors.canvas,
    '--r-toolbar': colors.toolbar,
    '--r-toolbar-border': colors.toolbarBorder,
    '--r-surface': colors.surface,
    '--r-raised': colors.surfaceRaised,
    '--r-text': colors.text,
    '--r-muted': colors.textMuted,
    '--r-border': colors.border,
    '--r-accent': colors.accent,
    '--r-on-accent': colors.accentForeground,
    '--r-message': colors.messageSurface,
    '--r-action': colors.messageAction,
    '--r-sidebar': colors.sidebar,
    '--r-sidebar-text': colors.sidebarForeground,
    '--r-sidebar-row': colors.sidebarRowActive,
    '--r-sidebar-border': colors.sidebarBorder,
  } as CSSProperties
}

export function Sphere({ theme, mode, size, className }: {
  readonly theme: ThemeDefinition
  readonly mode: ThemeAppearance
  readonly size: number
  readonly className?: string
}): ReactNode {
  const painted = paint(theme, mode)
  const [light, dark] = themeBrand(painted.colors, painted.mode).orb
  return (
    <span
      className={`proto-sphere${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ width: size, height: size, '--sphere-light': light, '--sphere-dark': dark } as CSSProperties}
    />
  )
}

/*
 * Theme previews: the glowing preview circle and a card's pair of circles.
 *
 * Ported from T3 Code's apps/web/src/components/settings/ThemePreviewCircles.tsx
 * and packages/shared/src/themePreview.ts at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3. MIT License, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md.
 *
 * Every colour here is a canonical theme colour or a fixed hex constant, so
 * the inline styles cannot carry anything but a colour.
 */

import React, { type CSSProperties, type ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'

import type { ThemeAppearance } from '../../../../../shared/themes/library'
import type { ThemeCardPreview, ThemeMode, ThemePreviewColors } from './themeLibrary'

const PREVIEW_RENDER_SPECS = {
  light: {
    baseTarget: '#ffffff',
    baseWeight: 0.8,
    blur: 3,
    scale: 1.1,
    accent: { center: [0.72, 0.22], middleOffset: 0.28, middleOpacity: 0.72, endOffset: 0.58 },
    action: { center: [0.18, 0.82], startOpacity: 0.45, endOffset: 0.55 },
  },
  dark: {
    baseTarget: '#09090b',
    baseWeight: 0.8,
    blur: 3,
    scale: 1.1,
    accent: { center: [0.28, 0.78], middleOffset: 0.28, middleOpacity: 0.62, endOffset: 0.58 },
    action: { center: [0.82, 0.18], startOpacity: 0.45, endOffset: 0.55 },
  },
} as const

const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`

// Interpolating in oklab keeps the glow falloff even; the canvas stays dominant
// so a light and a dark circle never read alike.
function previewStyle(colors: ThemePreviewColors, mode: ThemeAppearance): CSSProperties {
  const spec = PREVIEW_RENDER_SPECS[mode]
  const accentAt = `${percent(spec.accent.center[0])} ${percent(spec.accent.center[1])}`
  const actionAt = `${percent(spec.action.center[0])} ${percent(spec.action.center[1])}`
  return {
    backgroundColor: `color-mix(in oklab, ${colors.canvas} ${percent(spec.baseWeight)}, ${spec.baseTarget})`,
    backgroundImage: [
      `radial-gradient(circle at ${accentAt} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${percent(spec.accent.middleOpacity)}, transparent) ${percent(spec.accent.middleOffset)}, transparent ${percent(spec.accent.endOffset)})`,
      `radial-gradient(circle at ${actionAt} in oklab, color-mix(in oklab, ${colors.messageAction} ${percent(spec.action.startOpacity)}, transparent) 0%, transparent ${percent(spec.action.endOffset)})`,
    ].join(', '),
    filter: `blur(${spec.blur}px)`,
    transform: `scale(${spec.scale})`,
  }
}

export function ThemePreviewCircle({ colors, mode, small = false }: {
  readonly colors: ThemePreviewColors
  readonly mode: ThemeAppearance
  readonly small?: boolean
}): ReactNode {
  return (
    <span className="theme-orb" data-mode={mode} data-size={small ? 'small' : undefined} aria-hidden="true">
      <span className="theme-orb__glow" style={previewStyle(colors, mode)} />
    </span>
  )
}

/**
 * A card's light and dark swatches. Clicking one assigns the theme to that half;
 * the sun and moon identify each choice, and an assigned half carries a ring.
 */
export function ThemePreviewCircles({ label, previews, activeModes, onSelectMode }: {
  readonly label: string
  readonly previews: readonly ThemeCardPreview[]
  readonly activeModes: readonly ThemeAppearance[]
  readonly onSelectMode: (mode: ThemeAppearance) => void
}): ReactNode {
  return (
    <div className="theme-card__swatches">
      {previews.map(preview => {
        const picked = activeModes.includes(preview.mode)
        return (
          <button
            key={preview.mode}
            type="button"
            className="theme-palette-swatch tt-focusable"
            aria-label={`Use ${label} ${preview.mode} mode`}
            aria-pressed={picked}
            title={preview.mode === 'light' ? 'Use for light mode only' : 'Use for dark mode only'}
            style={{ backgroundColor: preview.colors.canvas, '--swatch-accent': preview.colors.accent } as CSSProperties}
            onClick={event => {
              event.stopPropagation()
              onSelectMode(preview.mode)
            }}
          >
            <span className="theme-palette-swatch__sidebar" style={{ backgroundColor: preview.colors.sidebar }} />
            <span className="theme-palette-swatch__accent" style={{ backgroundColor: preview.colors.accent }} />
            <span className="theme-palette-swatch__mode" aria-hidden="true">
              {preview.mode === 'light' ? <Sun size={13} /> : <Moon size={13} />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export const MODE_LABELS: Readonly<Record<ThemeMode, string>> = { system: 'System', light: 'Light', dark: 'Dark' }

/*
 * Theme previews: the glowing preview circle, a card's pair of circles, and
 * the miniature app drawn on the mode tiles.
 *
 * Ported from T3 Code's apps/web/src/components/settings/ThemePreviewCircles.tsx,
 * ThemeWireframe.tsx and packages/shared/src/themePreview.ts at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3. MIT License, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md. The wireframe keeps T3's geometry
 * but draws Sotto's room: sidebar, a thread, the composer and the tools island.
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

const WIREFRAME_LINE = 'rgb(127 127 127 / 0.25)'

function WireframePane({ colors, clip }: { readonly colors: ThemePreviewColors; readonly clip?: 'left' | 'right' }): ReactNode {
  const box = (style: CSSProperties, className = 'theme-wireframe__box'): ReactNode => <span className={className} style={style} />
  return (
    <span className="theme-wireframe__pane" data-clip={clip}>
      {box({ inset: 0, backgroundColor: colors.canvas })}
      {box({ top: 0, bottom: 0, left: 0, width: '22%', backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${WIREFRAME_LINE}` })}
      {box({ left: '3%', top: '8%', height: '8%', width: '16%', borderRadius: 4, backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIREFRAME_LINE}` })}
      {box({ left: '3%', top: '22%', height: '7%', width: '16%', borderRadius: 4, backgroundColor: colors.accentSurface })}
      {box({ left: '3%', top: '32%', height: '7%', width: '16%', borderRadius: 4, backgroundColor: colors.messageSurface, opacity: 0.7 })}
      {box({ left: '3%', top: '42%', height: '7%', width: '16%', borderRadius: 4, backgroundColor: colors.messageSurface, opacity: 0.5 })}
      {box({ right: '28%', top: '11%', height: '9%', width: '24%', borderRadius: 6, backgroundColor: colors.messageSurface })}
      {box({ left: '27%', top: '28%', height: '5%', width: '34%', borderRadius: 2, backgroundColor: WIREFRAME_LINE })}
      {box({ left: '27%', top: '38%', height: '5%', width: '26%', borderRadius: 2, backgroundColor: WIREFRAME_LINE })}
      <span className="theme-wireframe__composer" style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIREFRAME_LINE}` }}>
        <span style={{ height: '26%', width: '34%', borderRadius: 999, backgroundColor: WIREFRAME_LINE, opacity: 0.7 }} />
        <span style={{ height: '58%', aspectRatio: '1', borderRadius: 999, backgroundColor: colors.messageAction }} />
      </span>
      <span className="theme-wireframe__island" style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${WIREFRAME_LINE}, 0 2px 5px rgb(0 0 0 / 0.14)` }}>
        {[0, 1, 2].map(row => (
          <span key={row} className="theme-wireframe__row" style={{ top: `${10 + row * 30}%` }}>
            <span style={{ height: '26%', aspectRatio: '1', borderRadius: 999, opacity: 0.55, backgroundColor: row === 0 ? '#34d399' : row === 1 ? colors.messageAction : '#fbbf24' }} />
            <span style={{ height: '30%', width: '52%', borderRadius: 2, backgroundColor: WIREFRAME_LINE }} />
          </span>
        ))}
      </span>
    </span>
  )
}

export function ThemeWireframe({ panes }: {
  readonly panes: ReadonlyArray<{ readonly colors: ThemePreviewColors; readonly clip?: 'left' | 'right' }>
}): ReactNode {
  return (
    <span className="theme-wireframe" aria-hidden="true">
      {panes.map(pane => <WireframePane key={pane.clip ?? 'pane'} colors={pane.colors} {...(pane.clip ? { clip: pane.clip } : {})} />)}
    </span>
  )
}

export const MODE_LABELS: Readonly<Record<ThemeMode, string>> = { system: 'System', light: 'Light', dark: 'Dark' }

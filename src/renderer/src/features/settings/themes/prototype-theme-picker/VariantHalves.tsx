/*
 * PROTOTYPE, throwaway. Variant D, "Day and night columns": the two halves are the idea. A Light column
 * and a Dark column each list the palettes as a flat chord of their colours; you pick one in each. The
 * scheme sits above as a track from Light to Dark with the system in the middle, and the column not in
 * use right now steps back. The Live appearance panel stays on the right.
 */

import React, { type ReactNode } from 'react'
import { Check, Moon, Paintbrush, Plus, Sun } from 'lucide-react'

import { getThemeModes, type ThemeAppearance, type ThemeDefinition } from '../../../../../../shared/themes/library'
import type { PickerProps } from './picker'
import { PALETTE_MOOD } from './prototypeState'
import { roomVars, paint } from './sphere'

const CHORD = ['canvas', 'sidebar', 'raised', 'message', 'accent'] as const

function Column({ p, half, themes }: { readonly p: PickerProps; readonly half: ThemeAppearance; readonly themes: readonly ThemeDefinition[] }): ReactNode {
  const chosen = half === 'light' ? p.shown.lightTheme : p.shown.darkTheme
  const live = p.resolved === half
  const Icon = half === 'light' ? Sun : Moon
  const title = half === 'light' ? 'Light' : 'Dark'
  const note = live
    ? 'Painting the window now.'
    : p.shown.appearance === 'system' ? `Used when ${p.system} turns ${half}.` : `Used when you switch to ${title}.`
  return (
    <section className="proto-c__column" data-live={live} aria-label={`${title} theme`}>
      <header>
        <Icon size={16} aria-hidden="true" />
        <strong>{title}</strong>
        <span>{note}</span>
      </header>
      <div className="proto-c__options" role="radiogroup" aria-label={`${title} theme`}>
        {themes.filter(theme => getThemeModes(theme).includes(half)).map(theme => {
          const picked = chosen === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={picked}
              className="proto-c__option tt-focusable"
              style={roomVars(paint(theme, half).colors)}
              onClick={() => p.use(theme, half)}
            >
              <span className="proto-c__chord" aria-hidden="true">{CHORD.map(part => <i key={part} data-part={part} />)}</span>
              <span className="proto-c__name">{theme.label}{PALETTE_MOOD[theme.id] ? <small className="proto-c__mood">{PALETTE_MOOD[theme.id]}</small> : null}</span>
              {picked ? <Check size={15} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function VariantHalves(p: PickerProps): ReactNode {
  const all = [...p.palettes, ...p.customs]
  const stops = [['light', 'Light'], ['system', `Match ${p.system}`], ['dark', 'Dark']] as const
  return (
    <div className="theme-settings__layout">
      <div className="theme-settings__controls proto-c">
        <div className="proto-c__track" role="group" aria-label="Color scheme" data-at={p.shown.appearance}>
          <span className="proto-c__rail" aria-hidden="true" />
          {stops.map(([mode, label]) => (
            <button key={mode} type="button" className="tt-focusable" aria-pressed={p.shown.appearance === mode} onClick={() => p.onChooseMode(mode)}>
              <span className="proto-c__stop" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        <div className="proto-c__columns">
          <Column p={p} half="light" themes={all} />
          <Column p={p} half="dark" themes={all} />
        </div>
        <div className="proto-c__actions">
          <button type="button" className="tt-focusable" onClick={p.onCreate}><Paintbrush size={14} aria-hidden="true" />Create theme</button>
          <button type="button" className="tt-focusable" onClick={p.onAdd}><Plus size={14} aria-hidden="true" />Add theme</button>
        </div>
        {p.status}
        {p.effort}
        {p.sliders}
      </div>
      {p.livePreview}
    </div>
  )
}

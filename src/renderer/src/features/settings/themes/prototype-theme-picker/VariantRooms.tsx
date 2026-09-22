/*
 * PROTOTYPE, throwaway. Variant C, "Day into night rooms": every theme is a miniature of the Sotto room,
 * cut on a diagonal so the light half runs into the dark half. Press the light side or the dark side to
 * set that half; press the name to use it for both. The rooms are the preview, so the Live appearance
 * panel goes; effort color and the sliders sit below under Interface.
 */

import React, { type ReactNode } from 'react'
import { Check, Moon, Paintbrush, Plus, Sun } from 'lucide-react'

import { getThemeModes, type ThemeAppearance, type ThemeDefinition } from '../../../../../../shared/themes/library'
import type { PickerProps } from './picker'
import { PALETTE_NOTES } from './prototypeState'
import { paint, roomVars } from './sphere'

function MiniRoom({ theme, mode }: { readonly theme: ThemeDefinition; readonly mode: ThemeAppearance }): ReactNode {
  return (
    <span className="proto-room" data-half={mode} style={roomVars(paint(theme, mode).colors)} aria-hidden="true">
      <span className="proto-room__strip"><i /><i /><i /></span>
      <span className="proto-room__body">
        <span className="proto-room__sidebar"><i data-active="true" /><i /><i /><i /></span>
        <span className="proto-room__main">
          <span className="proto-room__bubble" />
          <span className="proto-room__line" />
          <span className="proto-room__line proto-room__line--short" />
          <span className="proto-room__composer"><span className="proto-room__send" /></span>
        </span>
      </span>
    </span>
  )
}

function holding(p: PickerProps, theme: ThemeDefinition): string {
  const light = p.shown.lightTheme === theme.id
  const dark = p.shown.darkTheme === theme.id
  if (light && dark) return 'In use, light and dark'
  if (light) return 'In use for light'
  if (dark) return 'In use for dark'
  return ''
}

export function VariantRooms(p: PickerProps): ReactNode {
  const all = [...p.palettes, ...p.customs]
  return (
    <div className="proto-b">
      <div className="proto-b__head">
        <div>
          <h3 className="theme-settings__subheading">Themes</h3>
          <p className="theme-settings__assignment-hint">Press a name to use it everywhere. Press the light or dark side of a room to use it for that half only.</p>
        </div>
        <div className="proto-b__scheme" role="group" aria-label="Color scheme">
          {([['light', 'Light'], ['system', `Match ${p.system}`], ['dark', 'Dark']] as const).map(([mode, label]) => (
            <button key={mode} type="button" className="tt-focusable" aria-pressed={p.shown.appearance === mode} onClick={() => p.onChooseMode(mode)}>{label}</button>
          ))}
        </div>
      </div>

      <ul className="proto-b__list">
        {all.map(theme => {
          const modes = getThemeModes(theme)
          const state = holding(p, theme)
          return (
            <li key={theme.id} className="proto-b__row" data-active={state !== '' || undefined}>
              <span className="proto-b__rooms">
                {modes.includes('light') ? <MiniRoom theme={theme} mode="light" /> : null}
                {modes.includes('dark') ? <MiniRoom theme={theme} mode="dark" /> : null}
                {modes.map(half => (
                  <button
                    key={half}
                    type="button"
                    className="proto-b__half tt-focusable"
                    data-half={modes.length === 1 ? 'whole' : half}
                    aria-label={`Use ${theme.label} in ${half} mode`}
                    aria-pressed={(half === 'light' ? p.shown.lightTheme : p.shown.darkTheme) === theme.id}
                    onClick={() => p.use(theme, half)}
                  >
                    {half === 'light' ? <Sun size={12} aria-hidden="true" /> : <Moon size={12} aria-hidden="true" />}
                  </button>
                ))}
              </span>
              <button type="button" className="proto-b__name tt-focusable" aria-pressed={state === 'In use, light and dark'} onClick={() => p.use(theme)}>
                <strong>{theme.label}</strong>
                <span>{PALETTE_NOTES[theme.id] ?? (modes.length === 1 ? `Your own ${modes[0]} theme.` : 'Your own theme.')}</span>
              </button>
              <span className="proto-b__state">{state === '' ? null : <><Check size={13} aria-hidden="true" />{state}</>}</span>
            </li>
          )
        })}
      </ul>
      <div className="proto-b__actions">
        <button type="button" className="proto-b__add tt-focusable" onClick={p.onCreate}><Paintbrush size={14} aria-hidden="true" />Create theme</button>
        <button type="button" className="proto-b__add tt-focusable" onClick={p.onAdd}><Plus size={14} aria-hidden="true" />Add theme</button>
      </div>
      {p.status}

      <h3 className="theme-settings__subheading proto-b__interface">Interface</h3>
      <div className="proto-b__lower">
        <div>{p.effort}</div>
        <div>{p.sliders}</div>
      </div>
    </div>
  )
}

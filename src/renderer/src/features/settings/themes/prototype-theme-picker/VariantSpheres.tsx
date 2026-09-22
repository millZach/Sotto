/*
 * PROTOTYPE, throwaway. Variant B, "Voice spheres": the voice sphere is the swatch. A stage at the top
 * shows the theme under the pointer in its own room, sphere and widget; below it a single row of spheres.
 * The scheme is three icons on the stage. Separate halves are a quiet toggle that splits every sphere.
 */

import React, { useState, type ReactNode } from 'react'
import { AudioLines, Monitor, Moon, Paintbrush, Plus, Sun } from 'lucide-react'

import type { ThemeAppearance, ThemeDefinition } from '../../../../../../shared/themes/library'
import { getThemeModes } from '../../../../../../shared/themes/library'
import type { PickerProps } from './picker'
import { findShown, PALETTE_NOTES } from './prototypeState'
import { paint, roomVars, Sphere } from './sphere'

export function VariantSpheres(p: PickerProps): ReactNode {
  const [hover, setHover] = useState<ThemeDefinition | null>(null)
  const [split, setSplit] = useState(false)
  const current = findShown(p.resolved === 'light' ? p.shown.lightTheme : p.shown.darkTheme, p.shown.customThemes) ?? p.palettes[0]!
  const stage = hover ?? current
  const stagePaint = paint(stage, p.resolved)
  const all = [...p.palettes, ...p.customs]
  const inUse = (theme: ThemeDefinition, half: ThemeAppearance): boolean => (half === 'light' ? p.shown.lightTheme : p.shown.darkTheme) === theme.id

  return (
    <div className="proto-a">
      <section className="proto-a__stage" style={roomVars(stagePaint.colors)} aria-label="Theme preview">
        <div className="proto-a__stage-top">
          <span className="proto-a__stage-kicker">{hover ? 'Previewing' : 'In use'}</span>
          <div className="proto-a__scheme" role="group" aria-label="Color scheme">
            {([['light', Sun, 'Always light'], ['dark', Moon, 'Always dark'], ['system', Monitor, `Match ${p.system}`]] as const).map(([mode, Icon, label]) => (
              <button key={mode} type="button" className="tt-focusable" aria-label={label} title={label} aria-pressed={p.shown.appearance === mode} onClick={() => p.onChooseMode(mode)}>
                <Icon size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        <Sphere theme={stage} mode={p.resolved} size={112} className="proto-a__stage-sphere" />
        <p className="proto-a__stage-name">{stage.label}</p>
        <p className="proto-a__stage-note">{PALETTE_NOTES[stage.id] ?? 'Your own theme.'}</p>
        <div className="proto-a__stage-widget"><AudioLines size={15} aria-hidden="true" />Ready</div>
      </section>

      <div className="proto-a__row-head">
        <h3 className="theme-settings__subheading">Themes</h3>
        <button type="button" className="proto-a__split tt-focusable" aria-pressed={split} onClick={() => setSplit(value => !value)}>
          {split ? 'Use one theme for both' : 'Choose light and dark separately'}
        </button>
      </div>

      <div className="proto-a__row" role="list" onMouseLeave={() => setHover(null)}>
        {all.map(theme => {
          const modes = getThemeModes(theme)
          const both = modes.every(mode => inUse(theme, mode))
          return (
            <div key={theme.id} role="listitem" className="proto-a__item" onMouseEnter={() => setHover(theme)}>
              {split
                ? (
                    <span className="proto-a__halves">
                      {(['light', 'dark'] as const).map(half => modes.includes(half)
                        ? (
                            <button
                              key={half}
                              type="button"
                              className="proto-a__half tt-focusable"
                              data-half={half}
                              aria-label={`Use ${theme.label} in ${half} mode`}
                              aria-pressed={inUse(theme, half)}
                              style={roomVars(paint(theme, half).colors)}
                              onFocus={() => setHover(theme)}
                              onClick={() => p.use(theme, half)}
                            >
                              <Sphere theme={theme} mode={half} size={46} />
                              {half === 'light' ? <Sun size={11} aria-hidden="true" /> : <Moon size={11} aria-hidden="true" />}
                            </button>
                          )
                        : <span key={half} className="proto-a__half proto-a__half--none" />)}
                    </span>
                  )
                : (
                    <button
                      type="button"
                      className="proto-a__disc tt-focusable"
                      aria-label={`Use ${theme.label}`}
                      aria-pressed={both}
                      style={roomVars(paint(theme, p.resolved).colors)}
                      onFocus={() => setHover(theme)}
                      onClick={() => p.use(theme)}
                    >
                      <Sphere theme={theme} mode={p.resolved} size={46} />
                    </button>
                  )}
              <span className="proto-a__label">{theme.label}</span>
            </div>
          )
        })}
        <div role="listitem" className="proto-a__item">
          <button type="button" className="proto-a__disc proto-a__disc--new tt-focusable" aria-label="Create a theme" onClick={p.onCreate}><Paintbrush size={18} aria-hidden="true" /></button>
          <span className="proto-a__label">Create</span>
        </div>
        <div role="listitem" className="proto-a__item">
          <button type="button" className="proto-a__disc proto-a__disc--new tt-focusable" aria-label="Add a theme from a file or Open VSX" onClick={p.onAdd}><Plus size={18} aria-hidden="true" /></button>
          <span className="proto-a__label">Add</span>
        </div>
      </div>
      {p.status}

      <div className="proto-a__lower">
        <div>{p.effort}</div>
        <div>{p.sliders}</div>
      </div>
    </div>
  )
}

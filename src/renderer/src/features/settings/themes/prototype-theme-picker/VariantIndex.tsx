/*
 * PROTOTYPE, throwaway. Variant E, "Index, try it on": no swatches at all. The themes are a typeset
 * index of names; pointing at one (or focusing it) repaints the whole window in it, and leaving puts the
 * saved look back. Pressing keeps it. The window is the preview, so there is no preview panel; the right
 * column says what is in use in plain sentences and holds the rest of Appearance.
 */

import React, { type ReactNode } from 'react'
import { Paintbrush, Plus } from 'lucide-react'

import { getThemeModes, type ThemeDefinition } from '../../../../../../shared/themes/library'
import type { PickerProps } from './picker'
import { findShown } from './prototypeState'
import { paint } from './sphere'

function Dots({ theme }: { readonly theme: ThemeDefinition }): ReactNode {
  return (
    <span className="proto-d__dots" aria-hidden="true">
      {getThemeModes(theme).map(mode => {
        const { colors } = paint(theme, mode)
        return <i key={mode} style={{ backgroundColor: colors.canvas, borderColor: colors.accent, color: colors.accent }} />
      })}
    </span>
  )
}

export function VariantIndex(p: PickerProps): ReactNode {
  const all = [...p.palettes, ...p.customs]
  const light = findShown(p.shown.lightTheme, p.shown.customThemes)?.label ?? 'Sotto'
  const dark = findShown(p.shown.darkTheme, p.shown.customThemes)?.label ?? 'Sotto'
  const schemes = [['light', 'always light'], ['dark', 'always dark'], ['system', `light or dark with ${p.system}`]] as const
  return (
    <div className="proto-d">
      <div className="proto-d__index">
        <p className="proto-d__hint">Point at a name to try it on. Press to keep it.</p>
        <ol className="proto-d__names" onMouseLeave={() => p.tryOn(null)}>
          {all.map(theme => {
            const holdsLight = p.shown.lightTheme === theme.id
            const holdsDark = p.shown.darkTheme === theme.id
            const modes = getThemeModes(theme)
            return (
              <li key={theme.id} data-active={holdsLight || holdsDark || undefined}>
                <button
                  type="button"
                  className="proto-d__name tt-focusable"
                  aria-pressed={modes.every(mode => (mode === 'light' ? holdsLight : holdsDark))}
                  onMouseEnter={() => p.tryOn(theme)}
                  onFocus={() => p.tryOn(theme)}
                  onBlur={() => p.tryOn(null)}
                  onClick={() => p.use(theme)}
                >
                  <Dots theme={theme} />
                  <span className="proto-d__label">{theme.label}</span>
                </button>
                {modes.length === 2
                  ? (
                      <span className="proto-d__only">
                        <button type="button" className="tt-focusable" aria-pressed={holdsLight} onMouseEnter={() => p.tryOn(theme, 'light')} onClick={() => p.use(theme, 'light')}>light only</button>
                        <button type="button" className="tt-focusable" aria-pressed={holdsDark} onMouseEnter={() => p.tryOn(theme, 'dark')} onClick={() => p.use(theme, 'dark')}>dark only</button>
                      </span>
                    )
                  : <span className="proto-d__only"><span>{modes[0]} only</span></span>}
              </li>
            )
          })}
        </ol>
        <div className="proto-d__actions">
          <button type="button" className="tt-focusable" onClick={p.onCreate}><Paintbrush size={14} aria-hidden="true" />Create theme</button>
          <button type="button" className="tt-focusable" onClick={p.onAdd}><Plus size={14} aria-hidden="true" />Add theme</button>
        </div>
        {p.status}
      </div>

      <aside className="proto-d__side">
        <div className="proto-d__now">
          <p>
            Sotto is{' '}
            {schemes.map(([mode, label], index) => (
              <React.Fragment key={mode}>
                <button type="button" className="proto-d__choice tt-focusable" aria-pressed={p.shown.appearance === mode} onClick={() => p.onChooseMode(mode)}>{label}</button>
                {index === 0 ? ', ' : index === 1 ? ' or ' : '.'}
              </React.Fragment>
            ))}
          </p>
          <p>{light === dark ? <>Both halves wear <strong>{light}</strong>.</> : <>Light wears <strong>{light}</strong>. Dark wears <strong>{dark}</strong>.</>}</p>
        </div>
        {p.effort}
        {p.sliders}
      </aside>
    </div>
  )
}

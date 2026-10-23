import React, { useId, type ReactNode } from 'react'

import {
  MENU_BAR_OWL_BODIES,
  MENU_BAR_OWL_BODY_LABELS,
  MENU_BAR_OWL_BODY_SWATCHES,
  MENU_BAR_OWL_EYES,
  MENU_BAR_OWL_EYES_LABELS,
  MENU_BAR_OWL_EYES_SWATCHES,
  type MenuBarOwlBody,
  type MenuBarOwlEyes,
} from '../../../../shared/menuBarOwl'
import './menuBarOwl.css'

/**
 * Settings → Appearance → Menu bar owl (ADR-0114): the colour of the owl's body and of its eyes. Each swatch is the
 * colour the frames are drawn in, so what the user presses is what the bar shows.
 */
export function MenuBarOwlSettings({ body, eyes, onChoose }: {
  readonly body: MenuBarOwlBody
  readonly eyes: MenuBarOwlEyes
  readonly onChoose: (patch: { menuBarOwlBody: MenuBarOwlBody } | { menuBarOwlEyes: MenuBarOwlEyes }, successText: string) => void
}): ReactNode {
  return (
    <div className="menu-bar-owl">
      <h3 className="theme-settings__subheading">Menu bar owl</h3>
      <p className="theme-settings__assignment-hint">The owl perched on a branch in your menu bar.</p>
      <SwatchGroup
        title="Body"
        part="body"
        ids={MENU_BAR_OWL_BODIES}
        labels={MENU_BAR_OWL_BODY_LABELS}
        swatches={MENU_BAR_OWL_BODY_SWATCHES}
        value={body}
        onChoose={id => onChoose({ menuBarOwlBody: id }, 'Owl body saved.')}
      />
      <SwatchGroup
        title="Eyes"
        part="eye"
        ids={MENU_BAR_OWL_EYES}
        labels={MENU_BAR_OWL_EYES_LABELS}
        swatches={MENU_BAR_OWL_EYES_SWATCHES}
        value={eyes}
        onChoose={id => onChoose({ menuBarOwlEyes: id }, 'Owl eyes saved.')}
      />
    </div>
  )
}

function SwatchGroup<Id extends string>({ title, part, ids, labels, swatches, value, onChoose }: {
  readonly title: string
  readonly part: string
  readonly ids: readonly Id[]
  readonly labels: Record<Id, string>
  readonly swatches: Record<Id, string>
  readonly value: Id
  readonly onChoose: (id: Id) => void
}): ReactNode {
  const headingId = useId()
  return (
    <div className="menu-bar-owl__part">
      <h4 className="menu-bar-owl__title" id={headingId}>{title}</h4>
      <div className="menu-bar-owl__grid" role="group" aria-labelledby={headingId}>
        {ids.map(id => {
          const active = id === value
          return (
            <button
              key={id}
              type="button"
              className="menu-bar-owl__choice tt-focusable"
              aria-pressed={active}
              aria-label={`Use ${labels[id]} as the owl's ${part} color${active ? ', currently active' : ''}`}
              onClick={() => onChoose(id)}
            >
              <span className="menu-bar-owl__swatch" style={{ background: swatches[id] }} aria-hidden="true" />
              <span>{labels[id]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

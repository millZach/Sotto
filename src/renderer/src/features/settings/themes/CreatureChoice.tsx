import React, { useId, type ReactNode } from 'react'

import { CREATURES, CREATURE_LABELS, type Creature } from '../../../../../shared/settings'
import { CreatureWalk } from '../../../agents/CreatureWalk'

/**
 * Settings → Appearance → Creature: each character walking in its own frame above its name, laid out like the
 * effort colours. A plain setting, not a palette choice, so it is saved directly rather than previewed.
 */
export function CreatureChoice({ value, onChoose }: {
  readonly value: Creature
  readonly onChoose: (creature: Creature) => void
}): ReactNode {
  const headingId = useId()
  return (
    <div className="creature-choice">
      <h3 className="theme-settings__subheading" id={headingId}>Creature</h3>
      <p className="theme-settings__assignment-hint">The little character that stands above a thread’s composer while it watches, works or waits.</p>
      <div className="creature-choice__grid" role="group" aria-labelledby={headingId}>
        {CREATURES.map(id => {
          const active = id === value
          return (
            <button
              key={id}
              type="button"
              className="creature-option tt-focusable"
              aria-pressed={active}
              aria-label={`Use ${CREATURE_LABELS[id]} as the creature${active ? ', currently active' : ''}`}
              onClick={() => onChoose(id)}
            >
              <span className="creature-option__preview"><CreatureWalk creature={id} /></span>
              <span className="creature-option__name">{CREATURE_LABELS[id]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

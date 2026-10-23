import React, { useId, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'

import { CREATURES, CREATURE_LABELS, type Creature } from '../../../../../shared/settings'
import { Toggle } from '../../../components/Toggle'
import { CreatureWalk } from '../../../agents/CreatureWalk'

/**
 * Settings → Appearance → Creature: each character walking in its own frame above its name, laid out like the
 * effort colours. A plain setting, not a palette choice, so it is saved directly rather than previewed.
 */
export function CreatureChoice({ value, shown, onChoose, onShow }: {
  readonly value: Creature
  readonly shown: boolean
  readonly onChoose: (creature: Creature) => void
  /** Absent where the switch is held to Owl (ADR-0072): no switch, and the choice always shows. */
  readonly onShow?: ((shown: boolean) => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  return (
    <div className="creature-choice">
      <h3 className="theme-settings__subheading" id={headingId}><Trans>Creature</Trans></h3>
      <p className="theme-settings__assignment-hint"><Trans>The little character that stands above a thread’s composer while it watches, works or waits.</Trans></p>
      {onShow ? <Toggle label={t`Show the creature`} checked={shown} onCheckedChange={onShow} description={t`Off, nothing stands above the composer. The sidebar still says when a thread is working or waiting.`} /> : null}
      {shown ? <div className="creature-choice__grid" role="group" aria-labelledby={headingId}>
        {CREATURES.map(id => {
          const active = id === value
          const creature = CREATURE_LABELS[id]
          return (
            <button
              key={id}
              type="button"
              className="creature-option tt-focusable"
              aria-pressed={active}
              aria-label={active ? t`Use ${creature} as the creature, currently active` : t`Use ${creature} as the creature`}
              onClick={() => onChoose(id)}
            >
              <span className="creature-option__preview"><CreatureWalk creature={id} /></span>
              <span className="creature-option__name">{CREATURE_LABELS[id]}</span>
            </button>
          )
        })}
      </div> : null}
    </div>
  )
}

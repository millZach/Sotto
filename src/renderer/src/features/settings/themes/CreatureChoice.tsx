import React, { useId, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'

import { CREATURES, CREATURE_LABELS, type Creature } from '../../../../../shared/settings'
import { Toggle } from '../../../components/Toggle'

/**
 * Settings → Appearance → Creature: the switch that shows it, where Owl offers one (ADR-0072), and a row choosing the
 * character. The preview beside the page shows the chosen one walking above its composer. A plain setting, not a
 * palette choice, so it is saved directly rather than previewed.
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
    <>
      {onShow ? <Toggle setting="show-creature" label={t`Show the creature`} checked={shown} onCheckedChange={onShow} description={t`Off, nothing stands above the composer. The sidebar still says when a thread is working or waiting.`} /> : null}
      {shown ? (
        <div className="appearance-row creature-choice">
          <div className="appearance-row__text">
            <p className="tt-field__label" id={headingId}><Trans>Creature</Trans></p>
            <p className="tt-field__description tt-paragraph"><Trans>The little character that stands above a thread’s composer while it watches, works or waits.</Trans></p>
          </div>
          <div className="creature-choice__grid" role="group" data-setting="creature" aria-labelledby={headingId}>
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
                  {CREATURE_LABELS[id]}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </>
  )
}

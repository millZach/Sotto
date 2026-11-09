import React from 'react'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS } from '../../../../shared/agents'
import type { CouncilAskedByView } from '../../../../shared/council'

/**
 * Who asked a Council or a Climb that a thread's agent started (ADR-0177, November 5, 2026): the agent's provider, and the
 * user's own words that asked, while Keep local history keeps them.
 */
export function AskedByLine({ askedBy }: { readonly askedBy: CouncilAskedByView | undefined }): React.JSX.Element | null {
  const { t } = useLingui()
  if (!askedBy) return null
  const provider = PROVIDER_LABELS[askedBy.provider], words = askedBy.words
  return <p className="council-entry__asked tt-paragraph">
    {words ? t({ message: `Asked by ${provider}: “${words}”`, comment: 'Under a Council an agent started at the user\'s request; the provider\'s name, then the user\'s own message quoted.' })
      : t({ message: `Asked by ${provider}`, comment: 'Under a Council an agent started at the user\'s request, when the user\'s words are not kept.' })}
  </p>
}

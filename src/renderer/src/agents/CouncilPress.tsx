import React, { type ReactNode } from 'react'
import { Landmark } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

/** Beside Fork from here: opens the Council tab of this thread's drawer with this thread chosen and this reply as the question (ADR-0177). */
export function CouncilPress({ text, ask }: { readonly text: string; readonly ask: (text: string) => void }): ReactNode {
  const { t } = useLingui()
  return <button type="button" className="thread-message__council tt-focusable" aria-label={t`Ask the Council about this reply`} onClick={() => ask(text)}>
    <Landmark size={14} aria-hidden="true" /><span>{t`Ask the Council`}</span></button>
}

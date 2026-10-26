import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { isThreadProviderConnected, type AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './providerRecovery.css'

/**
 * Whether the coordinator holds a draft recovered after a provider retirement: one that names no thread. This notice
 * shows it, and the empty Threads page leaves it here.
 */
export function isRecoveredDraft(state: AgentState): boolean {
  return Boolean(state.providerUpgrade && state.draftThreadId === null && (state.draft.trim() || state.draftAttachments?.length))
}

/** Recovery is a draft review action, never a retry of the retired provider's command. */
export function ProviderUpgradeNotice({ state, command, threadId, localDraftPresent = false }: {
  readonly state: AgentState; readonly command: AgentConnection['command']; readonly threadId?: string | undefined
  readonly localDraftPresent?: boolean
}): ReactNode {
  const { t } = useLingui()
  const upgrade = state.providerUpgrade
  if (!upgrade) return null
  const expiresAt = upgrade.migratedAt + 7 * 86_400_000
  const target = state.host.threads.find(thread => thread.id === threadId)
  const recovered = isRecoveredDraft(state)
  const until = new Date(expiresAt).toLocaleDateString()
  return <section className="provider-recovery" aria-label={t`Recovered work`}>
    {recovered ? <>
      <p className="tt-paragraph">{t`Your saved draft is kept. Check any earlier send in the previous provider before using it again.`}</p>
      <label>{t`Recovered draft`}<textarea rows={3} value={state.draft} readOnly /></label>
      {!!state.draftAttachments?.length && <p>{state.draftAttachments.map(image => image.name).join(', ')}</p>}
      <div className="agent-actions">
        {threadId ? <Button variant="secondary" disabled={localDraftPresent || state.globalLaneBusy || !target || !isThreadProviderConnected(state.host, target)} onClick={() => void command({ type: 'recover-draft', threadId })}>{t`Use saved draft here`}</Button> : <span>{t`Choose or create a thread to review this draft.`}</span>}
        <Button variant="ghost" disabled={state.globalLaneBusy} onClick={() => void command({ type: 'cancel-draft' })}>{t`Clear saved draft`}</Button>
      </div>
      {localDraftPresent ? <p className="tt-paragraph">{t`Finish or clear the current prompt, or choose another thread, before using this saved draft.`}</p> : null}
    </> : null}
    <details><summary>{t`Previous-provider recovery`}</summary>
      <p className="tt-paragraph">{t`Automatic management and pending actions were stopped in Sotto. Native work was not cancelled or replayed.`}</p>
      <p className="tt-paragraph">{Date.now() < expiresAt ? t({ message: `The local recovery record is kept until ${until}.`, comment: '{until} is a date.' }) : t`The recovery record retention period has ended.`}</p>
      <code>{upgrade.recoveryPath}</code>
    </details>
  </section>
}

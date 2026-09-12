import React, { type ReactNode } from 'react'
import type { AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { Button } from '../components/Button'
import './providerRecovery.css'

/** Recovery is a draft review action, never a retry of the retired provider's command. */
export function ProviderUpgradeNotice({ state, command, threadId }: {
  readonly state: AgentState; readonly command: AgentConnection['command']; readonly threadId?: string | undefined
}): ReactNode {
  const upgrade = state.providerUpgrade
  if (!upgrade) return null
  const expiresAt = upgrade.migratedAt + 7 * 86_400_000
  const recovered = state.draftThreadId === null && Boolean(state.draft || state.draftAttachments?.length)
  return <section className="provider-recovery" aria-label="Recovered work">
    {recovered ? <>
      <p>Your saved draft is kept. Check any earlier send in the previous provider before using it again.</p>
      <label>Recovered draft<textarea rows={3} value={state.draft} readOnly /></label>
      {!!state.draftAttachments?.length && <p>{state.draftAttachments.map(image => image.name).join(', ')}</p>}
      <div className="agent-actions">
        {threadId ? <Button variant="secondary" disabled={state.busy || state.connection !== 'connected'} onClick={() => void command({ type: 'recover-draft', threadId })}>Use saved draft here</Button> : <span>Choose or create a thread to review this draft.</span>}
        <Button variant="ghost" disabled={state.busy} onClick={() => void command({ type: 'cancel-draft' })}>Clear saved draft</Button>
      </div>
    </> : null}
    <details><summary>Previous-provider recovery</summary>
      <p>Automatic management and pending actions were stopped in Sotto. Native work was not cancelled or replayed.</p>
      <p>{Date.now() < expiresAt ? `The local recovery record is kept until ${new Date(expiresAt).toLocaleDateString()}.` : 'The recovery record retention period has ended.'}</p>
      <code>{upgrade.recoveryPath}</code>
    </details>
  </section>
}

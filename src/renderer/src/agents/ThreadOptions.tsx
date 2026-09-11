import React, { useState, type ReactNode } from 'react'
import type { AgentModel, AgentRuntimeMode, AgentState, AgentThread } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { ModelPicker } from './ModelPicker'

export const RUNTIME_LABELS: Record<AgentRuntimeMode, string> = {
  'approval-required': 'Ask for approval',
  'auto-accept-edits': 'Allow edits',
  auto: 'Auto',
  'full-access': 'Full access',
}
export function ThreadOptionFields({ models, modelId, reasoningEffort, runtimeMode, onModel, onReasoning, onRuntime, disabled = false }: {
  readonly models: AgentModel[]
  readonly modelId: string
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly onModel: (id: string) => void
  readonly onReasoning: (effort: string) => void
  readonly onRuntime: (mode: AgentRuntimeMode) => void
  readonly disabled?: boolean
}): ReactNode {
  const model = models.find(item => item.id === modelId)
  const reasoning = reasoningEffort ?? model?.defaultReasoningEffort ?? ''
  return <div className="thread-options">
    <div className="thread-options__model"><span>Model</span><ModelPicker models={models} modelId={modelId} disabled={disabled} onChange={onModel} /></div>
    {!!model?.reasoningEfforts?.length && <label><span>Reasoning</span><select aria-label="Thread reasoning" title="Reasoning" value={reasoning} disabled={disabled} onChange={event => onReasoning(event.target.value)}>
      {!model.reasoningEfforts.includes(reasoning) && <option value={reasoning} disabled>{reasoning || 'Provider default'}</option>}
      {model.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
    </select></label>}
    {!!model?.runtimeModes?.length && <label><span>Permissions</span><select aria-label="Thread permissions" title="Permissions" value={runtimeMode ?? ''} disabled={disabled} onChange={event => onRuntime(event.target.value as AgentRuntimeMode)}>
      {!runtimeMode && <option value="" disabled>Provider default</option>}
      {runtimeMode && !model.runtimeModes.includes(runtimeMode) && <option value={runtimeMode} disabled>{RUNTIME_LABELS[runtimeMode]}</option>}
      {model.runtimeModes.map(mode => <option key={mode} value={mode}>{RUNTIME_LABELS[mode]}</option>)}
    </select></label>}
  </div>
}

export function ThreadOptions({ thread, state, command }: { readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command'] }): ReactNode {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = saving || state.busy || state.connection !== 'connected' || thread.status === 'running' || thread.requests.length > 0 || Boolean(thread.archivedAt)
  const save = async (patch: { modelId?: string; reasoningEffort?: string; runtimeMode?: AgentRuntimeMode }): Promise<void> => {
    setSaving(true); setError(null)
    try {
      const result = await command({ type: 'configure-thread', threadId: thread.id, ...patch })
      if (!result || result.error) setError(result?.error ?? 'Could not confirm this change. Try again.')
    } finally { setSaving(false) }
  }
  if (!state.host.capabilities.configureThread) return null
  return <div className="thread-options-bar">
    <ThreadOptionFields models={state.host.models} modelId={thread.modelId} reasoningEffort={thread.reasoningEffort} runtimeMode={thread.runtimeMode}
      disabled={disabled} onModel={modelId => void save({ modelId })} onReasoning={reasoningEffort => void save({ reasoningEffort })} onRuntime={runtimeMode => void save({ runtimeMode })} />
    {saving ? <small role="status">Saving...</small> : thread.status === 'running' ? <small>Available after this turn finishes.</small> : null}
    {error && <p className="agent-error" role="alert">{error}</p>}
  </div>
}

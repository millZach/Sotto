import { useState } from 'react'
import { defaultThreadModelId, isSubscriptionReasoning, type AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { folderKey, folderName } from './ProjectChooser'

/** Open a folder from disk as a Sotto project, or open the project that already has it. */
export function useAddProject(state: AgentState, command: AgentConnection['command']): { readonly add: () => Promise<void>; readonly adding: boolean; readonly error: string | null; readonly clearError: () => void } {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async (): Promise<void> => {
    if (adding) return
    setError(null)
    if (state.connections?.find(host => host.hostId === state.hostId)?.kind === 'remote') { setError('Project folders are on the host machine. Add the project there, then reconnect.'); return }
    const picker = window.sotto?.agents?.chooseProjectDirectory
    if (!picker) { setError('Folder browsing is unavailable. Reopen Sotto and try again.'); return }
    setAdding(true)
    try {
      const path = await picker()
      if (!path) return
      const existing = state.host.projects.find(project => folderKey(project.path) === folderKey(path))
      if (existing) { await command({ type: 'select-project', projectId: existing.id }); return }
      const defaultModelId = defaultThreadModelId(state.configuration, state.host.models, state.reasoningAccounts)
      const provider = isSubscriptionReasoning(state.configuration.reasoning) ? state.configuration.reasoning
        : state.host.models.find(model => model.id === defaultModelId)?.providerId
      const result = await command({ type: 'create-project', title: folderName(path), path, useExisting: true, ...(provider ? { provider } : {}) })
      if (result === null || result.error !== null) setError(result?.error ?? 'Could not confirm the new project. Choose the folder again to check; it will not be added twice.')
    } catch { setError('Could not open the folder browser. Try again.') }
    finally { setAdding(false) }
  }
  return { add, adding, error, clearError: () => setError(null) }
}

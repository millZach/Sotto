import React, { useRef, useState, type ReactNode } from 'react'
import { defaultThreadModelId, hostForThread, isSubscriptionReasoning, PROJECT_FOLDER_MISSING, type AgentState } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import type { AgentConnection } from './AgentContext'
import { FolderBrowserDialog, type FolderChoice } from './FolderBrowserDialog'
import { projectAtFolder } from './projectFolders'

/**
 * Add project: choose the computer the project lives on when more than one is paired, then a folder there, and open
 * it as a Sotto project on that host, or open the project that already has it. The folder is made on the host when
 * it is new, by the same create-project that attaches an existing one. Only a listed folder is sent as existing, so one
 * that has gone since it was listed is refused rather than made again. `hostId` fixes the computer, as first-run setup
 * does for this one, so the dialog asks only for a folder.
 */
export function useAddProject(state: AgentState, command: AgentConnection['command'], options: { readonly hostId?: string | undefined } = {}): {
  readonly add: () => Promise<void>; readonly adding: boolean; readonly error: string | null; readonly clearError: () => void; readonly dialog: ReactNode
} {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const latest = useRef(state)
  latest.current = state
  const unansweredNew = useRef(new Set<string>())
  const add = async (): Promise<void> => {
    if (adding) return
    // Reopened, the browser lists the host's folders afresh: a folder an unanswered try made shows as a folder, not a new name.
    unansweredNew.current.clear()
    setError(null); setDialogError(null); setOpen(true)
  }
  const use = async (choice: FolderChoice): Promise<void> => {
    if (adding) return
    setAdding(true); setDialogError(null)
    try {
      // Main adds a project to the host selected for new work, so the chosen host is selected first.
      let current = latest.current
      if (choice.hostId !== current.hostId && current.connections?.length) {
        await window.sotto?.hosts?.command({ type: 'select', hostId: choice.hostId })
        // The chosen host's own settings pick the provider, so read them now rather than wait for the next render.
        current = await window.sotto?.agents?.get?.().catch(() => null) ?? latest.current
      }
      const existing = projectAtFolder(current.host.projects, choice.hostId, choice.path)
      if (existing) {
        const result = await command({ type: 'select-project', projectId: existing.id })
        if (result === null || result.error !== null) { setDialogError(result?.error ?? 'Could not open the project. Nothing was changed. Try again.'); return }
        setOpen(false); return
      }
      const host = hostForThread(current.host, { hostId: choice.hostId })
      const defaultModelId = defaultThreadModelId(current.configuration, host.models, current.reasoningAccounts)
      const provider = isSubscriptionReasoning(current.configuration.reasoning) ? current.configuration.reasoning
        : resolveModel(host.models, defaultModelId)?.providerId
      const send = (asNew: boolean): Promise<AgentState | null> =>
        command({ type: 'create-project', title: choice.name, path: choice.path, ...(asNew ? {} : { useExisting: true }), ...(provider ? { provider } : {}) })
      // A new folder whose first try went unanswered may have been made, so the next try checks for it as existing.
      // When the check finds nothing there, that try made nothing, and the folder is made now.
      const unanswered = `${choice.hostId}:${choice.path}`
      const checking = choice.isNew === true && unansweredNew.current.has(unanswered)
      let asNew = choice.isNew === true && !checking
      if (asNew) unansweredNew.current.add(unanswered)
      let result = await send(asNew)
      if (checking && result?.error === PROJECT_FOLDER_MISSING) { asNew = true; result = await send(true) }
      if (asNew && result !== null) unansweredNew.current.delete(unanswered)
      if (result === null || result.error !== null) { setDialogError(result?.error ?? 'Could not confirm the new project. Choose the folder again to check; it will not be added twice.'); return }
      setOpen(false)
    } catch { setDialogError('Could not add the project. Nothing was changed. Try again.') }
    finally { setAdding(false) }
  }
  const dialog = open ? React.createElement(FolderBrowserDialog, {
    state, hostId: options.hostId, heading: 'Where should this project live?', busy: adding, error: dialogError,
    onUse: choice => { void use(choice) }, onClose: () => { if (!adding) setOpen(false) },
  }) : null
  return { add, adding, error, clearError: () => setError(null), dialog }
}

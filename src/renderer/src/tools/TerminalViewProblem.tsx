import React, { useState, type ReactNode } from 'react'
import { useOptionalAgents } from '../agents/AgentContext'
import { requestAnswerStore } from '../agents/requests/requestAnswers'

/** Reloading the renderer leaves main's terminal processes and output intact. */
export function TerminalViewProblem(): ReactNode {
  const agents = useOptionalAgents()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<'drafts' | 'reload' | null>(null)
  const reload = async (): Promise<void> => {
    setSaving(true)
    for (;;) {
      const saved = await Promise.all([agents?.threadDrafts.flushForReload() ?? true, requestAnswerStore.flushForReload()])
      if (saved.some(value => !value)) {
        setFailure('drafts')
        setSaving(false)
        return
      }
      // Either store may have changed while the other one's save acknowledgement was pending.
      if (agents?.threadDrafts.canReload() !== false && requestAnswerStore.canReload()) break
    }
    try { await window.sotto!.reloadApp() } catch {
      setFailure('reload')
      setSaving(false)
    }
  }
  return <div className="files-problem" role="status">
    <strong>{failure === 'reload' ? 'The window could not reload. Your terminal and drafts are still here. Try again.' : failure === 'drafts' ? 'Some drafts could not be saved. The window was not reloaded, and your drafts are still here. Try again.'
      : 'The terminal view could not load. Your terminal and its output are still here.'}</strong>
    <button type="button" className="files-link tt-focusable" disabled={saving} onClick={() => void reload()}>Reload window</button>
  </div>
}

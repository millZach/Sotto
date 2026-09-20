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
    if ((agents && !await agents.threadDrafts.flushForReload()) || !requestAnswerStore.canReload()) {
      setFailure('drafts')
      setSaving(false)
      return
    }
    try { await window.sotto!.reloadApp() } catch {
      setFailure('reload')
      setSaving(false)
    }
  }
  return <div className="files-problem" role="status">
    <strong>{failure === 'reload' ? 'The window could not reload. Your terminal and drafts are still here. Try again.' : failure === 'drafts' ? 'Some drafts are not saved yet. The window was not reloaded, and your drafts are still here. Save them, then try again.'
      : 'The terminal view could not load. Your terminal and its output are still here.'}</strong>
    <button type="button" className="files-link tt-focusable" disabled={saving} onClick={() => void reload()}>Reload window</button>
  </div>
}

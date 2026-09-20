import React, { useState, type ReactNode } from 'react'
import { useOptionalAgents } from '../agents/AgentContext'

/** Reloading the renderer leaves main's terminal processes and output intact. */
export function TerminalViewProblem(): ReactNode {
  const agents = useOptionalAgents()
  const [saving, setSaving] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const reload = async (): Promise<void> => {
    setSaving(true)
    if (agents && !await agents.threadDrafts.flushForReload()) {
      setUnsaved(true)
      setSaving(false)
      return
    }
    window.location.reload()
  }
  return <div className="files-problem" role="status">
    <strong>{unsaved ? 'Some drafts could not be saved. The window was not reloaded, and your drafts are still here. Try again.'
      : 'The terminal view could not load. Your terminal and its output are still here.'}</strong>
    <button type="button" className="files-link tt-focusable" disabled={saving} onClick={() => void reload()}>Reload window</button>
  </div>
}

import React, { useState, type ReactNode } from 'react'
import type { AppNavigation } from '../../state/AppContext'
import { MemoryInspector } from './MemoryInspector'
import { Questionnaire, emptyQuestionnaire } from './Questionnaire'
import { useMemory } from './useMemory'
import './memory.css'

/** Stays mounted across page changes so an unfinished conversation is not lost. */
export function MemorySurface({ navigation, children }: { navigation: AppNavigation; children: ReactNode }): ReactNode {
  const memory = useMemory(window.sotto?.memory)
  const [draft, setDraft] = useState(emptyQuestionnaire)
  const [dismissed, setDismissed] = useState(false)
  const [requested, setRequested] = useState(false)
  const incomplete = memory.snapshot?.available && memory.snapshot.questionnaireCompletedAt === null
  const questionnaire = incomplete && ((navigation === 'agents' && !dismissed) || (navigation === 'memory' && requested))
  if (questionnaire) return <Questionnaire draft={draft} onChange={setDraft} busy={memory.busy} error={memory.error}
    onSave={async command => {
      const saved = await memory.command(command)
      if (saved) { setRequested(false); setDismissed(true) }
      return saved
    }} onLater={() => { setDismissed(true); setRequested(false) }} />
  if (navigation === 'memory') return <MemoryInspector controller={memory} onQuestionnaire={() => setRequested(true)} />
  if (navigation === 'agents' && memory.snapshot === null && !memory.error && window.sotto?.memory) return <p className="memory-page" role="status">Reading your preferences…</p>
  return children
}

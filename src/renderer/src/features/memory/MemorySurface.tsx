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
  const [requested, setRequested] = useState(false)
  const incomplete = memory.snapshot?.available && memory.snapshot.questionnaireCompletedAt === null
  const questionnaire = incomplete && navigation === 'memory' && requested
  if (questionnaire) return <Questionnaire draft={draft} onChange={setDraft} busy={memory.busy} error={memory.error}
    onSave={async command => {
      const saved = await memory.command(command)
      if (saved) setRequested(false)
      return saved
    }} onLater={() => { setRequested(false) }} />
  if (navigation === 'memory') return <MemoryInspector controller={memory} onQuestionnaire={() => setRequested(true)} />
  return children
}

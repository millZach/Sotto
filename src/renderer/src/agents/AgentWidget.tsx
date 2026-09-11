import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Mic, MicOff, VolumeX, Workflow } from 'lucide-react'

import type { WidgetPresentation, WidgetDragPayload } from '../../../shared/contracts'
import { useWidgetDragGesture } from '../widget/useWidgetDragGesture'
import { supportsAgentSupervision, type AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { AgentComposer, AgentLatestResponse, AgentManualNotice, AgentQueue } from './AgentView'

export function AgentWidget({ state, command, onPresentationChange, onToggle, onDrag, visibilityGeneration, dragCancellationVersion }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onPresentationChange?: ((presentation: WidgetPresentation) => void) | undefined
  readonly onToggle?: (() => void) | undefined
  readonly onDrag?: ((payload: WidgetDragPayload) => void) | undefined
  readonly visibilityGeneration: number
  readonly dragCancellationVersion: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const dragGeneration = useRef(visibilityGeneration)
  const surface = useWidgetDragGesture(onToggle, phase => {
    if (phase.phase === 'start') dragGeneration.current = visibilityGeneration
    onDrag?.({ ...phase, generation: dragGeneration.current })
  }, undefined, dragCancellationVersion)
  const previousReadyCount = useRef(state.queue.length)
  const previousComposing = useRef(state.composing)
  const previousManual = useRef(false)
  const active = state.host.threads.find((thread) => thread.id === state.activeThreadId)
  const project = state.host.projects.find((entry) => entry.id === active?.projectId)
  const assignment = state.assignments.find((entry) => entry.threadId === active?.id)
  const manual = assignment?.mode === 'manual'
  useEffect(() => {
    const voiceStartedPrompt = state.composing && !previousComposing.current && state.voice.status === 'listening'
    if (state.queue.length > previousReadyCount.current || voiceStartedPrompt || (manual && !previousManual.current)) setExpanded(true)
    previousReadyCount.current = state.queue.length
    previousComposing.current = state.composing
    previousManual.current = manual
  }, [state.queue.length, state.composing, state.voice.status, manual])
  useEffect(() => { onPresentationChange?.(expanded ? 'agents-expanded' : 'agents-compact') }, [expanded, onPresentationChange])
  const status = state.voice.status === 'listening' ? 'Listening · say “send it”'
    : state.voice.status === 'speaking' ? 'Sotto is speaking'
    : state.voice.status === 'muted' ? 'Microphone muted'
    : state.voice.status === 'error' ? 'Voice needs attention'
    : state.voice.status === 'wake' ? 'Say “Hey Sotto”'
    : `${state.queue.length} waiting · ${state.assignments.length} assigned`
  return <aside className="agent-widget" aria-label="Sotto agent control center">
    <div className="agent-widget__panel">
      <header className="agent-widget__header"><button type="button" className="agent-widget__move" aria-label="Start dictation or drag widget" {...surface.surfaceProps}><Workflow size={19} aria-hidden="true" /><span><strong>{active?.title ?? 'Sotto agents'}</strong><small>{status}</small></span></button>
        <button className="agent-widget__icon" type="button" aria-label={state.voice.status === 'muted' ? 'Unmute listening' : 'Mute listening'} onClick={() => void command({ type: 'voice', action: state.voice.status === 'muted' ? 'unmute' : 'mute' })}>{state.voice.status === 'muted' ? <Mic size={15} /> : <MicOff size={15} />}</button>
        <button className="agent-widget__icon" type="button" aria-label="Stop speech" onClick={() => void command({ type: 'voice', action: 'stop-speaking' })}><VolumeX size={15} /></button>
        <button className="agent-widget__icon" type="button" aria-expanded={expanded} aria-label={expanded ? 'Collapse agent controls' : 'Expand agent controls'} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>
      </header>
      {expanded ? <div className="agent-widget__body">
        <div><span className="agent-eyebrow">{project?.title ?? 'T3 Code'}</span><label className="tt-visually-hidden" htmlFor="widget-agent-thread">Active thread</label>
          <select id="widget-agent-thread" value={state.activeThreadId ?? ''} onChange={(event) => void command({ type: 'select-thread', threadId: event.target.value })}>
            <option value="" disabled>Select a thread</option>{state.host.threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select></div>
        {state.error ? <p className="agent-error" role="alert">{state.error}</p> : null}
        {state.voice.error ? <p className="agent-error" role="alert">{state.voice.error}</p> : null}
        <AgentQueue state={state} command={command} compact />
        <AgentManualNotice state={state} command={command} />
        {active !== undefined && assignment === undefined ? <div className="agent-widget__assignment"><p className="agent-muted">Manage this thread to send prompts through Sotto.</p><button type="button" className="tt-button tt-button--secondary" disabled={state.busy || state.connection !== 'connected' || !supportsAgentSupervision(state.host.capabilities)} onClick={() => void command({ type: 'assign', threadId: active.id })}>Manage this thread</button></div> : null}
        <AgentLatestResponse thread={active} compact />
        <AgentComposer state={state} command={command} compact />
        <div className="agent-widget__controls"><button type="button" className="tt-button tt-button--ghost" onClick={() => void command({ type: 'voice', action: 'sleep' })}>Stop listening</button></div>
      </div> : null}
    </div>
  </aside>
}

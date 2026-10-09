import type { AgentState } from '../../../shared/agents'
import React, { type ReactNode } from 'react'

import { isThreadClosed } from '../../../shared/threadActivity'
import type { AgentConnection } from '../agents/AgentContext'

/** An explicitly opened extension of the pill, never a replacement widget. */
export function WidgetThreads({ state, command }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
}): ReactNode {
  const active = state.host.threads.find(thread => thread.id === state.activeThreadId)
  const unsettled = state.host.threads.filter(thread => !isThreadClosed(thread))
  const settled = state.host.threads.filter(isThreadClosed)
  const threadList = (threads: typeof unsettled): ReactNode => threads.map(thread => (
    <button type="button" className="widget-threads__thread" key={thread.id}
      aria-pressed={thread.id === state.activeThreadId}
      onClick={() => { void command({ type: 'select-thread', threadId: thread.id }) }}>
      <span>{thread.title}</span>
      <small>{state.host.projects.find(project => project.id === thread.projectId)?.title}</small>
    </button>
  ))

  return <section className="widget-threads" aria-label="Threads">
    <h2>Threads <span>{unsettled.length} unsettled</span></h2>
    <div className="widget-threads__list">
      {threadList(unsettled)}
      {unsettled.length === 0 && <p className="agent-muted">No unsettled threads.</p>}
      {settled.length > 0 && <details><summary>Settled ({settled.length})</summary>{threadList(settled)}</details>}
    </div>
    {state.connection !== 'connected' && <p className="agent-muted">Connect your thread provider in Sotto.</p>}
    {state.error && <p className="agent-error" role="alert">{state.error}</p>}
    {active && <div className="widget-threads__detail">
      <h2>{active.title}</h2>
      <p>{active.summary?.lastAssistant?.text ?? active.messages.findLast(message => message.role === 'assistant')?.text}</p>
      <p className="agent-muted">Open Sotto to continue this thread.</p>
    </div>}
  </section>
}

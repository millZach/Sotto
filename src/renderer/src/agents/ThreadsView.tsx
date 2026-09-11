import React, { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'

import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { clockLabel, describeThreads, groupThreads, listThreads, providerGlyph, threadCounts, type ThreadRow } from './threadFacts'
import './threads.css'

type Command = AgentConnection['command']

export interface ThreadsViewProps {
  /** Navigates to the Agents room. When a thread should be selected first, the page sends `select-thread` before calling this. */
  readonly onOpenAgents: () => void
  /** A fixed clock for deterministic captures; the page otherwise ticks on real time. */
  readonly now?: number | undefined
}

function useClock(fixed: number | undefined): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined) return
    const timer = setInterval(() => setTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [fixed])
  return fixed ?? tick
}

/** The inline request: Allow and Deny answer it; nothing else on the page ever does. */
function ThreadRequest({ row, command, busy, onAnswerInAgents }: {
  readonly row: ThreadRow; readonly command: Command; readonly busy: boolean; readonly onAnswerInAgents: () => void
}): ReactNode {
  const request = row.request
  if (request?.requestId === undefined) return null
  const [title, ...detail] = request.text.split('\n')
  const answer = (value: string, approved: boolean): void => {
    void command({ type: 'answer', threadId: row.thread.id, requestId: request.requestId!, answer: value, approved })
  }
  const permission = request.kind === 'permission'
  return <div className="thread-row__ask" data-kind={request.kind} aria-label={permission ? `Permission request for ${row.thread.title}` : `Question from ${row.thread.title}`}>
    <div className="thread-row__ask-text">
      <strong>{permission ? (title || 'Permission request') : 'Question'}</strong>
      {permission
        ? detail.length > 0 ? <code>{detail.join('\n').trim()}</code> : null
        : <p>{request.text}</p>}
    </div>
    <div className="thread-row__ask-actions">
      {permission
        ? <><Button variant="secondary" disabled={busy} onClick={() => answer('Denied', false)}>Deny</Button>
          <Button disabled={busy} onClick={() => answer('Approved', true)}>Allow</Button></>
        : <Button variant="secondary" onClick={onAnswerInAgents}>Answer in Agents</Button>}
    </div>
    <span className="thread-row__say">{permission ? 'Say “allow” or “deny”, or choose here.' : 'Say your answer, then “send it”, or answer in the Agents room.'}</span>
  </div>
}

function ThreadArticle({ row, open, command, busy, onToggle, onOpenThread }: {
  readonly row: ThreadRow; readonly open: boolean
  readonly command: Command; readonly busy: boolean
  readonly onToggle: () => void; readonly onOpenThread: (threadId: string) => void
}): ReactNode {
  const { thread, assignment, facts } = row
  const toggleFromRow = (event: MouseEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button, a, input, code')) return
    onToggle()
  }
  const managing = row.management === 'managed'
  return <article className="thread-row" data-state={row.state} aria-current={open ? 'true' : undefined} onClick={toggleFromRow}>
    <span className="thread-row__agent" data-provider={row.providerKey} aria-hidden="true">{providerGlyph(row.provider)}</span>
    <div className="thread-row__title">
      <button type="button" className="thread-row__toggle tt-focusable" aria-expanded={open} onClick={onToggle}>{thread.title}</button>
      <small>{row.provider}{row.project !== undefined ? `, in ${row.project.title}` : ''}</small>
    </div>
    <div className="thread-row__side tt-tabular">
      {/* A finished thread has nothing to signal, so Done carries no dot. */}
      <span className="thread-row__state" data-state={row.state}>{row.state === 'done' ? null : <i aria-hidden="true" />}{row.stateLabel}</span>
      <span>{row.when}</span>
    </div>
    <p className="thread-row__now">{row.sentence}</p>
    <ThreadRequest row={row} command={command} busy={busy} onAnswerInAgents={() => onOpenThread(thread.id)} />
    {open ? <>
      <p className="thread-row__facts">{facts.lead ? <><b>{facts.lead}</b> </> : null}{facts.rest}</p>
      {row.lastMessage !== undefined ? <div className="thread-row__recent">
        <span className="thread-row__who">{row.lastMessage.who}, {clockLabel(row.lastMessage.at)}</span>
        <p>{row.lastMessage.text}</p>
      </div> : null}
      <div className="thread-row__more">
        <Button variant="secondary" onClick={() => onOpenThread(thread.id)}>Open transcript</Button>
        {assignment === undefined
          ? <Button variant="secondary" disabled={busy} onClick={() => void command({ type: 'assign', threadId: thread.id })}>Manage</Button>
          : managing
            ? <Button variant="secondary" disabled={busy} onClick={() => void command({ type: 'pause', threadId: thread.id })}>Pause managing</Button>
            : <Button variant="secondary" disabled={busy} onClick={() => void command({ type: 'resume', threadId: thread.id })}>Resume managing</Button>}
        {assignment !== undefined
          ? <Button variant="danger" className="thread-row__stop" disabled={busy} onClick={() => void command({ type: 'unassign', threadId: thread.id })}>Stop managing</Button>
          : null}
      </div>
    </> : null}
  </article>
}

/**
 * Every thread Sotto is looking after, grouped by what you need to know:
 * needs you, running, finished today, then earlier days. Groups and states
 * come from Sotto's assignments, attention queue and thread status.
 */
export function ThreadsView({ onOpenAgents, now: fixedNow }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const now = useClock(fixedNow)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const state: AgentState | null = agents.state
  const rows = useMemo(() => state === null ? [] : describeThreads(state, now), [state, now])
  const { matching, listed } = useMemo(() => listThreads(rows, query), [rows, query])
  const groups = useMemo(() => groupThreads(listed, now), [listed, now])
  const counts = threadCounts(rows, now)
  const trimmed = query.trim()

  if (state === null) {
    return <div className="management-view threads-view"><header className="threads-head"><h1>Threads</h1></header><p className="threads-muted">{agents.error ?? 'Preparing agent controls…'}</p></div>
  }

  const openThread = (threadId: string): void => {
    void agents.command({ type: 'select-thread', threadId })
    onOpenAgents()
  }

  if (rows.length === 0) {
    return <div className="management-view threads-view" data-empty="none">
      <div className="threads-empty">
        <h2>No threads yet.</h2>
        <p>Say “Hey Sotto, open a thread” or start one from the Agents room. The provider keeps every thread; Sotto lists the ones it can see.</p>
        <Button onClick={onOpenAgents}>New thread</Button>
      </div>
    </div>
  }

  return <div className="management-view threads-view">
    <header className="threads-head">
      <h1>Threads</h1>
      <small className="tt-tabular">{trimmed ? `${matching.length} of ${rows.length}` : `${counts.active} active, ${counts.week} this week`}</small>
      <label className="threads-search" data-filled={trimmed ? '1' : '0'}>
        <span className="tt-visually-hidden">Search threads</span>
        <Search size={14} aria-hidden="true" />
        <input className="tt-input tt-focusable" type="search" value={query} placeholder="Search threads" onChange={(event) => setQuery(event.currentTarget.value)} />
        {trimmed ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} aria-hidden="true" /></button> : null}
      </label>
      <Button variant="secondary" onClick={onOpenAgents}>New thread</Button>
    </header>
    {agents.error !== null || state.error !== null ? <p className="agent-error" role="alert">{state.error ?? agents.error}</p> : null}
    {groups.map((group, index) => <section key={group.id} className="threads-group" data-first={index === 0 ? '1' : undefined} aria-label={group.label}>
      <h2 className="threads-group__label" data-tone={group.tone}>{group.label}</h2>
      {group.rows.map(row => <ThreadArticle key={row.thread.id} row={row} open={openId === row.thread.id}
        command={agents.command} busy={state.busy}
        onToggle={() => setOpenId(openId === row.thread.id ? null : row.thread.id)} onOpenThread={openThread} />)}
    </section>)}
    {/* The attention queue above stays put; this only says the search itself found nothing. */}
    {trimmed && matching.length === 0
      ? <div className="threads-empty" data-empty="search">
        <h2>Nothing matches “{trimmed}”.</h2>
        <p>Try a project or thread name, or clear the search.</p>
      </div>
      : null}
  </div>
}

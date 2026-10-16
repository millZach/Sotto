import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { GitFork, Laptop, Server } from 'lucide-react'
import { PROVIDER_LABELS, type AgentState, type AgentThread } from '../../../shared/agents'
import { DELEGATION_WORK_TITLES, type DelegationView } from '../../../shared/delegation'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import type { AgentConnection } from './AgentContext'
import { threadHostName } from './HostBadge'
import { ProviderMark } from './ProviderMark'
import { DELEGATION_OUTCOME_WORDS, delegatedNote, delegationWaitLine, stopLine, workingDelegatedThreads } from './delegationWords'
import { useDelegations, useDelegationsEnabled } from './delegations'
import './delegation.css'

/** What a card needs of the window besides its delegation: the threads it names, where they run, and a way to open one. */
export interface DelegationCardWorld {
  readonly thread: (threadId: string) => AgentThread | undefined
  readonly hostName: (thread: AgentThread) => string
  readonly open: (threadId: string) => void
  /** False where the page holds its clock still (a capture run): a wait in progress keeps the time it was drawn with. */
  readonly liveClock: boolean
  readonly now?: number | undefined
}
const DelegationCardContext = createContext<DelegationCardWorld | null>(null)

/** The transcript's world for its cards, built once per state the transcript is given. */
export function useDelegationCardWorld(state: AgentState, command: AgentConnection['command'], now?: number): DelegationCardWorld {
  const threads = state.host.threads
  const connections = state.connections
  return useMemo(() => {
    const byId = new Map(threads.map(thread => [thread.id, thread]))
    return { thread: id => byId.get(id), hostName: thread => threadHostName({ connections }, thread),
      open: id => { void command({ type: 'select-thread', threadId: id }) }, liveClock: now === undefined, now }
  }, [threads, connections, command, now])
}
export function DelegationCardProvider({ world, children }: { readonly world: DelegationCardWorld; readonly children: ReactNode }): ReactNode {
  return <DelegationCardContext.Provider value={world}>{children}</DelegationCardContext.Provider>
}

/** The outcome's ring and word, coloured by the outcome. */
function Outcome({ view }: { readonly view: DelegationView }): ReactNode {
  return <span className="delegation-card__outcome" data-outcome={view.outcome}>
    <span className="delegation-ring" data-outcome={view.outcome} aria-hidden="true" />{DELEGATION_OUTCOME_WORDS[view.outcome]}
  </span>
}

/** The wait line, counting the seconds while the delegating thread waits in the call. */
function WaitLine({ view, id, world }: { readonly view: DelegationView; readonly id: string; readonly world: DelegationCardWorld }): ReactNode {
  const ticking = view.waiting && world.liveClock
  const [now, setNow] = useState(() => world.now ?? Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return <p id={id} className="delegation-card__wait">{delegationWaitLine(view, world.now ?? now)}</p>
}

/**
 * One delegation in the delegating thread's transcript (#1029, design A): "Delegated to" the thread as a link, its
 * provider and machine, its outcome, and how the wait went.
 */
export function DelegationCard({ view }: { readonly view: DelegationView }): ReactNode {
  const world = useContext(DelegationCardContext)
  if (world === null) return null
  const thread = world.thread(view.thread)
  const title = thread?.title ?? DELEGATION_WORK_TITLES[view.work]
  const provider = thread?.providerId
  const machine = thread ? world.hostName(thread) : 'This computer'
  const Machine = thread?.remoteHost ? Server : Laptop
  const detailsId = `delegation-${view.id}-details`, waitId = `delegation-${view.id}-wait`
  return <div className="delegation-card" role="group" aria-label={`Delegated to ${title}`} data-outcome={view.outcome}>
    <div className="delegation-card__top">
      <GitFork size={15} aria-hidden="true" className="delegation-card__glyph" />
      <span className="delegation-card__lead">Delegated to</span>
      {thread
        ? <button type="button" className="delegation-card__link tt-focusable" aria-label={`Open ${title}`} aria-describedby={`${detailsId} ${waitId}`} title={title}
          onClick={() => world.open(view.thread)}>{title}</button>
        : <span className="delegation-card__name">{title}</span>}
      <Outcome view={view} />
    </div>
    <p id={detailsId} className="delegation-card__meta">
      {provider ? <><ProviderMark provider={provider} name={PROVIDER_LABELS[provider]} size={12} /><span>{PROVIDER_LABELS[provider]}</span><span aria-hidden="true">·</span></> : null}
      <span className="delegation-card__machine" data-kind={thread?.remoteHost ? 'remote' : 'local'}><Machine size={12} aria-hidden="true" />{machine}</span>
      <span className="tt-visually-hidden">, {DELEGATION_OUTCOME_WORDS[view.outcome]}.</span>
    </p>
    <WaitLine view={view} id={waitId} world={world} />
  </div>
}

/** The cards of one turn, in the order the delegating thread made them. */
export function DelegationCards({ views }: { readonly views: readonly DelegationView[] | undefined }): ReactNode {
  if (!views?.length) return null
  return <div className="delegation-cards">{views.map(view => <DelegationCard key={view.id} view={view} />)}</div>
}

/**
 * Which turn each card belongs to: the user's message the delegation answers (decision 3). A delegation whose message is
 * not among the messages shown goes last, unless it was made before the first of them, when it belongs to history the
 * reader has not opened yet.
 */
export function delegationsByTurn(views: readonly DelegationView[], messages: readonly { readonly id: string; readonly createdAt: string }[]): ReadonlyMap<string, readonly DelegationView[]> {
  const byTurn = new Map<string, DelegationView[]>()
  if (!views.length) return byTurn
  const shown = new Set(messages.map(message => message.id))
  const first = messages.length ? Date.parse(messages[0]!.createdAt) : Number.NaN
  for (const view of views) {
    const key = shown.has(view.rootUserMessageId) ? view.rootUserMessageId
      : Number.isFinite(first) && Date.parse(view.createdAt) < first ? undefined : ''
    if (key !== undefined) byTurn.set(key, [...byTurn.get(key) ?? [], view])
  }
  return byTurn
}

/**
 * "Delegated by" the thread that delegated to this one, as a link back, with the outcome of its newest brief here
 * (#1029, design A). Nothing for a thread no other thread started, and nothing while the Owl list keeps delegation off.
 */
export function DelegatedBy({ thread, state, command }: { readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command'] }): ReactNode {
  const enabled = useDelegationsEnabled()
  const parentId = enabled ? thread.delegatedBy : undefined
  const views = useDelegations(parentId, true)
  if (parentId === undefined) return null
  const parent = state.host.threads.find(item => item.id === parentId)
  const newest = views.findLast(view => view.thread === thread.id)
  return <div className="delegated-by">
    <GitFork size={14} aria-hidden="true" />
    <span>Delegated by {parent
      ? <button type="button" className="delegation-card__link tt-focusable" aria-label={`Open ${parent.title}, the thread that delegated to this one`} title={parent.title}
        onClick={() => void command({ type: 'select-thread', threadId: parent.id })}>{parent.title}</button>
      : <span className="delegated-by__gone">a thread that is no longer listed</span>}</span>
    {newest ? <><span aria-hidden="true">·</span><Outcome view={newest} /></> : null}
  </div>
}

/**
 * The line under the composer delegation owns (#1029, design A). In a thread that delegated, while it works: Stop also
 * stops the threads it delegated that are working. In a delegated thread: what the user's own turn there does to the
 * thread that delegated.
 */
export function DelegationComposerNote({ thread, state }: { readonly thread: AgentThread; readonly state: AgentState }): ReactNode {
  const enabled = useDelegationsEnabled()
  const parentId = enabled ? thread.delegatedBy : undefined
  const views = useDelegations(parentId, true)
  // Stop shows while the thread works, as the composer decides it; what it also stops is main's rule, a turn still running.
  const working = enabled && thread.status === 'running' && !isThreadClosed(thread) ? workingDelegatedThreads(state.host.threads, thread.id) : 0
  if (!enabled) return null
  if (working) return <p className="delegation-note"><GitFork size={13} aria-hidden="true" /><span>{stopLine(working)}</span></p>
  if (parentId === undefined) return null
  const parent = state.host.threads.find(item => item.id === parentId)
  const newest = views.findLast(view => view.thread === thread.id)
  return <p className="delegation-note"><GitFork size={13} aria-hidden="true" />
    <span>{delegatedNote(parent?.title ?? 'The thread that delegated', newest?.outcome, isThreadTurnRunning(thread))}</span></p>
}

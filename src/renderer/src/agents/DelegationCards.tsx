import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, GitFork, Laptop, Server, ShieldCheck } from 'lucide-react'
import { PROVIDER_LABELS, type AgentState, type AgentThread, type ProviderId } from '../../../shared/agents'
import { DELEGATION_WORK_TITLES, type DelegatedView, type DelegationView, type RefusedView } from '../../../shared/delegation'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import type { AgentConnection } from './AgentContext'
import { threadHostName } from './HostBadge'
import { ProviderMark } from './ProviderMark'
import { askedFor, DELEGATION_OUTCOME_WORDS, delegatedNote, delegationRefusalLine, delegationWaitLine, heldLine, lastReadOutcome, lastReadWord, stopLine, userTurnRunning, workingDelegatedThreads } from './delegationWords'
import { useDelegations, useDelegationsEnabled, useNewestBrief } from './delegations'
import { openDelegatedThread, rosterMachine } from '../tools/delegatedRoster'
import { useOwlFeature } from '../state/owlFeature'
import { t } from '@lingui/core/macro'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import './delegation.css'

/** What a card needs of the window besides its delegation: the threads it names, where they run, and a way to open one. */
export interface DelegationCardWorld {
  readonly thread: (threadId: string) => AgentThread | undefined
  readonly hostName: (thread: AgentThread) => string
  readonly open: (threadId: string) => void
  /** False where the page holds its clock still (a capture run): a wait in progress keeps the time it was drawn with. */
  readonly liveClock: boolean
  readonly now?: number | undefined
  /**
   * The delegating thread's machine where it is another machine and Work across machines is on (#1310): its name, whether
   * Sotto is connected to it now, and when what the cards show stood, while it is not.
   */
  readonly away?: { readonly name: string; readonly connected: boolean; readonly lastReadAt: number } | undefined
  /** A machine by its host ID, as a refused start's card names what it asked for: "this computer", or a host's name. */
  readonly machineName?: ((hostId: string) => string | undefined) | undefined
}
const DelegationCardContext = createContext<DelegationCardWorld | null>(null)

/**
 * The transcript's world for its cards, built once per state the transcript is given. A card's link opens its thread as
 * a delegated thread's roster row does: in the pane, with an open Tools kept on the thread that delegated it.
 */
export function useDelegationCardWorld(state: AgentState, command: AgentConnection['command'], now?: number,
  from?: { readonly thread: AgentThread; readonly lastReadAt: number | undefined }): DelegationCardWorld {
  const threads = state.host.threads
  const connections = state.connections
  const crossMachine = useOwlFeature('cross-machine-work')
  const machine = crossMachine && from?.thread.remoteHost === true ? rosterMachine(connections, from.thread) : undefined
  const awayName = machine?.name, awayConnected = machine?.connected, lastReadAt = from?.lastReadAt
  return useMemo(() => {
    const byId = new Map(threads.map(thread => [thread.id, thread]))
    return { thread: id => byId.get(id), hostName: thread => threadHostName({ connections }, thread),
      open: id => {
        const from = byId.get(id)?.delegatedBy
        if (from === undefined) void command({ type: 'select-thread', threadId: id })
        else openDelegatedThread(command, id, from)
      }, liveClock: now === undefined, now,
      machineName: hostId => { const listed = connections?.find(item => item.hostId === hostId); return listed === undefined ? undefined : listed.kind === 'local' ? t`this computer` : listed.name },
      ...(awayName !== undefined ? { away: { name: awayName, connected: awayConnected !== false, lastReadAt: lastReadAt ?? Number.NaN } } : {}) }
  }, [threads, connections, command, now, awayName, awayConnected, lastReadAt])
}
export function DelegationCardProvider({ world, children }: { readonly world: DelegationCardWorld; readonly children: ReactNode }): ReactNode {
  return <DelegationCardContext.Provider value={world}>{children}</DelegationCardContext.Provider>
}

/** The outcome's ring and word, coloured by the outcome. */
function Outcome({ view, lastRead = false }: { readonly view: DelegatedView; readonly lastRead?: boolean }): ReactNode {
  return <span className="delegation-card__outcome" data-outcome={view.outcome} data-last-read={lastRead || undefined}>
    <span className="delegation-ring" data-outcome={view.outcome} data-last-read={lastRead || undefined} aria-hidden="true" />{lastRead ? lastReadWord(view.outcome) : DELEGATION_OUTCOME_WORDS[view.outcome]}
  </span>
}

/** The wait line, counting the seconds while the delegating thread waits in the call. */
function WaitLine({ view, id, world }: { readonly view: DelegatedView; readonly id: string; readonly world: DelegationCardWorld }): ReactNode {
  const away = world.away && (!world.away.connected || Number.isFinite(world.away.lastReadAt)) ? world.away : undefined
  const ticking = view.waiting && world.liveClock && !away
  const [now, setNow] = useState(() => world.now ?? Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  // Its machine is not connected: how it stood when Sotto last read it, never a wait still counting (#1310).
  return <p id={id} className="delegation-card__wait">{away ? lastReadOutcome(away.name, view.outcome, away.lastReadAt, away.connected) : delegationWaitLine(view, world.now ?? now)}</p>
}

/** The provider's mark and name, then the machine, under a card's first line. */
function Where({ id, provider, thread, world, children, machine: shown = true }: { readonly id: string; readonly provider: ProviderId | undefined; readonly thread: AgentThread | undefined
  readonly world: DelegationCardWorld; readonly children?: ReactNode
  /** False for a refused start of a thread on another machine, which names no machine it could have started on (#1310). */
  readonly machine?: boolean }): ReactNode {
  const machine = thread ? world.hostName(thread) : t`This computer`
  const Machine = thread?.remoteHost ? Server : Laptop
  return <p id={id} className="delegation-card__meta">
    {provider ? <><ProviderMark provider={provider} name={PROVIDER_LABELS[provider]} size={12} /><span>{PROVIDER_LABELS[provider]}</span>{shown ? <span aria-hidden="true">·</span> : null}</> : null}
    {shown ? <span className="delegation-card__machine" data-kind={thread?.remoteHost ? 'remote' : 'local'}><Machine size={12} aria-hidden="true" />{machine}</span> : null}
    {children}
  </p>
}

/**
 * A delegation Sotto refused as it was asked for (decision 7), as the placement prototype's variant A draws the
 * permission ceiling's: "Not delegated" and the kind of work, or "Not sent to" the thread a send named, the provider
 * and machine it would have used, and why, in plain words. No link: nothing was started, and nothing was sent.
 */
function RefusedDelegationCard({ view, world }: { readonly view: RefusedView; readonly world: DelegationCardWorld }): ReactNode {
  const thread = view.thread === undefined ? undefined : world.thread(view.thread)
  const send = view.action === 'send'
  const title = send && thread ? thread.title : DELEGATION_WORK_TITLES[view.work]
  const lead = send && thread ? 'Not sent to' : 'Not delegated:'
  return <div className="delegation-card" role="note" aria-label={`${lead} ${title}`} data-outcome="refused">
    <div className="delegation-card__top">
      <CircleAlert size={15} aria-hidden="true" className="delegation-card__glyph" />
      <span className="delegation-card__lead">{lead}</span>
      <span className="delegation-card__name" title={title}>{title}</span>
    </div>
    <Where id={`delegation-${view.id}-details`} provider={view.provider ?? thread?.providerId} thread={thread} world={world} machine={thread !== undefined || world.away === undefined} />
    <p className="delegation-card__wait">{delegationRefusalLine(view, world.away?.name, view.asked && world.away ? askedFor(view.asked, hostId => world.machineName?.(hostId)) : undefined)}</p>
  </div>
}

/**
 * One delegation in the delegating thread's transcript (#1029, design A): "Delegated to" the thread as a link, its
 * provider and machine, its outcome, and how the wait went; or why Sotto refused it.
 */
export function DelegationCard({ view }: { readonly view: DelegationView }): ReactNode {
  const world = useContext(DelegationCardContext)
  // Its words are messages; reading the language draws the card again when it changes (ADR-0123).
  useInterfaceLanguageState()
  if (world === null) return null
  if (view.outcome === 'refused') return <RefusedDelegationCard view={view} world={world} />
  const thread = world.thread(view.thread)
  const title = thread?.title ?? DELEGATION_WORK_TITLES[view.work]
  const detailsId = `delegation-${view.id}-details`, waitId = `delegation-${view.id}-wait`
  // As Sotto last read it: its machine is not connected, or main could not read it afresh there (#1310).
  const lastRead = world.away !== undefined && (!world.away.connected || Number.isFinite(world.away.lastReadAt))
  // Its start was held to Ask for approval on its machine (#1310), said as the roster says it.
  const held = view.held && world.away ? heldLine(view.held, thread ? world.hostName(thread) : world.away.name) : undefined
  return <div className="delegation-card" role="group" aria-label={`Delegated to ${title}`} data-outcome={view.outcome}>
    <div className="delegation-card__top">
      <GitFork size={15} aria-hidden="true" className="delegation-card__glyph" />
      <span className="delegation-card__lead">Delegated to</span>
      {thread
        ? <button type="button" className="delegation-card__link tt-focusable" aria-label={`Open ${title}`} aria-describedby={`${detailsId} ${waitId}`} title={title}
          onClick={() => world.open(view.thread)}>{title}</button>
        : <span className="delegation-card__name">{title}</span>}
      <Outcome view={view} lastRead={lastRead} />
    </div>
    <Where id={detailsId} provider={thread?.providerId} thread={thread} world={world}>
      <span className="tt-visually-hidden">, {lastRead ? lastReadWord(view.outcome) : DELEGATION_OUTCOME_WORDS[view.outcome]}.</span>
    </Where>
    <WaitLine view={view} id={waitId} world={world} />
    {held ? <p className="delegation-card__held"><ShieldCheck size={13} aria-hidden="true" /><span>{held}</span></p> : null}
  </div>
}

/** The cards of one turn, in the order the delegating thread made them. */
export function DelegationCards({ views }: { readonly views: readonly DelegationView[] | undefined }): ReactNode {
  if (!views?.length) return null
  return <div className="delegation-cards">{views.map(view => <DelegationCard key={view.id} view={view} />)}</div>
}

/**
 * Which turn each card belongs to: the one the call was made in, opened by the user's message or a wake-up. A delegation
 * whose message is not among the messages shown goes last, unless it was made before the first of them, when it belongs
 * to history the reader has not opened yet.
 */
export function delegationsByTurn(views: readonly DelegationView[], messages: readonly { readonly id: string; readonly createdAt: string }[]): ReadonlyMap<string, readonly DelegationView[]> {
  const byTurn = new Map<string, DelegationView[]>()
  if (!views.length) return byTurn
  const shown = new Set(messages.map(message => message.id))
  const first = messages.length ? Date.parse(messages[0]!.createdAt) : Number.NaN
  for (const view of views) {
    const key = view.anchorMessageId !== undefined && shown.has(view.anchorMessageId) ? view.anchorMessageId
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
  const newest = useNewestBrief(thread)
  const parentId = enabled ? thread.delegatedBy : undefined
  if (parentId === undefined) return null
  const parent = state.host.threads.find(item => item.id === parentId)
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
 * stops the threads it delegated that are working. In a delegated thread, only while something holds a send back: the
 * user's own turn there, which the thread that delegated waits out, or that thread's brief still being worked on.
 */
export function DelegationComposerNote({ thread, state }: { readonly thread: AgentThread; readonly state: AgentState }): ReactNode {
  const enabled = useDelegationsEnabled()
  const received = useDelegations(thread.delegatedBy === undefined ? undefined : thread.id).received
  const parentId = enabled ? thread.delegatedBy : undefined
  // Stop shows while the thread works, as the composer decides it; what it also stops is main's rule, a turn still running.
  const working = enabled && thread.status === 'running' && !isThreadClosed(thread) ? workingDelegatedThreads(state.host.threads, thread.id) : 0
  if (!enabled) return null
  if (working) return <p className="delegation-note"><GitFork size={13} aria-hidden="true" /><span>{stopLine(working)}</span></p>
  if (parentId === undefined) return null
  const parent = state.host.threads.find(item => item.id === parentId)
  const note = delegatedNote(parent?.title ?? 'The thread that delegated', received.at(-1), userTurnRunning(thread, received), isThreadTurnRunning(thread))
  return note === undefined ? null : <p className="delegation-note"><GitFork size={13} aria-hidden="true" /><span>{note}</span></p>
}

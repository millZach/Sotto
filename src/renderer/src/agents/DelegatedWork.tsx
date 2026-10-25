import React, { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { GitFork, Laptop, Search, Server, ShieldCheck, Sparkle, type LucideIcon } from 'lucide-react'
import { PROVIDER_LABELS, type AgentState, type AgentThread } from '../../../shared/agents'
import { DELEGATION_WORK_TITLES, type DelegatedView, type DelegationView } from '../../../shared/delegation'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import type { AgentConnection } from './AgentContext'
import { threadHostName } from './HostBadge'
import { ProviderMark } from './ProviderMark'
import { askedFor, DELEGATION_OUTCOME_WORDS, delegatedKind, delegatedKindWord, delegatedLine, delegatedNote, delegatedState, delegatedSummary, delegationRefusalLine, heldLine, lastReadOutcome, lastReadWord, pendingRequestOf, settledDelegation, stopLine, userTurnRunning, workingDelegatedThreads, type DelegatedKind, type DelegatedState } from './delegationWords'
import { useDelegations, useDelegationsEnabled, useNewestBrief } from './delegations'
import { openDelegatedThread, rosterMachine } from '../tools/delegatedRoster'
import { useOwlFeature } from '../state/owlFeature'
import { t } from '@lingui/core/macro'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import './delegation.css'

/** What a row of delegated work needs of the window besides its delegation: the threads it names, where they run, and a way to open one. */
export interface DelegationWorld {
  readonly thread: (threadId: string) => AgentThread | undefined
  readonly hostName: (thread: AgentThread) => string
  readonly open: (threadId: string) => void
  /** False where the page holds its clock still (a capture run): a wait in progress keeps the time it was drawn with. */
  readonly liveClock: boolean
  readonly now?: number | undefined
  /**
   * The delegating thread's machine where it is another machine and Work across machines is on (#1310): its name, whether
   * Sotto is connected to it now, and when what the rows show stood, while it is not.
   */
  readonly away?: { readonly name: string; readonly connected: boolean; readonly lastReadAt: number } | undefined
  /** A machine by its host ID, as a refused start's row names what it asked for: "this computer", or a host's name. */
  readonly machineName?: ((hostId: string) => string | undefined) | undefined
}
const DelegationWorldContext = createContext<DelegationWorld | null>(null)

/**
 * The transcript's world for its rows of delegated work, built once per state the transcript is given. A row's link opens
 * its thread as a delegated thread's roster row does: in the pane, with an open Tools kept on the thread that delegated it.
 */
export function useDelegationWorld(state: AgentState, command: AgentConnection['command'], now?: number,
  from?: { readonly thread: AgentThread; readonly lastReadAt: number | undefined }): DelegationWorld {
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
export function DelegationWorldProvider({ world, children }: { readonly world: DelegationWorld; readonly children: ReactNode }): ReactNode {
  return <DelegationWorldContext.Provider value={world}>{children}</DelegationWorldContext.Provider>
}

/** The outcome's ring and word, coloured by the outcome: what "Delegated by" shows of the newest brief. */
function Outcome({ view }: { readonly view: DelegatedView }): ReactNode {
  return <span className="delegation-outcome" data-outcome={view.outcome}>
    <span className="delegation-ring" data-outcome={view.outcome} aria-hidden="true" />{DELEGATION_OUTCOME_WORDS[view.outcome]}
  </span>
}

/** Each kind of delegated work's mark: a review, a Muse review, or any other kind of work handed to a delegated thread. */
const KIND_GLYPHS: Record<DelegatedKind, LucideIcon> = { review: Search, 'muse-review': Sparkle, work: GitFork }

/**
 * As Sotto last read it (#1310): the delegating thread's machine is not connected, or main could not read it afresh there.
 * What a row then says stood when that read did.
 */
const lastReadAway = (world: DelegationWorld): DelegationWorld['away'] =>
  world.away && (!world.away.connected || Number.isFinite(world.away.lastReadAt)) ? world.away : undefined

/** The line under a row, counting the seconds while the delegating thread waits in the call. */
function RowLine({ view, state, id, world, request }: { readonly view: DelegationView; readonly state: DelegatedState; readonly id: string; readonly world: DelegationWorld
  readonly request: AgentThread['requests'][number] | undefined }): ReactNode {
  const away = view.outcome === 'refused' ? undefined : lastReadAway(world)
  const ticking = view.outcome !== 'refused' && view.waiting && world.liveClock && !away
  const [now, setNow] = useState(() => world.now ?? Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  const listed = view.thread !== undefined && world.thread(view.thread) !== undefined
  // A thread on another machine starts threads only there for now, and a refused start names what it asked for (#1310).
  const line = view.outcome === 'refused' ? world.away ? delegationRefusalLine(view, world.away.name, view.asked ? askedFor(view.asked, hostId => world.machineName?.(hostId)) : undefined)
    : delegatedLine(view, state, world.now ?? now, request, listed)
    // Its machine is not connected: how it stood when Sotto last read it, never a wait still counting (#1310).
    : away ? lastReadOutcome(away.name, view.outcome, away.lastReadAt, away.connected)
      : delegatedLine(view, state, world.now ?? now, request, listed)
  return <p id={id} className="delegated-work__line tt-paragraph">{line}</p>
}

/**
 * One delegation as a row of delegated work (Drake's pick on October 23, 2026, variant 2 of
 * docs/prototypes/delegated-work-prototype.html): the kind of work as a mark and a word, the delegated thread as a link
 * that opens it, its provider and machine, its state as a ring and a word, and a line on how the wait went, what it waits
 * on you for, or why Sotto refused it. A refused one links nowhere: nothing was started, and nothing was sent.
 */
export function DelegatedWorkRow({ view }: { readonly view: DelegationView }): ReactNode {
  const world = useContext(DelegationWorldContext)
  const lineId = useId(), metaId = useId()
  // Its words are messages; reading the language draws the row again when it changes (ADR-0123).
  useInterfaceLanguageState()
  if (world === null) return null
  const thread = view.thread === undefined ? undefined : world.thread(view.thread)
  const provider = thread?.providerId ?? (view.outcome === 'refused' ? view.provider : undefined)
  const kind = delegatedKind(view.work, provider)
  const Glyph = KIND_GLYPHS[kind]
  const request = pendingRequestOf(view, thread)
  const refused = view.outcome === 'refused'
  // As Sotto last read it on a machine it cannot read afresh now (#1310): that outcome, greyed, said as such.
  const lastRead = !refused && lastReadAway(world) !== undefined
  const state = lastRead ? { id: view.outcome, word: lastReadWord(view.outcome) } : delegatedState(view, kind, request !== undefined)
  const name = thread?.title ?? DELEGATION_WORK_TITLES[view.work]
  const kindWord = delegatedKindWord(kind, view.work)
  const label = `${refused ? `${kindWord}, ${view.action === 'send' && thread ? `not sent to ${thread.title}` : 'not delegated'}` : `${kindWord}: ${name}`}, ${state.word}`
  const machine = thread ? world.hostName(thread) : t`This computer`
  const Machine = thread?.remoteHost ? Server : Laptop
  // A refused start of a thread on another machine names no machine it could have started on (#1310).
  const shownMachine = thread !== undefined || !refused || world.away === undefined
  // Its start was held to Ask for approval on its machine (#1310), said as the roster says it.
  const held = view.outcome !== 'refused' && view.held && world.away ? heldLine(view.held, thread ? world.hostName(thread) : world.away.name) : undefined
  return <li className="delegated-work__row" data-outcome={view.outcome} data-state={state.id} aria-label={label}>
    <Glyph size={14} aria-hidden="true" className="delegated-work__glyph" />
    <span className="delegated-work__name">
      <span className="delegated-work__kind">{kindWord}</span>
      {refused ? <span className="delegated-work__refused">{view.action === 'send' && thread ? <>Not sent to {thread.title}</> : 'Not delegated'}</span>
        : thread ? <button type="button" className="delegation-link tt-focusable" aria-label={`Open ${thread.title}`} aria-describedby={`${metaId} ${lineId}`} title={thread.title}
          onClick={() => world.open(thread.id)}>{thread.title}</button>
          : <span>{name}</span>}
    </span>
    <span className="delegated-work__state" data-state={state.id} data-last-read={lastRead || undefined}>
      <span className="delegation-ring" data-outcome={view.outcome} data-state={state.id} data-last-read={lastRead || undefined} aria-hidden="true" />{state.word}
    </span>
    <p id={metaId} className="delegated-work__meta">
      {provider ? <><ProviderMark provider={provider} name={PROVIDER_LABELS[provider]} size={12} /><span>{PROVIDER_LABELS[provider]}</span>{shownMachine ? <span aria-hidden="true">·</span> : null}</> : null}
      {shownMachine ? <span className="delegated-work__machine" data-kind={thread?.remoteHost ? 'remote' : 'local'}><Machine size={12} aria-hidden="true" />{machine}</span> : null}
      <span className="tt-visually-hidden">, {state.word}.</span>
    </p>
    <RowLine view={view} state={state.id} id={lineId} world={world} request={request} />
    {held ? <p className="delegated-work__held tt-paragraph"><ShieldCheck size={13} aria-hidden="true" /><span>{held}</span></p> : null}
  </li>
}

/** The rows of one turn, in the order the delegating thread made them: in its Worked for fold, or under its reply when nothing folds. */
export function DelegatedWork({ views, label = 'Delegated work' }: { readonly views: readonly DelegationView[] | undefined; readonly label?: string | null }): ReactNode {
  if (!views?.length) return null
  return <ul className="delegated-work" aria-label={label ?? undefined}>{views.map(view => <DelegatedWorkRow key={view.id} view={view} />)}</ul>
}

/** The turn's delegated work in a few words after its Worked for line, so a closed fold still says what it holds. */
export function DelegatedWorkSummary({ views }: { readonly views: readonly DelegationView[] | undefined }): ReactNode {
  const world = useContext(DelegationWorldContext)
  if (!views?.length || world === null) return null
  const words = delegatedSummary(views, view => view.thread === undefined ? undefined : world.thread(view.thread))
  return words ? <span className="thread-work__delegated"> · {words}</span> : null
}

/**
 * The delegated work of a finished turn that outlives its reply, such as a Muse review still running: under the reply, so
 * it is not folded away while the thread waits on it. It goes once the work settles, and while the fold is open, where
 * the same rows already are.
 */
export function StillWorking({ views }: { readonly views: readonly DelegationView[] | undefined }): ReactNode {
  const open = useMemo(() => views?.filter(view => !settledDelegation(view)), [views])
  const headingId = useId()
  if (!open?.length) return null
  return <section className="delegated-work-still" aria-labelledby={headingId}>
    <p id={headingId} className="delegated-work-still__heading">Still working after this reply</p>
    <DelegatedWork views={open} label={null} />
  </section>
}

/**
 * Which turn each delegation belongs to: the one the call was made in, opened by the user's message or a wake-up. A delegation
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
      ? <button type="button" className="delegation-link tt-focusable" aria-label={`Open ${parent.title}, the thread that delegated to this one`} title={parent.title}
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

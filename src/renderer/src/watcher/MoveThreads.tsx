import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRightLeft, Laptop, Server } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentState, type AgentThread } from '../../../shared/agents'
import type { HostsBridge, HostsState } from '../../../shared/hosts'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../shared/threadActivity'
import { THREAD_MOVE_THREADS_MAX, type ThreadMoveCard, type ThreadMovePlanned, type ThreadMovePrepare, type ThreadMovesBridge, type ThreadMovesView } from '../../../shared/threadMoves'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { clockLabel } from '../agents/threadFacts'
import { useDialogFocus } from '../components/useDialogFocus'
import { ProviderMark } from '../agents/ProviderMark'
import { useOptionalAgents } from '../agents/AgentContext'
import { savedMachines, type SavedMachine } from '../state/hostsState'
import { useOwlFeature } from '../state/owlFeature'
import { useWatcherRoom } from './watcherRoom'

/**
 * Moving threads to another machine, in the window (#1178 part 2, Zach's pick B on October 29, 2026). **Move threads**,
 * next to Stop all in Watcher's header, and **Continue on another machine…** in a thread's More menu open one sheet: the
 * machine, then what moves now, what asks first and what stays and why, confirmed once. Sotto runs the moves, not a
 * Watcher turn, and each is a card in Watcher's conversation; one that would start narrower waits there for a press.
 * Both are hidden while no other machine is connected. Part of the Owl feature Work across machines: stable has no bridge.
 */

/** An end-to-end run's moves and machines, in place of main's (`createE2EThreadMovesStandIn`). */
let standIn: { readonly moves: ThreadMovesBridge; readonly hosts: HostsBridge } | undefined
export function setThreadMovesStandIn(next: typeof standIn): void { standIn = next }

/** The bridge, where main offers it: Owl, with Watcher and Work across machines on. */
export function useThreadMovesBridge(bridge: ThreadMovesBridge | undefined = standIn?.moves ?? window.sotto?.threadMoves): ThreadMovesBridge | undefined {
  return useOwlFeature('cross-machine-work') ? bridge : undefined
}

/**
 * The machines this computer is paired with and whether each is connected now, shared by every surface that offers a move
 * so the hosts bridge is read once however many panes are open. Kept current by main's pushes; forgotten once unused.
 */
class MachinesConnected {
  private state: HostsState | null = null
  private readonly listeners = new Set<() => void>()
  private bridge: HostsBridge | null = null
  private users = 0
  private stop: (() => void) | null = null
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly get = (): HostsState | null => this.state
  use(bridge: HostsBridge): () => void {
    if (this.bridge !== bridge) { this.stop?.(); this.stop = null; this.users = 0; this.bridge = bridge; this.set(null) }
    if (this.users++ === 0) {
      let pushed = false
      this.stop = bridge.onChanged(state => { pushed = true; this.set(state) })
      void bridge.get().then(state => { if (!pushed && this.bridge === bridge && this.users > 0) this.set(state) }, () => undefined)
    }
    let stopped = false
    return () => {
      if (stopped || this.bridge !== bridge) return
      stopped = true
      if (--this.users === 0) { this.stop?.(); this.stop = null; this.set(null) }
    }
  }
  private set(state: HostsState | null): void {
    if (this.state === state) return
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
  /** For tests: forget everything. */
  clear(): void { this.stop?.(); this.stop = null; this.users = 0; this.bridge = null; this.state = null }
}
export const machinesConnected = new MachinesConnected()

/** The paired machines a move could go to, connected or not; empty while moving is not offered. */
export function useMoveMachines(offered: boolean, bridge: HostsBridge | undefined = standIn?.hosts ?? window.sotto?.hosts): readonly SavedMachine[] {
  const active = offered ? bridge : undefined
  useEffect(() => active ? machinesConnected.use(active) : undefined, [active])
  const state = useSyncExternalStore(machinesConnected.subscribe, machinesConnected.get)
  return useMemo(() => active ? savedMachines(state) ?? [] : [], [active, state])
}

/** What the sheet was opened for: every thread on This computer from Watcher's header, or one thread from its More menu. */
export type MoveSheetRequest =
  | { readonly kind: 'all' }
  | { readonly kind: 'one'; readonly threadId: string; readonly title: string }
class MoveSheetStore {
  private request: MoveSheetRequest | null = null
  /** Where focus goes once the sheet closes, when the control that opened it is gone. */
  opener: HTMLElement | null = null
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly get = (): MoveSheetRequest | null => this.request
  open(request: MoveSheetRequest): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.set(request)
  }
  close(): void { this.set(null) }
  private set(request: MoveSheetRequest | null): void { this.request = request; for (const listener of [...this.listeners]) listener() }
}
export const moveSheetStore = new MoveSheetStore()

/** A thread put away: settled on the shelf, settled by its lifecycle, or archived. Nothing moves it. */
export const isPutAway = (thread: AgentThread): boolean => isThreadClosed(thread) || isWorkspaceThreadSettled(thread)
/** This computer's open threads, as Move threads offers them: everything but Watcher's own and what is settled or archived. */
export function movableThreadIds(state: AgentState): readonly string[] {
  return state.host.threads.filter(thread => thread.remoteHost !== true && !isPutAway(thread) && thread.kind !== 'watcher' && thread.kind !== 'watcher-history')
    .slice(0, THREAD_MOVE_THREADS_MAX).map(thread => thread.id)
}

/**
 * Whether moving is offered now: Owl's bridge, with Watcher started, since each move is reported in its conversation. The
 * machines a move could go to follow.
 */
export function useMovesOffered(): ThreadMovesBridge | undefined {
  const bridge = useThreadMovesBridge()
  return useWatcherRoom()?.state?.current != null ? bridge : undefined
}

/** Move threads, beside Stop all in Watcher's header: shown only while another machine is connected (Zach, October 29). */
export function WatcherMoveThreads(): ReactNode {
  const { t } = useLingui()
  const bridge = useMovesOffered()
  const machines = useMoveMachines(bridge !== undefined)
  if (bridge === undefined || !machines.some(machine => machine.connected)) return null
  return <button type="button" className="watcher-move-threads tt-focusable" aria-haspopup="dialog" title={t`Move threads to another machine`}
    aria-label={t`Move threads to another machine`} onClick={() => moveSheetStore.open({ kind: 'all' })}>
    <ArrowRightLeft size={13} aria-hidden="true" /><span className="watcher-move-threads__text"><Trans>Move threads</Trans></span>
  </button>
}

/** A thread as the sheet names it: its title, its provider and its project, from the window's own record. */
interface SheetThread { readonly title: string; readonly thread: AgentThread | undefined; readonly provider: string | undefined; readonly project: string | undefined }
function sheetThread(state: AgentState | null, threadId: string, fallback: string): SheetThread {
  const thread = state?.host.threads.find(item => item.id === threadId)
  const provider = thread?.providerId ? PROVIDER_LABELS[thread.providerId] : undefined
  const project = thread ? state?.host.projects.find(item => item.id === thread.projectId)?.title : undefined
  return { title: thread?.title ?? fallback, thread, provider, project }
}

type Phase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'preparing'; readonly machine: SavedMachine }
  | { readonly kind: 'confirm'; readonly machine: SavedMachine; readonly preview: Extract<ThreadMovePrepare, { status: 'ok' }> }
  | { readonly kind: 'starting'; readonly machine: SavedMachine; readonly preview: Extract<ThreadMovePrepare, { status: 'ok' }> }
  | { readonly kind: 'refused'; readonly message: string }

/** The sheet, wherever it was opened from. Mounted once in the main window while Watcher is on. */
export function MoveThreadsSheetHost(): ReactNode {
  const request = useSyncExternalStore(moveSheetStore.subscribe, moveSheetStore.get)
  const bridge = useThreadMovesBridge()
  if (request === null || bridge === undefined) return null
  return <MoveThreadsSheet key={request.kind === 'one' ? request.threadId : 'all'} request={request} bridge={bridge} />
}

function MoveThreadsSheet({ request, bridge }: { readonly request: MoveSheetRequest; readonly bridge: ThreadMovesBridge }): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const state = agents?.state ?? null
  const machines = useMoveMachines(true)
  const connected = machines.filter(machine => machine.connected)
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const titleId = useId(), leadId = useId()
  const first = useRef<HTMLButtonElement>(null)
  const opener = useRef(moveSheetStore.opener)
  const fallback = useRef<HTMLElement | null>(null)
  fallback.current = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.watcher-move-threads, #watcher-prompt')
  // Escape, Cancel or Close put the sheet away at any step. Put away while the moves start, they go on, and their cards
  // in Watcher's conversation say how each goes.
  const close = (): void => { moveSheetStore.close() }
  const dialog = useDialogFocus({ onEscape: close, initialFocus: first, fallbackFocus: fallback })
  const threadIds = useMemo(() => request.kind === 'one' ? [request.threadId] : state === null ? [] : movableThreadIds(state), [request, state])
  const idsRef = useRef(threadIds)
  idsRef.current = threadIds
  const prepare = async (machine: SavedMachine): Promise<void> => {
    if (idsRef.current.length === 0) { setPhase({ kind: 'refused', message: t`This computer has no open threads to move.` }); return }
    setPhase({ kind: 'preparing', machine })
    try {
      const preview = await bridge.prepare({ threadIds: [...idsRef.current], hostId: machine.hostId })
      setPhase(preview.status === 'ok' ? { kind: 'confirm', machine, preview } : { kind: 'refused', message: preview.message })
    } catch { setPhase({ kind: 'refused', message: t`Sotto could not check which threads can move. Nothing was moved. Try again.` }) }
  }
  // One machine connected: the sheet goes straight to it, as there is nothing to choose.
  const only = connected.length === 1 ? connected[0]! : null
  const started = useRef(false)
  useEffect(() => {
    if (started.current || phase.kind !== 'choose' || only === null) return
    started.current = true
    void prepare(only)
  })
  // Each step's first control takes focus as it draws, so Escape and Tab stay in the sheet: Cancel or Close, as every
  // confirmation here starts on its secondary action.
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() }, [phase.kind, dialog])
  const start = async (machine: SavedMachine, preview: Extract<ThreadMovePrepare, { status: 'ok' }>, ids: readonly string[]): Promise<void> => {
    setPhase({ kind: 'starting', machine, preview })
    try {
      const result = await bridge.start({ confirmationId: preview.confirmationId, threadIds: [...ids], allowNarrower: [] })
      if (result.status === 'refused') { setPhase({ kind: 'refused', message: result.message }); return }
      // Only this sheet: one put away while its moves started may have been opened again since.
      if (moveSheetStore.get() === request) moveSheetStore.close()
    } catch { setPhase({ kind: 'refused', message: t`Sotto lost the answer, so some threads may be moving. Each move’s card in Watcher’s conversation says where it stands.` }) }
  }

  let title: string, body: ReactNode, actions: ReactNode
  const cancel = (label: string = t`Cancel`): ReactNode =>
    <Button ref={first} variant="secondary" data-autofocus onClick={close}>{phase.kind === 'starting' ? t`Close` : label}</Button>
  if (phase.kind === 'choose') {
    title = request.kind === 'one' ? t`Move ${request.title} to which machine?` : t`Move threads to which machine?`
    body = <ul className="move-sheet__machines">{machines.map(machine => <li key={machine.hostId}>
      <button type="button" className="move-sheet__machine tt-focusable" disabled={!machine.connected} aria-describedby={machine.connected ? undefined : `${machine.hostId}-why`}
        onClick={() => void prepare(machine)}>
        <Server size={15} aria-hidden="true" /><span className="move-sheet__machine-name">{machine.name}</span>
        {machine.connected ? null : <span id={`${machine.hostId}-why`} className="move-sheet__machine-why"><Trans>Not connected</Trans></span>}
      </button></li>)}</ul>
    actions = cancel()
  } else if (phase.kind === 'preparing') {
    title = request.kind === 'one' ? t`Move ${request.title} to ${phase.machine.name}?` : t`Move threads to ${phase.machine.name}?`
    body = <p className="move-sheet__note tt-paragraph" role="status"><Trans>Checking which threads can move…</Trans></p>
    actions = cancel()
  } else if (phase.kind === 'refused') {
    title = t`Nothing was moved`
    body = <p className="move-sheet__note move-sheet__refused tt-paragraph" role="alert">{phase.message}</p>
    actions = cancel(t`Close`)
  } else {
    const { machine, preview } = phase
    const named = preview.machine
    const moves = preview.threads.filter(item => item.outcome === 'moves'), asks = preview.threads.filter(item => item.outcome === 'asks')
    const stays = preview.threads.filter(item => item.outcome === 'stays')
    const going = [...moves, ...asks].map(item => item.threadId)
    const count = going.length
    const one = request.kind === 'one' ? sheetThread(state, request.threadId, request.title).title : null
    title = count === 0 ? (one !== null ? t`${one} can’t move to ${named} now` : t`No thread can move to ${named} now`)
      : one !== null ? t`Move ${one} to ${named}?` : plural(count, { one: `Move # thread to ${named}?`, other: `Move # threads to ${named}?` })
    const row = (planned: ThreadMovePlanned, tone?: 'needs'): ReactNode => {
      const facts = sheetThread(state, planned.threadId, t`A thread no longer here`)
      const line = planned.outcome === 'asks' ? t`${planned.words ?? ''} It waits on its card in Watcher’s conversation for your press before it moves.` : planned.words
      return <li key={planned.threadId} className="move-sheet__row">
        {facts.thread?.providerId === undefined ? <span aria-hidden="true" /> : <span className="thread-nav__mark" data-provider={facts.thread.providerId} aria-hidden="true">
          <ProviderMark provider={facts.thread.providerId} name={facts.provider ?? facts.thread.providerId} /></span>}
        <span className="move-sheet__name">{facts.title}</span>
        {planned.outcome === 'stays' ? null : <p className="move-sheet__meta">
          {facts.provider === undefined ? null : <span>{facts.provider}</span>}
          {planned.model ? <span>{t({ message: `${planned.model.name} on ${named}`, comment: 'The model a moved thread runs on there, and the machine' })}</span> : null}
          {planned.model?.instead ? <span className="move-sheet__instead">{t`${named} doesn’t have ${planned.model.instead}`}</span> : null}
          {facts.project === undefined ? null : <span>{facts.project}</span>}
        </p>}
        {line ? <p className="move-sheet__line tt-paragraph" data-tone={tone}>{line}</p> : null}
      </li>
    }
    body = <>
      <p id={leadId} className="move-sheet__lead tt-paragraph">{count === 0 ? <Trans>Nothing moves: each thread says why it stays.</Trans>
        : <Trans>Each continues on {named} as a new thread, in the same project, on the same provider, with a handover of the thread here. Its first turn starts at once. Watcher’s conversation reports each move.</Trans>}</p>
      <div className="move-sheet__body" tabIndex={0} role="region" aria-label={t`What moves and what stays`}>
        {moves.length ? <><h3><Trans>Moves now</Trans> <span>{moves.length}</span></h3><ul className="move-sheet__list">{moves.map(item => row(item))}</ul></> : null}
        {asks.length ? <><h3 data-tone="needs"><Trans>Asks you first</Trans> <span>{asks.length}</span></h3><ul className="move-sheet__list">{asks.map(item => row(item, 'needs'))}</ul></> : null}
        {stays.length || request.kind === 'all' ? <><h3><Trans>Stays here</Trans> <span>{stays.length + (request.kind === 'all' ? 1 : 0)}</span></h3>
          <ul className="move-sheet__list">{stays.map(item => row(item))}
            {request.kind === 'all' ? <li className="move-sheet__row"><Laptop size={14} aria-hidden="true" /><span className="move-sheet__name">Watcher</span>
              <p className="move-sheet__line tt-paragraph"><Trans>Watcher stays on This computer. It watches your threads from here, wherever they run.</Trans></p></li> : null}
          </ul></> : null}
      </div>
      {count ? <p className="move-sheet__note tt-paragraph"><Trans>Each thread here is settled once its new thread’s first turn ends, and its worktree is kept.</Trans></p> : null}
    </>
    actions = <>
      {cancel(count ? t`Cancel` : t`Close`)}
      {count ? <Button variant="primary" disabled={phase.kind === 'starting'} onClick={() => void start(machine, preview, going)}>
        {phase.kind === 'starting' ? t`Moving…` : one !== null ? t`Move it to ${named}` : plural(count, { one: 'Move # thread', other: 'Move # threads' })}
      </Button> : null}
    </>
  }
  return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialog} className="tt-dialog move-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={phase.kind === 'confirm' || phase.kind === 'starting' ? leadId : undefined} aria-busy={phase.kind === 'starting' || phase.kind === 'preparing' || undefined}>
      <h2 id={titleId}>{title}</h2>
      {body}
      <div className="tt-dialog__actions">{actions}</div>
    </section>
  </div>
}

/**
 * Every move's card as main last sent them, shared by Watcher's conversation: read once when it appears, then kept current
 * by main's pushes, which come only when a card changes. Nothing reads on a timer.
 */
class MoveCardsStore {
  private view: ThreadMovesView | null = null
  private readonly listeners = new Set<() => void>()
  private bridge: ThreadMovesBridge | null = null
  private users = 0
  private stop: (() => void) | null = null
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly get = (): ThreadMovesView | null => this.view
  use(bridge: ThreadMovesBridge): () => void {
    if (this.bridge !== bridge) { this.stop?.(); this.stop = null; this.users = 0; this.bridge = bridge; this.set(null) }
    if (this.users++ === 0) {
      // A push that answers before the first read is newer than it, so that read is dropped.
      let pushed = false
      this.stop = bridge.onChanged(view => { pushed = true; this.set(view) })
      void bridge.read().then(view => { if (!pushed && this.bridge === bridge && this.users > 0) this.set(view) }, () => undefined)
    }
    let stopped = false
    return () => {
      if (stopped || this.bridge !== bridge) return
      stopped = true
      if (--this.users === 0) { this.stop?.(); this.stop = null; this.set(null) }
    }
  }
  private set(view: ThreadMovesView | null): void {
    if (this.view === view) return
    this.view = view
    for (const listener of [...this.listeners]) listener()
  }
  /** For tests: forget everything. */
  clear(): void { this.stop?.(); this.stop = null; this.users = 0; this.bridge = null; this.view = null }
}
export const moveCardsStore = new MoveCardsStore()
const NO_CARDS: readonly ThreadMoveCard[] = []

/** Every move's card, or none where moving is not offered and until the first read answers. */
export function useMoveCards(bridge?: ThreadMovesBridge): readonly ThreadMoveCard[] {
  const active = useThreadMovesBridge(bridge)
  useEffect(() => active ? moveCardsStore.use(active) : undefined, [active])
  const view = useSyncExternalStore(moveCardsStore.subscribe, moveCardsStore.get)
  return active ? view?.cards ?? NO_CARDS : NO_CARDS
}

/** A thread as a move's card names it, and what a press on its name does: what Watcher's conversation provides. */
export interface MoveCardThreads {
  readonly describe: (target: WatcherThreadTarget) => { readonly threadId: string | null; readonly title: string | null; readonly providerId: AgentThread['providerId']; readonly provider: string | undefined; readonly project: string | undefined }
  readonly press: (threadId: string) => Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown'>
}

/** The steps a move's record goes through, for the track on its card. */
const STEPS: readonly ThreadMoveCard['state'][] = ['fenced', 'branch-sent', 'thread-started', 'first-turn-ended', 'source-settled']

/** What a move's card says: its lead, the short word for where it stands and that word's tone, and its line. */
export function moveCardWords(card: ThreadMoveCard): { readonly lead: string; readonly short: string; readonly tone: 'working' | 'needs' | 'ready' | 'quiet'; readonly line: string | null } {
  const machine = card.machine
  if (card.waiting && STEPS.includes(card.state) && card.state !== 'source-settled')
    return { lead: i18n._(msg`Moving`), short: i18n._(msg`Waiting for ${machine}`), tone: 'needs', line: i18n._(msg`This thread is waiting for ${machine} to answer about its move. Nothing was lost.`) }
  switch (card.state) {
    case 'fenced': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Holding sends`), tone: 'working', line: i18n._(msg`It takes no sends here while it moves.`) }
    case 'branch-sent': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Branch sent`), tone: 'working', line: i18n._(msg`Its branch is on ${machine}. Starting the new thread there…`) }
    case 'thread-started': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Started on ${machine}`), tone: 'working', line: i18n._(msg`The new thread on ${machine} is working from its handover. This one is settled once that first turn ends.`) }
    case 'first-turn-ended': return { lead: i18n._(msg`Moving`), short: i18n._(msg`First turn ended`), tone: 'working', line: i18n._(msg`Its first turn on ${machine} ended. Settling the thread here…`) }
    case 'source-settled': return { lead: i18n._(msg`Moved`), short: i18n._(msg`Continued on ${machine}`), tone: 'ready', line: null }
    case 'stayed': return { lead: i18n._(msg`Stayed here`), short: i18n._(msg`Stayed here`), tone: 'quiet', line: card.words ?? null }
    case 'given-back': return { lead: i18n._(msg`Not moved`), short: i18n._(msg`Stays here`), tone: 'quiet', line: card.words ?? null }
    case 'asks': return { lead: i18n._(msg`Not moved yet`), short: i18n._(msg`Waits for you`), tone: 'needs', line: card.words ?? null }
    case 'kept': return { lead: i18n._(msg`Kept here`), short: i18n._(msg`Kept here`), tone: 'quiet', line: i18n._(msg`Nothing was sent to ${machine}. You can send here as before.`) }
    case 'stays': return { lead: i18n._(msg`Not moved`), short: i18n._(msg`Stays here`), tone: 'quiet', line: card.words ?? null }
  }
}

/** One move's card in Watcher's conversation (Zach's pick B): what became of the thread, where it goes, and its press. */
function MoveCard({ card, threads, answer }: { readonly card: ThreadMoveCard; readonly threads: MoveCardThreads; readonly answer: ThreadMovesBridge['answer'] | undefined }): ReactNode {
  const { t } = useLingui()
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const facts = threads.describe(card.source)
  const words = moveCardWords(card)
  const title = facts.title ?? t`a thread no longer here`
  const metaId = useId(), statusId = useId()
  const step = STEPS.indexOf(card.state)
  const moved = card.moved ? threads.describe(card.moved) : null
  const link = (thread: NonNullable<typeof moved>, label: string): ReactNode => thread.threadId === null ? <span className="receipt-card__name">{label}</span>
    : <button type="button" className="receipt-link tt-focusable" aria-label={t`Open ${label} on ${card.machine} beside Watcher`} {...threads.press(thread.threadId)}>{label}</button>
  const press = async (choice: 'move' | 'keep'): Promise<void> => {
    if (answer === undefined || pending) return
    setPending(true); setRefusal(null)
    try {
      const result = await answer({ cardId: card.id, answer: choice })
      if (result.status === 'refused') setRefusal(result.message)
    } catch { setRefusal(t`Sotto could not reach the move. Nothing changed. Try again.`) }
    setPending(false)
  }
  return <li className="receipt-card move-card" data-move-card={card.id} data-state={card.state} data-tone={words.tone}>
    <div className="receipt-card__top">
      <ArrowRightLeft size={15} aria-hidden="true" className="receipt-card__glyph" />
      <span className="receipt-card__lead">{words.lead}</span>
      {facts.threadId === null ? <span className="receipt-card__name">{title}</span>
        : <button type="button" className="receipt-link tt-focusable" aria-label={t`Open ${title} beside Watcher`} aria-describedby={`${statusId} ${metaId}`} title={title}
          {...threads.press(facts.threadId)}>{title}</button>}
      <span className="receipt-outcome" id={statusId} data-tone={words.tone}>
        <span className="watcher-row__ring" data-tone={words.tone === 'ready' ? 'ready' : words.tone} aria-hidden="true" /><span className="receipt-outcome__word">{words.short}</span>
      </span>
    </div>
    <p className="receipt-card__meta" id={metaId}>
      {facts.provider === undefined ? null : <span className="receipt-card__provider">
        {facts.providerId === undefined ? null : <span className="thread-nav__mark" data-provider={facts.providerId} aria-hidden="true"><ProviderMark provider={facts.providerId} name={facts.provider} /></span>}
        {facts.provider}</span>}
      <span className="receipt-card__machine" data-kind="remote"><Laptop size={12} aria-hidden="true" /><Trans>This computer</Trans>
        <span aria-hidden="true">→</span><span className="tt-visually-hidden"><Trans>to</Trans></span><Server size={12} aria-hidden="true" />{card.machine}</span>
      {card.model ? <span>{t({ message: `${card.model.name} there`, comment: 'The model a moved thread runs on the other machine' })}</span> : null}
      {card.model?.instead ? <span>{t`${card.machine} doesn’t have ${card.model.instead}`}</span> : null}
      {facts.project === undefined ? null : <span className="receipt-card__project">{facts.project}</span>}
    </p>
    {step >= 0 && card.state !== 'source-settled' ? <ol className="move-card__steps" aria-hidden="true">{STEPS.map((item, index) => <li key={item} data-done={index <= step || undefined} />)}</ol> : null}
    {card.state === 'source-settled' ? <p className="receipt-card__placement tt-paragraph">
      {moved !== null ? <Trans>Continued in {link(moved, moved.title ?? title)} on {card.machine}.</Trans> : <Trans>Continued on {card.machine}.</Trans>}{' '}
      <Trans>Settled here, and its worktree is kept.</Trans>{card.watched ? <> <Trans>Watcher watches it there now.</Trans></> : null}
    </p> : words.line !== null ? <p className="receipt-card__placement tt-paragraph" data-tone={words.tone}>{words.line}
      {card.state === 'stayed' && moved !== null ? <> {link(moved, t`Open the new thread`)}</> : null}</p> : null}
    {card.state === 'asks' ? <div className="move-card__actions">
      <Button variant="primary" disabled={pending || answer === undefined} onClick={() => void press('move')}>
        {card.startsOn ? t`Move it on ${card.startsOn}` : t`Move it anyway`}</Button>
      <Button variant="secondary" disabled={pending || answer === undefined} onClick={() => void press('keep')}><Trans>Keep it here</Trans></Button>
    </div> : null}
    {refusal !== null ? <p className="receipt-card__placement move-card__refused tt-paragraph" role="alert">{refusal}</p> : null}
  </li>
}

/**
 * The moves Sotto ran after one message of Watcher's conversation: Sotto's own line naming the machine and how many, then
 * a card for each, grouped by machine in the order they were confirmed.
 */
export function WatcherMoveCards({ cards, threads }: { readonly cards: readonly ThreadMoveCard[]; readonly threads: MoveCardThreads }): ReactNode {
  const { t } = useLingui()
  const answer = useThreadMovesBridge()?.answer
  const groups: ThreadMoveCard[][] = []
  for (const card of cards) {
    const last = groups.at(-1)
    if (last !== undefined && last[0]!.hostId === card.hostId) last.push(card); else groups.push([card])
  }
  return <>{groups.map(group => {
    const machine = group[0]!.machine, count = group.length
    return <section key={group[0]!.id} className="move-cards" aria-label={t`Moves to ${machine}`}>
      <div className="sotto-line">
        <span className="sotto-line__mark" role="img" aria-label="Sotto"><SottoMark className="sotto-line__glyph" /></span>
        <p className="tt-paragraph">{plural(count, { one: `You asked to move # thread to ${machine}. Sotto reports its move here.`, other: `You asked to move # threads to ${machine}. Sotto reports each move here.` })}</p>
        <time dateTime={group[0]!.at}>{clockLabel(Date.parse(group[0]!.at))}</time>
      </div>
      <ul className="watcher-receipts move-cards__list" aria-label={t`Moves to ${machine}`}>
        {group.map(card => <MoveCard key={card.id} card={card} threads={threads} answer={answer} />)}
      </ul>
    </section>
  })}</>
}

import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRightLeft, Laptop, Server } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentState, type AgentThread } from '../../../shared/agents'
import type { HostsBridge, HostsState } from '../../../shared/hosts'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../shared/threadActivity'
import { THREAD_MOVE_THREADS_MAX, type ThreadMoveCard, type ThreadMovePlanned, type ThreadMovePrepare, type ThreadMoveProposal, type ThreadMovesBridge, type ThreadMovesView } from '../../../shared/threadMoves'
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

/**
 * What the sheet was opened for: threads on every machine from Watcher's header, or one thread from its More menu, with
 * the machine it is on when that is not This computer.
 */
export type MoveSheetRequest =
  | { readonly kind: 'all' }
  | { readonly kind: 'one'; readonly threadId: string; readonly title: string; readonly hostId?: string | undefined }
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
/** This computer's host ID as the window knows it. */
export function thisComputerId(state: AgentState | null): string | undefined {
  return state?.connections?.find(item => item.kind === 'local')?.hostId ?? state?.hostId
}
/** The machine a thread is on, by its host ID: a host's, or This computer's. */
const machineOf = (thread: AgentThread, here: string | undefined): string | undefined => thread.remoteHost === true ? thread.hostId : here
/**
 * The open threads Move threads offers for a machine (#1178 part 3, Zach's pick A): every connected machine's but that
 * one's, Watcher's own and what is settled or archived left out, up to the hundred a preview takes.
 */
export function movableThreadIds(state: AgentState, target: string | undefined): readonly string[] {
  const here = thisComputerId(state)
  return state.host.threads.filter(thread => !isPutAway(thread) && thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && thread.clientConnected !== false
    && machineOf(thread, here) !== target).slice(0, THREAD_MOVE_THREADS_MAX).map(thread => thread.id)
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

/** A thread as a move's row names it: its title, provider and project, and the machine it is on now. */
interface RowFacts {
  readonly title: string
  readonly providerId: AgentThread['providerId']
  readonly provider: string | undefined
  readonly project: string | undefined
  /** Its machine's name, or undefined for This computer. */
  readonly from: string | undefined
}
function sheetThread(state: AgentState | null, threadId: string, fallback: string, names: ReadonlyMap<string, string>): RowFacts {
  const thread = state?.host.threads.find(item => item.id === threadId)
  const from = thread?.remoteHost === true ? (thread.hostId ? names.get(thread.hostId) : undefined) ?? thread.hostLabel ?? i18n._(msg`Paired machine`) : undefined
  return { title: thread?.title ?? fallback, providerId: thread?.providerId, provider: thread?.providerId ? PROVIDER_LABELS[thread.providerId] : undefined,
    project: thread ? state?.host.projects.find(item => item.id === thread.projectId)?.title : undefined, from }
}

/**
 * One thread in a move's preview, in the sheet and on Watcher's proposal: where it is now, what it runs on there and why
 * it asks or stays, with a box to tick when `box` is given (Zach's pick, October 29: nothing starts ticked but what the
 * user pointed at).
 */
function MoveRow({ planned, facts, machine, box }: { readonly planned: ThreadMovePlanned; readonly facts: RowFacts; readonly machine: string
  readonly box?: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly disabled?: boolean } | undefined }): ReactNode {
  const { t } = useLingui()
  const boxId = useId(), lineId = useId()
  const line = planned.outcome === 'asks' ? t`${planned.words ?? ''} It waits on its card in Watcher’s conversation for your press before it moves.` : planned.words
  const tone = planned.outcome === 'asks' ? 'needs' : undefined
  const where = <span className="move-sheet__where">{facts.from === undefined ? <><Laptop size={12} aria-hidden="true" /><Trans>This computer</Trans></>
    : <><Server size={12} aria-hidden="true" />{facts.from}</>}</span>
  return <li className="move-sheet__row" data-box={box === undefined ? undefined : 'true'}>
    {box === undefined ? null : <input id={boxId} type="checkbox" className="move-sheet__box" checked={box.checked} disabled={box.disabled}
      aria-describedby={line ? lineId : undefined} onChange={event => box.onChange(event.currentTarget.checked)} />}
    {facts.providerId === undefined ? <span aria-hidden="true" /> : <span className="thread-nav__mark" data-provider={facts.providerId} aria-hidden="true">
      <ProviderMark provider={facts.providerId} name={facts.provider ?? facts.providerId} /></span>}
    {box === undefined ? <span className="move-sheet__name">{facts.title}</span> : <label htmlFor={boxId} className="move-sheet__name">{facts.title}</label>}
    <p className="move-sheet__meta">
      {where}
      {planned.outcome === 'stays' || facts.provider === undefined ? null : <span>{facts.provider}</span>}
      {planned.outcome !== 'stays' && planned.model ? <span>{t({ message: `${planned.model.name} on ${machine}`, comment: 'The model a moved thread runs on there, and the machine' })}</span> : null}
      {planned.outcome !== 'stays' && planned.model?.instead ? <span className="move-sheet__instead">{t`${machine} doesn’t have ${planned.model.instead}`}</span> : null}
      {planned.outcome === 'stays' || facts.project === undefined ? null : <span>{facts.project}</span>}
    </p>
    {line ? <p id={lineId} className="move-sheet__line tt-paragraph" data-tone={tone}>{line}</p> : null}
  </li>
}

/** The ticked threads with one ticked or unticked. */
const toggled = (ticked: ReadonlySet<string>, threadId: string, checked: boolean): ReadonlySet<string> => {
  const next = new Set(ticked)
  if (checked) next.add(threadId); else next.delete(threadId)
  return next
}

/** The preview's three groups, each thread with its box: what moves now, what asks first, and what stays and why. */
function MoveGroups({ threads, machine, facts, box, watcher }: { readonly threads: readonly ThreadMovePlanned[]; readonly machine: string
  readonly facts: (planned: ThreadMovePlanned) => RowFacts
  readonly box?: ((planned: ThreadMovePlanned) => { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly disabled?: boolean }) | undefined
  readonly watcher: boolean }): ReactNode {
  const moves = threads.filter(item => item.outcome === 'moves'), asks = threads.filter(item => item.outcome === 'asks'), stays = threads.filter(item => item.outcome === 'stays')
  const row = (planned: ThreadMovePlanned): ReactNode => <MoveRow key={planned.threadId} planned={planned} facts={facts(planned)} machine={machine}
    box={box !== undefined && planned.outcome !== 'stays' ? box(planned) : undefined} />
  const boxed = box === undefined ? undefined : 'true'
  return <>
    {moves.length ? <><h3><Trans>Moves now</Trans> <span>{moves.length}</span></h3><ul className="move-sheet__list" data-box={boxed}>{moves.map(row)}</ul></> : null}
    {asks.length ? <><h3 data-tone="needs"><Trans>Asks you first</Trans> <span>{asks.length}</span></h3><ul className="move-sheet__list" data-box={boxed}>{asks.map(row)}</ul></> : null}
    {stays.length || watcher ? <><h3><Trans>Stays where it is</Trans> <span>{stays.length + (watcher ? 1 : 0)}</span></h3>
      <ul className="move-sheet__list" data-box={boxed}>{stays.map(row)}
        {watcher ? <li className="move-sheet__row" data-box={boxed}>{boxed ? <span aria-hidden="true" /> : null}<Laptop size={14} aria-hidden="true" /><span className="move-sheet__name">Watcher</span>
          <p className="move-sheet__line tt-paragraph"><Trans>Watcher stays on This computer. It watches your threads from here, wherever they run.</Trans></p></li> : null}
      </ul></> : null}
  </>
}

/** A machine the sheet offers: This computer, or one paired with it. */
interface MoveMachine { readonly hostId: string; readonly name: string; readonly connected: boolean; readonly here: boolean }

type Phase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'preparing'; readonly machine: MoveMachine }
  | { readonly kind: 'confirm'; readonly machine: MoveMachine; readonly preview: Extract<ThreadMovePrepare, { status: 'ok' }> }
  | { readonly kind: 'starting'; readonly machine: MoveMachine; readonly preview: Extract<ThreadMovePrepare, { status: 'ok' }> }
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
  const saved = useMoveMachines(true)
  const hosts = useSyncExternalStore(machinesConnected.subscribe, machinesConnected.get)
  const here = hosts?.localHostId ?? thisComputerId(state)
  // This computer is among the machines (Zach's pick A, October 29) while another machine has a thread to bring here; the
  // one the thread is on is not.
  const own = request.kind === 'one' ? request.hostId ?? here : undefined
  const comes = request.kind === 'one' || state !== null && here !== undefined && movableThreadIds(state, here).length > 0
  const machines = useMemo<readonly MoveMachine[]>(() => [...here === undefined || !comes ? [] : [{ hostId: here, name: t`This computer`, connected: true, here: true }],
    ...saved.map(machine => ({ ...machine, here: false }))].filter(machine => machine.hostId !== own), [here, comes, saved, own, t])
  const names = useMemo(() => new Map(saved.map(machine => [machine.hostId, machine.name] as const)), [saved])
  const connected = machines.filter(machine => machine.connected)
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  // Nothing starts ticked but the thread the sheet was opened for (Zach's pick, October 29).
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const titleId = useId(), leadId = useId()
  const first = useRef<HTMLButtonElement>(null)
  const opener = useRef(moveSheetStore.opener)
  const fallback = useRef<HTMLElement | null>(null)
  fallback.current = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.watcher-move-threads, #watcher-prompt')
  // Escape, Cancel or Close put the sheet away at any step. Put away while the moves start, they go on, and their cards
  // in Watcher's conversation say how each goes.
  const close = (): void => { moveSheetStore.close() }
  const dialog = useDialogFocus({ onEscape: close, initialFocus: first, fallbackFocus: fallback })
  const stateRef = useRef(state)
  stateRef.current = state
  const prepare = async (machine: MoveMachine): Promise<void> => {
    const ids = request.kind === 'one' ? [request.threadId] : stateRef.current === null ? [] : movableThreadIds(stateRef.current, machine.hostId)
    if (ids.length === 0) { setPhase({ kind: 'refused', message: t`No open thread on another machine can move to ${machine.name}.` }); return }
    setPhase({ kind: 'preparing', machine })
    try {
      const preview = await bridge.prepare({ threadIds: [...ids], hostId: machine.hostId })
      if (preview.status !== 'ok') { setPhase({ kind: 'refused', message: preview.message }); return }
      setTicked(new Set(request.kind === 'one' ? preview.threads.filter(item => item.threadId === request.threadId && item.outcome !== 'stays').map(item => item.threadId) : []))
      setPhase({ kind: 'confirm', machine, preview })
    } catch { setPhase({ kind: 'refused', message: t`Sotto could not check which threads can move. Nothing was moved. Try again.` }) }
  }
  // One machine to choose, once the paired machines are known: the sheet goes straight to it, as there is nothing to choose.
  const only = hosts !== null && connected.length === 1 ? connected[0]! : null
  const started = useRef(false)
  useEffect(() => {
    if (started.current || phase.kind !== 'choose' || only === null) return
    started.current = true
    void prepare(only)
  })
  // Each step's first control takes focus as it draws, so Escape and Tab stay in the sheet: Cancel or Close, as every
  // confirmation here starts on its secondary action.
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() }, [phase.kind, dialog])
  const start = async (machine: MoveMachine, preview: Extract<ThreadMovePrepare, { status: 'ok' }>, ids: readonly string[]): Promise<void> => {
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
        {machine.here ? <Laptop size={15} aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}<span className="move-sheet__machine-name">{machine.name}</span>
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
    const going = preview.threads.filter(item => item.outcome !== 'stays')
    const chosen = going.filter(item => ticked.has(item.threadId)).map(item => item.threadId)
    const count = chosen.length
    const one = request.kind === 'one' ? sheetThread(state, request.threadId, request.title, names).title : null
    title = going.length === 0 ? (one !== null ? t`${one} can’t move to ${named} now` : t`No thread can move to ${named} now`)
      : one !== null ? t`Move ${one} to ${named}?` : count === 0 ? t`Choose threads to move to ${named}`
        : plural(count, { one: `Move # thread to ${named}?`, other: `Move # threads to ${named}?` })
    const box = (planned: ThreadMovePlanned) => ({ checked: ticked.has(planned.threadId), disabled: phase.kind === 'starting',
      onChange: (checked: boolean) => { setTicked(previous => toggled(previous, planned.threadId, checked)) } })
    body = <>
      <p id={leadId} className="move-sheet__lead tt-paragraph">{going.length === 0 ? <Trans>Nothing moves: each thread says why it stays.</Trans>
        : one !== null ? <Trans>It continues on {named} as a new thread, in the same project, on the same provider, with a handover of the thread where it is. Its first turn starts at once. Watcher’s conversation reports the move.</Trans>
          : <Trans>Tick each thread to move. Each continues on {named} as a new thread, in the same project, on the same provider, with a handover of the thread where it is. Its first turn starts at once. Watcher’s conversation reports each move.</Trans>}</p>
      <div className="move-sheet__body" tabIndex={0} role="region" aria-label={t`What moves and what stays`}>
        <MoveGroups threads={preview.threads} machine={named} facts={planned => sheetThread(state, planned.threadId, t`A thread no longer here`, names)}
          box={box} watcher={request.kind === 'all' && !machine.here} />
      </div>
      {going.length ? <p className="move-sheet__note tt-paragraph"><Trans>Each thread is settled where it is once its new thread’s first turn ends, and its worktree is kept there.</Trans></p> : null}
    </>
    actions = <>
      {cancel(going.length ? t`Cancel` : t`Close`)}
      {going.length ? <Button variant="primary" disabled={phase.kind === 'starting' || count === 0} onClick={() => void start(machine, preview, chosen)}>
        {phase.kind === 'starting' ? t`Moving…` : one !== null ? t`Move it to ${named}` : count === 0 ? t`Move threads` : plural(count, { one: 'Move # thread', other: 'Move # threads' })}
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
const NO_PROPOSALS: readonly ThreadMoveProposal[] = []
/** Watcher's proposals from the user's words, as main last sent them, or none where moving is not offered. */
export function useMoveProposals(bridge?: ThreadMovesBridge): readonly ThreadMoveProposal[] {
  const active = useThreadMovesBridge(bridge)
  useEffect(() => active ? moveCardsStore.use(active) : undefined, [active])
  const view = useSyncExternalStore(moveCardsStore.subscribe, moveCardsStore.get)
  return active ? view?.proposals ?? NO_PROPOSALS : NO_PROPOSALS
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
  const machine = card.machine, from = card.from
  const stays = from ? i18n._(msg`Stays on ${from}`) : i18n._(msg`Stays here`)
  if (card.waiting && STEPS.includes(card.state) && card.state !== 'source-settled') {
    // Main says which machine it waits on: the one it goes to, or the host its thread is on.
    const waitsOn = card.waitingOn ?? machine
    return { lead: i18n._(msg`Moving`), short: i18n._(msg`Waiting for ${waitsOn}`), tone: 'needs', line: i18n._(msg`This thread is waiting for ${waitsOn} to answer about its move. Nothing was lost.`) }
  }
  switch (card.state) {
    case 'fenced': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Holding sends`), tone: 'working', line: from ? i18n._(msg`It takes no sends on ${from} while it moves.`) : i18n._(msg`It takes no sends here while it moves.`) }
    case 'branch-sent': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Branch sent`), tone: 'working', line: i18n._(msg`Its branch is on ${machine}. Starting the new thread there…`) }
    case 'thread-started': return { lead: i18n._(msg`Moving`), short: i18n._(msg`Started on ${machine}`), tone: 'working', line: i18n._(msg`The new thread on ${machine} is working from its handover. This one is settled once that first turn ends.`) }
    case 'first-turn-ended': return { lead: i18n._(msg`Moving`), short: i18n._(msg`First turn ended`), tone: 'working',
      line: from ? i18n._(msg`Its first turn on ${machine} ended. Settling the thread on ${from}…`) : i18n._(msg`Its first turn on ${machine} ended. Settling the thread here…`) }
    case 'source-settled': return { lead: i18n._(msg`Moved`), short: i18n._(msg`Continued on ${machine}`), tone: 'ready', line: null }
    case 'stayed': { const stayed = from ? i18n._(msg`Stayed on ${from}`) : i18n._(msg`Stayed here`); return { lead: stayed, short: stayed, tone: 'quiet', line: card.words ?? null } }
    case 'given-back': return { lead: i18n._(msg`Not moved`), short: stays, tone: 'quiet', line: card.words ?? null }
    case 'asks': return { lead: i18n._(msg`Not moved yet`), short: i18n._(msg`Waits for you`), tone: 'needs', line: card.words ?? null }
    case 'kept': { const kept = from ? i18n._(msg`Kept on ${from}`) : i18n._(msg`Kept here`)
      return { lead: kept, short: kept, tone: 'quiet', line: from ? i18n._(msg`Nothing was sent to ${machine}. You can send to it on ${from} as before.`) : i18n._(msg`Nothing was sent to ${machine}. You can send here as before.`) } }
    case 'stays': return { lead: i18n._(msg`Not moved`), short: stays, tone: 'quiet', line: card.words ?? null }
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
      <span className="receipt-card__machine" data-kind="remote">
        {card.from === undefined ? <><Laptop size={12} aria-hidden="true" /><Trans>This computer</Trans></> : <><Server size={12} aria-hidden="true" />{card.from}</>}
        <span aria-hidden="true">→</span><span className="tt-visually-hidden"><Trans>to</Trans></span>
        {card.here ? <Laptop size={12} aria-hidden="true" /> : <Server size={12} aria-hidden="true" />}{card.machine}</span>
      {card.model ? <span>{t({ message: `${card.model.name} there`, comment: 'The model a moved thread runs on the other machine' })}</span> : null}
      {card.model?.instead ? <span>{t`${card.machine} doesn’t have ${card.model.instead}`}</span> : null}
      {facts.project === undefined ? null : <span className="receipt-card__project">{facts.project}</span>}
    </p>
    {step >= 0 && card.state !== 'source-settled' ? <ol className="move-card__steps" aria-hidden="true">{STEPS.map((item, index) => <li key={item} data-done={index <= step || undefined} />)}</ol> : null}
    {card.state === 'source-settled' ? <p className="receipt-card__placement tt-paragraph">
      {moved !== null ? <Trans>Continued in {link(moved, moved.title ?? title)} on {card.machine}.</Trans> : <Trans>Continued on {card.machine}.</Trans>}{' '}
      {card.from === undefined ? <Trans>Settled here, and its worktree is kept.</Trans> : <Trans>Settled on {card.from}, and its worktree is kept there.</Trans>}{card.watched ? <> <Trans>Watcher watches it there now.</Trans></> : null}
    </p> : words.line !== null ? <p className="receipt-card__placement tt-paragraph" data-tone={words.tone}>{words.line}
      {card.state === 'stayed' && moved !== null ? <> {link(moved, t`Open the new thread`)}</> : null}</p> : null}
    {card.state === 'asks' ? <div className="move-card__actions">
      <Button variant="primary" disabled={pending || answer === undefined} onClick={() => void press('move')}>
        {card.startsOn ? t`Move it on ${card.startsOn}` : t`Move it anyway`}</Button>
      <Button variant="secondary" disabled={pending || answer === undefined} onClick={() => void press('keep')}>{card.from === undefined ? <Trans>Keep it here</Trans> : <Trans>Keep it on {card.from}</Trans>}</Button>
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

/**
 * Watcher's proposal from the user's words (#1178 part 3, Zach's pick A, October 29, 2026): Sotto's card in Watcher's
 * conversation with the preview, a box for each thread that can move, ticked as Watcher named them, and Move and Not now.
 * Nothing moves until the press, which asks for a fresh preview first; one that changed moves nothing and shows it again.
 */
function MoveProposalCard({ proposal, threads, answer }: { readonly proposal: ThreadMoveProposal; readonly threads: MoveCardThreads; readonly answer: ThreadMovesBridge['answer'] | undefined }): ReactNode {
  const { t } = useLingui()
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(proposal.threads.filter(item => item.ticked).map(item => item.threadId)))
  // Shown again as it is now, the boxes start from what main sent, in the same card, so focus stays where it was.
  const shownAt = useRef(proposal.updatedAt)
  useEffect(() => {
    if (shownAt.current === proposal.updatedAt) return
    shownAt.current = proposal.updatedAt
    setTicked(new Set(proposal.threads.filter(item => item.ticked).map(item => item.threadId)))
  }, [proposal])
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const open = proposal.state === 'open'
  const going = proposal.threads.filter(item => item.outcome !== 'stays')
  const chosen = going.filter(item => ticked.has(item.threadId)).map(item => item.threadId)
  const byId = new Map(proposal.threads.map(item => [item.threadId, item] as const))
  const facts = (planned: ThreadMovePlanned): RowFacts => {
    const item = byId.get(planned.threadId)
    const described = item ? threads.describe(item.source) : undefined
    return { title: described?.title ?? t`A thread no longer here`, providerId: described?.providerId, provider: described?.provider, project: described?.project, from: item?.from }
  }
  const box = (planned: ThreadMovePlanned) => ({ checked: ticked.has(planned.threadId), disabled: !open || pending,
    onChange: (checked: boolean) => { setTicked(previous => toggled(previous, planned.threadId, checked)) } })
  const press = async (request: Parameters<ThreadMovesBridge['answer']>[0]): Promise<void> => {
    if (answer === undefined || pending) return
    setPending(true); setRefusal(null)
    try {
      const result = await answer(request)
      if (result.status === 'refused') setRefusal(result.message)
    } catch { setRefusal(t`Sotto could not reach the move. Nothing changed. Try again.`) }
    setPending(false)
  }
  const machine = proposal.machine
  const said = proposal.state === 'moved' ? plural(proposal.threads.filter(item => item.ticked).length, { one: `You asked to move # thread to ${machine}. Sotto reports its move here.`, other: `You asked to move # threads to ${machine}. Sotto reports each move here.` })
    : proposal.state === 'dismissed' ? t`You chose not to move these threads to ${machine}. Nothing was moved.`
      : going.length === 0 ? t`Watcher proposed moving threads to ${machine}, but none can move now. Each says why.`
        : plural(going.length, { one: `Watcher proposes moving # thread to ${machine}. Nothing moves until you press Move.`, other: `Watcher proposes moving # threads to ${machine}. Nothing moves until you press Move.` })
  return <section className="move-proposal" data-move-proposal={proposal.id} data-state={proposal.state} aria-label={t`Proposed moves to ${machine}`}>
    <div className="sotto-line">
      <span className="sotto-line__mark" role="img" aria-label="Sotto"><SottoMark className="sotto-line__glyph" /></span>
      <p className="tt-paragraph">{said}</p>
      <time dateTime={proposal.at}>{clockLabel(Date.parse(proposal.at))}</time>
    </div>
    {open ? <div className="move-proposal__card">
      <MoveGroups threads={proposal.threads} machine={machine} facts={facts} box={box} watcher={false} />
      {proposal.words !== undefined ? <p className="move-proposal__changed tt-paragraph">{proposal.words}</p> : null}
      {going.length ? <div className="move-card__actions">
        <Button variant="primary" disabled={pending || answer === undefined || chosen.length === 0}
          onClick={() => void press({ proposalId: proposal.id, answer: 'move', threadIds: chosen })}>
          {chosen.length === 0 ? t`Move threads` : plural(chosen.length, { one: 'Move # thread', other: 'Move # threads' })}</Button>
        <Button variant="secondary" disabled={pending || answer === undefined} onClick={() => void press({ proposalId: proposal.id, answer: 'dismiss' })}><Trans>Not now</Trans></Button>
      </div> : <div className="move-card__actions">
        <Button variant="secondary" disabled={pending || answer === undefined} onClick={() => void press({ proposalId: proposal.id, answer: 'dismiss' })}><Trans>Close</Trans></Button>
      </div>}
      {refusal !== null ? <p className="receipt-card__placement move-card__refused tt-paragraph" role="alert">{refusal}</p> : null}
    </div> : null}
  </section>
}

/** Watcher's proposals after one message of its conversation, each a card of Sotto's. */
export function WatcherMoveProposals({ proposals, threads }: { readonly proposals: readonly ThreadMoveProposal[]; readonly threads: MoveCardThreads }): ReactNode {
  const answer = useThreadMovesBridge()?.answer
  return <>{proposals.map(proposal => <MoveProposalCard key={proposal.id} proposal={proposal} threads={threads} answer={answer} />)}</>
}


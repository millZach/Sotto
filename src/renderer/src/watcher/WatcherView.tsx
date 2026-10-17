import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, List, MoreHorizontal } from 'lucide-react'
import { PROVIDER_LABELS, type AgentState } from '../../../shared/agents'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { resolveModel } from '../../../shared/modelCatalog'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { Select } from '../components/Select'
import { SottoMark } from '../components/SottoMark'
import { PageWindowControls } from '../components/WindowControls'
import { claimRoomFocus } from '../components/AppShell'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import { useAgents } from '../agents/AgentContext'
import { EffortPicker } from '../agents/EffortPicker'
import { ModelPicker } from '../agents/ModelPicker'
import { OwlRoomSky } from '../agents/OwlSky'
import { useClock } from '../agents/paneGrid'
import { PromptEditor, type PromptEditorElement } from '../agents/PromptEditor'
import { useShared } from '../agents/stateSharing'
import { describeThreads, type ThreadRow } from '../agents/threadFacts'
import { useContinueEnabled } from '../agents/continuations'
import { effortChoices } from '../agents/ThreadOptions'
import { ThreadPane } from '../agents/ThreadPane'
import { BrowserPageRouteContext } from '../tools/webLinks'
import { useWatcherRoom, type WatcherRoom } from './watcherRoom'
import { BESIDE_PANE_ID, BesideDivider, BesidePane, historyDrawn, roomView, shownShare, useKeptReadingPosition, useRoomView, type RoomTab } from './WatcherBeside'
import { firstMessage, useFirstMessage } from './watcherFirstMessage'
import { WatcherDock } from './WatcherDock'
import { WatcherGlance } from './WatcherGlance'
import { watcherProviderOf } from './watcherProviders'
import { WatcherHandoverOffer, WatcherSendGateContext, watcherSendGate } from './WatcherHandover'
import { overviewCount, useOverview, WatcherOverviewList, type OpenThread, type OverviewEntry } from './WatcherOverview'
import { WatcherOwl } from './WatcherOwl'
import { WatcherOwnChangesContext } from './WatcherOwnChange'
import { WatcherPermissionChip } from './WatcherPermissionChip'
import { WatcherWatchedView, watchedCount } from './WatcherWatched'
import { useOrchestratingStart, useSaveOrchestrating } from './orchestratingRole'

const WATCHER_PROMPT_ID = 'watcher-prompt'
const WATCHER_PANE_ID = 'watcher-pane'
const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8] as const

const ROOM_TABS: readonly RoomTab[] = ['conversation', 'watched']
const TAB_KEYS: Readonly<Record<string, (index: number) => number>> = {
  ArrowLeft: index => (index + ROOM_TABS.length - 1) % ROOM_TABS.length, ArrowRight: index => (index + 1) % ROOM_TABS.length,
  Home: () => 0, End: () => ROOM_TABS.length - 1,
}

/**
 * Conversation and Watched, beside All threads, once Watcher runs (Zach's pick on October 13, 2026, watch B): what
 * Watcher's pane shows, its conversation or the threads it watches, with how many it watches. The count replaces "2 of
 * 4 watched", since watching has no limit; the arrow keys move between the two, as the room switch's do.
 */
function RoomTabs({ tab, count, ids }: { readonly tab: RoomTab; readonly count: number; readonly ids: { readonly watchedTab: string; readonly watchedPanel: string } }): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  const show = (next: RoomTab): void => roomView.set({ tab: next })
  return <div ref={list} className="watcher-tabs" role="tablist" aria-label="Watcher’s view"
    onKeyDown={event => {
      const move = TAB_KEYS[event.key]
      if (move === undefined) return
      event.preventDefault()
      const next = ROOM_TABS[move(ROOM_TABS.indexOf(tab))]!
      show(next)
      list.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    }}>
    <button type="button" role="tab" data-tab="conversation" className="watcher-tabs__tab tt-focusable" aria-selected={tab === 'conversation'} tabIndex={tab === 'conversation' ? 0 : -1}
      onClick={() => show('conversation')}>Conversation</button>
    <button type="button" role="tab" data-tab="watched" id={ids.watchedTab} className="watcher-tabs__tab tt-focusable" aria-selected={tab === 'watched'} tabIndex={tab === 'watched' ? 0 : -1}
      aria-controls={tab === 'watched' ? ids.watchedPanel : undefined} aria-label={`Watched, ${count} ${count === 1 ? 'thread' : 'threads'}`} onClick={() => show('watched')}>
      Watched<span className="watcher-tabs__count" aria-hidden="true">{count}</span>
    </button>
  </div>
}

/**
 * More Watcher actions: a small panel under its button, holding Threads in flight, the one setting Watcher has.
 * It saves as it changes, like Settings. Escape closes it and returns focus to the button; a press outside closes it
 * and leaves focus where that press put it.
 */
function WatcherActions({ room, limit }: { readonly room: WatcherRoom; readonly limit: number }): ReactNode {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    select.current?.focus()
    const away = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const close = (): void => { setOpen(false); button.current?.focus() }
  const change = async (next: number): Promise<void> => {
    if (room.setLimit === null) return
    setError(null)
    // The field stays live while main saves, so it keeps focus; main's answer, or the next change, is what shows.
    try { setError(room.settle(await room.setLimit({ limit: next }))) } catch { setError('Sotto could not save the limit. It is unchanged.') }
  }
  // Escape answers on the button as well as in the panel: Shift+Tab back to the button leaves the panel open.
  return <div className="watcher-actions" onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button ref={button} type="button" className="pane-action tt-focusable" aria-label="More Watcher actions" title="More Watcher actions"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={panelId} className="watcher-actions__panel" role="dialog" aria-label="Watcher settings"
      onBlur={event => { const next = event.relatedTarget as Node | null; if (next !== null && !event.currentTarget.contains(next) && next !== button.current) setOpen(false) }}>
      <Field label="Threads in flight" description="Watcher starts new work only while fewer than this many threads are working for it. It watches any number, and lowering this stops nothing.">
        <Select ref={select} value={String(limit)} onChange={event => void change(Number(event.currentTarget.value))}>
          {LIMITS.map(value => <option key={value} value={value}>{value}</option>)}
        </Select>
      </Field>
      {error ? <p className="watcher-actions__error" role="alert">{error}</p> : null}
    </div> : null}
  </div>
}

/** What Watcher's header holds besides its name: All threads and its count, and, once Watcher runs, its tabs and its actions. */
interface HeaderParts {
  readonly room: WatcherRoom | null
  readonly limit: number
  readonly count: number
  readonly tab: RoomTab
  readonly tabIds: { readonly watchedTab: string; readonly watchedPanel: string }
  readonly listOpen: boolean
  readonly listButton: React.RefObject<HTMLButtonElement | null>
  readonly onToggleList: () => void
}

/**
 * Watcher's header: the Sotto Owl tile in the window's corner, as on every other Owl page, then Watcher's name and
 * All threads, which opens the Overview over the room; once Watcher runs, Conversation and Watched, and at its end More
 * Watcher actions. The night sky spreads behind the corner. The row is the window's drag strip.
 */
function WatcherHeader({ room, limit, count, tab, tabIds, listOpen, listButton, onToggleList }: HeaderParts): ReactNode {
  const started = room?.state?.current != null
  return <header className="thread-workspace__head watcher-head">
    <span className="watcher-head__tile" role="img" aria-label={releaseTrackName('owl')}><SottoMark className="thread-nav__tile" /></span>
    <div className="thread-workspace__title">
      <h1>Watcher</h1>
      <button ref={listButton} type="button" className="watcher-head__list tt-focusable" aria-haspopup="dialog" aria-expanded={listOpen}
        aria-label={`All threads, ${count}. Show the list`} title="All threads" onClick={onToggleList}>
        <List size={15} aria-hidden="true" /><span className="watcher-head__list-text">All threads</span>
        <span className="watcher-head__count" aria-hidden="true">{count}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      {started && room !== null ? <RoomTabs tab={tab} count={watchedCount(room)} ids={tabIds} /> : null}
    </div>
    {started && room !== null ? <div className="thread-workspace__actions"><WatcherActions room={room} limit={limit} /></div> : null}
  </header>
}

/**
 * The first time: the room as it will be, with Watcher's composer ready (Zach's pick on October 11, 2026). The user
 * picks one of their own Codex, Claude Code, Grok Build or Muse models in the composer and sends what they want done first;
 * that send asks main to create Watcher, selecting nothing anywhere, and the message then goes to it as its first. A
 * refusal is said in main's own words and the message stays in the composer. What it holds is the window's
 * (`firstMessage`), so leaving the room and coming back finds it as it was, starting included.
 */
function WatcherFirstEntry({ state, room }: { readonly state: AgentState; readonly room: WatcherRoom }): ReactNode {
  const app = useOptionalApp()
  // Muse is named only where its own gate shows it (ADR-0072); its models are listed only then too.
  const providers = useOwlFeature('muse') ? 'Codex, Claude Code, Grok Build or Muse' : 'Codex, Claude Code or Grok Build'
  const models = useMemo(() => state.host.models.filter(model => model.ready !== false && watcherProviderOf(model) !== null), [state.host.models])
  const { text, modelId, effort, phase, error } = useFirstMessage()
  // Unchosen here, Watcher starts on the Orchestrating role's model and effort where worker roles are on (#1041). A pick
  // here saves the role too, and a change to the role in Settings clears the pick, so the two never disagree.
  const roleStart = useOrchestratingStart(models)
  const saveOrchestrating = useSaveOrchestrating()
  const roleModel = roleStart === null ? undefined : resolveModel(models, roleStart.modelId)
  const model = models.find(item => item.id === modelId) ?? roleModel ?? models[0]
  const roleEffort = roleStart !== null && model !== undefined && model.id === roleStart.modelId ? roleStart.reasoningEffort ?? undefined : undefined
  const reasoning = effort ?? roleEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, reasoning)
  const starting = phase !== 'writing'
  const field = useRef<PromptEditorElement | null>(null)
  const [notices, setNotices] = useState<HTMLElement | null>(null)
  const provider = model === undefined ? null : watcherProviderOf(model)
  const ready = model !== undefined && provider !== null && room.open !== null && !starting
  const canSend = ready && text.trim() !== ''
  const start = async (): Promise<void> => {
    if (!canSend || model === undefined || provider === null || room.open === null) return
    firstMessage.update({ phase: 'starting', error: null })
    // Main's answer is kept by the window, not here: the room may be gone by the time it comes.
    try {
      const refusal = room.settle(await room.open({ provider, modelId: model.id, ...(reasoning ? { reasoningEffort: reasoning } : {}) }))
      firstMessage.update(refusal === null ? { phase: 'started' } : { phase: 'writing', error: refusal })
    } catch {
      firstMessage.update({ phase: 'writing', error: 'Sotto could not start Watcher. Nothing was started, and your message is still here. Try again.' })
    }
  }
  const providerName = provider === null ? null : PROVIDER_LABELS[provider]
  return <>
    <div className="thread-transcript">
      <div className="thread-workspace__transcript watcher-first">
        <div className="watcher-first__intro">
          <WatcherOwl size={28} className="watcher-first__owl" />
          <h2>Start Watcher</h2>
          <p>Watcher is a thread that starts and briefs your other threads, and keeps an eye on them while they work.</p>
          <p>It runs on your own {providers} account, with that provider’s own tools. It hands changes to your threads rather than making them itself, and only you answer a thread’s questions and permissions.</p>
          {model === undefined ? <>
            <p className="watcher-first__missing">Connect {providers} in Settings, under Providers, to start Watcher.</p>
            {app ? <div className="thread-workspace__empty-actions"><Button variant="secondary" onClick={() => app.actions.navigate('settings')}>Open Settings</Button></div> : null}
          </> : <p>Pick its model and what it may do without asking below, then send what you want done first. That message starts it.</p>}
        </div>
      </div>
    </div>
    {model !== undefined ? <div className="thread-workspace__compose">
      {error ? <p className="agent-error watcher-first__error" role="alert">{error}</p> : null}
      <form className="thread-prompt" onSubmit={event => { event.preventDefault(); void start() }}>
        <PromptEditor fieldRef={field} id={WATCHER_PROMPT_ID} text={text} skills={[]} sigils={[]} label="Watcher message" editable={!starting}
          placeholder="Say what to start or check. Sending starts Watcher."
          onChange={next => firstMessage.update({ text: next })}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void start()
          }} />
        <label className="tt-visually-hidden" htmlFor={WATCHER_PROMPT_ID} onClick={() => field.current?.focus()}>Watcher message</label>
        <div className="thread-prompt__footer">
          <div className="thread-prompt__meta">
            <div className="thread-options-bar">
              <div className="thread-options thread-options--chips" role="group" aria-label="Watcher’s model">
                <ModelPicker models={models} modelId={model.id} disabled={starting} onChange={id => {
                  firstMessage.update({ modelId: id, effort: null })
                  saveOrchestrating?.(id, resolveModel(models, id)?.defaultReasoningEffort ?? null, models)
                }} />
                {efforts.length > 0 ? <EffortPicker key={model.id} value={reasoning} options={efforts} disabled={starting} onChange={value => {
                  firstMessage.update({ effort: value })
                  saveOrchestrating?.(model.id, value, models)
                }}
                  defaultValue={model.defaultReasoningEffort} modelName={model.name} /> : null}
                <WatcherPermissionChip model={model} provider={providerName ?? model.provider} disabled={starting} noticeSlot={notices} />
              </div>
            </div>
            {starting ? <span className="thread-prompt__status" role="status">Starting Watcher…</span> : null}
          </div>
          <div className="thread-prompt__actions">
            <Button iconOnly className="thread-prompt__send" type="submit" aria-label="Start Watcher and send" title={canSend ? 'Start Watcher and send' : 'Write what Watcher should do first'} disabled={!canSend}>
              <ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div ref={setNotices} className="thread-options-notices" />
      </form>
      <div className="thread-pane__meta">
        <p className="watched-note"><WatcherOwl size={13} /><span>Your first message starts Watcher on {model.name}, with your own {providerName ?? model.provider} account.</span></p>
      </div>
    </div> : null}
  </>
}

/**
 * The current Watcher's real thread pane: its transcript, its request cards and its composer, under Watcher's header
 * and the needs-you line. The first entry's message reaches it from the room provider (`useFirstMessageDelivery`).
 */
function WatcherPane({ state, row, header, watched, error, focused, now }: {
  readonly state: AgentState
  readonly row: ThreadRow
  readonly header: ReactNode
  /** The Watched view, when it stands in the conversation's place. */
  readonly watched: ReactNode
  readonly error: string | null
  readonly focused: boolean
  readonly now: number | undefined
}): ReactNode {
  const agents = useAgents()
  // Its reading position is kept for a trip to another room, as a beside thread's is for its next opening, and for a
  // look at Watched.
  useKeptReadingPosition(row.thread, WATCHER_PANE_ID, watched === null)
  // The first entry's composer had focus and is gone, or the room opened before Watcher's thread arrived: focus left
  // with nowhere to be goes to Watcher's own composer.
  useLayoutEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById(WATCHER_PROMPT_ID)?.focus()
  }, [])
  // Each reply in which Watcher changed files itself carries a line saying so (`WatcherOwnChangeFor`).
  const room = useWatcherRoom()
  const ownChanges = room?.state?.ownChanges
  const changes = useMemo(() => new Map((ownChanges ?? []).map(change => [change.replyMessageId, change] as const)), [ownChanges])
  // After a provider change, the handover of the last Watcher is offered over the composer until the first send or X
  // (ADR-0073), and while it stands a send carries it.
  const offer = room?.state?.handover ?? null
  const offered = offer !== null && room?.handover != null
  const gate = useMemo(() => watcherSendGate(room?.handover, room?.settle, offered), [room?.handover, room?.settle, offered])
  // Watcher is not on the Threads page, so a page in its own browser could never be seen: its links open in the
  // system browser.
  return <BrowserPageRouteContext.Provider value={null}><WatcherOwnChangesContext.Provider value={changes}><WatcherSendGateContext.Provider value={gate}>
    <ThreadPane row={row} state={state} command={agents.command} store={agents.threadDrafts} focused={focused} promptId={WATCHER_PROMPT_ID}
      error={error} now={now} watcherHeader={header} watcherBody={watched}
      notice={offered && room !== null && offer !== null ? <WatcherHandoverOffer key={offer.source.threadId} room={room} offer={offer} composerId={WATCHER_PROMPT_ID} /> : undefined} />
  </WatcherSendGateContext.Provider></WatcherOwnChangesContext.Provider></BrowserPageRouteContext.Provider>
}

/** Room left above a failed turn's line when it is brought into view, so the line does not sit flush on the edge. */
const FAILURE_MARGIN_PX = 12

/**
 * Puts focus where a thread opened beside Watcher should take it. Opened at what it waits on: its request card, or, for
 * a thread that waits on the user after a failed turn, that turn's line ("Failed after …") brought into view, or the
 * end of its transcript when no turn record says where it failed, since the failure is then its latest turn. Otherwise
 * its title.
 */
function focusBeside(atRequest: boolean): void {
  const pane = document.getElementById(BESIDE_PANE_ID)
  if (pane === null) return
  const card = atRequest ? pane.querySelector<HTMLElement>('.agent-request[data-kind]') : null
  if (atRequest && card === null && focusFailure(pane)) return
  const target = card ?? pane.querySelector<HTMLElement>('.thread-workspace__head h2')
  if (target === null) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: card === null })
  card?.scrollIntoView?.({ block: 'nearest' })
}

/** Brings a beside thread's latest failed turn into view and focuses its line; false when it has no transcript. */
function focusFailure(pane: HTMLElement): boolean {
  const transcript = pane.querySelector<HTMLElement>('.thread-workspace__transcript')
  if (transcript === null) return false
  const failure = [...transcript.querySelectorAll<HTMLElement>('[data-turn-outcome="failed"]')].at(-1)
  if (failure === undefined) transcript.scrollTop = transcript.scrollHeight
  else transcript.scrollTop += failure.getBoundingClientRect().top - transcript.getBoundingClientRect().top - FAILURE_MARGIN_PX
  // The transcript learns at once whether its reader is still at the end.
  transcript.dispatchEvent(new Event('scroll'))
  const line = failure === undefined ? transcript : failure.querySelector<HTMLElement>(':scope > button') ?? failure
  if (!line.hasAttribute('tabindex')) line.setAttribute('tabindex', '-1')
  line.focus({ preventScroll: true })
  return true
}

/**
 * Watcher's room (ADR-0073), with no sidebar (Zach's picks on October 11, 2026): the Sotto Owl tile and its night sky
 * in the corner, Watcher's conversation centred under its header and the needs-you line, a thread opened beside it in
 * its own real pane, the Overview over the room on All threads, and the switch and page links floating at the bottom.
 * The room keeps its own view: it never selects a thread or a project on the Threads page, except through Open in
 * Threads or Shift with a press, which go there on purpose; Watcher itself is in neither the Overview nor Threads.
 */
export function WatcherView({ now: fixedNow, updateControl }: {
  /** A fixed clock for captures; the rows' times then hold still. */
  readonly now?: number | undefined
  readonly updateControl?: ReactNode
}): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  const room = useWatcherRoom()
  const now = useClock(fixedNow)
  const state = agents.state
  const command = agents.command
  const mac = app?.platform === 'darwin'
  const current = room?.state?.current ?? null
  const watcherId = room?.currentThreadId ?? null
  const continued = useContinueEnabled()
  const rows = useShared(useMemo(() => state === null ? [] : describeThreads(state, now, { continued }), [state, now, continued]))
  const groups = useOverview(state, rows, now, watcherId)
  const needs = useMemo<readonly OverviewEntry[]>(() => groups.find(group => group.group === 'Needs you')?.entries ?? [], [groups])
  const rowsById = useMemo(() => new Map(rows.map(row => [row.thread.id, row] as const)), [rows])
  const view = useRoomView()
  const besideRow = view.besideId !== null && view.besideId !== watcherId ? rowsById.get(view.besideId) : undefined
  const watcherRow = watcherId === null ? undefined : rowsById.get(watcherId)
  const [listOpen, setListOpen] = useState(false)
  const listButton = useRef<HTMLButtonElement>(null)
  const listOpener = useRef<HTMLElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const pendingFocus = useRef<{ readonly threadId: string; readonly atRequest: boolean } | null>(null)
  const [focusedPane, setFocusedPane] = useState<'watcher' | 'beside'>('watcher')
  const watchedTab = useId()
  const watchedPanel = useId()
  const tabIds = useMemo(() => ({ watchedTab, watchedPanel }), [watchedTab, watchedPanel])
  const area = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  // The room reads Watcher's history and the thread beside it while they are on screen, as Threads does for its
  // panes, and lets them go after. An empty list goes too: closing the only pane before Watcher exists leaves the
  // room mounted, and main would otherwise go on counting the closed thread as seen.
  const observed = JSON.stringify([watcherId, besideRow?.thread.id ?? null].filter(Boolean))
  useEffect(() => {
    void command({ type: 'observe-threads', threadIds: JSON.parse(observed) as string[] })
  }, [command, observed])
  useEffect(() => () => { void command({ type: 'observe-threads', threadIds: [] }) }, [command])

  useLayoutEffect(() => {
    const element = area.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setWidth(Math.round(element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A switch press hands focus to the floating switch's lit owl. Arriving any other way, focus goes to Watcher's composer.
  useLayoutEffect(() => {
    if (claimRoomFocus('watcher')) return
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById(WATCHER_PROMPT_ID)?.focus()
    // Only on arrival; later renders leave focus where the user put it.
  }, [])

  // A thread just opened beside Watcher takes focus once its pane is drawn, and, opened at what it waits on, once its
  // history is too, so that a kept reading position put back when the history arrives cannot move it off the failure.
  useEffect(() => {
    const wanted = pendingFocus.current
    if (wanted === null || besideRow?.thread.id !== wanted.threadId) return
    if (wanted.atRequest && !historyDrawn(besideRow.thread) && besideRow.thread.historyStatus !== 'error') return
    pendingFocus.current = null
    focusBeside(wanted.atRequest)
  })

  const openThread = useCallback<OpenThread>((threadId, how) => {
    setListOpen(false)
    if (how.inThreads) {
      // Shift with a press, or Open in Threads: the Threads room with that thread selected, on purpose.
      void command({ type: 'select-thread', threadId }).finally(() => app?.actions.navigate('threads'))
      return
    }
    opener.current = how.from ?? null
    pendingFocus.current = { threadId, atRequest: how.atRequest === true }
    setFocusedPane('beside')
    if (roomView.get().besideId === threadId) { pendingFocus.current = null; focusBeside(how.atRequest === true); return }
    roomView.set({ besideId: threadId })
  }, [command, app])

  const closeBeside = useCallback((): void => {
    roomView.set({ besideId: null })
    setFocusedPane('watcher')
    const back = opener.current
    opener.current = null
    // Focus returns to what opened the thread, or to Watcher's composer when that is gone.
    window.setTimeout(() => { if (back?.isConnected) back.focus(); else document.getElementById(WATCHER_PROMPT_ID)?.focus() }, 0)
  }, [])

  /** Opens or closes the Overview over the room, remembering what opened it for focus to go back to. */
  const toggleList = (from: HTMLElement | null, open?: boolean): void => {
    listOpener.current = from
    setListOpen(value => open ?? !value)
  }
  const closeList = useCallback((refocus: boolean): void => {
    setListOpen(false)
    if (refocus) (listOpener.current?.isConnected ? listOpener.current : listButton.current)?.focus()
  }, [])

  const error = state?.error ?? agents.error ?? null
  const limit = room?.state?.inFlightLimit ?? app?.settings?.watcherInFlightLimit ?? 4
  const tab = current === null ? 'conversation' : view.tab
  const header = <>
    <WatcherHeader room={room} limit={limit} count={overviewCount(groups)} tab={tab} tabIds={tabIds} listOpen={listOpen} listButton={listButton} onToggleList={() => toggleList(listButton.current)} />
    <WatcherGlance entries={needs} onOpen={openThread} onShowAll={from => toggleList(from, true)} />
  </>
  let watcherContent: ReactNode
  const status = (text: string, alert = false): ReactNode => <>{header}<p className={alert ? 'agent-error watcher-room__status' : 'watcher-room__status'} role={alert ? 'alert' : 'status'}>{text}</p></>
  if (room === null || room.status === 'unavailable') watcherContent = status('This build cannot reach Watcher yet. Nothing was started. A later Sotto Owl build adds it.')
  else if (state === null || room.status === 'loading') watcherContent = status(agents.error ?? 'Opening Watcher…')
  else if (room.error !== null && room.state === null) watcherContent = status(room.error, true)
  else if (current === null) watcherContent = <>{header}<WatcherFirstEntry state={state} room={room} /></>
  else if (watcherRow === undefined) watcherContent = status('Opening Watcher…')
  else watcherContent = <WatcherPane state={state} row={watcherRow} header={header} error={focusedPane === 'watcher' || besideRow === undefined ? error : null}
    watched={tab === 'watched' ? <WatcherWatchedView room={room} state={state} groups={groups} id={watchedPanel} labelledBy={watchedTab} onOpen={openThread}
      onShowAll={from => toggleList(from, true)} /> : null}
    focused={focusedPane === 'watcher' || besideRow === undefined} now={fixedNow} />

  const beside = besideRow !== undefined && state !== null
  const share = shownShare(width, view.share)
  return <div className={`management-view threads-view watcher-room${mac ? ' threads-view--mac' : ''}`} data-beside={beside || undefined}>
    <section className="thread-workspace" aria-label="Watcher’s room">
      <div className="thread-workspace__body">
        <div className="thread-panes">
          <div ref={area} className="thread-panes__area" style={{ '--watcher-share': share } as CSSProperties}>
            <section id={WATCHER_PANE_ID} className="thread-pane watcher-pane" data-thread-id={watcherId ?? undefined} data-focused={focusedPane === 'watcher' || !beside || undefined}
              data-under-controls={!beside || undefined} role="region" aria-label="Watcher"
              onFocusCapture={() => setFocusedPane('watcher')} onPointerDownCapture={() => setFocusedPane('watcher')}>
              <OwlRoomSky />
              {watcherContent}
            </section>
            {beside ? <>
              <BesideDivider width={width} share={view.share} controls={BESIDE_PANE_ID} />
              <BesidePane key={besideRow.thread.id} row={besideRow} state={state} command={command} store={agents.threadDrafts} focused={focusedPane === 'beside'} underControls
                error={focusedPane === 'beside' ? error : null} now={fixedNow} onFocus={() => setFocusedPane('beside')} onClose={closeBeside}
                onOpenInThreads={() => openThread(besideRow.thread.id, { inThreads: true })} />
            </> : null}
          </div>
        </div>
      </div>
    </section>
    <WatcherDock updateControl={updateControl} />
    <PageWindowControls />
    {listOpen ? <WatcherOverviewList groups={groups} watched={room?.watchedThreadIds ?? new Set()} besideId={besideRow?.thread.id ?? null}
      liveClock={fixedNow === undefined} anchor={listButton} opener={listOpener} onOpen={openThread} onClose={closeList} /> : null}
  </div>
}

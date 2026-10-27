import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Marked } from '../components/marks'
import { ArrowUp, BarChart3, Brain, ChevronDown, CircleHelp, Download, Eye, List, MessageSquare, MoreHorizontal, RefreshCw, RotateCw, Settings, Waypoints } from 'lucide-react'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownWords } from '../features/settings/laterWords'
import { PROVIDER_LABELS, type AgentState } from '../../../shared/agents'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { resolveModel } from '../../../shared/modelCatalog'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { PageWindowControls } from '../components/WindowControls'
import { claimRoomFocus } from '../components/AppShell'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import { useAgents } from '../agents/AgentContext'
import { PaneMenu } from '../agents/PaneMenu'
import { RoomSwitch } from '../agents/SidebarFrame'
import { useMemoryEnabled } from '../state/memoryFeature'
import type { UpdateControlProps } from '../features/updates/UpdateControl'
import { updateAction, updateIconState, updateTooltip } from '../features/updates/updateControlLogic'
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
import { isThreadClosed } from '../../../shared/threadActivity'
import { BrowserPageRouteContext } from '../tools/webLinks'
import type { WatcherOperation, WatcherThreadTarget } from '../../../shared/watcher'
import { watcherTakeovers, type WatcherRoomState } from '../../../shared/watcherRoom'
import { rowStatus } from '../agents/threadFacts'
import { threadAddressIndex, threadForTarget, useWatcherRoom, watchedRows, type WatcherRoom } from './watcherRoom'
import { placeTakeovers, WatcherConversationContext, type ConversationThread, type WatcherConversation } from './WatcherReceipts'
import { WatcherStopAll } from './WatcherStopAll'
import { BESIDE_PANE_ID, BesideDivider, BesidePane, historyDrawn, roomView, shownShare, useKeptReadingPosition, useRoomView, type RoomTab } from './WatcherBeside'
import { firstMessage, useFirstMessage } from './watcherFirstMessage'
import { WatcherGlance } from './WatcherGlance'
import { WatcherMachines } from './WatcherMachines'
import { watcherProviderOf } from './watcherProviders'
import { WatcherHandoverOffer, WatcherSendGateContext, watcherSendGate } from './WatcherHandover'
import { NewWatcherNote, newWatcherNoteFacts, WatcherStartStopped } from './WatcherNew'
import { overviewCount, statusWord, threadPress, TONES, useOverview, WatcherOverviewList, type OpenThread, type OverviewEntry } from './WatcherOverview'
import { WatcherContextTile } from './WatcherContextTile'
import { WatcherOwl } from './WatcherOwl'
import { WatcherNightScene } from './WatcherNightScene'
import { moodOf, owlKey, type WatchedOwl } from './owlFamily'
import { WatcherOwnChangesContext } from './WatcherOwnChange'
import { placeAsks, useStablePlacements, WatcherAskAnsweringContext, type WatcherAskAnswering } from './WatcherAsks'
import { prefersReducedMotion } from '../state/reducedMotion'
import { WatcherPermissionChip } from './WatcherPermissionChip'
import { unlistedStatus, WatcherWatchedView, watchedCount } from './WatcherWatched'
import { WatcherPicture } from './WatcherPicture'
import { useOrchestratingStart, useSaveOrchestrating } from './orchestratingRole'

const WATCHER_PROMPT_ID = 'watcher-prompt'
const WATCHER_PANE_ID = 'watcher-pane'

const ROOM_TABS: readonly RoomTab[] = ['conversation', 'watched', 'visualize']
const TAB_KEYS: Readonly<Record<string, (index: number) => number>> = {
  ArrowLeft: index => (index + ROOM_TABS.length - 1) % ROOM_TABS.length, ArrowRight: index => (index + 1) % ROOM_TABS.length,
  Home: () => 0, End: () => ROOM_TABS.length - 1,
}

/** The tabs' and their panels' IDs, for each panel to be named by its tab. */
interface TabIds { readonly watchedTab: string; readonly watchedPanel: string; readonly pictureTab: string; readonly picturePanel: string }

/**
 * Conversation, Watched and Visualize, beside All threads, once Watcher runs (Zach's picks on October 13, 2026, watch B,
 * and October 22, the picture as a third tab): what Watcher's pane shows, its conversation, the threads it watches with
 * how many, or its picture of them (#1339). The count replaces "2 of 4 watched", since watching has no limit; the arrow
 * keys move between the tabs, as the room switch's do. Each tab is its icon alone, named on hover and to assistive
 * technology, with the count as a badge on Watched's eye (Drake's pick on October 24, 2026, `watcher-tabs-prototype.html`).
 */
function RoomTabs({ tab, count, ids }: { readonly tab: RoomTab; readonly count: number; readonly ids: TabIds }): ReactNode {
  const { t } = useLingui()
  const list = useRef<HTMLDivElement>(null)
  const show = (next: RoomTab): void => roomView.set({ tab: next })
  // The badge stops at 99+, so the name on hover says the exact count.
  const watchedName = plural(count, { one: 'Watched, # thread', other: 'Watched, # threads' })
  const conversation = t({ message: 'Conversation', comment: 'The tab that shows Watcher’s own conversation' })
  const visualize = t({ message: 'Visualize', comment: 'The tab that shows what Watcher is doing as a picture' })
  return <div ref={list} className="watcher-tabs" role="tablist" aria-label={t`Watcher’s view`}
    onKeyDown={event => {
      const move = TAB_KEYS[event.key]
      if (move === undefined) return
      event.preventDefault()
      const next = ROOM_TABS[move(ROOM_TABS.indexOf(tab))]!
      show(next)
      list.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
    }}>
    <button type="button" role="tab" data-tab="conversation" className="watcher-tabs__tab tt-focusable" aria-selected={tab === 'conversation'} tabIndex={tab === 'conversation' ? 0 : -1}
      aria-label={conversation} title={conversation} onClick={() => show('conversation')}>
      <MessageSquare size={16} className="watcher-tabs__icon" aria-hidden="true" />
    </button>
    <button type="button" role="tab" data-tab="watched" id={ids.watchedTab} className="watcher-tabs__tab tt-focusable" aria-selected={tab === 'watched'} tabIndex={tab === 'watched' ? 0 : -1}
      aria-controls={tab === 'watched' ? ids.watchedPanel : undefined} aria-label={watchedName} title={watchedName} onClick={() => show('watched')}>
      <Eye size={16} className="watcher-tabs__icon" aria-hidden="true" />
      {count > 0 ? <span className="watcher-tabs__count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
    </button>
    <button type="button" role="tab" data-tab="visualize" id={ids.pictureTab} className="watcher-tabs__tab tt-focusable" aria-selected={tab === 'visualize'} tabIndex={tab === 'visualize' ? 0 : -1}
      aria-controls={tab === 'visualize' ? ids.picturePanel : undefined} aria-label={visualize} title={visualize} onClick={() => show('visualize')}>
      <Waypoints size={16} className="watcher-tabs__icon" aria-hidden="true" />
    </button>
  </div>
}

/** What Watcher's header holds besides its name: All threads and its count, and, once Watcher runs, its tabs and Stop all. */
interface HeaderParts {
  readonly room: WatcherRoom | null
  readonly count: number
  readonly tab: RoomTab
  readonly tabIds: TabIds
  readonly listOpen: boolean
  readonly listButton: React.RefObject<HTMLButtonElement | null>
  readonly onToggleList: () => void
  /** Stop all, at the header's end, while threads Watcher started are running. */
  readonly stopAll: ReactNode
  /** The update control's status and press, for the More menu's last row; none where the app does not update itself. */
  readonly update: UpdateControlProps | null
}

/**
 * The header's end, Watcher's way off the page (Drake's pick on October 26, 2026, D in
 * docs/prototypes/watcher-head-strip-prototype.html): the room switch as the sidebar foot draws it, then one More menu
 * holding the other pages and, under a rule, the update control's press. While an update is in hand, the states the
 * control marks, the menu's button wears a dot and its name says what is ready.
 */
const PAGES = [
  { id: 'usage', label: msg({ message: 'Usage', comment: 'The Usage page.' }), Icon: BarChart3 },
  { id: 'memory', label: msg({ message: 'Memory', comment: 'The Memory page.' }), Icon: Brain },
  { id: 'settings', label: msg({ message: 'Settings', comment: 'The Settings page.' }), Icon: Settings },
  { id: 'help', label: msg({ message: 'Help', comment: 'The Help page.' }), Icon: CircleHelp },
] as const

function WatcherWayOut({ update }: { readonly update: UpdateControlProps | null }): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  // The pages the sidebar foot links, filtered the same way: Usage behind its Owl feature, Memory behind its gate.
  const memory = useMemoryEnabled()
  const usage = useOwlFeature('usage')
  const pages = PAGES.filter(page => (page.id !== 'memory' || memory) && (page.id !== 'usage' || usage)).map(page => ({ ...page, label: t(page.label) }))
  const status = update?.status ?? null
  const action = updateAction(status)
  const icon = updateIconState(status)
  const news = update !== null && icon !== 'idle' && icon !== 'checking'
  const names = pages.map(page => page.label).join(', ')
  const ready = updateTooltip(status)
  const label = news ? t`More: ${names}. ${ready}` : t`More: ${names}`
  const Glyph = icon === 'downloaded' ? RotateCw : icon === 'available' || icon === 'downloading' ? Download : RefreshCw
  return <>
    <RoomSwitch className="thread-nav__seg watcher-head__rooms" iconOnly />
    <PaneMenu className="watcher-head__more" label={label}
      icon={<><MoreHorizontal size={16} aria-hidden="true" />{news ? <span className="watcher-head__news" aria-hidden="true" /> : null}</>}
      groups={[
        pages.map(({ id, label: name, Icon }) => ({ id, label: name, icon: <Icon size={15} aria-hidden="true" />, run: () => app?.actions.navigate(id) })),
        update === null ? [] : [{ id: 'update', label: ready, icon: <Glyph size={15} aria-hidden="true" />, disabled: update.busy || action === 'none',
          run: () => { if (action !== 'none') update.onActivate(action) } }],
      ]} />
  </>
}

/**
 * Watcher's header: the Sotto tile in the window's corner, named for the running build, then Watcher's name and
 * All threads, which opens the Overview over the room; once Watcher runs, Conversation and Watched, and at its end More
 * Watcher actions, then at its far end the room switch and the More menu. Once Watcher runs the tile is also a button for Watcher's context and state (#1189). On macOS no
 * app mark sits beside the traffic lights: before Watcher starts there is no tile, and the button, once it runs,
 * wears Watcher's owl. The night sky spreads behind the corner. The row is the window's drag strip.
 */
function WatcherHeader({ room, count, tab, tabIds, listOpen, listButton, onToggleList, stopAll, update }: HeaderParts): ReactNode {
  const { t } = useLingui()
  const started = room?.state?.current != null
  const track = useReleaseTrack()
  const mac = useOptionalApp()?.platform === 'darwin'
  return <header className="thread-workspace__head watcher-head">
    {started && room !== null ? <WatcherContextTile room={room} />
      : mac ? null
      : <span className="watcher-head__tile" role="img" aria-label={releaseTrackName(track)}><SottoMark className="thread-nav__tile" /></span>}
    <div className="thread-workspace__title">
      <h1>Watcher</h1>
      <button ref={listButton} type="button" className="watcher-head__list tt-focusable" aria-haspopup="dialog" aria-expanded={listOpen}
        aria-label={t`All threads, ${count}. Show the list`} title={t`All threads`} onClick={onToggleList}>
        <List size={15} aria-hidden="true" /><span className="watcher-head__list-text">{t`All threads`}</span>
        <span className="watcher-head__count" aria-hidden="true">{count}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      {started && room !== null ? <RoomTabs tab={tab} count={watchedCount(room)} ids={tabIds} /> : null}
    </div>
    <div className="thread-workspace__actions">{started && room !== null ? stopAll : null}<WatcherWayOut update={update} /></div>
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
  const { t } = useLingui()
  const app = useOptionalApp()
  // Muse is named only where its own gate shows it (ADR-0072); its models are listed only then too.
  const providers = useOwlFeature('muse') ? t`Codex, Claude Code, Grok Build or Muse` : t`Codex, Claude Code or Grok Build`
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
      firstMessage.update({ phase: 'writing', error: t`Sotto could not start Watcher. Nothing was started, and your message is still here. Try again.` })
    }
  }
  const providerName = provider === null ? null : PROVIDER_LABELS[provider]
  const modelName = model?.name
  const accountProvider = providerName ?? model?.provider
  return <>
    <div className="thread-transcript">
      <div className="thread-workspace__transcript watcher-first">
        <div className="watcher-first__intro">
          <WatcherOwl size={28} className="watcher-first__owl" />
          <h2><Trans>Start Watcher</Trans></h2>
          <p className="tt-paragraph"><Trans>Watcher is a thread that starts and briefs your other threads, and keeps an eye on them while they work.</Trans></p>
          <p className="tt-paragraph"><Trans>It runs on your own {providers} account, with that provider’s own tools. It hands changes to your threads rather than making them itself, and only you answer a thread’s questions and permissions.</Trans></p>
          {model === undefined ? <>
            <p className="watcher-first__missing tt-paragraph"><Trans>Connect {providers} in Settings, under Providers, to start Watcher.</Trans></p>
            {app ? <div className="thread-workspace__empty-actions"><Button variant="secondary" onClick={() => app.actions.navigate('settings', 'settings-providers')}><Trans>Open Settings</Trans></Button></div> : null}
          </> : <p className="tt-paragraph"><Trans>Pick its model and what it may do without asking below, then send what you want done first. That message starts it.</Trans></p>}
        </div>
      </div>
    </div>
    {model !== undefined ? <div className="thread-workspace__compose">
      {error ? <p className="agent-error watcher-first__error tt-paragraph" role="alert">{error}</p> : null}
      <form className="thread-prompt" onSubmit={event => { event.preventDefault(); void start() }}>
        <PromptEditor fieldRef={field} id={WATCHER_PROMPT_ID} text={text} skills={[]} sigils={[]} label={t`Watcher message`} editable={!starting}
          placeholder={t`Say what to start or check. Sending starts Watcher.`}
          onChange={next => firstMessage.update({ text: next })}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void start()
          }} />
        <label className="tt-visually-hidden" htmlFor={WATCHER_PROMPT_ID} onClick={() => field.current?.focus()}>{t`Watcher message`}</label>
        <div className="thread-prompt__footer">
          <div className="thread-prompt__meta">
            <div className="thread-options-bar">
              <div className="thread-options thread-options--chips" role="group" aria-label={t`Watcher’s model`}>
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
            {starting ? <span className="thread-prompt__status" role="status"><Trans>Starting Watcher…</Trans></span> : null}
          </div>
          <div className="thread-prompt__actions">
            <Button iconOnly className="thread-prompt__send" type="submit" aria-label={t`Start Watcher and send`} title={canSend ? t`Start Watcher and send` : t`Write what Watcher should do first`} disabled={!canSend}>
              <ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div ref={setNotices} className="thread-options-notices" />
      </form>
      <div className="thread-pane__meta">
        <p className="watched-note tt-paragraph"><WatcherOwl size={13} /><span><Trans>Your first message starts Watcher on {modelName}, with your own {accountProvider} account.</Trans></span></p>
      </div>
    </div> : null}
  </>
}

/**
 * The current Watcher's real thread pane: its transcript, its request cards and its composer, under Watcher's header
 * and the needs-you line. The first entry's message reaches it from the room provider (`useFirstMessageDelivery`).
 */
function WatcherPane({ state, row, header, watched, error, focused, now, describe, press, answering }: {
  readonly state: AgentState
  readonly row: ThreadRow
  readonly header: ReactNode
  /** What a receipt card or a takeover line says of a thread, and what a press on its name does. */
  readonly describe: WatcherConversation['describe']
  readonly press: WatcherConversation['press']
  /** What a watched thread's request card under a wake-up answers with (answering in Watcher's conversation). */
  readonly answering: WatcherAskAnswering | null
  /** The Watched view, when it stands in the conversation's place. */
  readonly watched: ReactNode
  readonly error: string | null
  readonly focused: boolean
  readonly now: number | undefined
}): ReactNode {
  const { t } = useLingui()
  const agents = useAgents()
  // Its reading position is kept for a trip to another room, as a beside thread's is for its next opening, and for a
  // look at Watched.
  useKeptReadingPosition(row.thread, WATCHER_PANE_ID, watched === null)
  // The first entry's composer had focus and is gone, the room opened before Watcher's thread arrived, or New Watcher
  // or a provider change took the last Watcher's composer away: focus left with nowhere to be goes to Watcher's own composer.
  const threadId = row.thread.id
  useLayoutEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById(WATCHER_PROMPT_ID)?.focus()
  }, [threadId])
  // Each reply in which Watcher changed files itself carries a line saying so (`WatcherOwnChangeFor`).
  const room = useWatcherRoom()
  const ownChanges = room?.state?.ownChanges
  const changes = useMemo(() => new Map((ownChanges ?? []).map(change => [change.replyMessageId, change] as const)), [ownChanges])
  // After a provider change, the handover of the last Watcher is offered over the composer until the first send or X
  // (ADR-0073), and while it stands a send carries it.
  const offer = room?.state?.handover ?? null
  const offered = offer !== null && room?.handover != null
  // A Watcher that replaced another says so while its conversation is empty: on which model, and what carried on.
  const note = newWatcherNoteFacts(state, row.thread, room?.state ?? null)
  const noteModel = note?.model, noteCarries = note?.carries
  const empty = useMemo(() => noteModel === undefined ? undefined : <NewWatcherNote model={noteModel} carries={noteCarries ?? null} />, [noteModel, noteCarries])
  const continueLabel = t`Continue with the handover`
  const gate = useMemo(() => watcherSendGate(room?.handover, room?.settle, offered, continueLabel), [room?.handover, room?.settle, offered, continueLabel])
  // Each action Watcher took is a receipt card under the reply of the turn that took it, where main's record places it,
  // and each thread the user took over is a quiet line in the conversation, after the turn it came in (ADR-0073).
  const receipts = room?.state?.receipts
  const replies = room?.state?.receiptReplies
  const byMessage = useMemo(() => {
    const placed = new Map<string, WatcherOperation[]>()
    if (receipts === undefined || replies === undefined || replies.length === 0) return placed
    const operations = new Map(receipts.map(operation => [operation.id, operation] as const))
    for (const { operationId, messageId } of replies) {
      const operation = operations.get(operationId)
      if (operation !== undefined) placed.set(messageId, [...placed.get(messageId) ?? [], operation])
    }
    for (const list of placed.values()) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    return placed
  }, [receipts, replies])
  const requests = room?.state?.requests
  const current = room?.state?.current ?? null
  const takeovers = useMemo(() => requests === undefined ? [] : watcherTakeovers({ current, requests }), [current, requests])
  const messages = row.thread.messages
  const lines = useMemo(() => placeTakeovers(messages, takeovers), [messages, takeovers])
  // Each request a wake-up said waited on the user has its thread's own card under the reply that told of it, where
  // main's record places it, and only under the newest wake-up that named it (Zach's pick on October 19, 2026).
  // The placements keep their identity until they change, so the conversation context does not change with every update;
  // the cards' answering, which does, goes in a context of its own that only the cards read.
  const placements = useStablePlacements(room?.state?.asks)
  const asks = useMemo(() => placeAsks(placements), [placements])
  // Where each start went (#1032), only while Work across machines is on, and kept in memory as main keeps it.
  const crossMachine = useOwlFeature('cross-machine-work')
  const receiptPlacements = room?.state?.receiptPlacements
  const placementsById = useMemo(() => !crossMachine || receiptPlacements === undefined ? undefined
    : new Map(receiptPlacements.map(item => [item.operationId, item.placement] as const)), [crossMachine, receiptPlacements])
  const conversation = useMemo<WatcherConversation>(() => ({ receipts: byMessage, takeovers: lines, describe, press, asks, placements: placementsById }),
    [byMessage, lines, describe, press, asks, placementsById])
  // Watcher is not on the Threads page, so a page in its own browser could never be seen: its links open in the
  // system browser.
  return <BrowserPageRouteContext.Provider value={null}><WatcherOwnChangesContext.Provider value={changes}><WatcherSendGateContext.Provider value={gate}>
    <WatcherConversationContext.Provider value={conversation}><WatcherAskAnsweringContext.Provider value={answering}>
      <ThreadPane row={row} state={state} command={agents.command} store={agents.threadDrafts} focused={focused} promptId={WATCHER_PROMPT_ID}
        error={error} now={now} watcherHeader={header} watcherBody={watched} watcherEmpty={empty}
        notice={offered && room !== null && offer !== null ? <WatcherHandoverOffer key={offer.source.threadId} room={room} offer={offer} composerId={WATCHER_PROMPT_ID} /> : undefined} />
    </WatcherAskAnsweringContext.Provider></WatcherConversationContext.Provider>
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
  // What it waits on: its request's card, or the strip of a prototype waiting for review (ADR-0108).
  const card = atRequest ? pane.querySelector<HTMLElement>('.agent-request[data-kind], .prototype-ready') : null
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
 * Brings a waiting request's card in Watcher's conversation into view and focuses it: the card for that request when
 * there is one, else the first live card for the thread. False when the conversation holds none, so the caller opens the
 * thread instead. The scroll is instant when motion is reduced.
 */
function focusInlineAsk(threadId: string, requestId: string | undefined): boolean {
  const pane = document.getElementById(WATCHER_PANE_ID)
  const cards = [...pane?.querySelectorAll<HTMLElement>('.watcher-ask[data-ask-thread]') ?? []].filter(card => card.dataset.askThread === threadId)
  const card = cards.find(item => item.dataset.askRequest === requestId) ?? cards[0]
  if (card === undefined) return false
  card.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  card.focus({ preventScroll: true })
  // The transcript learns at once whether its reader is still at the end.
  card.closest('.thread-workspace__transcript')?.dispatchEvent(new Event('scroll'))
  return true
}

/**
 * The threads Watcher watches, as the night scene's thread owls: one for each watched row, with its thread in this
 * window to open and how its owl looks. The same owls keep the same list, so the scene takes only the updates that
 * change one.
 */
function useWatchedOwls(room: WatcherRoomState | null, state: AgentState | null): readonly WatchedOwl[] {
  // One pass over the threads for the index, then a look-up a row, so the work grows with the threads and no faster.
  const idOf = useMemo(() => threadAddressIndex(state), [state])
  return useShared(useMemo<readonly WatchedOwl[]>(() => room === null ? [] : watchedRows(room).map(row => ({
    key: owlKey(row.target), title: row.title, threadId: idOf(row.target) ?? null, mood: moodOf(row),
  })), [room, idOf]))
}

/**
 * Watcher's room (ADR-0073), with no sidebar (Zach's picks on October 11, 2026): the Sotto tile and its night sky
 * in the corner, Watcher's conversation centred under its header and the needs-you line, a thread opened beside it in
 * its own real pane, the Overview over the room on All threads, and the room switch and a More menu at the header's end.
 * The room keeps its own view: it never selects a thread or a project on the Threads page, except through Open in
 * Threads or Shift with a press, which go there on purpose; Watcher itself is in neither the Overview nor Threads.
 * An ASCII night is drawn in its side margins, with Watcher's owl and a thread owl for each watched thread
 * (`WatcherNightScene`).
 */
export function WatcherView({ now: fixedNow, update = null }: {
  /** A fixed clock for captures; the rows' times then hold still, and so does the night scene, every owl sitting. */
  readonly now?: number | undefined
  /** The update control's status and press for the header's More menu; null on Linux, which has no in-app updater. */
  readonly update?: UpdateControlProps | null
}): ReactNode {
  const { t } = useLingui()
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
  const pictureTab = useId()
  const picturePanel = useId()
  const tabIds = useMemo(() => ({ watchedTab, watchedPanel, pictureTab, picturePanel }), [watchedTab, watchedPanel, pictureTab, picturePanel])
  const area = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  // The room reads Watcher's history and the thread beside it while they are on screen, as Threads does for its
  // panes, and lets them go after. An empty list goes too: closing the only pane before Watcher exists leaves the
  // room mounted, and main would otherwise go on counting the closed thread as seen.
  const observed = JSON.stringify([watcherId, besideRow?.thread.id ?? null].filter(Boolean))
  // What is on screen now, for a card's Check again to hand back once its one read is done.
  const onScreen = useRef<readonly string[]>([])
  onScreen.current = JSON.parse(observed) as string[]
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

  // A switch press hands focus to the header switch's lit owl. Arriving any other way, focus goes to Watcher's composer.
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

  // What a receipt card, a takeover line or Stop all says of a thread: the window's own facts for it, as All threads
  // shows them, or the room's last word on one this window does not list.
  const entries = useMemo(() => new Map(groups.flatMap(group => group.entries).map(entry => [entry.overview.thread.id, entry] as const)), [groups])
  const roomRows = room?.state?.watchedThreads
  const describe = useCallback((target: WatcherThreadTarget): ConversationThread => {
    const thread = threadForTarget(state, target)
    const facts = thread === undefined ? undefined : rowsById.get(thread.id)
    if (thread !== undefined && facts !== undefined) {
      const entry = entries.get(thread.id)
      const group = entry?.overview.group ?? 'Idle'
      const failed = thread.status === 'error' || thread.lastTurn?.status === 'failed'
      const remote = thread.remoteHost === true
      return { threadId: thread.id, title: thread.title, providerId: facts.providerId, provider: facts.provider,
        computer: remote ? thread.hostLabel ?? t`Paired computer` : t`This computer`, remote, project: facts.project?.title,
        status: entry === undefined ? rowStatus(facts).text : statusWord(entry), tone: TONES[group], ring: failed ? 'failed' : TONES[group] }
    }
    const known = roomRows?.find(row => row.target.hostId === target.hostId && row.target.threadId === target.threadId)
    return { threadId: null, title: known?.title ?? null, providerId: undefined, provider: undefined, computer: undefined, remote: false, project: undefined,
      status: known === undefined ? null : unlistedStatus(known), tone: 'idle', ring: 'idle' }
  }, [state, rowsById, entries, roomRows, t])
  const press = useCallback((threadId: string) => threadPress(openThread, threadId, false), [openThread])

  // Answering in Watcher's conversation (ADR-0073): the watched thread's own card, found by its owning host's address
  // and answered as its own pane answers it, with this window's command.
  const rowFor = useCallback((target: WatcherThreadTarget): ThreadRow | undefined => {
    const thread = threadForTarget(state, target)
    return thread === undefined ? undefined : rowsById.get(thread.id)
  }, [state, rowsById])
  const answering = useMemo<WatcherAskAnswering | null>(() => state === null ? null : {
    state, command, rowFor,
    openAtRequest: (threadId, from) => openThread(threadId, { atRequest: true, from }),
    // A card's Check again reads its thread once, alongside what is on screen, and then lets it go again: a thread kept
    // observed would count as seen, and its later finish or failure would leave Needs attention unopened (#1193).
    check: async threadId => {
      const result = await command({ type: 'observe-threads', threadIds: [...new Set([...onScreen.current, threadId])] })
      await command({ type: 'observe-threads', threadIds: [...onScreen.current] })
      return result !== null && result.error === null
    },
  }, [state, command, rowFor, openThread])
  // The threads whose waiting request has its card in the conversation now, which the needs-you line goes to instead.
  const placements = useStablePlacements(room?.state?.asks)
  const placed = useMemo(() => placeAsks(placements), [placements])
  const shownMessages = watcherRow?.thread.messages
  const shownIds = useMemo(() => new Set(shownMessages?.map(message => message.id) ?? []), [shownMessages])
  const inline = useMemo<ReadonlySet<string>>(() => {
    if (placed.size === 0 || view.tab !== 'conversation') return new Set()
    const ids = shownIds
    const found = new Set<string>()
    for (const list of placed.values()) for (const ask of list) {
      const row = ids.has(ask.messageId) ? rowFor(ask.target) : undefined
      if (row !== undefined && !isThreadClosed(row.thread) && row.thread.requests.some(request => request.id === ask.requestCardId)) found.add(row.thread.id)
    }
    return found
  }, [placed, shownIds, view.tab, rowFor])
  const jumpToAsk = useCallback((threadId: string, requestId: string | undefined): boolean => focusInlineAsk(threadId, requestId), [])

  // The machines line (#1032) is part of the Owl feature Work across machines: Stable shows none of it.
  const crossMachine = useOwlFeature('cross-machine-work')
  const error = state?.error ?? agents.error ?? null
  const tab = current === null ? 'conversation' : view.tab
  const stopAll = room === null ? null : <WatcherStopAll room={room} conversation={{ describe, press }}
    fallbackFocus={() => document.querySelector<HTMLElement>('.watcher-head .watcher-tabs__tab[aria-selected="true"]')?.focus()} />
  const header = <>
    <WatcherHeader room={room} count={overviewCount(groups)} tab={tab} tabIds={tabIds} listOpen={listOpen} listButton={listButton} onToggleList={() => toggleList(listButton.current)}
      stopAll={stopAll} update={update} />
    <WatcherGlance entries={needs} onOpen={openThread} onShowAll={from => toggleList(from, true)} inline={inline} onJump={jumpToAsk} />
    {crossMachine ? <WatcherMachines state={state} now={fixedNow} /> : null}
  </>
  let watcherContent: ReactNode
  const status = (text: string, alert = false): ReactNode => <>{header}<p className={alert ? 'agent-error watcher-room__status tt-paragraph' : 'watcher-room__status tt-paragraph'} role={alert ? 'alert' : 'status'}>{text}</p></>
  if (room === null || room.status === 'unavailable') watcherContent = status(t`This build cannot reach Watcher yet. Nothing was started. A later Sotto build adds it.`)
  else if (state === null || room.status === 'loading') watcherContent = status(agents.error ?? t`Opening Watcher…`)
  else if (room.error !== null && room.state === null) watcherContent = status(shownWords(room.error), true)
  else if (current === null) watcherContent = <>{header}<WatcherFirstEntry state={state} room={room} /></>
  // A creation that stopped part-way leaves Watcher with no thread; the room says so and offers to finish it.
  else if (watcherRow === undefined) watcherContent = room.state?.creationStopped === true ? <>{header}<WatcherStartStopped room={room} /></> : status(t`Opening Watcher…`)
  else watcherContent = <WatcherPane state={state} row={watcherRow} header={header} describe={describe} press={press} answering={answering} error={focusedPane === 'watcher' || besideRow === undefined ? error : null}
    watched={tab === 'watched' ? <WatcherWatchedView room={room} state={state} groups={groups} id={watchedPanel} labelledBy={watchedTab} onOpen={openThread}
      onShowAll={from => toggleList(from, true)} />
      : tab === 'visualize' ? <WatcherPicture room={room} state={state} entries={entries} id={picturePanel} labelledBy={pictureTab} onOpen={openThread} /> : null}
    focused={focusedPane === 'watcher' || besideRow === undefined} now={fixedNow} />

  // The night scene in the room's margins, with a thread owl for each watched thread. It steps away while Visualize
  // shows, whose picture takes the pane's whole width (Zach, October 22, 2026), and while the room or Watcher's
  // conversation cannot be read yet.
  const roomOpen = room !== null && room.status === 'ready' && state !== null && !(room.error !== null && room.state === null)
  const sceneShown = roomOpen && tab !== 'visualize' && (current === null || watcherRow !== undefined)
  const owls = useWatchedOwls(room?.state ?? null, state)
  const showWatched = useCallback((): void => roomView.set({ tab: 'watched' }), [])

  const beside = besideRow !== undefined && state !== null
  const share = shownShare(width, view.share)
  return <Marked>{marks => <div className={`management-view threads-view watcher-room${mac ? ' threads-view--mac' : ''}`} data-beside={beside || undefined} {...marks}>
    <section className="thread-workspace" aria-label={t`Watcher’s room`}>
      <div className="thread-workspace__body" data-panes>
        <div className="thread-panes">
          <div ref={area} className="thread-panes__area" style={{ '--watcher-share': share } as CSSProperties}>
            <Marked>{paneMarks => <section id={WATCHER_PANE_ID} className="thread-pane watcher-pane" {...paneMarks} data-thread-id={watcherId ?? undefined} data-view={tab} data-focused={focusedPane === 'watcher' || !beside || undefined}
              data-under-controls={!beside || undefined} role="region" aria-label="Watcher"
              onFocusCapture={() => setFocusedPane('watcher')} onPointerDownCapture={() => setFocusedPane('watcher')}>
              <WatcherNightScene shown={sceneShown} held={fixedNow !== undefined} owls={owls} onOpen={openThread} onShowWatched={showWatched} />
              <OwlRoomSky />
              {watcherContent}
            </section>}</Marked>
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
    <PageWindowControls />
    {listOpen ? <WatcherOverviewList groups={groups} watched={room?.watchedThreadIds ?? new Set()} besideId={besideRow?.thread.id ?? null}      liveClock={fixedNow === undefined} anchor={listButton} opener={listOpener} onOpen={openThread} onClose={closeList} /> : null}
  </div>}</Marked>
}

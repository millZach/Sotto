import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Marked } from '../components/marks'
import { ArrowUp, ChevronDown, List } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownWords } from '../features/settings/laterWords'
import { PROVIDER_LABELS, type AgentSpeed, type AgentState } from '../../../shared/agents'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { resolveModel } from '../../../shared/modelCatalog'
import { fitSpeed } from '../../../shared/workerRoles'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { PageWindowControls } from '../components/WindowControls'
import { claimRoomFocus } from '../components/AppShell'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import { useAgents } from '../agents/AgentContext'
import { KeyedGlyph } from '../agents/composerPlate'
import { threadChordCap } from '../agents/threadShortcuts'
import { WayOffThePage } from '../agents/SidebarFrame'
import { UpdateControl, type UpdateControlProps } from '../features/updates/UpdateControl'
import { EffortPicker } from '../agents/EffortPicker'
import { EffortDots } from '../agents/EffortDots'
import { draftEffortScore, suggestedEffortIndex } from '../agents/effortSuggestion'
import { EffortTrace } from '../agents/EffortTrace'
import { ModelPicker } from '../agents/ModelPicker'
import { OwlRoomSky } from '../agents/OwlSky'
import { useClock } from '../agents/paneGrid'
import { PromptEditor, type PromptEditorElement } from '../agents/PromptEditor'
import { useShared } from '../agents/stateSharing'
import { threadDescriber, useWordsRevision, type ThreadRow } from '../agents/threadFacts'
import { useContinueEnabled } from '../agents/continuations'
import { effortChoices, nextSpeed, offeredSpeeds, speedName, speedTitle, SpeedToggle } from '../agents/ThreadOptions'
import { SPEED_STANDARD } from '../agents/pendingSettings'
import { ThreadPane } from '../agents/ThreadPane'
import { isThreadClosed } from '../../../shared/threadActivity'
import { BrowserPageRouteContext } from '../tools/webLinks'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { watcherTakeovers, type WatcherRoomState } from '../../../shared/watcherRoom'
import { joinedPlacements, joinedReceipts, joinedTakeovers, liveReceipts, recalledConversation } from './watcherConversationWork'
import { rowStatus } from '../agents/threadFacts'
import { threadAddressIndex, threadForTarget, useWatcherRoom, watchedRows, type WatcherRoom } from './watcherRoom'
import { placeAfterTurns, placeTakeovers, WatcherConversationContext, type ConversationThread, type WatcherConversation } from './WatcherReceipts'
import { WatcherStopAll } from './WatcherStopAll'
import { useMoveCards, useMoveProposals, WatcherMoveThreads } from './MoveThreads'
import { BESIDE_PANE_ID, BesideDivider, BesidePane, historyDrawn, roomView, shownShare, useKeptReadingPosition, useRoomView } from './WatcherBeside'
import { firstMessage, useFirstMessage } from './watcherFirstMessage'
import { WatcherGlance } from './WatcherGlance'
import { WatcherMachines } from './WatcherMachines'
import { watcherProviderOf } from './watcherProviders'
import { WatcherHandoverOffer, WatcherSendGateContext, watcherSendGate } from './WatcherHandover'
import { NewWatcherNote, newWatcherNoteFacts, WatcherStartStopped } from './WatcherNew'
import { overviewCount, statusWord, threadPress, TONES, unlistedStatus, useOverview, WatcherOverviewList, type OpenThread, type OverviewEntry } from './WatcherOverview'
import { WatcherContextTile } from './WatcherContextTile'
import { WatcherOwl } from './WatcherOwl'
import { WatcherNightScene } from './WatcherNightScene'
import { moodOf, owlKey, type WatchedOwl } from './owlFamily'
import { WatcherOwnChangesContext } from './WatcherOwnChange'
import { placeAsks, useStablePlacements, WatcherAskAnsweringContext, type WatcherAskAnswering } from './WatcherAsks'
import { prefersReducedMotion } from '../state/reducedMotion'
import { WatcherPermissionChip } from './WatcherPermissionChip'
import { useOrchestratingSpeed, useOrchestratingStart, useSaveOrchestrating } from './orchestratingRole'

const WATCHER_PROMPT_ID = 'watcher-prompt'
const WATCHER_PANE_ID = 'watcher-pane'

/** What Watcher's header holds besides its name: All threads and its count, and, once Watcher runs, Stop all. */
interface HeaderParts {
  readonly room: WatcherRoom | null
  readonly count: number
  readonly listOpen: boolean
  readonly listButton: React.RefObject<HTMLButtonElement | null>
  readonly onToggleList: () => void
  /** Stop all, at the header's end, while threads Watcher started are running. */
  readonly stopAll: ReactNode
  /** The update control's status and press, for the way off the page; none where the app does not update itself. */
  readonly update: UpdateControlProps | null
}

/**
 * Watcher's way off the page, right after All threads where its tabs were (Zach's pick on October 27, 2026, drawn by
 * him): the row the sidebar's foot draws. The room switch, a hairline, the other pages as icon links (Usage behind its
 * Owl feature, Memory while memory is on, Settings and Help) and the update control, each a press of its own with its
 * name on hover and to assistive technology. It replaced the More menu that held the pages and the update.
 */
function WatcherWayOut({ update }: { readonly update: UpdateControlProps | null }): ReactNode {
  return <WayOffThePage className="watcher-head__way" roomsClassName="thread-nav__seg watcher-head__rooms" pagesClassName="thread-nav__pages watcher-head__pages"
    updateControl={update === null ? null : <UpdateControl status={update.status} busy={update.busy} onActivate={update.onActivate} />} />
}

/**
 * Watcher's header: the Sotto tile in the window's corner, named for the running build, then Watcher's name and
 * All threads, which opens the Overview over the room, then the way off the page; once Watcher runs, Stop all at its
 * end. Watcher's room is its conversation alone (Zach, October 27, 2026), so the header holds no tabs. Once Watcher runs the tile is also a button for Watcher's context and state (#1189). On macOS no
 * app mark sits beside the traffic lights: before Watcher starts there is no tile, and the button, once it runs,
 * wears Watcher's owl. The night sky spreads behind the corner. The row is the window's drag strip.
 */
function WatcherHeader({ room, count, listOpen, listButton, onToggleList, stopAll, update }: HeaderParts): ReactNode {
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
      <WatcherWayOut update={update} />
    </div>
    <div className="thread-workspace__actions">{started && room !== null ? stopAll : null}</div>
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
  const quiet = useOwlFeature('quiet-composer')
  // Muse is named only where its own gate shows it (ADR-0072); its models are listed only then too.
  const providers = useOwlFeature('muse') ? t`Codex, Claude Code, Grok Build or Muse` : t`Codex, Claude Code or Grok Build`
  const models = useMemo(() => state.host.models.filter(model => model.ready !== false && watcherProviderOf(model) !== null), [state.host.models])
  const { text, modelId, effort, phase, error } = useFirstMessage()
  // Unchosen here, Watcher starts on the Orchestrating role's model and effort where worker roles are on (#1041). A pick
  // here saves the role too, and a change to the role in Settings clears the pick, so the two never disagree.
  const roleStart = useOrchestratingStart(models)
  const savedRoleSpeed = useOrchestratingSpeed()
  const saveOrchestrating = useSaveOrchestrating()
  const roleModel = roleStart === null ? undefined : resolveModel(models, roleStart.modelId)
  const model = models.find(item => item.id === modelId) ?? roleModel ?? models[0]
  const roleEffort = roleStart !== null && model !== undefined && model.id === roleStart.modelId ? roleStart.reasoningEffort ?? undefined : undefined
  const roleSpeed = roleStart !== null && model !== undefined && model.id === roleStart.modelId
    ? savedRoleSpeed !== undefined ? savedRoleSpeed : roleStart.speed : null
  const [pickedSpeed, setPickedSpeed] = useState<AgentSpeed | null | undefined>(undefined)
  const [speedSourceModelId, setSpeedSourceModelId] = useState<string | undefined>(undefined)
  const selectedSpeed = pickedSpeed === undefined ? roleSpeed : pickedSpeed
  const speed = fitSpeed(selectedSpeed, model)
  const reasoning = effort ?? roleEffort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, reasoning)
  const levels = efforts.filter(option => !option.disabled).map(option => option.id)
  const starting = phase !== 'writing'
  const field = useRef<PromptEditorElement | null>(null)
  const [notices, setNotices] = useState<HTMLElement | null>(null)
  const provider = model === undefined ? null : watcherProviderOf(model)
  const speeds = offeredSpeeds(model, provider ?? undefined)
  const speedValue = speed ?? SPEED_STANDARD
  const ready = model !== undefined && provider !== null && room.open !== null && !starting
  const canSend = ready && text.trim() !== ''
  const changeEffort = (value: string): void => {
    firstMessage.update({ effort: value })
    if (model !== undefined) saveOrchestrating?.(model.id, value, models, pickedSpeed)
  }
  const changeSpeed = (value: string): void => {
    const chosen = value === SPEED_STANDARD ? null : value as AgentSpeed
    setPickedSpeed(chosen)
    setSpeedSourceModelId(chosen ? model?.id : undefined)
    if (model !== undefined) saveOrchestrating?.(model.id, reasoning || null, models, chosen)
  }
  const start = async (): Promise<void> => {
    if (!canSend || model === undefined || provider === null || room.open === null) return
    firstMessage.update({ phase: 'starting', error: null })
    // Main's answer is kept by the window, not here: the room may be gone by the time it comes.
    try {
      const keptSpeed = selectedSpeed && selectedSpeed !== speed && speedSourceModelId !== undefined
      const refusal = room.settle(await room.open({ provider, modelId: model.id, ...(reasoning ? { reasoningEffort: reasoning } : {}),
        ...(speed || pickedSpeed !== undefined ? { speed: keptSpeed ? selectedSpeed : speed } : {}), ...(keptSpeed ? { speedSourceModelId } : {}) }))
      firstMessage.update(refusal === null ? { phase: 'started' } : { phase: 'writing', error: refusal })
    } catch {
      firstMessage.update({ phase: 'writing', error: t`Sotto could not start Watcher. Nothing was started, and your message is still here. Try again.` })
    }
  }
  const providerName = provider === null ? null : PROVIDER_LABELS[provider]
  const modelName = model?.name
  const accountProvider = providerName ?? model?.provider
  return <>
    <div className="thread-transcript" data-room-backdrop="">
      <div className="thread-workspace__transcript watcher-first" data-room-backdrop="">
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
    {model !== undefined ? <div className="thread-workspace__compose" data-room-backdrop="">
      {error ? <p className="agent-error watcher-first__error tt-paragraph" role="alert">{error}</p> : null}
      <form className="thread-prompt" data-quiet={quiet || undefined} onSubmit={event => { event.preventDefault(); void start() }}>
        <EffortTrace />
        <div className="screenshot-input"><div>
        <PromptEditor fieldRef={field} id={WATCHER_PROMPT_ID} text={text} skills={[]} sigils={[]} label={t`Watcher message`} editable={!starting}
          placeholder={t`Say what to start or check. Sending starts Watcher.`}
          onChange={next => firstMessage.update({ text: next })}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void start()
          }} />
        </div></div>
        <label className="tt-visually-hidden" htmlFor={WATCHER_PROMPT_ID} onClick={() => field.current?.focus()}>{t`Watcher message`}</label>
        <div className="thread-prompt__footer">
          <div className="thread-prompt__meta">
            <div className="thread-options-bar" data-permission={quiet ? room.state?.runtimeMode ?? 'approval-required' : undefined}>
              <div className="thread-options thread-options--chips" role="group" aria-label={t`Watcher’s model`}>
                <ModelPicker models={models} modelId={model.id} disabled={starting} onChange={id => {
                  firstMessage.update({ modelId: id, effort: null })
                  setPickedSpeed(selectedSpeed)
                  setSpeedSourceModelId(source => source ?? (speed ? model.id : undefined))
                  saveOrchestrating?.(id, resolveModel(models, id)?.defaultReasoningEffort ?? null, models, selectedSpeed)
                }} />
                {!quiet && speeds.length > 0 && <SpeedToggle offered={speeds} provider={provider ?? undefined} value={speedValue} disabled={starting} pending={false} onChange={changeSpeed} />}
                {quiet ? levels.length > 0 && <EffortDots levels={levels} value={reasoning} provider={provider ?? undefined} disabled={starting}
                  suggestion={starting ? null : suggestedEffortIndex(draftEffortScore(text), levels.length, levels.indexOf(reasoning))}
                  speed={speeds.length === 0 ? undefined : { value: speedValue, name: speedName(speedValue, speeds),
                    description: speedTitle(speeds, speedValue, provider ?? undefined, starting),
                    onStep: direction => changeSpeed(nextSpeed(speeds, speedValue, direction)) }}
                  onChange={changeEffort} />
                  : efforts.length > 0 ? <EffortPicker key={model.id} value={reasoning} options={efforts} disabled={starting} onChange={changeEffort}
                  defaultValue={model.defaultReasoningEffort} modelName={model.name} /> : null}
                <WatcherPermissionChip model={model} provider={providerName ?? model.provider} disabled={starting} noticeSlot={notices} />
              </div>
            </div>
            {starting ? <span className="thread-prompt__status" role="status"><Trans>Starting Watcher…</Trans></span> : null}
          </div>
          <div className="thread-prompt__actions">
            <Button className={quiet ? 'thread-prompt__send thread-prompt__disc' : 'thread-prompt__send'} data-face={quiet ? 'send' : undefined} type="submit" aria-label={t`Start Watcher and send`} aria-keyshortcuts="Enter" title={canSend ? t`Start Watcher and send` : t`Write what Watcher should do first`} disabled={!canSend}>
              {quiet ? <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" /> : <KeyedGlyph role="send" keyCap={threadChordCap('enter', app?.platform ?? 'win32')} />}
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
function WatcherPane({ state, row, header, error, focused, now, describe, press, answering }: {
  readonly state: AgentState
  readonly row: ThreadRow
  readonly header: ReactNode
  /** What a receipt card or a takeover line says of a thread, and what a press on its name does. */
  readonly describe: WatcherConversation['describe']
  readonly press: WatcherConversation['press']
  /** What a watched thread's request card under a wake-up answers with (answering in Watcher's conversation). */
  readonly answering: WatcherAskAnswering | null
  readonly error: string | null
  readonly focused: boolean
  readonly now: number | undefined
}): ReactNode {
  const { t } = useLingui()
  const agents = useAgents()
  // Its reading position is kept for a trip to another room, as a beside thread's is for its next opening.
  useKeptReadingPosition(row.thread, WATCHER_PANE_ID)
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
  // Each room update brings a new copy of what carried over, so the note is made again only when its words would change.
  const carriedKey = note?.carried ? JSON.stringify(note.carried) : ''
  const noteCarried = useMemo(() => carriedKey === '' ? null : JSON.parse(carriedKey) as NonNullable<WatcherRoomState['carried']>, [carriedKey])
  const empty = useMemo(() => noteModel === undefined ? undefined : <NewWatcherNote model={noteModel} carries={noteCarries ?? null} carried={noteCarried} />, [noteModel, noteCarries, noteCarried])
  const continueLabel = t`Continue with the handover`
  const gate = useMemo(() => watcherSendGate(room?.handover, room?.settle, offered, continueLabel), [room?.handover, room?.settle, offered, continueLabel])
  // Each action Watcher took is a receipt card under the reply of the turn that took it, where main's record places it,
  // and each thread the user took over is a quiet line in the conversation, after the turn it came in (ADR-0073).
  // With what the conversation shown back recalled from Watcher's archive ahead of the record's own (#1759): the read
  // back is indexed once for its own object, and a change of the record's lists works over those lists alone.
  const receipts = room?.state?.receipts, replies = room?.state?.receiptReplies, requests = room?.state?.requests
  const current = room?.state?.current ?? null, recalledWork = room?.state?.recalled
  const recalled = useMemo(() => recalledConversation(recalledWork, current?.target), [recalledWork, current?.target])
  const own = useMemo(() => liveReceipts(receipts, replies), [receipts, replies])
  const byMessage = useMemo(() => joinedReceipts(own.byMessage, own.operations, recalled), [own, recalled])
  const takeovers = useMemo(() => requests === undefined ? [] : watcherTakeovers({ current, requests }), [current, requests])
  const messages = row.thread.messages
  const ownLines = useMemo(() => placeTakeovers(messages, takeovers), [messages, takeovers])
  const recalledLines = useMemo(() => recalled === undefined ? undefined : placeTakeovers(messages, recalled.takeovers), [messages, recalled])
  const lines = useMemo(() => joinedTakeovers(ownLines, recalledLines), [ownLines, recalledLines])
  // Each request a wake-up said waited on the user has its thread's own card under the reply that told of it, where
  // main's record places it, and only under the newest wake-up that named it (Zach's pick on October 19, 2026).
  // The placements keep their identity until they change, so the conversation context does not change with every update;
  // the cards' answering, which does, goes in a context of its own that only the cards read.
  const placements = useStablePlacements(room?.state?.asks)
  const asks = useMemo(() => placeAsks(placements), [placements])
  // Where each start went (#1032), only while Work across machines is on, and kept in memory as main keeps it.
  const crossMachine = useOwlFeature('cross-machine-work')
  const receiptPlacements = room?.state?.receiptPlacements
  const placementsById = useMemo(() => !crossMachine ? undefined
    : joinedPlacements(new Map((receiptPlacements ?? []).map(item => [item.operationId, item.placement] as const)), recalled), [crossMachine, receiptPlacements, recalled])
  // The moves Sotto ran (#1178), each after the turn it was confirmed in; a move from before this Watcher started is the
  // last Watcher's, and is not shown here.
  const moveCards = useMoveCards()
  const since = current?.createdAt
  const movesPlaced = useMemo(() => !crossMachine || moveCards.length === 0 || since === undefined ? undefined
    : placeAfterTurns(messages, moveCards.filter(card => Date.parse(card.at) >= Date.parse(since))), [crossMachine, moveCards, messages, since])
  // Watcher's proposals from the user's words (#1178 part 3), after the turn that made each, the same way.
  const proposals = useMoveProposals()
  const proposalsPlaced = useMemo(() => !crossMachine || proposals.length === 0 || since === undefined ? undefined
    : placeAfterTurns(messages, proposals.filter(proposal => Date.parse(proposal.at) >= Date.parse(since))), [crossMachine, proposals, messages, since])
  const conversation = useMemo<WatcherConversation>(() => ({ receipts: byMessage, takeovers: lines, describe, press, asks, placements: placementsById, moves: movesPlaced, proposals: proposalsPlaced }),
    [byMessage, lines, describe, press, asks, placementsById, movesPlaced, proposalsPlaced])
  // Watcher is not on the Threads page, so a page in its own browser could never be seen: its links open in the
  // system browser.
  return <BrowserPageRouteContext.Provider value={null}><WatcherOwnChangesContext.Provider value={changes}><WatcherSendGateContext.Provider value={gate}>
    <WatcherConversationContext.Provider value={conversation}><WatcherAskAnsweringContext.Provider value={answering}>
      <ThreadPane row={row} state={state} command={agents.command} store={agents.threadDrafts} focused={focused} promptId={WATCHER_PROMPT_ID}
        error={error} now={now} watcherHeader={header} watcherEmpty={empty}
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
  // Describes only the threads an update changed and hands back the rest as they were, and every thread again when the
  // interface language or its messages change.
  const [describeRows] = useState(threadDescriber)
  const words = useWordsRevision()
  const rows = useShared(useMemo(() => state === null ? [] : describeRows(state, now, { continued }), [state, now, continued, words]))
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
    if (placed.size === 0) return new Set()
    const ids = shownIds
    const found = new Set<string>()
    for (const list of placed.values()) for (const ask of list) {
      const row = ids.has(ask.messageId) ? rowFor(ask.target) : undefined
      if (row !== undefined && !isThreadClosed(row.thread) && row.thread.requests.some(request => request.id === ask.requestCardId)) found.add(row.thread.id)
    }
    return found
  }, [placed, shownIds, rowFor])
  const jumpToAsk = useCallback((threadId: string, requestId: string | undefined): boolean => focusInlineAsk(threadId, requestId), [])

  // The machines line (#1032) is part of the Owl feature Work across machines: Stable shows none of it.
  const crossMachine = useOwlFeature('cross-machine-work')
  const error = state?.error ?? agents.error ?? null
  const stopAll = room === null ? null : <>
    {crossMachine ? <WatcherMoveThreads /> : null}
    <WatcherStopAll room={room} conversation={{ describe, press }} fallbackFocus={() => listButton.current?.focus()} />
  </>
  const header = <>
    <WatcherHeader room={room} count={overviewCount(groups)} listOpen={listOpen} listButton={listButton} onToggleList={() => toggleList(listButton.current)}
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
    focused={focusedPane === 'watcher' || besideRow === undefined} now={fixedNow} />

  // The night scene in the room's margins, with a thread owl for each watched thread. It steps away while the room or
  // Watcher's conversation cannot be read yet.
  const roomOpen = room !== null && room.status === 'ready' && state !== null && !(room.error !== null && room.state === null)
  const sceneShown = roomOpen && (current === null || watcherRow !== undefined)
  const owls = useWatchedOwls(room?.state ?? null, state)
  // Watcher's own owl glows while something waits on the user (Zach, October 27, 2026): a question or permission of
  // Watcher's own, or a thread in Needs you for a question, a permission or a prototype to review. A failed turn alone
  // lights it no more than it lights a thread owl.
  // A thread's request or prototype is read on its own, since the needs-you line's word for a thread puts a failed turn
  // before a prototype that also waits.
  const glowing = (watcherRow?.thread.requests.length ?? 0) > 0 || needs.some(({ facts }) =>
    facts.request !== undefined || facts.thread.requests.length > 0 || facts.thread.prototypeReady !== undefined)
  const showAll = useCallback((): void => { listOpener.current = null; setListOpen(true) }, [])

  const beside = besideRow !== undefined && state !== null
  const share = shownShare(width, view.share)
  return <Marked>{marks => <div className={`management-view threads-view watcher-room${mac ? ' threads-view--mac' : ''}`} data-beside={beside || undefined} data-room-backdrop="" {...marks}>
    <section className="thread-workspace" data-room-backdrop="" aria-label={t`Watcher’s room`}>
      <div className="thread-workspace__body" data-room-backdrop="" data-panes>
        <div className="thread-panes" data-room-backdrop="">
          <div ref={area} className="thread-panes__area" data-room-backdrop="" style={{ '--watcher-share': share } as CSSProperties}>
            <Marked>{paneMarks => <section id={WATCHER_PANE_ID} className="thread-pane watcher-pane" data-room-backdrop="" {...paneMarks} data-thread-id={watcherId ?? undefined} data-focused={focusedPane === 'watcher' || !beside || undefined}
              data-under-controls={!beside || undefined} role="region" aria-label="Watcher"
              onFocusCapture={() => setFocusedPane('watcher')} onPointerDownCapture={() => setFocusedPane('watcher')}>
              <WatcherNightScene shown={sceneShown} held={fixedNow !== undefined} place={app?.settings?.watcherScene} owls={owls} glowing={glowing} onOpen={openThread} onShowAll={showAll} />
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

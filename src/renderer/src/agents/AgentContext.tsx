import React, { createContext, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentBridge, AgentCommand, AgentState, AgentThread, AgentThreadDetail, AgentThreadDetailUpdate } from '../../../shared/agents'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../shared/agentThreadDetail'
import { wrapAgentBridge } from './agentStateCatalogs'
import { clearShellCache, readShellCache, writeShellCache } from './shellCache'
import type { AppSettings } from '../../../shared/settings'
import type { DictationState } from '../../../shared/dictation'
import { AgentVoiceSession, type AgentVoiceState } from './voiceSession'
import { createE2EAgentVoiceEffects } from '../e2e/agentVoiceEffects'
import { createConfiguredSpeech } from './naturalSpeech'
import { playWakeCue } from './voiceCue'
import { useAttentionReview, type AttentionReview } from './attentionReview'
import { share } from './stateSharing'
import { ThreadDraftStore } from './threadDraftStore'

export interface AgentConnection {
  readonly state: AgentState | null
  readonly error: string | null
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  readonly threadDrafts: ThreadDraftStore
}

/** How many threads' histories the window keeps once it stops looking at them. */
const DETAIL_CACHE_LIMIT = 16
/** At most one cache write per this long; the shell arrives as often as a provider streams. */
const SHELL_CACHE_INTERVAL_MS = 2_000

export function useAgentConnection(bridge: AgentBridge | undefined): AgentConnection {
  // A connection owns its command lane and draft durability knowledge. Neither page
  // navigation nor outstanding writes create a new store; a different bridge does.
  const session = useMemo(() => ({ current: false, observed: 0, tail: Promise.resolve() as Promise<unknown> }), [bridge])
  /**
   * Main publishes every thread's state but only the history of the threads this window says it is
   * looking at, so the window holds those histories and splices them back into each arriving shell.
   * Consumers still read one whole `AgentState`; what changed is what crosses the bridge.
   */
  const detail = useMemo(() => ({
    held: new Map<string, AgentThreadDetail>(), used: new Map<string, number>(), asked: new Set<string>(),
    viewed: new Set<string>(), shell: null as AgentState | null, clock: 0,
    pendingShell: null as AgentState | null, frame: 0,
    channel: bridge?.threadDetail !== undefined || bridge?.onThreadDetail !== undefined,
  }), [bridge])
  const [snapshot, setSnapshot] = useState<{ session: typeof session; state: AgentState } | null>(null)
  const [failure, setFailure] = useState<{ session: typeof session; error: string } | null>(null)
  /** When the newest state arrived, and when the dev console was last told what one cost. */
  const arrived = useRef<number | null>(null)
  const reported = useRef(0)
  /** One shell plus the histories this window holds: the whole state every consumer already reads. */
  const assemble = useCallback((shell: AgentState): AgentState => {
    const wanted = (thread: AgentThread): boolean => detail.viewed.has(thread.id) || shell.activeThreadId === thread.id
    let changed = false
    const threads = shell.host.threads.map(original => {
      const thread = splice(original)
      if (thread !== original) changed = true
      return thread
    })
    // A state that already carries its own history — a fixture, a test bridge — is passed through as it is.
    return changed ? { ...shell, host: { ...shell.host, threads } } : shell

    function splice(thread: AgentThread): AgentThread {
      const held = detail.held.get(thread.id)
      if (held !== undefined) {
        detail.used.set(thread.id, ++detail.clock)
        return { ...thread, messages: held.messages, ...(held.activities === undefined ? {} : { activities: held.activities }) }
      }
      // A thread whose history has not arrived is exactly what `historyStatus: 'loading'` already says;
      // a thread the provider itself could not load keeps its own error. A window with no detail channel
      // — the widget, which draws a thread from its summary alone — is never told to wait for one.
      return detail.channel && thread.summary !== undefined && (thread.summary.messageCount > 0 || thread.summary.activityCount > 0) && wanted(thread) && thread.historyStatus !== 'error'
        ? { ...thread, historyStatus: 'loading' as const } : thread
    }
  }, [detail])
  /**
   * Every published state is a whole new object, so the window would repaint all of it for one streaming
   * chunk. Reconciling the arrival against the state on screen keeps the reference of every part that did
   * not change, and a state that changed nothing at all stops here instead of becoming a render.
   */
  const ask = useRef<(threadId: string) => void>(() => undefined)
  const resync = useRef<(threadId: string) => void>(() => undefined)
  // Arriving agent state is background news, about 1.4 times a second while a thread works, and the
  // render it causes (host of 61 threads: ~11ms) must not sit in front of a keystroke. `startTransition`
  // gives the commit low priority so a sync update — the composer's draft store — interrupts it, while
  // React still guarantees the transition itself lands, just later. `urgent` opts a caller out of that:
  // the initial connect (nothing is on screen yet to stay interruptible for) and a command's own reply
  // (the user is watching that one land) both ask for it.
  const receiveState = useCallback((next: AgentState, options: { urgent?: boolean } = {}): void => {
    arrived.current = performance.now()
    detail.shell = next
    // The thread on screen needs its history whether or not this window asked for it: a restart opens
    // straight onto the selected thread, with no pane change to declare it viewed.
    if (next.stale !== true && next.activeThreadId !== null) ask.current(next.activeThreadId)
    const assembled = assemble(next)
    // React's own update queue, not extra bookkeeping here, keeps this in order: a `useState` setter
    // called from a transition and one called urgently both enqueue on the same fiber, and whichever
    // priority renders first, React replays the *whole* queue in the order the setters were called
    // once every lane has rendered — so a call made after another's can never be overwritten by it.
    const commit = (): void => setSnapshot(current => {
      // The cached shell is replaced outright, never reconciled: its identities belong to the last run.
      if (current?.session !== session || current.state.stale === true) return { session, state: assembled }
      const state = share(current.state, assembled)
      return state === current.state ? current : { session, state }
    })
    if (options.urgent === true) commit(); else startTransition(commit)
  }, [session, assemble, detail])
  /** A shell held for its frame commits now: the detail that follows it lands in the same commit. */
  const commitPendingShell = useCallback((options: { urgent?: boolean } = {}): void => {
    if (detail.frame !== 0) { cancelAnimationFrame(detail.frame); detail.frame = 0 }
    const pending = detail.pendingShell
    detail.pendingShell = null
    if (pending !== null) receiveState(pending, options)
  }, [detail, receiveState])
  const receiveDetail = useRef<(update: AgentThreadDetailUpdate) => void>(() => undefined)
  receiveDetail.current = (update: AgentThreadDetailUpdate): void => {
    const held = detail.held.get(update.threadId)
    // While a thread streams, main sends what changed rather than the thread. A delta applies only to the
    // revision it was measured from; anything else — a dropped update, a window that has just opened —
    // sends this thread back to the whole detail, which is also what resets main's own base.
    let next: AgentThreadDetail
    if (isAgentThreadDetailDelta(update)) {
      const applied = held === undefined ? null : applyAgentThreadDetailDelta(held, update)
      if (applied === null) { resync.current(update.threadId); return }
      next = applied
    } else {
      // Detail coalesces per thread and a request can answer out of order; only newer history replaces held history.
      if (held !== undefined && held.revision > update.revision) return
      next = update
    }
    detail.held.set(next.threadId, next)
    detail.used.set(next.threadId, ++detail.clock)
    if (detail.held.size > DETAIL_CACHE_LIMIT) {
      const evictable = [...detail.held.keys()].filter(id => !detail.viewed.has(id) && id !== detail.shell?.activeThreadId)
        .sort((first, second) => (detail.used.get(first) ?? 0) - (detail.used.get(second) ?? 0))
      for (const id of evictable.slice(0, detail.held.size - DETAIL_CACHE_LIMIT)) { detail.held.delete(id); detail.used.delete(id) }
    }
    // A shell being held for its frame commits now, inside the detail's own task: one chunk, one commit.
    if (detail.pendingShell !== null) commitPendingShell()
    else if (detail.shell !== null) receiveState(detail.shell)
  }
  /**
   * A thread's history the window does not hold, asked for once until it arrives. A resync asks for a
   * history the window does hold but can no longer follow, and is deduplicated the same way, so a run of
   * deltas the window cannot apply costs one request rather than one per delta.
   */
  const requestDetail = useCallback((threadId: string, options: { stale?: boolean } = {}): void => {
    if (bridge?.threadDetail === undefined || detail.asked.has(threadId)) return
    if (detail.held.has(threadId) && options.stale !== true) return
    detail.asked.add(threadId)
    void bridge.threadDetail(threadId).then(result => {
      detail.asked.delete(threadId)
      if (result !== null && session.current) receiveDetail.current(result)
    }).catch(() => { detail.asked.delete(threadId) })
  }, [bridge, detail, session])
  ask.current = requestDetail
  resync.current = threadId => requestDetail(threadId, { stale: true })
  const command = useCallback((request: AgentCommand): Promise<AgentState | null> => {
    // Telling main which panes are open is also this window's own record of whose history it needs.
    if (request.type === 'observe-threads') {
      detail.viewed = new Set(request.threadIds)
      for (const threadId of request.threadIds) requestDetail(threadId)
    }
    if (request.type === 'select-thread') requestDetail(request.threadId)
    const run = async (): Promise<AgentState | null> => {
      if (bridge === undefined || !session.current) return null
      const version = session.observed
      try {
        const next = await bridge.command(request)
        if (session.current) {
          setFailure(null)
          // A shell held for its frame is older than this response; it commits first so it can never land after.
          // Both commit urgently: the user is watching their own action land, and a transition here could let
          // the sync command reply paint before the older pending shell it must follow.
          if (version === session.observed) { commitPendingShell({ urgent: true }); receiveState(next, { urgent: true }) }
        }
        return next
      } catch {
        if (session.current) setFailure({ session, error: 'The action could not be confirmed. Your draft is retained; check the connection before retrying.' })
        return null
      }
    }
    // Send admission and draft saves must reach main in user order, without
    // waiting for an earlier IPC reply. Main still serializes execution and
    // checks busy state, provider locks and authority before dispatch.
    const speechPreference = request.type === 'configure' && typeof request.patch.speak === 'boolean' && Object.keys(request.patch).length === 1
    const providerOperation = request.type === 'connect' || request.type === 'disconnect' || request.type === 'refresh'
    // A thread's own follow-up queue, steering and skills catalog never wait behind another thread's work;
    // telling main which panes are open grants nothing and must not wait either.
    const threadLane = request.type === 'queue-followup' || request.type === 'edit-followup' || request.type === 'remove-followup'
      || request.type === 'reorder-followups' || request.type === 'resume-followups' || request.type === 'steer-followup' || request.type === 'steer' || request.type === 'refresh-thread-skills'
      || request.type === 'observe-threads'
    if (request.type === 'manual-send' || request.type === 'select-thread' || request.type === 'save-thread-draft' || request.type === 'voice' || request.type === 'voice-state' || speechPreference || providerOperation || threadLane) return run()
    const operation = session.tail.then(run)
    session.tail = operation
    return operation
  }, [bridge, session, receiveState, commitPendingShell, detail, requestDetail])
  const threadDrafts = useMemo(() => new ThreadDraftStore(command), [command])
  const state = snapshot?.session === session ? snapshot.state : null
  const error = failure?.session === session ? failure.error : null
  useEffect(() => {
    session.current = true
    let active = true
    const receive = receiveState
    const version = session.observed
    // A streamed chunk arrives as two messages: the shell, then the open thread's detail delta. The shell
    // waits out the frame so the detail that follows commits with it; a shell nothing follows commits in
    // the frame it would have painted in anyway, and a second shell inside the frame commits the first —
    // nothing published is skipped. Hidden windows cannot wait for animation frames: voice controls must
    // still reach their effects. They and windows without a detail channel commit at once — still as a
    // transition, which is fine: React's scheduler runs on its own timer, not a rAF, so it keeps
    // committing while the window is hidden.
    const flushPendingShell = (): void => { if (active) commitPendingShell() }
    const unsubscribe = bridge?.onState(next => {
      ++session.observed
      if (!active) return
      if (detail.pendingShell !== null) commitPendingShell()
      if (!detail.channel || document.hidden) { receive(next); return }
      detail.pendingShell = next
      detail.frame = requestAnimationFrame(flushPendingShell)
    })
    const visibilityChanged = (): void => { if (document.hidden) flushPendingShell() }
    document.addEventListener('visibilitychange', visibilityChanged)
    const unsubscribeDetail = bridge?.onThreadDetail?.(next => { if (active) receiveDetail.current(next) })
    // The shell this window saw last time paints the page on the first frame, marked stale and
    // disconnected, and the first live shell replaces it. Both are urgent: there is nothing on
    // screen yet for a transition to stay interruptible for, only a blank window to fill in.
    if (detail.shell === null) {
      const cached = readShellCache()
      if (cached !== null) receive(cached, { urgent: true })
    }
    void bridge?.get().then(next => {
      if (active && version === session.observed) receive(next, { urgent: true })
    }).catch(() => { if (active) setFailure({ session, error: 'Agent controls are unavailable. Reopen Sotto to reconnect.' }) })
    const flush = (): void => threadDrafts.flushAll()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      flush()
      if (detail.frame !== 0) { cancelAnimationFrame(detail.frame); detail.frame = 0 }
      detail.pendingShell = null
      active = false; session.current = false; unsubscribe?.(); unsubscribeDetail?.()
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [bridge, session, threadDrafts, receiveState, commitPendingShell, detail])
  // Keep the newest shell for the next start, at most once every couple of seconds. Nothing is kept
  // while Keep local history is off, and a stale shell is never written back over itself.
  const cached = useRef(0)
  useEffect(() => {
    if (state === null || state.stale === true) return
    if (state.historyEnabled === false) { clearShellCache(); return }
    const now = performance.now()
    if (cached.current !== 0 && now - cached.current < SHELL_CACHE_INTERVAL_MS) return
    cached.current = now
    writeShellCache(state)
  }, [state])
  // Both published and command-returned snapshots reach the store before paint,
  // including while the Threads page is absent.
  // The cached shell carries no draft evidence and must not be read as any: what a previous run saw
  // says nothing about what is on disk now.
  useLayoutEffect(() => { if (state !== null && state.stale !== true) threadDrafts.receive(state) }, [state, threadDrafts])
  // What one state update costs this window, from the moment it arrived to the commit that shows it, in the
  // dev console at most once a second. Development only: the production bundle drops the whole effect body.
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return
    const at = arrived.current
    arrived.current = null
    if (at === null) return
    const now = performance.now()
    if (now - reported.current < 1000) return
    reported.current = now
    console.info(`sotto: state update ${Math.round(now - at)} ms`)
  }, [state])
  return { state, error, command, threadDrafts }
}

interface AgentContextValue extends AgentConnection {
  readonly attention: AttentionReview
  readonly voice: AgentVoiceState
  readonly muteVoice: () => void
  readonly stopSpeech: () => void
  readonly retryVoice: () => void
  readonly claimPersonalAudio: () => () => void
  readonly waitForPersonalAudio: () => Promise<void>
  readonly responseStreaming: AppSettings['responseStreaming']
  /** Whether browser tasks show a corner preview; off leaves the work and Tools > Browser unchanged. */
  readonly showBrowserPreviews: boolean
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children, settings, dictation }: {
  readonly children: ReactNode
  readonly settings: AppSettings | null
  readonly dictation: DictationState
}): ReactNode {
  const agentsBridge = window.sotto?.agents
  const connection = useAgentConnection(agentsBridge && wrapAgentBridge(agentsBridge))
  const [voice, setVoice] = useState<AgentVoiceState>({ status: 'off' })
  const voiceRef = useRef<AgentVoiceSession | null>(null)
  const [personalAudio, setPersonalAudio] = useState(false)
  const personalAudioRef = useRef(false)
  const personalRelease = useRef(Promise.resolve())
  const claimPersonalAudio = useCallback(() => {
    personalAudioRef.current = true
    setPersonalAudio(true)
    personalRelease.current = voiceRef.current?.stop() ?? Promise.resolve()
    return () => { personalAudioRef.current = false; setPersonalAudio(false) }
  }, [])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const stateRef = useRef(connection.state)
  stateRef.current = connection.state
  const spoken = useRef<number | null>(null)
  const voiceAction = useRef<number | null>(null)
  const stopSpeech = useCallback(() => {
    voiceRef.current?.stopSpeaking()
    void connection.command({ type: 'voice', action: 'stop-speaking' })
  }, [connection.command])
  const attention = useAttentionReview(connection.state, connection.command, stopSpeech)

  useEffect(() => {
    if (connection.state?.configuration.speak === false) voiceRef.current?.stopSpeaking()
  }, [connection.state?.configuration.speak])

  useEffect(() => {
    if (window.sotto?.agents === undefined) return
    const agentBridge = window.sotto.agents
    const speech = createConfiguredSpeech(agentBridge, () => stateRef.current?.configuration)
    const session = new AgentVoiceSession({
      transcriptionBridge: window.sotto,
      wakeDetector: {
        async load() {
          if (agentBridge.prepareWake === undefined) throw new Error('Local wake detection is unavailable in this build.')
          await agentBridge.prepareWake()
        },
        async detect(audio) {
          if (agentBridge.detectWake === undefined) throw new Error('Local wake detection is unavailable in this build.')
          return agentBridge.detectWake(audio)
        },
        dispose() { void agentBridge.releaseWake?.().catch(() => undefined) },
      },
      ...(agentBridge.synthesizeSpeech === undefined ? {} : { speechOutput: speech.output }),
      getSettings: () => {
        const current = settingsRef.current
        if (current === null) throw new Error('Speech settings are not ready.')
        return current
      },
      onState: (next) => {
        setVoice(next)
        void connection.command({ type: 'voice-state', status: next.status, error: next.error ?? null })
      },
      onWake: () => {
        if (settingsRef.current?.soundCues) playWakeCue()
      },
      onUtterance: async (text, voiceTiming) => {
        if (!personalAudioRef.current) await connection.command({ type: 'utterance', text, ...(voiceTiming ? { voiceTiming } : {}) })
      },
      // A long composition must keep accepting speech after the user pauses to think.
      conversationTimeoutMs: 0,
    }, window.sottoE2E === undefined ? undefined : createE2EAgentVoiceEffects({
      async speak(text) {
        const state = stateRef.current
        if (state?.configuration.speechProvider === 'kokoro' || (state?.configuration.speechProvider === 'grok' && state.credentials.grokSpeech)) await speech.output.speak(text)
      },
      stop() { speech.output.stop() },
    }))
    voiceRef.current = session
    return () => { session.dispose(); speech.dispose(); voiceRef.current = null }
  }, [connection.command])

  // Setup finished without a microphone leaves wake listening off; the threads
  // themselves stay fully usable by typing. The coordinator is hidden for the
  // beta, and a hidden coordinator must never open the microphone, so the
  // wake session also waits on the setting rather than on its own controls.
  const voiceEnabled = connection.state?.configuration.enabled === true
    && settings?.voiceCoordinatorEnabled === true
    && settings?.onboardingComplete === true
    && settings?.microphoneSkipped !== true
    && ['active', 'beta'].includes(connection.state?.membership.status ?? '')
  const dictationActive = dictation.status === 'requesting-permission'
    || dictation.status === 'listening' || dictation.status === 'processing'
  useEffect(() => {
    const session = voiceRef.current
    if (session === null) return
    let current = true
    void (async () => {
      await session.setDictationActive(dictationActive)
      if (!current) return
      if (voiceEnabled && !personalAudio) await session.start()
      else await session.stop()
    })()
    return () => { current = false; void session.stop() }
  }, [voiceEnabled, personalAudio, dictationActive, settings?.microphoneId, connection.state?.configuration.wakeModelDirectory, connection.state?.configuration.wakeRuntimeDirectory])

  useEffect(() => {
    const request = connection.state?.voice
    if (request === undefined) return
    if (voiceAction.current === null) { voiceAction.current = request.revision; return }
    if (voiceAction.current === request.revision) return
    voiceAction.current = request.revision
    switch (request.action) {
      case 'mute': void voiceRef.current?.setMuted(true); break
      case 'unmute': void voiceRef.current?.setMuted(false); break
      case 'stop-speaking': voiceRef.current?.stopSpeaking(); break
      case 'sleep': voiceRef.current?.sleep(); break
    }
  }, [connection.state?.voice])

  useEffect(() => {
    const state = connection.state
    if (state === null) return
    // Reopening the management window should not replay an old announcement.
    if (spoken.current === null) { spoken.current = state.speech.id; return }
    if (spoken.current === state.speech.id) return
    spoken.current = state.speech.id
    // A hidden coordinator has no spoken hints, so an announcement is tracked
    // but never voiced; the identifier still advances so switching voice on
    // does not replay whatever was current while it was off.
    if (settingsRef.current?.voiceCoordinatorEnabled !== true) return
    if (!personalAudioRef.current && (state.speech.preview || (state.configuration.enabled && state.configuration.speak))) {
      // Selection updates replace narration; they must not accumulate a backlog.
      voiceRef.current?.stopSpeaking()
      void voiceRef.current?.speak(state.speech.text)
    }
  }, [connection.state])

  return <AgentContext.Provider value={{
    ...connection,
    claimPersonalAudio,
    waitForPersonalAudio: () => personalRelease.current,
    responseStreaming: settings?.responseStreaming ?? 'live',
    showBrowserPreviews: settings?.showBrowserPreviews ?? true,
    attention,
    voice,
    muteVoice: () => { void connection.command({ type: 'voice', action: voiceRef.current?.getState().status === 'muted' ? 'unmute' : 'mute' }) },
    stopSpeech,
    retryVoice: () => { if (!personalAudioRef.current) void voiceRef.current?.start() },
  }}>{children}</AgentContext.Provider>
}

export function useAgents(): AgentContextValue {
  const context = useContext(AgentContext)
  if (context === null) throw new Error('AgentProvider is required')
  return context
}

export function useOptionalAgents(): AgentContextValue | null {
  return useContext(AgentContext)
}

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentBridge, AgentCommand, AgentState } from '../../../shared/agents'
import type { AppSettings } from '../../../shared/settings'
import type { DictationState } from '../../../shared/dictation'
import { AgentVoiceSession, type AgentVoiceState } from './voiceSession'
import { createE2EAgentVoiceEffects } from '../e2e/agentVoiceEffects'
import { createConfiguredSpeech } from './naturalSpeech'
import { playWakeCue } from './voiceCue'
import { useAttentionReview, type AttentionReview } from './attentionReview'
import { ThreadDraftStore } from './threadDraftStore'

export interface AgentConnection {
  readonly state: AgentState | null
  readonly error: string | null
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  readonly threadDrafts: ThreadDraftStore
}

export function useAgentConnection(bridge: AgentBridge | undefined): AgentConnection {
  // A connection owns its command lane and draft durability knowledge. Neither page
  // navigation nor outstanding writes create a new store; a different bridge does.
  const session = useMemo(() => ({ current: false, observed: 0, tail: Promise.resolve() as Promise<unknown> }), [bridge])
  const [snapshot, setSnapshot] = useState<{ session: typeof session; state: AgentState } | null>(null)
  const [failure, setFailure] = useState<{ session: typeof session; error: string } | null>(null)
  const command = useCallback((request: AgentCommand): Promise<AgentState | null> => {
    const run = async (): Promise<AgentState | null> => {
      if (bridge === undefined || !session.current) return null
      const version = session.observed
      try {
        const next = await bridge.command(request)
        if (session.current) {
          setFailure(null)
          if (version === session.observed) setSnapshot({ session, state: next })
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
      || request.type === 'reorder-followups' || request.type === 'resume-followups' || request.type === 'steer' || request.type === 'refresh-thread-skills'
      || request.type === 'observe-threads'
    if (request.type === 'manual-send' || request.type === 'select-thread' || request.type === 'save-thread-draft' || request.type === 'voice' || request.type === 'voice-state' || speechPreference || providerOperation || threadLane) return run()
    const operation = session.tail.then(run)
    session.tail = operation
    return operation
  }, [bridge, session])
  const threadDrafts = useMemo(() => new ThreadDraftStore(command), [command])
  const state = snapshot?.session === session ? snapshot.state : null
  const error = failure?.session === session ? failure.error : null
  useEffect(() => {
    session.current = true
    let active = true
    const receive = (next: AgentState): void => {
      setSnapshot({ session, state: next })
    }
    const version = session.observed
    const unsubscribe = bridge?.onState(next => {
      ++session.observed
      if (active) receive(next)
    })
    void bridge?.get().then(next => {
      if (active && version === session.observed) receive(next)
    }).catch(() => { if (active) setFailure({ session, error: 'Agent controls are unavailable. Reopen Sotto to reconnect.' }) })
    const flush = (): void => threadDrafts.flushAll()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      flush()
      active = false; session.current = false; unsubscribe?.()
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [bridge, session, threadDrafts])
  // Both published and command-returned snapshots reach the store before paint,
  // including while the Threads page is absent.
  useLayoutEffect(() => { if (state !== null) threadDrafts.receive(state) }, [state, threadDrafts])
  return { state, error, command, threadDrafts }
}

interface AgentContextValue extends AgentConnection {
  readonly attention: AttentionReview
  readonly voice: AgentVoiceState
  readonly muteVoice: () => void
  readonly stopSpeech: () => void
  readonly retryVoice: () => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children, settings, dictation }: {
  readonly children: ReactNode
  readonly settings: AppSettings | null
  readonly dictation: DictationState
}): ReactNode {
  const connection = useAgentConnection(window.sotto?.agents)
  const [voice, setVoice] = useState<AgentVoiceState>({ status: 'off' })
  const voiceRef = useRef<AgentVoiceSession | null>(null)
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
      onUtterance: async (text, voiceTiming) => { await connection.command({ type: 'utterance', text, ...(voiceTiming ? { voiceTiming } : {}) }) },
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

  const voiceEnabled = connection.state?.configuration.enabled === true
    && settings?.onboardingComplete === true
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
      if (voiceEnabled) await session.start()
      else await session.stop()
    })()
    return () => { current = false; void session.stop() }
  }, [voiceEnabled, dictationActive, settings?.microphoneId, connection.state?.configuration.wakeModelDirectory, connection.state?.configuration.wakeRuntimeDirectory])

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
    if (state.speech.preview || (state.configuration.enabled && state.configuration.speak)) {
      // Selection updates replace narration; they must not accumulate a backlog.
      voiceRef.current?.stopSpeaking()
      void voiceRef.current?.speak(state.speech.text)
    }
  }, [connection.state])

  return <AgentContext.Provider value={{
    ...connection,
    attention,
    voice,
    muteVoice: () => { void connection.command({ type: 'voice', action: voiceRef.current?.getState().status === 'muted' ? 'unmute' : 'mute' }) },
    stopSpeech,
    retryVoice: () => { void voiceRef.current?.start() },
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

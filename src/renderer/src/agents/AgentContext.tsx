import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import type { AgentBridge, AgentCommand, AgentState } from '../../../shared/agents'
import type { AppSettings } from '../../../shared/settings'
import type { DictationState } from '../../../shared/dictation'
import { AgentVoiceSession, type AgentVoiceState } from './voiceSession'
import { createE2EAgentVoiceEffects } from '../e2e/agentVoiceEffects'
import { createConfiguredSpeech } from './naturalSpeech'
import { playWakeCue } from './voiceCue'

export interface AgentConnection {
  readonly state: AgentState | null
  readonly error: string | null
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
}

export function useAgentConnection(bridge: AgentBridge | undefined): AgentConnection {
  const [state, setState] = useState<AgentState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef(false)
  const observed = useRef(0)
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    current.current = true
    if (bridge === undefined) return () => { current.current = false }
    const version = observed.current
    const unsubscribe = bridge.onState((next) => {
      ++observed.current
      if (current.current) setState(next)
    })
    void bridge.get().then((next) => {
      if (current.current && version === observed.current) setState(next)
    }).catch(() => { if (current.current) setError('Agent controls are unavailable. Reopen Sotto to reconnect.') })
    return () => { current.current = false; unsubscribe() }
  }, [bridge])
  const command = useCallback((request: AgentCommand): Promise<AgentState | null> => {
    const operation = tail.current.then(async () => {
      if (bridge === undefined || !current.current) return null
      const version = observed.current
      try {
        const next = await bridge.command(request)
        if (current.current) {
          setError(null)
          if (version === observed.current) setState(next)
        }
        return next
      } catch {
        if (current.current) setError('The action could not be confirmed. Your draft is retained; check the connection before retrying.')
        return null
      }
    })
    tail.current = operation
    return operation
  }, [bridge])
  return { state, error, command }
}

interface AgentContextValue extends AgentConnection {
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

  useEffect(() => {
    if (window.sotto?.agents === undefined) return
    const agentBridge = window.sotto.agents
    const speech = createConfiguredSpeech(agentBridge, () => stateRef.current?.configuration)
    const session = new AgentVoiceSession({
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
      onUtterance: async (text) => { await connection.command({ type: 'utterance', text }) },
      // A long composition must keep accepting speech after the user pauses to think.
      conversationTimeoutMs: 0,
    }, window.sottoE2E === undefined ? undefined : createE2EAgentVoiceEffects())
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
  }, [voiceEnabled, dictationActive, settings?.microphoneId, settings?.modelPreset, connection.state?.configuration.wakeModelDirectory, connection.state?.configuration.wakeRuntimeDirectory])

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
      void voiceRef.current?.speak(state.speech.text)
    }
  }, [connection.state])

  return <AgentContext.Provider value={{
    ...connection,
    voice,
    muteVoice: () => { void connection.command({ type: 'voice', action: voiceRef.current?.getState().status === 'muted' ? 'unmute' : 'mute' }) },
    stopSpeech: () => { void connection.command({ type: 'voice', action: 'stop-speaking' }) },
    retryVoice: () => { void voiceRef.current?.start() },
  }}>{children}</AgentContext.Provider>
}

export function useAgents(): AgentContextValue {
  const context = useContext(AgentContext)
  if (context === null) throw new Error('AgentProvider is required')
  return context
}

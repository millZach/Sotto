import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Mic, MicOff, VolumeX } from 'lucide-react'
import type { PersonalChat, PersonalChatBridge, PersonalChatState } from '../../../../shared/personalChats'
import { useOptionalApp } from '../../state/AppContext'
import { registerDictationDestination } from '../../features/dictation/dictationDestination'
import { Button } from '../../components/Button'
import { useOptionalAgents } from '../AgentContext'
import { AgentVoiceSession, type AgentVoiceState } from '../voiceSession'
import { createConfiguredSpeech } from '../naturalSpeech'
import { createE2EAgentVoiceEffects } from '../../e2e/agentVoiceEffects'
import type { PersonalDraftStore } from './personalDrafts'
import './personalVoice.css'

/** Capture this chat in every input closure. Navigation can stop audio, but cannot retarget it. */
export function PersonalVoice({ bridge, chat, state, store }: {
  readonly bridge: PersonalChatBridge; readonly chat: PersonalChat; readonly state: PersonalChatState; readonly store: PersonalDraftStore
}): ReactNode {
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const current = useRef({ chat, state, app, agents })
  current.current = { chat, state, app, agents }
  const session = useRef<AgentVoiceSession | null>(null)
  const [voice, setVoice] = useState<AgentVoiceState>({ status: 'off' })
  const [notice, setNotice] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const awaiting = useRef<{ before: Set<string>; generation: number } | null>(null)
  const generation = useRef(0)
  const dictating = app?.dictation.status === 'listening' || app?.dictation.status === 'requesting-permission'
  const processing = app?.dictation.status === 'processing'

  useEffect(() => {
    // While personal chat has the foreground, the project wake-command lane must stay asleep.
    const release = current.current.agents?.claimPersonalAudio()
    return release
  }, [])

  useEffect(() => registerDictationDestination(async request => {
    const owner = current.current.chat
    const draft = store.draft(owner)
    store.edit(bridge, owner, { text: [draft.text.trimEnd(), request.text].filter(Boolean).join('\n') })
    if (!await store.flush(bridge, owner.id)) throw new Error('The transcript is in your chat draft, but could not be saved. Retry saving it.')
    return 'pasted' as const
  }), [bridge, chat.id, store])

  useEffect(() => {
    const agentBridge = window.sotto?.agents
    if (!agentBridge || !app) return
    const speech = createConfiguredSpeech(agentBridge, () => current.current.agents?.state?.configuration)
    const voiceSession = new AgentVoiceSession({
      transcriptionBridge: window.sotto!,
      speechOutput: speech.output,
      getSettings: () => {
        const settings = current.current.app?.settings
        if (!settings) throw new Error('Speech settings are not ready.')
        return settings
      },
      onState: next => {
        setVoice(next)
        if (next.status === 'off' || next.status === 'muted' || next.status === 'error') {
          awaiting.current = null
          setWaiting(false)
        }
      },
      conversationTimeoutMs: 0,
      onUtterance: async text => {
        if (awaiting.current) return
        const captured = generation.current
        const { chat: owner, state: latest } = current.current
        const draft = store.draft(owner)
        const blocked = !latest.connected || owner.status === 'running' || owner.requests.length > 0
          || owner.nativeState === 'uncertain' || owner.submissions.some(item => item.status === 'submitting' || item.status === 'uncertain')
        store.edit(bridge, owner, { text: [draft.text.trimEnd(), text].filter(Boolean).join('\n') })
        if (blocked || draft.text.trim()) {
          await store.flush(bridge, owner.id)
          setNotice('Speech is in your draft. Review it before sending.')
          await voiceSession.stop()
          return
        }
        awaiting.current = { before: new Set(owner.messages.map(message => message.id)), generation: captured }
        setWaiting(true)
        const error = await store.send(bridge, owner)
        if (generation.current !== captured) return
        if (error) {
          awaiting.current = null
          setWaiting(false)
          setNotice(error)
          await voiceSession.stop()
        }
      },
    }, window.sottoE2E ? createE2EAgentVoiceEffects({
      async speak(text) {
        window.dispatchEvent(new CustomEvent('sotto:e2e:personal-spoken', { detail: text }))
        await new Promise(resolve => setTimeout(resolve, 500))
      }, stop() {},
    }) : undefined)
    session.current = voiceSession
    return () => {
      ++generation.current
      awaiting.current = null
      voiceSession.dispose()
      speech.dispose()
      session.current = null
    }
  // App/agent state is read at activation; rerenders must never recreate a live capture.
  }, [bridge, chat.id, store, Boolean(app)])

  useEffect(() => {
    if (dictating || processing) { ++generation.current; awaiting.current = null; setWaiting(false); void session.current?.stop() }
  }, [dictating, processing])

  useEffect(() => {
    const pending = awaiting.current
    if (!pending || pending.generation !== generation.current || chat.status === 'running') return
    const replies = chat.messages.filter(message => message.role === 'assistant' && !pending.before.has(message.id) && message.text.trim())
    if (!replies.length && !chat.requests.length && chat.status !== 'error') return
    awaiting.current = null
    setWaiting(false)
    if (replies.length) void session.current?.speak(replies.map(message => message.text).join('\n\n'))
    else setNotice(chat.requests.length ? 'Answer the request in the chat to continue.' : 'The reply failed. Check this chat before trying again.')
  }, [chat])

  if (!app || !agents) return null
  const active = voice.status !== 'off' && voice.status !== 'error'
  const end = (): void => { ++generation.current; awaiting.current = null; setWaiting(false); void session.current?.stop() }
  const start = (): void => {
    setNotice(null)
    const captured = generation.current
    void agents.waitForPersonalAudio().then(() => { if (captured === generation.current) return session.current?.startConversation() })
  }
  const label = dictating ? 'Dictating into this draft' : processing ? 'Transcribing into this draft'
    : waiting ? 'Waiting for reply' : ({ off: '', starting: 'Opening microphone', wake: 'Voice paused', listening: 'Listening', speaking: 'Speaking', muted: 'Microphone muted', dictation: 'Dictating', error: 'Voice needs attention' }[voice.status])
  return <div className="personal-voice">
    <div className="personal-voice__controls">
      <Button variant="ghost" disabled={processing || active} onClick={() => void (dictating ? app.actions.stop() : app.actions.start())}>
        <Mic size={16} aria-hidden="true" />{dictating ? 'Finish dictation' : 'Dictate'}</Button>
      <Button variant="ghost" disabled={dictating || processing || !state.connected} onClick={active ? end : start}>{active ? 'End voice' : 'Talk'}</Button>
      {active ? <>
        <Button variant="ghost" iconOnly aria-label={voice.status === 'muted' ? 'Unmute chat microphone' : 'Mute chat microphone'} onClick={() => {
          ++generation.current; awaiting.current = null; setWaiting(false)
          if (voice.status === 'muted') void session.current?.startConversation()
          else void session.current?.setMuted(true)
        }}><MicOff size={16} /></Button>
        {voice.status === 'speaking' ? <Button variant="ghost" iconOnly aria-label="Stop spoken reply" onClick={() => session.current?.stopSpeaking()}><VolumeX size={16} /></Button> : null}
      </> : null}
      <select className="tt-focusable personal-voice__provider" aria-label="Chat reply voice" value={agents.state?.configuration.speechProvider ?? 'grok'} disabled={active}
        onChange={event => void agents.command({ type: 'configure', patch: { speechProvider: event.target.value as 'grok' | 'kokoro' } })}>
        <option value="grok">Grok voice</option><option value="kokoro">Kokoro voice</option>
        {agents.state?.configuration.speechProvider !== 'grok' && agents.state?.configuration.speechProvider !== 'kokoro' ? <option value={agents.state?.configuration.speechProvider}>Current voice</option> : null}
      </select>
    </div>
    {label || notice || voice.error ? <span className="personal-voice__status" role={notice || voice.error ? 'alert' : 'status'}>{voice.error ?? notice ?? label}</span> : null}
  </div>
}

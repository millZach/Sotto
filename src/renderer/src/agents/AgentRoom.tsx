import { hostForThread } from '../../../shared/agents'
import React, { useState, type ReactNode } from 'react'
import { Mic, MicOff, Settings2, Volume2, VolumeX } from 'lucide-react'
import { isThreadClosed } from '../../../shared/threadActivity'
import { capabilitiesForThread, isThreadBusy, isThreadProviderConnected, supportsAgentSupervision, type AgentThread } from '../../../shared/agents'
import { Button } from '../components/Button'
import { SideSheet } from '../components/SideSheet'
import { useAgents } from './AgentContext'
import { AgentComposer, AgentManualNotice, AgentQueue } from './AgentView'
import { NewThreadDialog } from './NewThreadDialog'
import { AgentSetupFields } from './AgentAccountSettings'
import { VoiceSettings } from './VoiceSettings'
import { providerGlyph } from './threadFacts'
import { AgentOrb } from './orb/AgentOrb'
import type { OrbState } from './orb/orb'

export function AgentAppearance(): ReactNode {
  const { state, command } = useAgents()
  const [voiceOpen, setVoiceOpen] = useState(false)
  if (!state) return null
  const configuration = state.configuration
  const voice = configuration.speechProvider === 'natural' ? `${configuration.speechVoice}, natural voice` : configuration.speechProvider === 'grok' ? `${configuration.grokSpeechVoice}, Grok voice` : configuration.speechProvider === 'kokoro' ? 'Heart, Kokoro voice' : 'System voice'
  return <div className="agent-appearance">
    <button type="button" className="agent-voice-chip tt-focusable" onClick={() => setVoiceOpen(true)}><Volume2 size={15} />{voice}</button>
    {voiceOpen ? <SideSheet title="Voice" onClose={() => setVoiceOpen(false)}><VoiceSettings configuration={configuration} command={command} change={(key, value) => { void command({ type: 'configure', patch: { [key]: value } }) }} grokKeySaved={state.credentials.grokSpeech} voiceError={state.voice.error} /></SideSheet> : null}
  </div>
}

export function AgentRoom({ onOpenThreads, initialSheet = null }: { readonly onOpenThreads: () => void; readonly initialSheet?: 'session' | 'new' | 'settings' | null }): ReactNode {
  const agents = useAgents()
  const { state, command } = agents
  const [sheet, setSheet] = useState<'session' | 'new' | 'settings' | null>(initialSheet)
  if (!state) return <div className="agent-room"><p role="status">{agents.error ?? 'Preparing agent controls…'}</p></div>
  const active = state.host.threads.find(thread => thread.id === state.activeThreadId)
  const draftTarget = state.host.threads.find(thread => thread.id === state.draftThreadId)
  const project = state.host.projects.find(project => project.id === (active?.projectId ?? state.activeProjectId)) ?? state.host.projects[0]
  const assignment = state.assignments.find(entry => entry.threadId === active?.id)
  const connected = state.connection === 'connected'
  const { attention } = agents
  const attentionState = { ...state, queue: attention.items }
  const showAttention = attention.show
  const dismissAttention = attention.dismiss
  const nextAttention = attention.next
  const running = state.host.threads.filter(thread => !isThreadClosed(thread) && thread.status === 'running').length
  const status = agents.voice.status
  const orbState: OrbState = status === 'speaking' ? 'speaking' : status === 'listening' ? 'listening' : status === 'wake' ? 'wake' : (running > 0 || state.globalLaneBusy || Boolean(state.busyThreadIds?.length)) ? 'working' : 'idle'
  const caption = { off: 'Your agents, one conversation away', starting: 'Preparing your voice', wake: 'Say “Hey Sotto”', listening: 'Sotto is listening', speaking: 'Sotto is speaking', muted: 'Microphone muted', dictation: 'Dictation is using the microphone', error: 'Voice needs attention' }[status]
  const error = agents.voice.error ?? state.error ?? agents.error
  const feedback = status === 'speaking' && state.speech.text ? state.speech.text : state.notice || (running ? `${running} ${running === 1 ? 'thread is' : 'threads are'} working. ${attention.items.length} waiting for you.` : connected ? 'Choose a thread, or start something new.' : 'Connect your provider to bring your threads here.')
  const selectThread = async (thread: AgentThread): Promise<void> => {
    const result = await command({ type: 'select-thread', threadId: thread.id })
    if (result && !result.error) setSheet('session')
  }
  const provider = (thread: AgentThread): string => hostForThread(state.host, thread).models.find(model => model.id === thread.modelId)?.provider ?? state.configuration.provider
  return <div className="agent-room">
    <div className="agent-room__tools">
      <Button variant="ghost" iconOnly aria-label="Configure agents" onClick={() => setSheet('settings')}><Settings2 size={17} /></Button>
      <Button variant="secondary" iconOnly aria-label={status === 'muted' ? 'Unmute listening' : 'Mute listening'} disabled={!state.configuration.enabled} onClick={agents.muteVoice}>{status === 'muted' ? <MicOff size={17} /> : <Mic size={17} />}</Button>
      <Button variant="secondary" iconOnly aria-label={state.configuration.speak ? 'Mute spoken replies' : 'Enable spoken replies'} aria-pressed={!state.configuration.speak} onClick={() => { agents.stopSpeech(); void command({ type: 'configure', patch: { speak: !state.configuration.speak } }) }}>{state.configuration.speak ? <Volume2 size={17} /> : <VolumeX size={17} />}</Button>
    </div>
    <div className="agent-room__stage"><AgentOrb state={orbState} />
      {showAttention ? <div className="agent-room__attention"><AgentQueue approvalLabel="Allow" state={attentionState} command={command} onLater={dismissAttention} onNext={() => void nextAttention()} />{attention.items.find(item => item.threadId === state.activeThreadId)?.kind === 'permission' ? <small className="agent-muted">Say “allow” or “deny”, or choose here.</small> : null}{attention.items.find(item => item.threadId === state.activeThreadId)?.kind === 'question' ? <Button variant="secondary" onClick={() => setSheet('session')}>Write an answer</Button> : null}</div> : null}
    </div>
    <div className="agent-room__caption"><h1>{state.composing && status === 'listening' ? `Drafting for ${draftTarget?.title ?? 'your thread'}` : caption}</h1>
      {connected && attention.items.length > 0 && !showAttention ? <Button variant="secondary" onClick={attention.reopen}>Review attention ({attention.items.length})</Button> : null}
      {status === 'speaking' ? <Button variant="secondary" className="agent-room__speech-control" aria-label="Stop speech" onClick={agents.stopSpeech}><VolumeX size={15} />Stop speech</Button> : null}
      {state.composing && status !== 'speaking' ? <p role="status">{status === 'listening' ? 'Speech is added to your prompt. Say “send it” when ready, or “talk to Sotto” to pause.' : `Your prompt for ${draftTarget?.title ?? 'your thread'} is saved. ${status === 'wake' ? 'Wake Sotto to continue dictating.' : 'Return to listening to continue dictating.'}`}</p> : feedback !== error ? <p role="status">{feedback}</p> : null}
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
      {status === 'error' ? <Button variant="ghost" onClick={() => { if (!state.configuration.wakeModelDirectory || !state.configuration.wakeRuntimeDirectory) setSheet('settings'); else agents.retryVoice() }}>{!state.configuration.wakeModelDirectory || !state.configuration.wakeRuntimeDirectory ? 'Set up voice' : 'Retry voice'}</Button> : null}
      {state.composing ? <div className="agent-actions"><Button variant="secondary" onClick={() => { if (draftTarget) void selectThread(draftTarget); else setSheet('session') }}>Review draft</Button><Button variant="ghost" disabled={state.globalLaneBusy} onClick={() => void command({ type: 'pause-draft' })}>Talk to Sotto</Button></div> : connected && state.configuration.enabled ? <small>Try “what needs my attention?”</small> : <div className="agent-actions">{!connected ? <Button variant="secondary" disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect' })}>{state.connection === 'connecting' ? 'Connecting…' : 'Connect providers'}</Button> : null}{!state.configuration.enabled ? <Button variant="ghost" onClick={() => void command({ type: 'configure', patch: { enabled: true } })}>Enable agent control</Button> : null}</div>}
      {state.pendingRequest ? <details><summary>Pending spoken request</summary><p>{state.pendingRequest}</p><Button variant="ghost" onClick={() => void command({ type: 'cancel-request' })}>Clear request</Button></details> : null}
    </div>
    <div className="agent-sessions" aria-label="Sessions">{state.host.threads.filter(thread => !isThreadClosed(thread)).slice(0, 6).map(thread => <button key={thread.id} type="button" className="agent-session tt-focusable" aria-label={`Open ${thread.title}`} onClick={() => void selectThread(thread)}><span className="agent-session__badge" data-provider={provider(thread).toLowerCase()}>{providerGlyph(provider(thread))}</span><span>{thread.title}</span><i data-state={thread.requests.length ? 'attention' : thread.status} /></button>)}
      <Button variant="secondary" className="agent-session-new" disabled={!connected} onClick={() => setSheet('new')}>New session</Button><Button variant="ghost" onClick={onOpenThreads}>All threads</Button>
    </div>
    {sheet === 'settings' ? <SideSheet title="Agent configuration" onClose={() => setSheet(null)}><AgentSetupFields /><div className="agent-actions"><Button variant="secondary" onClick={() => void command({ type: 'configure', patch: { enabled: !state.configuration.enabled } })}>{state.configuration.enabled ? 'Turn off agent control' : 'Enable agent control'}</Button></div></SideSheet> : null}
    {sheet === 'new' ? <NewThreadDialog state={state} command={command} managed onClose={() => setSheet(null)} onCreated={() => setSheet('session')} /> : null}
    {sheet === 'session' ? <SideSheet title={active?.title ?? 'Session'} onClose={() => setSheet(null)}>
      {active ? <><p className="agent-muted">{project?.title} · {state.host.models.find(model => model.id === active.modelId)?.name ?? active.modelId}</p><AgentManualNotice state={state} command={command} />
        <div className="agent-actions">{assignment ? <><Button variant="ghost" onClick={() => void command({ type: assignment.paused || assignment.mode === 'manual' ? 'resume' : 'pause', threadId: active.id })}>{assignment.paused || assignment.mode === 'manual' ? 'Resume management' : 'Pause management'}</Button><Button variant="ghost" onClick={() => void command({ type: 'unassign', threadId: active.id })}>Stop managing</Button></> : <Button variant="secondary" disabled={!isThreadProviderConnected(state.host, active) || state.globalLaneBusy || !supportsAgentSupervision(capabilitiesForThread(state.host, active))} onClick={() => void command({ type: 'assign', threadId: active.id })}>Manage this thread</Button>}{active.status === 'running' && !isThreadClosed(active) && capabilitiesForThread(state.host, active).interrupt ? <Button variant="ghost" disabled={!isThreadProviderConnected(state.host, active) || isThreadBusy(state, active.id)} onClick={() => void command({ type: 'interrupt', threadId: active.id })}>Stop agent</Button> : null}</div>
        <div className="agent-transcript" aria-label="Session transcript">{active.messages.length ? active.messages.map(message => <article key={message.id}><small>{message.role === 'user' ? 'You' : 'Agent'}</small><p>{message.text}</p></article>) : <p className="agent-muted">No messages yet.</p>}</div></> : <p>Select a thread to read its transcript.</p>}
      {attention.items.some(item => item.threadId === state.activeThreadId) ? <AgentQueue approvalLabel="Allow" state={attentionState} command={command} compact /> : null}
      <AgentComposer state={state} command={command} />
      {state.error || agents.error ? <p className="agent-error" role="alert">{state.error ?? agents.error}</p> : null}
    </SideSheet> : null}
  </div>
}

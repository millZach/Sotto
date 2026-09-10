import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, FolderPlus, Mic, MicOff, Plus, RefreshCw, Settings2, VolumeX, Workflow } from 'lucide-react'

import { supportsAgentSupervision, type AgentConfiguration, type AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import './agents.css'

type Command = AgentConnection['command']

export function AgentManualNotice({ state, command }: { readonly state: AgentState; readonly command: Command }): ReactNode {
  const thread = state.host.threads.find((entry) => entry.id === state.activeThreadId)
  const assignment = state.assignments.find((entry) => entry.threadId === state.activeThreadId)
  if (thread === undefined || assignment?.mode !== 'manual') return null
  return <section className="agent-manual" aria-label={`Manual control for ${thread.title}`}>
    <strong>Manual control · {thread.title}</strong>
    <p>You’re replying directly in T3. Sotto is still watching this thread, but won’t send replies. Say “resume managing {thread.title}” or select Resume management to hand it back.</p>
    <Button variant="secondary" onClick={() => void command({ type: 'resume', threadId: thread.id })}>Resume management</Button>
  </section>
}

export function AgentComposer({ state, command, compact = false }: {
  readonly state: AgentState; readonly command: Command; readonly compact?: boolean
}): ReactNode {
  const [draft, setDraft] = useState(state.draft)
  const writes = useRef(0)
  const version = useRef(0)
  const target = state.host.threads.find((entry) => entry.id === (state.draftThreadId ?? state.activeThreadId))
  const project = state.host.projects.find((entry) => entry.id === target?.projectId)
  useEffect(() => {
    if (writes.current === 0) setDraft(state.draft)
  }, [state.draft, state.draftThreadId])
  const update = (value: string): void => {
    setDraft(value)
    ++writes.current
    const writeVersion = ++version.current
    void command({ type: 'compose', text: value }).then((result) => {
      --writes.current
      if (writeVersion === version.current && result !== null) setDraft(result.draft)
    })
  }
  const send = async (): Promise<void> => {
    const composed = await command({ type: 'compose', text: draft })
    if (composed === null || composed.error !== null) return
    const result = await command({ type: 'send' })
    if (result !== null) setDraft(result.draft)
  }
  return <section className="agent-composer">
    <div className="agent-section-title"><label htmlFor={compact ? 'widget-agent-prompt' : 'agent-prompt'}>{state.draftRequestId ? 'Answer draft' : 'Prompt'}</label>
      <span>{target === undefined ? 'Select a thread' : `${project?.title ?? 'Project'} / ${target.title}`}</span></div>
    <textarea id={compact ? 'widget-agent-prompt' : 'agent-prompt'} value={draft} onChange={(event) => update(event.target.value)}
      rows={compact ? 3 : 5} placeholder={target === undefined ? 'Select a thread to start a prompt.' : 'Dictate or type your prompt. Pauses won’t send it.'}
      disabled={target === undefined} spellCheck />
    <div className="agent-composer__footer"><span>Say “send it” when you’re ready.</span>
      <div className="agent-actions">
        {draft.length > 0 ? <Button variant="ghost" onClick={() => { setDraft(''); void command({ type: 'cancel-draft' }) }}>Clear</Button> : null}
        <Button disabled={state.busy || target === undefined || draft.trim().length === 0 || state.connection !== 'connected'} onClick={() => void send()}>
          Send it <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  </section>
}

export function AgentQueue({ state, command, compact = false }: {
  readonly state: AgentState; readonly command: Command; readonly compact?: boolean
}): ReactNode {
  const [answer, setAnswer] = useState('')
  const active = state.queue.find((entry) => entry.threadId === state.activeThreadId)
  const thread = state.host.threads.find((entry) => entry.id === active?.threadId)
  const request = thread?.requests.find((entry) => entry.id === active?.requestId)
  useEffect(() => { setAnswer('') }, [active?.id])
  const reply = (value: string, approved?: boolean): void => {
    if (active?.requestId === undefined) return
    void command({ type: 'answer', threadId: active.threadId, requestId: active.requestId, answer: value,
      ...(approved === undefined ? {} : { approved }) })
  }
  return <section className="agent-queue" aria-label="Ready threads">
    <div className="agent-section-title"><h2>Needs your attention <span className="agent-count">{state.queue.length}</span></h2>
      <div className="agent-actions"><Button variant="ghost" disabled={state.queue.length === 0} onClick={() => void command({ type: 'later' })}>Later</Button>
        <Button variant="secondary" disabled={state.queue.length === 0} onClick={() => void command({ type: 'next' })}>Next <ArrowRight size={13} aria-hidden="true" /></Button></div>
    </div>
    {state.queue.length === 0 ? <p className="agent-muted">Assigned threads will appear here when they need you.</p> : <>
      {!compact ? <div className="agent-queue__tabs">{state.queue.map((item) => {
        const target = state.host.threads.find((entry) => entry.id === item.threadId)
        return <button type="button" className="agent-queue__tab" key={item.id} aria-pressed={item.threadId === state.activeThreadId}
          onClick={() => void command({ type: 'select-thread', threadId: item.threadId })}>
          {target?.title ?? 'Thread'}{item.deferred ? ' · Later' : ''}
        </button>
      })}</div> : null}
      {active === undefined ? <p className="agent-muted">Select a waiting thread or say “next.”</p> : <div className="agent-queue__question">
        <span className="agent-eyebrow">{active.kind === 'permission' ? 'Permission requested' : active.kind === 'question' ? 'Your decision' : 'Ready for you'}</span>
        <p>{active.text}</p>
        {active.requestId === undefined ? null : request?.kind === 'permission' || active.kind === 'permission'
          ? <div className="agent-actions"><Button variant="secondary" onClick={() => reply('Denied', false)}>Deny</Button><Button onClick={() => reply('Approved', true)}>Approve</Button></div>
          : <div className="agent-answer">
            {request?.options.length ? <div className="agent-actions">{request.options.map((option) =>
              <Button key={option.id} variant="secondary" onClick={() => reply(option.id)}>{option.label}</Button>)}</div> : null}
            <label className="tt-visually-hidden" htmlFor={compact ? 'widget-agent-answer' : 'agent-answer'}>Your answer</label>
            <textarea id={compact ? 'widget-agent-answer' : 'agent-answer'} rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Your answer" />
            <Button disabled={answer.trim().length === 0 || state.busy} onClick={() => reply(answer)}>Answer question</Button>
          </div>}
      </div>}
    </>}
  </section>
}

function AgentConnectionSettings({ state, command }: { readonly state: AgentState; readonly command: Command }): ReactNode {
  const [configuration, setConfiguration] = useState(state.configuration)
  const [token, setToken] = useState('')
  const [reasoningKey, setReasoningKey] = useState('')
  const [saved, setSaved] = useState(false)
  const change = <K extends keyof AgentConfiguration>(key: K, value: AgentConfiguration[K]): void => {
    setConfiguration((current) => ({ ...current, [key]: value })); setSaved(false)
  }
  const save = async (): Promise<void> => {
    const result = await command({ type: 'configure', patch: {
      endpoint: configuration.endpoint,
      projectsDirectory: configuration.projectsDirectory,
      defaultModelId: configuration.defaultModelId,
      followupLimit: configuration.followupLimit,
      speak: configuration.speak,
      wakeModelDirectory: configuration.wakeModelDirectory,
      wakeRuntimeDirectory: configuration.wakeRuntimeDirectory,
      reasoning: configuration.reasoning,
      reasoningModel: configuration.reasoningModel,
    } })
    if (result === null || result.error !== null) return
    if (token.trim()) {
      const stored = await command({ type: 'credential', slot: 't3', value: token.trim() })
      if (stored === null || stored.error !== null) return
      setToken('')
    }
    if (reasoningKey.trim()) {
      const stored = await command({ type: 'credential', slot: 'reasoning', value: reasoningKey.trim() })
      if (stored === null || stored.error !== null) return
      setReasoningKey('')
    }
    setSaved(true)
  }
  return <section className="agent-settings" aria-label="Agent connection settings">
    <div className="agent-fields">
      <label>T3 Code address<input value={configuration.endpoint} onChange={(event) => change('endpoint', event.target.value)} placeholder="http://127.0.0.1:3773" /></label>
      <label>T3 access token<input type="password" autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setSaved(false) }} placeholder={state.credentials.t3 ? 'Saved securely · enter to replace' : 'Token from T3 connection settings'} /></label>
      <label className="agent-field-wide">Default projects directory<input value={configuration.projectsDirectory} onChange={(event) => change('projectsDirectory', event.target.value)} placeholder="D:\Projects" /></label>
      <label>Default agent model<select value={configuration.defaultModelId} onChange={(event) => change('defaultModelId', event.target.value)}>
        <option value="">Choose a model after connecting</option>
        {state.host.models.map((model) => <option key={model.id} value={model.id} disabled={!model.ready}>{model.name}{!model.ready ? ' · unavailable' : ''}</option>)}
      </select></label>
      <label>Automatic follow-up limit<input type="number" min={0} max={100} value={configuration.followupLimit} onChange={(event) => change('followupLimit', Math.min(100, Math.max(0, Number(event.target.value))))} /></label>
      <label>Sotto reasoning<select value={configuration.reasoning} onChange={(event) => change('reasoning', event.target.value as AgentConfiguration['reasoning'])}>
        <option value="none">Human decisions only</option><option value="openrouter">OpenRouter API</option><option value="openai">OpenAI API</option>
      </select></label>
      <label>Reasoning model<input value={configuration.reasoningModel} onChange={(event) => change('reasoningModel', event.target.value)} placeholder="Provider model ID" disabled={configuration.reasoning === 'none'} /></label>
      {configuration.reasoning !== 'none' ? <label className="agent-field-wide">Reasoning API key<input type="password" autoComplete="off" value={reasoningKey} onChange={(event) => { setReasoningKey(event.target.value); setSaved(false) }} placeholder={state.credentials.reasoning ? 'Saved securely · enter to replace' : 'Your provider API key'} /></label> : null}
      <label className="agent-checkbox"><input type="checkbox" checked={configuration.speak} onChange={(event) => change('speak', event.target.checked)} />Spoken replies using a local system voice</label>
      <label className="agent-field-wide">Local wake model folder<input value={configuration.wakeModelDirectory} onChange={(event) => change('wakeModelDirectory', event.target.value)} placeholder="Absolute path to your local wake model" />
        <span>Wake setup is required before using “Hey Sotto.” This build supports a separately supplied Sherpa phonetic model. Its distribution license is unresolved, so Sotto does not include or download the weights. Text agent controls remain available.</span>
      </label>
      <label className="agent-field-wide">Local wake runtime folder<input value={configuration.wakeRuntimeDirectory} onChange={(event) => change('wakeRuntimeDirectory', event.target.value)} placeholder="Absolute path to your existing sherpa-onnx 1.13.7 runtime" />
        <span>The packaged app also requires a separately supplied runtime. Only verified original files are accepted. Runtime redistribution review is still required.</span>
      </label>
    </div>
    <div className="agent-billing"><p><strong>Your connected accounts</strong></p>
      <p>T3’s project agents use the subscriptions or API accounts configured in T3. Sotto reasoning uses the API account you select above. Local spoken replies have no provider usage charge.</p>
      {!state.credentials.secure ? <p role="alert">Secure credential storage is unavailable. Credentials cannot be saved on this system.</p> : null}
      <p>Assignment context expires after seven days without activity. Turning off history prevents saving that context. Unsent drafts stay on this desktop until sent or cleared so they survive a restart.</p>
    </div>
    <div className="agent-actions"><Button onClick={() => void save()} disabled={state.busy}>Save connection settings</Button>{saved ? <span role="status">Settings saved</span> : null}</div>
    <div className="agent-billing agent-membership"><p><strong>Sotto access</strong></p>
      <p>{state.membership.label}</p><p>Provider usage is separate from Sotto access. Free dictation remains available without an account.</p>
      {state.membership.expiresAt ? <p>Current access ends {new Date(state.membership.expiresAt).toLocaleString()}.</p> : null}
      {state.configuration.membershipEndpoint ? <div className="agent-actions">
        <Button variant="secondary" onClick={() => void command({ type: 'membership', action: 'signin' })}>Sign in to Sotto</Button>
        <Button variant="secondary" onClick={() => void command({ type: 'membership', action: state.membership.status === 'active' ? 'portal' : 'checkout' })}>{state.membership.status === 'active' ? 'Manage subscription' : 'Get Sotto Pro'}</Button>
        <Button variant="ghost" onClick={() => void command({ type: 'membership', action: 'refresh' })}>Refresh membership</Button>
      </div> : <p>Hosted sign-in and checkout are not available in this private development beta.</p>}
    </div>
  </section>
}

function AgentNewProject({ state, command }: { readonly state: AgentState; readonly command: Command }): ReactNode {
  const [title, setTitle] = useState('')
  const [path, setPath] = useState('')
  const [existing, setExisting] = useState(false)
  return <form className="agent-new-project" onSubmit={(event) => {
    event.preventDefault()
    void command({ type: 'create-project', title: title.trim(), ...(path.trim() ? { path: path.trim() } : {}), ...(existing ? { useExisting: true } : {}) })
  }}>
    <label>Project name<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Workshop" /></label>
    <label>Project folder<input value={path} onChange={(event) => setPath(event.target.value)} placeholder={state.configuration.projectsDirectory ? `Inside ${state.configuration.projectsDirectory}` : 'Choose a folder or set your projects directory'} /></label>
    <label className="agent-checkbox"><input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />Use this folder if it already exists</label>
    <Button type="submit" disabled={state.busy || !title.trim()}><FolderPlus size={14} aria-hidden="true" />Create project</Button>
  </form>
}

export function AgentView(): ReactNode {
  const agents = useAgents()
  const { state, command } = agents
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newProject, setNewProject] = useState(false)
  const [threadName, setThreadName] = useState('')
  const [modelOverride, setModelOverride] = useState('')
  if (state === null) return <div className="management-view agent-view"><h1>Agents</h1><p>{agents.error ?? 'Preparing agent controls…'}</p></div>
  const active = state.host.threads.find((thread) => thread.id === state.activeThreadId)
  const activeProject = state.host.projects.find((project) => project.id === (active?.projectId ?? state.activeProjectId))
  const assignment = state.assignments.find((entry) => entry.threadId === active?.id)
  const connected = state.connection === 'connected'
  const fullSupervision = supportsAgentSupervision(state.host.capabilities)
  const modelId = modelOverride || state.configuration.defaultModelId
  const voiceLabel = {
    off: window.sottoE2E === undefined ? 'Voice control is off' : 'Test mode · microphone disabled', starting: 'Preparing local voice', wake: 'Say “Hey Sotto”',
    listening: 'Listening · say “send it” to submit', speaking: 'Sotto is speaking',
    muted: 'Microphone muted', dictation: 'Dictation has the microphone', error: 'Voice needs attention',
  }[agents.voice.status]
  return <div className="management-view agent-view">
    <header className="agent-header"><div><span className="agent-eyebrow">Agent control center</span><h1>Agents</h1></div>
      <div className="agent-actions"><Button variant="ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} aria-hidden="true" />Connection settings</Button>
        <Button variant={connected ? 'secondary' : 'primary'} disabled={state.connection === 'connecting'} onClick={() => void command({ type: connected ? 'disconnect' : 'connect' })}>{connected ? 'Disconnect T3 Code' : state.connection === 'connecting' ? 'Connecting…' : 'Connect T3 Code'}</Button></div>
    </header>
    <div className="agent-statusline"><span className="agent-connection" data-connected={connected}><i />{connected ? 'T3 Code connected' : 'T3 Code disconnected'}{state.host.version ? ` · ${state.host.version}` : ''}</span>
      <span>{state.assignments.length} assigned · {state.queue.length} waiting</span>
      {connected ? <Button variant="ghost" iconOnly aria-label="Refresh T3 Code" onClick={() => void command({ type: 'refresh' })}><RefreshCw size={14} /></Button> : null}
    </div>
    {settingsOpen ? <AgentConnectionSettings state={state} command={command} /> : null}
    <section className="agent-voice" aria-label="Voice control"><div><Mic size={18} aria-hidden="true" /><div><strong>{voiceLabel}</strong><span>Wake detection and speech recognition stay on this desktop.</span></div></div>
      <div className="agent-actions">
        {state.configuration.enabled ? <><Button variant="ghost" iconOnly aria-label={agents.voice.status === 'muted' ? 'Unmute listening' : 'Mute listening'} onClick={agents.muteVoice}>{agents.voice.status === 'muted' ? <Mic size={16} /> : <MicOff size={16} />}</Button>
          <Button variant="ghost" iconOnly aria-label="Stop speech" onClick={agents.stopSpeech}><VolumeX size={16} /></Button>
          {agents.voice.status === 'error' ? (!state.configuration.wakeModelDirectory || !state.configuration.wakeRuntimeDirectory
            ? <Button variant="secondary" onClick={() => setSettingsOpen(true)}>Set up voice</Button>
            : <Button variant="secondary" onClick={agents.retryVoice}>Retry voice</Button>) : null}</> : null}
        <Button variant="secondary" onClick={() => void command({ type: 'configure', patch: { enabled: !state.configuration.enabled } })}>{state.configuration.enabled ? 'Turn off agent control' : 'Enable agent control'}</Button>
      </div>
    </section>
    {agents.voice.error ? <p className="agent-error" role="alert">{agents.voice.error}</p> : null}
    {state.error || agents.error ? <p className="agent-error" role="alert">{state.error ?? agents.error}</p> : null}
    {state.notice && state.notice !== state.error ? <p className="agent-notice" role="status">{state.notice}</p> : null}
    {state.pendingRequest ? <details className="agent-notice"><summary>Pending spoken request</summary><p>{state.pendingRequest}</p><Button variant="ghost" onClick={() => void command({ type: 'cancel-request' })}>Clear request</Button></details> : null}
    {connected && !fullSupervision ? <p className="agent-notice">This connection supports limited controls. Automatic management requires reliable questions, permissions, message origins, and recovery.</p> : null}
    <div className="agent-workspace">
      <aside className="agent-threads" aria-label="Projects and threads"><div className="agent-section-title"><h2>Projects</h2><Button variant="ghost" iconOnly aria-label="New project" disabled={!connected || !state.host.capabilities.projects} onClick={() => setNewProject(!newProject)}><Plus size={15} /></Button></div>
        {newProject ? <AgentNewProject state={state} command={command} /> : null}
        {state.host.projects.length === 0 ? <p className="agent-muted">Connect T3 to see your projects and threads.</p> : state.host.projects.map((project) => <div className="agent-project" key={project.id}>
          <button className="agent-project__title" type="button" aria-pressed={activeProject?.id === project.id} onClick={() => void command({ type: 'select-project', projectId: project.id })}><ChevronDown size={13} aria-hidden="true" />{project.title}</button>
          {state.host.threads.filter((thread) => thread.projectId === project.id).map((thread) => {
            const managed = state.assignments.find((entry) => entry.threadId === thread.id)
            return <div className="agent-thread" data-selected={state.activeThreadId === thread.id} key={thread.id}>
              <button type="button" aria-label={`Select ${thread.title}`} onClick={() => void command({ type: 'select-thread', threadId: thread.id })}>
                <i data-status={thread.status} /><span>{thread.title}<small>{managed?.mode === 'manual' ? 'Manual control' : managed?.paused ? 'Management paused' : managed ? 'Managed' : thread.status === 'running' ? 'Working' : 'Unassigned'}</small></span>
              </button>
              {managed === undefined ? <button type="button" className="agent-thread__manage" aria-label={`Manage ${thread.title}`} title={`Manage ${thread.title}`} disabled={!fullSupervision} onClick={() => void command({ type: 'assign', threadId: thread.id })}><Plus size={14} /></button> : null}
            </div>
          })}
        </div>)}
      </aside>
      <div className="agent-detail">
        <AgentQueue state={state} command={command} />
        <AgentManualNotice state={state} command={command} />
        {active === undefined ? <section className="agent-empty"><Workflow size={28} aria-hidden="true" /><h2>Your agents, one conversation away</h2><p>Select a thread or create one in the project below.</p></section> : <section className="agent-thread-heading"><div><span className="agent-eyebrow">{activeProject?.title}</span><h2>{active.title}</h2><p>{state.host.models.find((model) => model.id === active.modelId)?.name ?? active.modelId} · {active.status === 'running' ? 'Working in T3' : 'Ready for a prompt'}</p></div>
          <div className="agent-actions">{assignment === undefined ? <Button variant="secondary" disabled={!fullSupervision} onClick={() => void command({ type: 'assign', threadId: active.id })}>Manage this thread</Button> : <>
            <span>{assignment.followups}/{state.configuration.followupLimit} follow-ups</span>
            {assignment.mode === 'managed' ? <Button variant="ghost" onClick={() => void command({ type: assignment.paused ? 'resume' : 'pause', threadId: active.id })}>{assignment.paused ? 'Resume management' : 'Pause management'}</Button> : null}
            <Button variant="ghost" onClick={() => void command({ type: 'unassign', threadId: active.id })}>Stop managing</Button>
          </>}{active.status === 'running' && state.host.capabilities.interrupt ? <Button variant="secondary" onClick={() => void command({ type: 'interrupt', threadId: active.id })}>Stop agent</Button> : null}</div>
        </section>}
        <AgentComposer state={state} command={command} />
        {activeProject !== undefined ? <details className="agent-new-thread"><summary>Open a new thread in {activeProject.title}</summary><form onSubmit={(event) => {
          event.preventDefault()
          void command({ type: 'create-thread', projectId: activeProject.id, title: threadName.trim() || 'New thread', modelId })
        }}><label>Thread name<input value={threadName} onChange={(event) => setThreadName(event.target.value)} placeholder="New thread" /></label><label>Agent model<select value={modelId} onChange={(event) => setModelOverride(event.target.value)}><option value="">Choose an available model</option>{state.host.models.map((model) => <option key={model.id} value={model.id} disabled={!model.ready}>{model.name}</option>)}</select></label><Button type="submit" disabled={state.busy || !modelId || !connected || !state.host.capabilities.threads}><Plus size={14} aria-hidden="true" />Open thread</Button></form></details> : null}
      </div>
    </div>
  </div>
}

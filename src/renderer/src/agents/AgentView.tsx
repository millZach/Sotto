import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, FolderPlus, List, Mic, MicOff, Plus, RefreshCw, Settings2, VolumeX, Workflow } from 'lucide-react'

import { PROVIDER_LABELS, supportsAgentSupervision, isSubscriptionReasoning, type SubscriptionProvider, type AgentAttachment, type AgentConfiguration, type AgentProject, type AgentState, type AgentThread } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import './agents.css'
import { VoiceSettings } from './VoiceSettings'
import { ScreenshotInput } from './ScreenshotInput'

type Command = AgentConnection['command']

export function AgentManualNotice({ state, command }: { readonly state: AgentState; readonly command: Command }): ReactNode {
  const thread = state.host.threads.find((entry) => entry.id === state.activeThreadId)
  const assignment = state.assignments.find((entry) => entry.threadId === state.activeThreadId)
  if (thread === undefined || assignment?.mode !== 'manual') return null
  return <section className="agent-manual" aria-label={`Manual control for ${thread.title}`}>
    <strong>Manual control · {thread.title}</strong>
    <p>You’re replying directly in {PROVIDER_LABELS[state.configuration.provider]}. Sotto is still watching this thread, but won’t send replies. Say “resume managing {thread.title}” or select Resume management to hand it back.</p>
    <Button variant="secondary" onClick={() => void command({ type: 'resume', threadId: thread.id })}>Resume management</Button>
  </section>
}

export function AgentComposer({ state, command, compact = false, footerControls }: {
  readonly state: AgentState; readonly command: Command; readonly compact?: boolean; readonly footerControls?: ReactNode
}): ReactNode {
  const [draft, setDraft] = useState(state.draft)
  const [attachments, setAttachments] = useState<AgentAttachment[]>(state.draftAttachments ?? [])
  const [readingImages, setReadingImages] = useState(false)
  const writes = useRef(0)
  const version = useRef(0)
  const sourceKey = JSON.stringify([state.draft, state.draftThreadId, state.draftRequestId, (state.draftAttachments ?? []).map(image => image.id)])
  const lastSource = useRef(sourceKey)
  const target = state.host.threads.find((entry) => entry.id === (state.draftThreadId ?? state.activeThreadId))
  const project = state.host.projects.find((entry) => entry.id === target?.projectId)
  const questionId = state.draftRequestId ?? (!state.composing ? state.queue.find((entry) => entry.threadId === target?.id && entry.kind === 'question')?.requestId : undefined)
  const answering = questionId !== undefined && questionId !== null
  const assigned = state.assignments.some((entry) => entry.threadId === target?.id)
  const hasDraft = state.composing || state.draftThreadId !== null || draft.length > 0 || attachments.length > 0
  useEffect(() => {
    if (writes.current === 0 && lastSource.current !== sourceKey) {
      lastSource.current = sourceKey
      setDraft(state.draft); setAttachments(state.draftAttachments ?? [])
    }
  }, [sourceKey, state.draft, state.draftAttachments])
  const update = (value: string): void => {
    setDraft(value)
    ++writes.current
    const writeVersion = ++version.current
    void command({ type: 'compose', text: value }).then((result) => {
      --writes.current
      if (writeVersion === version.current && result !== null && result.error === null) { setDraft(result.draft); setAttachments(result.draftAttachments ?? []) }
    })
  }
  const updateImages = (value: AgentAttachment[]): void => {
    setAttachments(value)
    ++writes.current
    const writeVersion = ++version.current
    void command({ type: 'compose', text: draft, attachments: value }).then(result => {
      --writes.current
      if (writeVersion === version.current && result !== null && result.error === null) { setDraft(result.draft); setAttachments(result.draftAttachments ?? []) }
    })
  }
  const send = async (): Promise<void> => {
    if (readingImages) return
    const composed = await command({ type: 'compose', text: draft, attachments })
    if (composed === null || composed.error !== null) return
    const result = await command({ type: 'send' })
    if (result !== null && result.error === null) { setDraft(result.draft); setAttachments(result.draftAttachments ?? []) }
  }
  if ((target === undefined || !assigned) && !hasDraft) return null
  return <section className="agent-composer">
    <div className="agent-section-title"><label htmlFor={compact ? 'widget-agent-prompt' : 'agent-prompt'}>{answering ? 'Your answer' : 'Prompt'}</label>
      <span>{target === undefined ? 'Select a thread' : `${project?.title ?? 'Project'} / ${target.title}`}</span></div>
    {target !== undefined && target.id !== state.activeThreadId ? <div className="agent-draft-target"><span>This draft stays with {target.title}.</span><Button variant="ghost" onClick={() => void command({ type: 'select-thread', threadId: target.id })}>Return to draft thread</Button></div> : null}
    {!assigned ? <p className="agent-muted">This saved draft is paused. {target === undefined ? 'Its thread is unavailable.' : <Button variant="secondary" disabled={state.busy || state.connection !== 'connected' || !supportsAgentSupervision(state.host.capabilities)} onClick={() => void command({ type: 'assign', threadId: target.id })}>Manage draft thread</Button>}</p> : null}
    <ScreenshotInput key={target?.id ?? 'no-thread'} attachments={attachments} onChange={updateImages} onReadingChange={setReadingImages}
      disabled={state.busy || target === undefined || !assigned} supported={!answering && state.host.models.some(model => model.id === target?.modelId && model.supportsImages === true)}>
    <textarea id={compact ? 'widget-agent-prompt' : 'agent-prompt'} value={draft} onChange={(event) => update(event.target.value)}
      rows={compact ? 3 : 5} placeholder={target === undefined ? 'Select a thread to start a prompt.' : answering ? 'Dictate or type your answer. It stays saved until you send or clear it.' : 'Dictate or type your prompt. Pauses won’t send it.'}
      disabled={target === undefined || !assigned} spellCheck />
    </ScreenshotInput>
    <div className="agent-composer__footer">{footerControls ?? <span>Say “send it” when you’re ready.</span>}
      <div className="agent-actions">
        {hasDraft ? <Button variant="ghost" disabled={readingImages || state.busy} onClick={() => { void command({ type: 'cancel-draft' }).then((result) => { if (result !== null && result.error === null) { setDraft(result.draft); setAttachments(result.draftAttachments ?? []) } }) }}>Clear</Button> : null}
        <Button disabled={state.busy || readingImages || target === undefined || !assigned || (!draft.trim() && !attachments.length) || state.connection !== 'connected'} onClick={() => void send()}>
          Send it <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  </section>
}

export function AgentLatestResponse({ thread, compact = false }: { readonly thread: AgentThread | undefined; readonly compact?: boolean }): ReactNode {
  const latest = thread?.messages.filter((message) => message.role === 'assistant').at(-1)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { setExpanded(false) }, [latest?.id, thread?.id])
  if (latest === undefined || !latest.text.trim()) return null
  const limit = compact ? 320 : 700
  const shortened = latest.text.length > limit
  return <section className="agent-response" aria-label={`Latest response from ${thread?.title ?? 'thread'}`}>
    <div className="agent-section-title"><h2>Latest response</h2>{thread?.status === 'running' ? <span>Still working</span> : null}</div>
    <p className={expanded ? 'agent-response__text agent-response__text--expanded' : 'agent-response__text'}>{shortened && !expanded ? `${latest.text.slice(0, limit).trimEnd()}…` : latest.text}</p>
    {shortened ? <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read full response'}</Button> : null}
  </section>
}

function AgentReadyUpdate({ text, compact }: { readonly text: string; readonly compact: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const preview = text.replace(/\s+/gu, ' ').trim()
  const limit = compact ? 200 : 320
  const shortened = preview.length > limit
  return <>
    <p className={expanded ? 'agent-queue__update-full' : undefined}>{expanded ? text : shortened ? `${preview.slice(0, limit).trimEnd()}…` : preview}</p>
    {shortened ? <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less update' : 'Read full update'}</Button> : null}
  </>
}

export function AgentQueue({ state, command, compact = false, approvalLabel = 'Approve', onLater, onNext }: {
  readonly state: AgentState; readonly command: Command; readonly compact?: boolean; readonly approvalLabel?: string; readonly onLater?: () => void; readonly onNext?: () => void
}): ReactNode {
  const active = state.queue.find((entry) => entry.threadId === state.activeThreadId)
  const thread = state.host.threads.find((entry) => entry.id === active?.threadId)
  const request = thread?.requests.find((entry) => entry.id === active?.requestId)
  const reply = (value: string, approved?: boolean): void => {
    if (active?.requestId === undefined) return
    void command({ type: 'answer', threadId: active.threadId, requestId: active.requestId, answer: value,
      ...(approved === undefined ? {} : { approved }) })
  }
  return <section className="agent-queue" aria-label="Ready threads">
    <div className="agent-section-title"><h2>Needs your attention <span className="agent-count">{state.queue.length}</span></h2>
      <div className="agent-actions"><Button variant="ghost" disabled={state.queue.length === 0} onClick={() => { if (onLater) onLater(); else void command({ type: 'later' }) }}>Later</Button>
        <Button variant="secondary" disabled={state.queue.length === 0 || Boolean(onNext && state.busy)} onClick={() => { if (onNext) onNext(); else void command({ type: 'next' }) }}>Next <ArrowRight size={13} aria-hidden="true" /></Button></div>
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
        {active.kind === 'ready' ? <AgentReadyUpdate key={active.id} text={active.text} compact={compact} /> : <p>{active.text}</p>}
        {active.requestId === undefined ? null : request?.kind === 'permission' || active.kind === 'permission'
          ? <div className="agent-actions"><Button variant="secondary" onClick={() => reply('Denied', false)}>Deny</Button><Button onClick={() => reply('Approved', true)}>{approvalLabel}</Button></div>
          : request?.options.length ? <div className="agent-actions">{request.options.map((option) =>
            <Button key={option.id} variant="secondary" disabled={state.busy || state.connection !== 'connected'} onClick={() => reply(option.id)}>{option.label}</Button>)}</div> : null}
      </div>}
    </>}
  </section>
}

export function AgentConnectionSettings({ state, command, focusReasoning }: { readonly state: AgentState; readonly command: Command; readonly focusReasoning: boolean }): ReactNode {
  const [configuration, setConfiguration] = useState(state.configuration)
  const [reasoningKey, setReasoningKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [checking, setChecking] = useState(false)
  const subscription = isSubscriptionReasoning(configuration.reasoning)
  const api = configuration.reasoning === 'openrouter' || configuration.reasoning === 'openai'
  const account = state.reasoningAccounts.find(item => item.provider === configuration.reasoning)
  const defaultReasoningModel = account?.models.find(model => model.id === account.defaultModelId)
  const selectedReasoningModel = configuration.reasoningModel ? account?.models.find(model => model.id === configuration.reasoningModel) : defaultReasoningModel
  const reasoningEfforts = selectedReasoningModel?.reasoningEfforts ?? []
  const reasoningChanged = configuration.reasoning !== state.configuration.reasoning || configuration.reasoningModel !== state.configuration.reasoningModel || configuration.reasoningEffort !== state.configuration.reasoningEffort
  const providerInput = useRef<HTMLSelectElement>(null)
  useEffect(() => { if (focusReasoning) { providerInput.current?.focus(); providerInput.current?.scrollIntoView?.({ block: 'nearest' }) } }, [focusReasoning])
  const change = <K extends keyof AgentConfiguration>(key: K, value: AgentConfiguration[K]): void => {
    setConfiguration((current) => ({ ...current, [key]: value })); setSaved(false)
  }
  const checkSubscription = async (provider: SubscriptionProvider): Promise<void> => {
    setChecking(true)
    try { await command({ type: 'check-reasoning', provider }) } finally { setChecking(false) }
  }
  const chooseReasoning = (provider: AgentConfiguration['reasoning']): void => {
    setConfiguration(current => ({ ...current, reasoning: provider, reasoningModel: '', reasoningEffort: '' }))
    setReasoningKey(''); setSaved(false)
    if (isSubscriptionReasoning(provider)) void checkSubscription(provider)
  }
  const save = async (): Promise<void> => {
    const result = await command({ type: 'configure', patch: {
      projectsDirectory: configuration.projectsDirectory,
      defaultModelId: configuration.defaultModelId,
      followupLimit: configuration.followupLimit,
      speak: configuration.speak,
      speechProvider: configuration.speechProvider,
      speechVoice: configuration.speechVoice,
      grokSpeechVoice: configuration.grokSpeechVoice,
      wakeModelDirectory: configuration.wakeModelDirectory,
      wakeRuntimeDirectory: configuration.wakeRuntimeDirectory,
      reasoning: configuration.reasoning,
      reasoningModel: configuration.reasoningModel,
      reasoningEffort: configuration.reasoningEffort,
    } })
    if (result === null || result.error !== null) return
    if (api && reasoningKey.trim()) {
      const stored = await command({ type: 'credential', slot: 'reasoning', value: reasoningKey.trim() })
      if (stored === null || stored.error !== null) return
      setReasoningKey('')
    }
    setSaved(true)
  }
  return <section className="agent-settings" aria-label="Agent connection settings">
    <div className="agent-fields">
      <label className="agent-field-wide">Default projects directory<input value={configuration.projectsDirectory} onChange={(event) => change('projectsDirectory', event.target.value)} placeholder="D:\Projects" /></label>
      <label>Default agent model<select value={configuration.defaultModelId} onChange={(event) => change('defaultModelId', event.target.value)}>
        <option value="">Choose a model after connecting</option>
        {state.host.models.map((model) => <option key={model.id} value={model.id} disabled={!model.ready}>{model.name}{!model.ready ? ' · unavailable' : ''}</option>)}
      </select></label>
      <label>Automatic follow-up limit<input type="number" min={0} max={100} value={configuration.followupLimit} onChange={(event) => change('followupLimit', Math.min(100, Math.max(0, Number(event.target.value))))} /></label>
      <label>Sotto reasoning<select ref={providerInput} value={configuration.reasoning} disabled={checking} onChange={(event) => chooseReasoning(event.target.value as AgentConfiguration['reasoning'])}>
        <option value="none">Not configured</option>
        <optgroup label="Your subscriptions">
          <option value="codex">ChatGPT subscription · Codex</option>
          <option value="claude">Claude subscription · Claude Code</option>
          <option value="grok">Grok subscription · Grok Build</option>
        </optgroup>
        <optgroup label="API accounts"><option value="openrouter">OpenRouter API</option><option value="openai">OpenAI API</option></optgroup>
      </select></label>
      <label>Reasoning model{subscription ? <select value={configuration.reasoningModel} onChange={event => { setConfiguration(current => ({ ...current, reasoningModel: event.target.value, reasoningEffort: '' })); setSaved(false) }} disabled={checking || !account?.ready}>
        <option value="">{defaultReasoningModel && defaultReasoningModel.id !== 'default' ? `Default (${defaultReasoningModel.name})` : 'Provider default'}</option>
        {configuration.reasoningModel && !account?.models.some(model => model.id === configuration.reasoningModel) ? <option value={configuration.reasoningModel}>{configuration.reasoningModel}</option> : null}
        {account?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select> : <input value={configuration.reasoningModel} onChange={(event) => change('reasoningModel', event.target.value)} placeholder="Provider model ID" disabled={configuration.reasoning === 'none'} />}</label>
      {subscription ? <label>Reasoning effort<select aria-label="Reasoning effort" value={configuration.reasoningEffort} onChange={event => change('reasoningEffort', event.target.value)} disabled={checking || !account?.ready || (reasoningEfforts.length === 0 && !configuration.reasoningEffort)}>
        <option value="">{selectedReasoningModel?.defaultReasoningEffort ? `Default (${selectedReasoningModel.defaultReasoningEffort})` : 'Provider default'}</option>
        {configuration.reasoningEffort && !reasoningEfforts.includes(configuration.reasoningEffort) ? <option value={configuration.reasoningEffort}>{configuration.reasoningEffort} · unavailable</option> : null}
        {reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
      </select>{account?.ready && reasoningEfforts.length === 0 ? <span>{selectedReasoningModel ? 'This model does not offer a reasoning level in its provider app.' : 'Select a model to see its available reasoning levels.'}</span> : null}</label> : null}
      {subscription ? <div className="agent-field-wide agent-subscription-status" role="status">
        <div><strong>{checking ? 'Checking your subscription…' : account?.ready ? `${account.label} connected` : 'Subscription connection'}</strong>
          <p>{checking ? 'Checking the account in your installed provider app.' : account?.detail ?? 'Check the subscription signed into your provider app. No API key is needed.'}</p></div>
        <Button variant="secondary" disabled={checking || state.busy} onClick={() => { if (isSubscriptionReasoning(configuration.reasoning)) void checkSubscription(configuration.reasoning) }}>Check connection</Button>
      </div> : null}
      {api ? <label className="agent-field-wide">Reasoning API key<input type="password" autoComplete="off" value={reasoningKey} onChange={(event) => { setReasoningKey(event.target.value); setSaved(false) }} placeholder={state.credentials.reasoning && configuration.reasoning === state.configuration.reasoning ? 'Saved securely · enter to replace' : 'Your provider API key'} /></label> : null}
      <p className="agent-field-wide agent-muted">Sotto uses this connection to understand voice commands and decide routine follow-ups. Subscription usage follows your provider’s allowance and any extra usage you enabled there. Sotto never switches accounts or enables paid overages for you.</p>
      <VoiceSettings configuration={configuration} command={command} change={change} grokKeySaved={state.credentials.grokSpeech} voiceError={state.voice.error} />
      <label className="agent-field-wide">Local wake model folder<input value={configuration.wakeModelDirectory} onChange={(event) => change('wakeModelDirectory', event.target.value)} placeholder="Absolute path to your local wake model" />
        <span>Wake setup is required before using “Hey Sotto.” This build supports a separately supplied Sherpa phonetic model. Its distribution license is unresolved, so Sotto does not include or download the weights. Text agent controls remain available.</span>
      </label>
      <label className="agent-field-wide">Local wake runtime folder<input value={configuration.wakeRuntimeDirectory} onChange={(event) => change('wakeRuntimeDirectory', event.target.value)} placeholder="Absolute path to your existing sherpa-onnx 1.13.7 runtime" />
        <span>The packaged app also requires a separately supplied runtime. Only verified original files are accepted. Runtime redistribution review is still required.</span>
      </label>
    </div>
    <div className="agent-billing"><p><strong>Your connected accounts</strong></p>
      <p>Project agents use the account signed into the selected thread provider. Sotto reasoning uses the subscription or API account selected above. Your provider app keeps its own sign-in. Local spoken replies have no provider usage charge.</p>
      {!state.credentials.secure ? <p role="alert">Secure credential storage is unavailable. Credentials cannot be saved on this system.</p> : null}
      <p>Assignment context expires after seven days without activity. Turning off history prevents saving that context. Unsent drafts stay on this desktop until sent or cleared so they survive a restart.</p>
    </div>
    <div className="agent-actions"><Button onClick={() => void save()} disabled={state.busy || checking || (reasoningChanged && subscription && !account?.ready)}>Save connection settings</Button>{saved ? <span role="status">Settings saved</span> : null}</div>
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

export function AgentNewProject({ state, command, onCreated }: { readonly state: AgentState; readonly command: Command; readonly onCreated: () => void }): ReactNode {
  const [title, setTitle] = useState('')
  const [path, setPath] = useState('')
  const [existing, setExisting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const create = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await command({ type: 'create-project', title: title.trim(), ...(path.trim() ? { path: path.trim() } : {}), ...(existing ? { useExisting: true } : {}) })
      if (result !== null && result.error === null) { setTitle(''); setPath(''); setExisting(false); onCreated() }
    } finally { setSubmitting(false) }
  }
  return <form className="agent-new-project" onSubmit={(event) => {
    event.preventDefault()
    void create()
  }}>
    <label>Project name<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Workshop" /></label>
    <label>Project folder<input value={path} onChange={(event) => setPath(event.target.value)} placeholder={state.configuration.projectsDirectory ? `Inside ${state.configuration.projectsDirectory}` : 'Choose a folder or set your projects directory'} /></label>
    <label className="agent-checkbox"><input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />Use this folder if it already exists</label>
    <Button type="submit" disabled={state.busy || submitting || !title.trim()}><FolderPlus size={14} aria-hidden="true" />Create project</Button>
  </form>
}

export function AgentNewThread({ state, command, project, onCreated }: { readonly state: AgentState; readonly command: Command; readonly project: AgentProject; readonly onCreated?: () => void }): ReactNode {
  const [threadName, setThreadName] = useState('')
  const [modelOverride, setModelOverride] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)
  const modelId = modelOverride || state.configuration.defaultModelId
  const create = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await command({ type: 'create-thread', projectId: project.id, title: threadName.trim() || 'New thread', modelId })
      if (result !== null && result.error === null) {
        setThreadName(''); setModelOverride('')
        if (details.current !== null) details.current.open = false
        onCreated?.()
      }
    } finally { setSubmitting(false) }
  }
  return <details ref={details} className="agent-new-thread" open={onCreated === undefined ? undefined : true}><summary>Open a new thread in {project.title}</summary><form onSubmit={(event) => { event.preventDefault(); void create() }}>
    <label>Thread name<input value={threadName} onChange={(event) => setThreadName(event.target.value)} placeholder="New thread" /></label>
    <label>Agent model<select aria-label="Agent model" value={modelId} onChange={(event) => setModelOverride(event.target.value)}><option value="">Choose an available model</option>{state.host.models.map((model) => <option key={model.id} value={model.id} disabled={!model.ready}>{model.name}</option>)}</select></label>
    <Button type="submit" disabled={state.busy || submitting || !modelId || state.connection !== 'connected' || !state.host.capabilities.threads}><Plus size={14} aria-hidden="true" />Open thread</Button>
  </form></details>
}

export function AgentView({ onOpenThreads }: { /** Opens the Threads page, the room's list of every thread. */ readonly onOpenThreads: () => void }): ReactNode {
  const agents = useAgents()
  const { state, command } = agents
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusReasoning, setFocusReasoning] = useState(false)
  const [newProject, setNewProject] = useState(false)
  const [search, setSearch] = useState('')
  if (state === null) return <div className="management-view agent-view"><h1>Agents</h1><p>{agents.error ?? 'Preparing agent controls…'}</p></div>
  const active = state.host.threads.find((thread) => thread.id === state.activeThreadId)
  const activeProject = state.host.projects.find((project) => project.id === (active?.projectId ?? state.activeProjectId))
  const assignment = state.assignments.find((entry) => entry.threadId === active?.id)
  const connected = state.connection === 'connected'
  const fullSupervision = supportsAgentSupervision(state.host.capabilities)
  const query = search.trim().toLocaleLowerCase()
  const visibleProjects = state.host.projects.map((project) => {
    const matchesProject = `${project.title} ${project.path}`.toLocaleLowerCase().includes(query)
    const threads = state.host.threads.filter((thread) => thread.projectId === project.id && (matchesProject || thread.title.toLocaleLowerCase().includes(query)))
    return { project, threads, matches: matchesProject || threads.length > 0 }
  }).filter((entry) => entry.matches)
  const reasoningReady = isSubscriptionReasoning(state.configuration.reasoning)
    ? state.reasoningAccounts.some(account => account.provider === state.configuration.reasoning && account.ready)
    : state.configuration.reasoning !== 'none' && Boolean(state.configuration.reasoningModel.trim()) && state.credentials.reasoning
  const voiceLabel = {
    off: window.sottoE2E === undefined ? 'Voice control is off' : 'Test mode · microphone disabled', starting: 'Preparing local voice', wake: 'Say “Hey Sotto”',
    listening: 'Listening · say “send it” to submit', speaking: 'Sotto is speaking',
    muted: 'Microphone muted', dictation: 'Dictation has the microphone', error: 'Voice needs attention',
  }[agents.voice.status]
  return <div className="management-view agent-view">
    <header className="agent-header"><div><span className="agent-eyebrow">Agent control center</span><h1>Agents</h1></div>
      <div className="agent-actions"><Button variant="ghost" onClick={onOpenThreads}><List size={15} aria-hidden="true" />All threads</Button>
        <Button variant="ghost" aria-expanded={settingsOpen} onClick={() => { setFocusReasoning(false); setSettingsOpen(!settingsOpen) }}><Settings2 size={15} aria-hidden="true" />Connection settings</Button>
        <Button variant={connected ? 'secondary' : 'primary'} disabled={state.connection === 'connecting'} onClick={() => void command({ type: connected ? 'disconnect' : 'connect' })}>{connected ? `Disconnect ${PROVIDER_LABELS[state.configuration.provider]}` : state.connection === 'connecting' ? 'Connecting…' : `Connect ${PROVIDER_LABELS[state.configuration.provider]}`}</Button></div>
    </header>
    <div className="agent-statusline"><span className="agent-connection" data-connected={connected}><i />{`${PROVIDER_LABELS[state.configuration.provider]} ${connected ? 'connected' : 'disconnected'}`}{state.host.version ? ` · ${state.host.version}` : ''}</span>
      <span>{state.assignments.length} assigned · {state.queue.length} waiting</span>
      {connected ? <Button variant="ghost" iconOnly aria-label={`Refresh ${PROVIDER_LABELS[state.configuration.provider]}`} onClick={() => void command({ type: 'refresh' })}><RefreshCw size={14} /></Button> : null}
    </div>
    {settingsOpen ? <AgentConnectionSettings state={state} command={command} focusReasoning={focusReasoning} /> : null}
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
    {!reasoningReady ? <section className="agent-reasoning-setup" aria-label="Reasoning setup"><div><strong>Connect reasoning for voice app commands</strong><p>Creating projects and threads by voice and automatic follow-ups need a connected subscription or API account. You can still use manual controls and dictate prompts.</p></div><Button variant="secondary" onClick={() => { setFocusReasoning(true); setSettingsOpen(true) }}>Set up reasoning</Button></section> : null}
    {agents.voice.error ? <p className="agent-error" role="alert">{agents.voice.error}</p> : null}
    {state.error || agents.error ? <p className="agent-error" role="alert">{state.error ?? agents.error}</p> : null}
    {state.notice && state.notice !== state.error ? <p className="agent-notice" role="status">{state.notice}</p> : null}
    {state.pendingRequest ? <details className="agent-notice"><summary>Pending spoken request</summary><p>{state.pendingRequest}</p><Button variant="ghost" onClick={() => void command({ type: 'cancel-request' })}>Clear request</Button></details> : null}
    {connected && !fullSupervision ? <p className="agent-notice">This connection supports limited controls. Automatic management requires reliable questions, permissions, message origins, and recovery.</p> : null}
    <div className="agent-workspace">
      <aside className="agent-threads" aria-label="Projects and threads"><div className="agent-section-title"><h2>Projects</h2><Button variant="ghost" iconOnly aria-label="New project" disabled={!connected || !state.host.capabilities.projects} onClick={() => setNewProject(!newProject)}><Plus size={15} /></Button></div>
        {newProject ? <AgentNewProject state={state} command={command} onCreated={() => setNewProject(false)} /> : null}
        <label className="tt-visually-hidden" htmlFor="agent-thread-search">Search projects and threads</label>
        <input id="agent-thread-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects and threads" />
        <div className="agent-project-list">
        {state.host.projects.length === 0 ? <p className="agent-muted">Connect your provider to see your projects and threads.</p> : visibleProjects.length === 0 ? <p className="agent-muted">No matching projects or threads.</p> : visibleProjects.map(({ project, threads }) => <div className="agent-project" key={project.id}>
          <button className="agent-project__title" type="button" aria-pressed={activeProject?.id === project.id} onClick={() => void command({ type: 'select-project', projectId: project.id })}><ChevronDown size={13} aria-hidden="true" />{project.title}</button>
          {threads.map((thread) => {
            const managed = state.assignments.find((entry) => entry.threadId === thread.id)
            return <div className="agent-thread" data-selected={state.activeThreadId === thread.id} key={thread.id}>
              <button type="button" aria-label={`Select ${thread.title}`} onClick={() => void command({ type: 'select-thread', threadId: thread.id })}>
                <i data-status={thread.status} /><span>{thread.title}<small>{managed?.mode === 'manual' ? 'Manual control' : managed?.paused ? 'Management paused' : managed ? 'Managed' : thread.status === 'running' ? 'Working' : 'Unassigned'}</small></span>
              </button>
              {managed === undefined ? <button type="button" className="agent-thread__manage" aria-label={`Manage ${thread.title}`} title={`Manage ${thread.title}`} disabled={state.busy || !connected || !fullSupervision} onClick={() => void command({ type: 'assign', threadId: thread.id })}><Plus size={14} /></button> : null}
            </div>
          })}
        </div>)}
        </div>
      </aside>
      <div className="agent-detail">
        {activeProject !== undefined ? <AgentNewThread state={state} command={command} project={activeProject} /> : null}
        <AgentQueue state={state} command={command} />
        <AgentManualNotice state={state} command={command} />
        {active === undefined ? <section className="agent-empty"><Workflow size={28} aria-hidden="true" /><h2>Your agents, one conversation away</h2><p>Select a thread or open one in your selected project.</p></section> : <section className="agent-thread-heading"><div><span className="agent-eyebrow">{activeProject?.title}</span><h2>{active.title}</h2><p>{state.host.models.find((model) => model.id === active.modelId)?.name ?? active.modelId} · {active.status === 'running' ? 'Working' : assignment === undefined ? 'Unassigned · manage this thread to send prompts' : 'Ready for a prompt'}</p></div>
          <div className="agent-actions">{assignment === undefined ? <Button variant="secondary" disabled={state.busy || !connected || !fullSupervision} onClick={() => void command({ type: 'assign', threadId: active.id })}>Manage this thread</Button> : <>
            <span>{assignment.followups}/{state.configuration.followupLimit} follow-ups</span>
            {assignment.mode === 'managed' ? <Button variant="ghost" onClick={() => void command({ type: assignment.paused ? 'resume' : 'pause', threadId: active.id })}>{assignment.paused ? 'Resume management' : 'Pause management'}</Button> : null}
            <Button variant="ghost" onClick={() => void command({ type: 'unassign', threadId: active.id })}>Stop managing</Button>
          </>}{assignment !== undefined && active.status === 'running' && state.host.capabilities.interrupt ? <Button variant="secondary" disabled={state.busy || !connected} onClick={() => void command({ type: 'interrupt', threadId: active.id })}>Stop agent</Button> : null}</div>
        </section>}
        <AgentLatestResponse thread={active} />
        <AgentComposer state={state} command={command} />
      </div>
    </div>
  </div>
}

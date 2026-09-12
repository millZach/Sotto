import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, Folder, Image, MessageSquare, Search, X } from 'lucide-react'
import { MAX_DELIVERED_DRAFTS, PROVIDER_LABELS, supportsAgentSupervision, type AgentAttachment, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { AgentComposer } from './AgentView'
import { clockLabel, describeThreads, groupThreads, listThreads, type ThreadRow } from './threadFacts'
import { NewThreadDialog } from './NewThreadDialog'
import { ThreadOptions } from './ThreadOptions'
import { ScreenshotInput } from './ScreenshotInput'

type Command = AgentConnection['command']
export interface ThreadsViewProps {
  readonly onOpenAgents: () => void
  readonly now?: number | undefined
}
function useClock(fixed: number | undefined): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined) return
    const timer = setInterval(() => setTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [fixed])
  return fixed ?? tick
}

/** The inline request: Allow and Deny answer it; nothing else on the page ever does. */
function ThreadRequest({ row, command, busy, onAnswer, voiceAvailable }: {
  readonly row: ThreadRow; readonly command: Command; readonly busy: boolean; readonly onAnswer: () => void; readonly voiceAvailable: boolean
}): ReactNode {
  const request = row.request
  if (request?.requestId === undefined) return null
  const [title, ...detail] = request.text.split('\n')
  const answer = (value: string, approved: boolean): void => {
    void command({ type: 'answer', threadId: row.thread.id, requestId: request.requestId!, answer: value, approved })
  }
  const permission = request.kind === 'permission'
  return <div className="thread-row__ask" data-kind={request.kind} aria-label={permission ? `Permission request for ${row.thread.title}` : `Question from ${row.thread.title}`}>
    <div className="thread-row__ask-text">
      <strong>{permission ? (title || 'Permission request') : 'Question'}</strong>
      {permission
        ? detail.length > 0 ? <code>{detail.join('\n').trim()}</code> : null
        : <p>{request.text}</p>}
    </div>
    <div className="thread-row__ask-actions">
      {permission
        ? <><Button variant="secondary" disabled={busy} onClick={() => answer('Denied', false)}>Deny</Button>
          <Button disabled={busy} onClick={() => answer('Approved', true)}>Allow</Button></>
        : <Button variant="secondary" onClick={onAnswer}>Write an answer</Button>}
    </div>
    {voiceAvailable ? <span className="thread-row__say">{permission ? 'Say “allow” or “deny”, or choose here.' : 'Say your answer, then “send it”, or write it below.'}</span> : null}
  </div>
}

function ThreadPrompt({ row, state, command }: { readonly row: ThreadRow; readonly state: AgentState; readonly command: Command }): ReactNode {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Record<string, AgentAttachment[]>>({})
  const [readingImages, setReadingImages] = useState(false)
  const revisions = useRef<Record<string, string>>({})
  const submitted = useRef(new Map<string, string>())
  const receiveDeliveries = useCallback((receipts: AgentState['deliveredDrafts']): void => {
    for (const receipt of receipts ?? []) {
      if (submitted.current.get(receipt.draftId) !== receipt.threadId) continue
      submitted.current.delete(receipt.draftId)
      if (revisions.current[receipt.threadId] !== receipt.draftId) continue
      delete revisions.current[receipt.threadId]
      setDrafts(previous => ({ ...previous, [receipt.threadId]: '' }))
      setImages(previous => ({ ...previous, [receipt.threadId]: [] }))
    }
  }, [])
  useEffect(() => { receiveDeliveries(state.deliveredDrafts) }, [state.deliveredDrafts, receiveDeliveries])
  const attachments = images[row.thread.id] ?? (state.draftThreadId === row.thread.id ? state.draftAttachments ?? [] : [])
  const text = drafts[row.thread.id] ?? (state.draftThreadId === row.thread.id ? state.draft : '')
  const question = row.request?.kind === 'question' ? row.request : undefined
  const permission = row.request?.kind === 'permission'
  const archived = Boolean(row.thread.archivedAt)
  const disabled = sending || state.busy || state.connection !== 'connected' || !state.host.capabilities.submit || archived || permission
  const sendDisabled = disabled || (row.thread.status === 'running' && !question)
  const send = async (): Promise<void> => {
    if (sendDisabled || readingImages || (!text.trim() && !attachments.length)) return
    const threadId = row.thread.id
    const draftId = revisions.current[threadId] ?? crypto.randomUUID()
    revisions.current[threadId] = draftId
    if (!question?.requestId) {
      submitted.current.set(draftId, threadId)
      while (submitted.current.size > MAX_DELIVERED_DRAFTS) submitted.current.delete(submitted.current.keys().next().value!)
    }
    setSending(true)
    try {
      if (row.assignment?.mode === 'managed' && isThreadClosed(row.thread)) {
        const released = await command({ type: 'unassign', threadId })
        if (released === null || released.error !== null) return
      }
      const result = await command(question?.requestId
        ? { type: 'answer', threadId, requestId: question.requestId, answer: text }
        : { type: 'manual-send', threadId, draftId, text, ...(attachments.length ? { attachments } : {}) })
      if (result !== null) receiveDeliveries(result.deliveredDrafts)
      if (result !== null && result.error === null) {
        const confirmedThread = result.host.threads.find(thread => thread.id === threadId)
        const answered = question?.requestId && confirmedThread !== undefined && !confirmedThread.requests.some(request => request.id === question.requestId)
        if (answered && revisions.current[threadId] === draftId) {
          delete revisions.current[threadId]
          setDrafts(previous => ({ ...previous, [threadId]: '' }))
          setImages(previous => ({ ...previous, [threadId]: [] }))
        }
      }
    } finally { setSending(false) }
  }
  return <form className="thread-prompt" onSubmit={event => { event.preventDefault(); void send() }}>
    <label className="tt-visually-hidden" htmlFor="thread-workspace-prompt">{question ? 'Your answer' : 'Prompt'}</label>
    <ScreenshotInput key={row.thread.id} attachments={attachments} disabled={disabled} supported={row.model?.supportsImages === true && !question && !permission}
      onReadingChange={setReadingImages} onChange={value => { revisions.current[row.thread.id] = crypto.randomUUID(); setImages(previous => ({ ...previous, [row.thread.id]: value })) }}>
    <textarea id="thread-workspace-prompt" rows={3} value={text} disabled={disabled}
      placeholder={archived ? 'This thread is archived.' : permission ? 'Allow or deny the request above to continue.' : question ? 'Write your answer...' : 'What would you like to do next?'}
      onChange={event => { const value = event.target.value; revisions.current[row.thread.id] = crypto.randomUUID(); setDrafts(previous => ({ ...previous, [row.thread.id]: value })) }}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void send() } }} />
    </ScreenshotInput>
    <div className="thread-prompt__footer">{state.host.capabilities.configureThread ? <ThreadOptions key={row.thread.id} thread={row.thread} state={state} command={command} /> : <span>{row.model?.name ?? row.provider}<small>{question ? 'Answer this question' : 'Manual prompt'}</small></span>}
      <Button iconOnly aria-label={question ? 'Send answer' : 'Send prompt'} disabled={sendDisabled || readingImages || (!text.trim() && !attachments.length)} type="submit"><ArrowUp size={18} /></Button>
    </div>
  </form>
}

export function ThreadsView({ onOpenAgents, now: fixedNow }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const now = useClock(fixedNow)
  const [query, setQuery] = useState('')
  const [settledOpen, setSettledOpen] = useState(false)
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  const [messageLimit, setMessageLimit] = useState(80)
  const onNewThread = (): void => setNewThreadOpen(true)
  const transcript = useRef<HTMLDivElement>(null)
  const state = agents.state
  const rows = useMemo(() => state === null ? [] : describeThreads(state, now), [state, now])
  const { matching, listed } = useMemo(() => listThreads(rows, query), [rows, query])
  const groups = useMemo(() => groupThreads(listed, now), [listed, now])
  const unsettled = groups.find(group => group.id === 'unsettled')?.rows ?? []
  const settled = groups.find(group => group.id === 'settled')?.rows ?? []
  const selected = rows.find(row => row.thread.id === state?.activeThreadId)
  const lastMessageId = selected?.thread.messages.at(-1)?.id
  useEffect(() => { setMessageLimit(80) }, [selected?.thread.id])
  useEffect(() => { transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight }) }, [selected?.thread.id, lastMessageId])
  if (state === null) return <div className="threads-view"><p role="status">{agents.error ?? 'Preparing agent controls...'}</p></div>
  const openThread = async (threadId: string): Promise<void> => {
    await agents.command({ type: 'select-thread', threadId })
  }
  const sidebarRow = (row: ThreadRow): ReactNode => <button key={row.thread.id} type="button" className="thread-nav__item tt-focusable"
    aria-label={row.thread.title} aria-current={selected?.thread.id === row.thread.id ? 'page' : undefined}
    onClick={() => void openThread(row.thread.id)}>
    <span className="thread-nav__project"><Folder size={13} /><span>{row.project?.title ?? row.provider}</span><time title={Number.isFinite(row.activityAt) ? new Date(row.activityAt).toLocaleString() : 'Last activity unavailable'} dateTime={Number.isFinite(row.activityAt) ? new Date(row.activityAt).toISOString() : undefined}>{row.when}</time></span>
    <span className="thread-nav__title">{row.thread.title}</span>
    <span className="thread-nav__status" data-state={row.state}><i />{row.stateLabel}</span>
  </button>
  const foreignDraft = (state.draft.trim() || state.draftAttachments?.length) && state.draftThreadId && state.draftThreadId !== selected?.thread.id ? state.host.threads.find(thread => thread.id === state.draftThreadId) : undefined
  const connected = state.connection === 'connected'
  const pending = selected?.thread.requests[0]
  const workspaceRow = selected && !isThreadClosed(selected.thread) && pending && !selected.request ? { ...selected, request: {
    id: `${selected.thread.id}:${pending.id}`, threadId: selected.thread.id, requestId: pending.id,
    kind: pending.kind, text: pending.text, createdAt: '', deferred: false,
  } } : selected
  const assigned = selected?.assignment
  const managed = assigned?.mode === 'managed' && selected !== undefined && !isThreadClosed(selected.thread)
  const canManage = connected && !state.busy && supportsAgentSupervision(state.host.capabilities) && selected !== undefined && !isThreadClosed(selected.thread)
  return <div className="management-view threads-view">
    {newThreadOpen && <NewThreadDialog state={state} command={agents.command} onClose={() => setNewThreadOpen(false)} onCreated={() => { setNewThreadOpen(false); window.setTimeout(() => document.getElementById('thread-workspace-prompt')?.focus(), 0) }} />}
    <aside className="thread-nav" aria-label="Thread sidebar">
      <header className="thread-nav__head"><h1>Threads</h1><Button variant="ghost" iconOnly aria-label="New thread" onClick={onNewThread}><MessageSquare size={18} /></Button></header>
      <label className="threads-search"><span className="tt-visually-hidden">Search threads</span><Search size={15} aria-hidden="true" />
        <input className="tt-input tt-focusable" type="search" value={query} placeholder="Search threads" onChange={event => setQuery(event.currentTarget.value)} />
        {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><X size={14} /></button> : null}
      </label>
      <div className="thread-nav__scroll">
        <section aria-label="Unsettled"><h2 className="thread-nav__label">Unsettled <span>{unsettled.length}</span></h2>{unsettled.map(sidebarRow)}{!unsettled.length ? <p className="thread-nav__empty">{query ? 'No matching open threads.' : 'All caught up.'}</p> : null}</section>
        <section aria-label="Settled"><button className="thread-nav__settled tt-focusable" type="button" aria-expanded={settledOpen || Boolean(query)} onClick={() => setSettledOpen(!settledOpen)}><span>Settled <small>{settled.length}</small></span><ChevronDown size={14} /></button>
          {settledOpen || query ? <div>{settled.map(sidebarRow)}{!settled.length ? <p className="thread-nav__empty">No settled threads.</p> : null}</div> : null}
        </section>
        {query && !matching.length ? <p className="thread-nav__empty">Nothing matches "{query}".</p> : null}
      </div>
    </aside>
    <section className="thread-workspace" aria-label="Thread workspace">
      {selected ? <>
        <header className="thread-workspace__head"><div><span>{selected.project?.title ?? selected.provider}</span><h2>{selected.thread.title}</h2></div><div className="thread-workspace__actions">
          {assigned && !isThreadClosed(selected.thread) ? <Button variant="ghost" disabled={!canManage} onClick={() => void agents.command({ type: assigned.paused || assigned.mode === 'manual' ? 'resume' : 'pause', threadId: selected.thread.id })}>{assigned.paused || assigned.mode === 'manual' ? 'Resume managing' : 'Pause managing'}</Button>
            : !assigned && !isThreadClosed(selected.thread) ? <Button variant="ghost" disabled={!canManage} onClick={() => void agents.command({ type: 'assign', threadId: selected.thread.id })}>Manage</Button> : null}
          {assigned ? <Button variant="ghost" disabled={state.busy || !connected} onClick={() => void agents.command({ type: 'unassign', threadId: selected.thread.id })}>Stop managing</Button> : null}
          {selected.thread.status === 'running' && !isThreadClosed(selected.thread) ? <Button variant="secondary" disabled={state.busy || !connected || !state.host.capabilities.interrupt} onClick={() => void agents.command({ type: 'interrupt', threadId: selected.thread.id })}>Stop agent</Button> : null}
        </div></header>
        {state.error || agents.error ? <p className="agent-error thread-workspace__error" role="alert">{state.error ?? agents.error}</p> : null}
        <div className="thread-workspace__transcript" ref={transcript} aria-label="Thread transcript" aria-busy={selected.thread.historyStatus === 'loading'}>
          {selected.thread.historyStatus === 'loading' && <div className="thread-history-status" role="status">Loading messages...</div>}
          {selected.thread.historyStatus === 'error' && <div className="thread-history-status" role="alert"><span>{selected.thread.historyError || 'Could not load this thread’s messages.'}</span><Button variant="ghost" disabled={state.busy || !connected} onClick={() => void agents.command({ type: 'refresh' })}>Retry loading messages</Button></div>}
          {selected.thread.messages.length > messageLimit && <Button variant="ghost" onClick={() => setMessageLimit(limit => limit + 80)}>Show earlier messages ({selected.thread.messages.length - messageLimit})</Button>}
          {selected.thread.messages.length ? selected.thread.messages.slice(-messageLimit).map(message => <article className="thread-message" key={message.id} data-role={message.role}>
            <header>{message.role === 'user' ? 'You' : message.role === 'assistant' ? selected.provider : 'System'}<time>{clockLabel(Date.parse(message.createdAt))}</time></header><p>{message.text}</p>
            {!!message.attachments?.length && <div className="thread-message__attachments" aria-label="Message screenshots">{message.attachments.map(attachment => <span key={attachment.id}><Image size={14} />{attachment.name}</span>)}</div>}
          </article>) : selected.thread.historyStatus === 'loading' ? <div className="thread-history-skeleton" aria-hidden="true"><i /><i /><i /></div> : selected.thread.historyStatus === 'error' ? null : <div className="thread-workspace__empty"><MessageSquare size={26} strokeWidth={1.3} /><h3>{selected.thread.status === 'running' ? 'The agent is working.' : 'What is next for this thread?'}</h3><p>{selected.thread.status === 'running' ? 'New messages will appear here.' : 'Write a prompt below to continue.'}</p></div>}
          <ThreadRequest row={workspaceRow!} voiceAvailable={state.queue.some(item => item.threadId === selected.thread.id && item.requestId === workspaceRow?.request?.requestId)} command={agents.command} busy={state.busy || !connected} onAnswer={() => document.getElementById(managed ? 'agent-prompt' : 'thread-workspace-prompt')?.focus()} />
        </div>
        <div className="thread-workspace__compose">
          {foreignDraft && managed ? <div className="thread-draft-notice"><p>Your saved draft belongs to <strong>{foreignDraft.title}</strong>.</p><Button variant="secondary" onClick={() => void openThread(foreignDraft.id)}>Open draft thread</Button><ThreadOptions key={selected.thread.id} thread={selected.thread} state={state} command={agents.command} /></div> : managed ? <AgentComposer state={state} command={agents.command} footerControls={state.host.capabilities.configureThread ? <ThreadOptions key={selected.thread.id} thread={selected.thread} state={state} command={agents.command} /> : undefined} /> : <ThreadPrompt row={workspaceRow!} state={state} command={agents.command} />}
        </div>
      </> : <div className="thread-workspace__empty"><MessageSquare size={30} strokeWidth={1.3} /><h2>{state.draft ? 'Your draft is saved.' : rows.length ? 'Choose a thread.' : 'No threads yet.'}</h2><p>{state.draft ? 'Reconnect to continue your saved draft.' : rows.length ? 'Select a thread to read its messages and continue working.' : 'Start a thread to begin working with your agent.'}</p>{state.draft ? <div className="thread-prompt thread-prompt--saved"><label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Prompt</label><textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly /></div> : null}{!connected ? <Button disabled={state.connection === 'connecting'} onClick={() => void agents.command({ type: 'connect' })}>{state.connection === 'connecting' ? 'Connecting...' : `Connect ${PROVIDER_LABELS[state.configuration.provider]}`}</Button> : <Button onClick={onNewThread}>New thread</Button>}<Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button></div>}
    </section>
  </div>
}

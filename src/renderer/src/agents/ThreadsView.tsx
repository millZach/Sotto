import React, { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import { capabilitiesForThread, supportsAgentSupervision } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { AgentComposer } from './AgentView'
import { describeThreads, organizeWorkspace, type ThreadRow } from './threadFacts'
import { NewThreadDialog } from './NewThreadDialog'
import { ThreadOptions } from './ThreadOptions'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'
import { ProviderMark } from './ProviderMark'
import { THREAD_PROMPT_ID, ThreadComposer } from './ThreadComposer'
import { ThreadDraftStore, hasDraftContent } from './threadDraftStore'
import { ThreadSidebar } from './ThreadSidebar'
import { ThreadTranscript } from './ThreadTranscript'

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

export function ThreadsView({ onOpenAgents, now: fixedNow }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const now = useClock(fixedNow)
  const [query, setQuery] = useState('')
  const [newThread, setNewThread] = useState<{ readonly projectId?: string | undefined } | null>(null)
  const [followSignal, setFollowSignal] = useState(0)
  const [store] = useState(() => new ThreadDraftStore(agents.command))
  store.setCommand(agents.command)
  const state = agents.state
  // Published drafts and receipts reach the store before the composer reads it.
  useLayoutEffect(() => { if (state !== null) store.receive(state) }, [state, store])
  const rows = useMemo(() => state === null ? [] : describeThreads(state, now), [state, now])
  const organization = useMemo(() => state === null ? { open: [], settled: [], matching: 0 } : organizeWorkspace(state, rows, query, state.activeProjectId), [state, rows, query])
  const selected = rows.find(row => row.thread.id === state?.activeThreadId)
  const selectedId = selected?.thread.id
  // Leaving a thread (or the page) saves its latest revision now instead of after the debounce.
  useEffect(() => () => { if (selectedId !== undefined) store.flush(selectedId) }, [selectedId, store])
  useEffect(() => {
    const flush = (): void => store.flushAll()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', flush); flush() }
  }, [store])
  if (state === null) return <div className="threads-view"><p role="status">{agents.error ?? 'Preparing agent controls...'}</p></div>
  const openThread = (threadId: string): void => { void agents.command({ type: 'select-thread', threadId }) }
  const foreignDraft = (state.draft.trim() || state.draftAttachments?.length) && state.draftThreadId && state.draftThreadId !== selected?.thread.id ? state.host.threads.find(thread => thread.id === state.draftThreadId) : undefined
  const connected = state.connection === 'connected'
  const localDraftPresent = selected !== undefined && hasDraftContent(store.draft(selected.thread.id))
  const recoverCommand: Command = async command => {
    if (command.type === 'recover-draft' && hasDraftContent(store.draft(command.threadId))) return state
    return agents.command(command)
  }
  const recoveredDraft = Boolean(state.providerUpgrade && state.draftThreadId === null && (state.draft || state.draftAttachments?.length))
  const savedDraft = !recoveredDraft && Boolean(state.draft || state.draftAttachments?.length)
  const pending = selected?.thread.requests[0]
  const workspaceRow = selected && !isThreadClosed(selected.thread) && pending && !selected.request ? { ...selected, request: {
    id: `${selected.thread.id}:${pending.id}`, threadId: selected.thread.id, requestId: pending.id,
    kind: pending.kind, text: pending.text, createdAt: '', deferred: false,
  } } : selected
  const assigned = selected?.assignment
  const managed = assigned?.mode === 'managed' && selected !== undefined && !isThreadClosed(selected.thread)
  const selectedConnected = selected?.connected === true
  const selectedCapabilities = selected ? capabilitiesForThread(state.host, selected.thread) : state.host.capabilities
  const canManage = selectedConnected && !state.busy && supportsAgentSupervision(selectedCapabilities) && selected !== undefined && !isThreadClosed(selected.thread)
  const reconnect = selected?.providerId && state.host.providers ? { provider: selected.providerId } : {}
  return <div className="management-view threads-view">
    {newThread && <NewThreadDialog state={state} command={agents.command} initialProjectId={newThread.projectId} onClose={() => setNewThread(null)} onCreated={() => { setNewThread(null); window.setTimeout(() => document.getElementById(THREAD_PROMPT_ID)?.focus(), 0) }} />}
    <ThreadSidebar state={state} command={agents.command} organization={organization} query={query} onQuery={setQuery} onOpen={openThread} onNewThread={projectId => setNewThread({ projectId })} />
    <section className="thread-workspace" aria-label="Thread workspace">
      {recoveredDraft ? <ProviderUpgradeNotice state={state} command={recoverCommand} threadId={selected?.thread.id} localDraftPresent={localDraftPresent} /> : null}
      {selected && workspaceRow ? <>
        <header className="thread-workspace__head">
          <div className="thread-workspace__title">
            <span className="thread-workspace__crumb"><ProviderMark provider={selected.providerId} name={selected.provider} size={16} /><span>{selected.project?.title ?? selected.provider}</span>
              {selected.settledBy === 'thread' || selected.settledBy === 'project' ? <span className="thread-workspace__tag">Settled</span> : null}
              {!selectedConnected ? <span className="thread-workspace__tag" data-tone="warning">{selected.provider} disconnected</span> : null}
            </span>
            <h2>{selected.thread.title}</h2>
          </div>
          <div className="thread-workspace__actions">
            {assigned && !isThreadClosed(selected.thread) ? <Button variant="ghost" disabled={!canManage} onClick={() => void agents.command({ type: assigned.paused || assigned.mode === 'manual' ? 'resume' : 'pause', threadId: selected.thread.id })}>{assigned.paused || assigned.mode === 'manual' ? 'Resume managing' : 'Pause managing'}</Button>
              : !assigned && !isThreadClosed(selected.thread) ? <Button variant="ghost" disabled={!canManage} onClick={() => void agents.command({ type: 'assign', threadId: selected.thread.id })}>Manage</Button> : null}
            {assigned ? <Button variant="ghost" disabled={state.busy || !connected} onClick={() => void agents.command({ type: 'unassign', threadId: selected.thread.id })}>Stop managing</Button> : null}
            {selected.settledBy === null ? <Button variant="ghost" disabled={state.busy} onClick={() => void agents.command({ type: 'settle-thread', threadId: selected.thread.id })}>Settle</Button>
              : selected.settledBy === 'thread' ? <Button variant="ghost" disabled={state.busy} onClick={() => void agents.command({ type: 'restore-thread', threadId: selected.thread.id })}>Restore</Button> : null}
            {!selectedConnected ? <Button variant="secondary" disabled={state.connection === 'connecting'} onClick={() => void agents.command({ type: 'connect', ...reconnect })}>Reconnect</Button> : null}
            {selected.thread.status === 'running' && !isThreadClosed(selected.thread) ? <Button variant="secondary" disabled={state.busy || !selectedConnected || !selectedCapabilities.interrupt} onClick={() => void agents.command({ type: 'interrupt', threadId: selected.thread.id })}>Stop agent</Button> : null}
          </div>
        </header>
        {state.error || agents.error ? <p className="agent-error thread-workspace__error" role="alert">{state.error ?? agents.error}</p> : null}
        <ThreadTranscript row={selected} state={state} command={agents.command} store={store} followSignal={followSignal}>
          <ThreadRequest row={workspaceRow} voiceAvailable={state.queue.some(item => item.threadId === selected.thread.id && item.requestId === workspaceRow.request?.requestId)} command={agents.command} busy={state.busy || !selectedConnected} onAnswer={() => document.getElementById(managed ? 'agent-prompt' : THREAD_PROMPT_ID)?.focus()} />
        </ThreadTranscript>
        <div className="thread-workspace__compose">
          {foreignDraft && managed ? <div className="thread-draft-notice"><p>Your saved draft belongs to <strong>{foreignDraft.title}</strong>.</p><Button variant="secondary" onClick={() => openThread(foreignDraft.id)}>Open draft thread</Button><ThreadOptions key={selected.thread.id} thread={selected.thread} state={state} command={agents.command} /></div>
            : managed ? <AgentComposer state={state} command={agents.command} enterToSend footerControls={selectedCapabilities.configureThread || selected.thread.nativeSessionStarted === false ? <ThreadOptions key={selected.thread.id} thread={selected.thread} state={state} command={agents.command} /> : undefined} />
              : <ThreadComposer key={selected.thread.id} row={workspaceRow} state={state} command={agents.command} store={store} onSend={() => setFollowSignal(signal => signal + 1)} />}
        </div>
      </> : <div className="thread-workspace__empty"><MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" /><h2>{savedDraft ? 'Your draft is saved.' : rows.length ? 'Choose a thread.' : 'No threads yet.'}</h2><p>{savedDraft ? 'Reconnect to continue your saved draft.' : rows.length ? 'Select a thread to read its messages and continue working.' : 'Start a thread to begin working with your agent.'}</p>{savedDraft ? <div className="thread-prompt thread-prompt--saved"><label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Prompt</label><textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly /></div> : null}{!connected ? <Button disabled={state.connection === 'connecting'} onClick={() => void agents.command({ type: 'connect' })}>{state.connection === 'connecting' ? 'Connecting...' : 'Connect providers'}</Button> : <Button onClick={() => setNewThread({ projectId: state.activeProjectId ?? undefined })}>New thread</Button>}<Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button></div>}
    </section>
  </div>
}

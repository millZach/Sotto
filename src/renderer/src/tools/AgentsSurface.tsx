import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Users } from 'lucide-react'
import type { WorkflowProgress } from '../../../shared/agentActivity'
import { distinctModels, type SubagentAssignment, type SubagentRow, type SubagentsBridge } from '../../../shared/subagents'
import { type SubagentsStore, useThreadSubagents } from './subagentsStore'
import { ToolsChrome, ToolsChromeLead } from './ToolsChrome'
import './agentsSurface.css'

const STATUS: Record<SubagentRow['status'], string> = { running: 'Working', completed: 'Finished', failed: 'Failed', interrupted: 'Interrupted', unknown: 'Last seen working' }

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return seconds >= 3_600 ? `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

/** The clock alone renders each second; hidden surfaces and uncertain agents own no timer. */
export function SubagentElapsed({ row }: { readonly row: SubagentRow }): ReactNode {
  const [now, setNow] = useState(Date.now)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const visibility = (): void => { setVisible(document.visibilityState !== 'hidden'); setNow(Date.now()) }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    if (row.status !== 'running' || !visible || !row.startedAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [row.status, row.startedAt, visible])
  const start = row.startedAt ? Date.parse(row.startedAt) : NaN
  const end = row.status === 'running' ? now : Date.parse(row.completedAt ?? row.lastObservedAt)
  const duration = row.status !== 'running' && row.durationMs !== undefined ? row.durationMs : end - start
  return Number.isFinite(duration) ? <span>{elapsedLabel(duration)}</span> : null
}

function AssignmentText({ assignment }: { readonly assignment: SubagentAssignment }): ReactNode {
  return <>
    <h3>Task</h3><p>{assignment.prompt || assignment.title}</p>
    <h3>{assignment.status === 'running' ? 'Latest update' : assignment.status === 'unknown' ? 'Last update' : assignment.status === 'failed' ? 'What happened' : 'Result'}</h3>
    <p className="subagent-result">{assignment.result || (assignment.status === 'running' ? 'No result reported yet.' : 'No result was reported.')}</p>
  </>
}

function AssignmentDetails({ threadId, row, bridge }: { readonly threadId: string; readonly row: SubagentRow; readonly bridge: SubagentsBridge | undefined }): ReactNode {
  const [assignments, setAssignments] = useState<readonly SubagentAssignment[]>([])
  const [before, setBefore] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef(0)
  const mounted = useRef(true)
  const loadedEarlier = useRef(false)
  const load = async (older?: number): Promise<void> => {
    const token = ++request.current
    setLoading(true)
    setError(false)
    try {
      if (!bridge) throw new Error('unavailable')
      const page = await bridge.assignments({ threadId, agentId: row.id, ...(older !== undefined ? { before: older } : {}) })
      if (!mounted.current || token !== request.current) return
      setAssignments(previous => {
        const merged = new Map(previous.map(assignment => [assignment.id, assignment]))
        for (const assignment of page.assignments) merged.set(assignment.id, assignment)
        return [...merged.values()].sort((a, b) => b.sequence - a.sequence)
      })
      if (older !== undefined) loadedEarlier.current = true
      if (older !== undefined || !loadedEarlier.current) setBefore(page.before)
    } catch { if (mounted.current && token === request.current) setError(true) }
    finally { if (mounted.current && token === request.current) setLoading(false) }
  }
  // A burst of live metadata is coalesced into one bounded detail read. Terminal states load immediately.
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => { void load() }, assignments.length && row.status === 'running' ? 250 : 0)
    return () => { mounted.current = false; request.current++; clearTimeout(timer) }
    // The bridge and row revision identify the provider data; local paging never retriggers this read.
  }, [bridge, threadId, row.id, row.revision])
  const current = assignments.find(assignment => assignment.id === row.assignmentId)
  return <>
    {current ? <AssignmentText assignment={current} /> : <><h3>Task</h3><p>{row.description || row.title}</p></>}
    {loading ? <p role="status">Loading assignments…</p> : null}
    {error ? <p role="status">Could not load assignments. Saved work is unchanged. <button className="files-link tt-focusable" type="button" onClick={() => void load()}>Try again</button></p> : null}
    {assignments.filter(assignment => assignment.id !== row.assignmentId).map(assignment => <details className="subagent-previous" key={assignment.id}>
      <summary className="tt-focusable">Previous assignment · {STATUS[assignment.status]}{assignment.durationMs !== undefined ? ` · ${elapsedLabel(assignment.durationMs)}` : ''}</summary>
      <h3>{assignment.title}</h3><AssignmentText assignment={assignment} />
    </details>)}
    {before !== undefined ? <button type="button" className="files-link tt-focusable subagents-older" disabled={loading} onClick={() => void load(before)}>Load earlier assignments</button> : null}
  </>
}

const AgentRow = memo(function AgentRow({ threadId, row, depth, bridge }: { readonly threadId: string; readonly row: SubagentRow; readonly depth: number; readonly bridge: SubagentsBridge | undefined }): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  return <li className="subagent-item" data-agent-id={row.id} data-nested={depth > 0 || undefined} style={{ '--subagent-depth': Math.min(depth, 4) } as React.CSSProperties} onKeyDown={event => { if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); button.current?.focus() } }}>
    <button ref={button} type="button" className="subagent-head tt-focusable" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className="subagent-dot" data-status={row.status} aria-hidden="true" />
      <span className="subagent-main"><span className="subagent-title" title={row.title || undefined}>{row.title || 'Agent task'}</span>
        {row.description && row.description !== row.title ? <span className="subagent-description">{row.description}</span> : null}
        <span className="subagent-meta"><span className="subagent-model">{row.model || 'Model not reported'}</span>{row.assignmentCount > 1 ? <span className="subagent-run">· Run {row.assignmentCount}</span> : null}</span>
      </span>
      <span className="subagent-right"><span className="subagent-time"><SubagentElapsed row={row} /><ChevronRight size={12} aria-hidden="true" /></span><span>{STATUS[row.status]}</span></span>
    </button>
    {open ? <div className="subagent-details" id={id} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); button.current?.focus() } }}>
      <AssignmentDetails threadId={threadId} row={row} bridge={bridge} />
    </div> : null}
  </li>
})

/** Stable spawn order with reported descendants directly below their parent; malformed cycles stay visible once. */
export function nestedSubagents(rows: readonly SubagentRow[]): { row: SubagentRow; depth: number }[] {
  const ids = new Set(rows.map(row => row.id))
  const children = new Map<string, SubagentRow[]>()
  const roots: SubagentRow[] = []
  for (const row of rows) {
    if (row.parentId && row.parentId !== row.id && ids.has(row.parentId)) {
      const siblings = children.get(row.parentId) ?? []; siblings.push(row); children.set(row.parentId, siblings)
    } else roots.push(row)
  }
  const result: { row: SubagentRow; depth: number }[] = []
  const visited = new Set<string>()
  const visit = (row: SubagentRow, depth: number): void => {
    if (visited.has(row.id)) return
    visited.add(row.id); result.push({ row, depth })
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1)
  }
  for (const row of roots) visit(row, 0)
  for (const row of rows) visit(row, 0)
  return result
}

type StripStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'queued'
const stripStatus = (status: SubagentRow['status']): StripStatus => status === 'unknown' ? 'running' : status

/** A workflow's count in words: what has finished, then what failed or stopped. "4 of 6 finished · 1 failed". */
export function workflowCount(progress: WorkflowProgress | undefined): string {
  if (!progress?.total) return 'No agents reported yet'
  return [`${progress.completed} of ${progress.total} finished`, ...(progress.failed ? [`${progress.failed} failed`] : []), ...(progress.interrupted ? [`${progress.interrupted} interrupted`] : [])].join(' · ')
}

/** Past this many agents, neighbouring segments in the same state join into one, so the strip keeps to its row. */
const STRIP_SEGMENTS = 40

/**
 * One segment per agent, in the order they were queued, coloured by state. The agents the roster has loaded draw
 * it, followed by the agents still waiting to start; until every started agent has loaded, the workflow's own counts do.
 */
function WorkflowStrip({ progress, agents }: { readonly progress: WorkflowProgress | undefined; readonly agents: readonly SubagentRow[] }): ReactNode {
  if (!progress?.total) return null
  const queued = progress.queued ?? 0
  const waiting = Array<StripStatus>(queued).fill('queued')
  const segments: StripStatus[] = agents.length === progress.total - queued ? [...agents.map(agent => stripStatus(agent.status)), ...waiting]
    : [...Array<StripStatus>(progress.completed).fill('completed'), ...Array<StripStatus>(progress.failed).fill('failed'), ...Array<StripStatus>(progress.interrupted).fill('interrupted'), ...Array<StripStatus>(progress.working).fill('running'), ...waiting]
  const label = [workflowCount(progress), ...(progress.working ? [`${progress.working} working`] : []), ...(queued ? [`${queued} waiting to start`] : [])].join(', ').replaceAll(' · ', ', ')
  const runs: { status: StripStatus; count: number }[] = []
  for (const status of segments) {
    const last = runs.at(-1)
    if (segments.length > STRIP_SEGMENTS && last?.status === status) last.count++
    else runs.push({ status, count: 1 })
  }
  return <span className="subagent-strip" role="img" aria-label={label}>{runs.map(({ status, count }, index) => <i key={index} data-status={status} style={count > 1 ? { flexGrow: count } : undefined} />)}</span>
}

/** A workflow in the roster: one row with its strip and count. Pressing it opens the workflow page. */
const WorkflowRow = memo(function WorkflowRow({ row, agents, onOpen }: { readonly row: SubagentRow; readonly agents: readonly SubagentRow[]; readonly onOpen: (id: string) => void }): ReactNode {
  const count = workflowCount(row.progress)
  return <li className="subagent-item subagent-item--workflow" data-agent-id={row.id}>
    <button type="button" className="subagent-head tt-focusable" aria-label={`Open the workflow ${row.title || 'Workflow'}: ${count.replaceAll(' · ', ', ')}, ${STATUS[row.status]}`} onClick={() => onOpen(row.id)}>
      <span className="subagent-dot" data-status={row.status} aria-hidden="true" />
      <span className="subagent-main"><span className="subagent-title" title={row.title || undefined}>{row.title || 'Workflow'}</span>
        <WorkflowStrip progress={row.progress} agents={agents} />
        <span className="subagent-meta"><span className="subagent-kind">Workflow</span><span className="subagent-count">{count}</span>
          {row.description && row.description !== row.title ? <span className="subagent-model">{row.description}</span> : null}</span>
      </span>
      <span className="subagent-right"><span className="subagent-time"><SubagentElapsed row={row} /><ChevronRight size={12} aria-hidden="true" /></span><span>{STATUS[row.status]}</span></span>
    </button>
  </li>
})

/**
 * The workflow page: one workflow's run and its agents, in place of the roster. Its line of chrome goes back to
 * all agents; so does Escape when nothing on the page is open.
 */
function WorkflowPage({ threadId, row, agents, bridge }: { readonly threadId: string; readonly row: SubagentRow; readonly agents: readonly { row: SubagentRow; depth: number }[]; readonly bridge: SubagentsBridge | undefined }): ReactNode {
  const models = distinctModels(agents.map(({ row: agent }) => agent.model))
  return <>
    <section className="subagent-workflow" aria-label="Workflow">
      <WorkflowStrip progress={row.progress} agents={agents.filter(({ depth }) => depth === 0).map(({ row: agent }) => agent)} />
      <p className="subagent-workflow__facts"><strong>{workflowCount(row.progress)}</strong><SubagentElapsed row={row} />
        {row.description && row.description !== row.title ? <span>{row.description}</span> : null}
        {models.length ? <span>{models.join(', ')}</span> : null}</p>
      <div className="subagent-details subagent-workflow__details"><AssignmentDetails threadId={threadId} row={row} bridge={bridge} /></div>
    </section>
    <h3 className="subagent-workflow__heading" id={`${row.id}-agents`}>Agents</h3>
    {!agents.length ? <p className="subagent-workflow__empty">No agents reported yet.</p> : null}
    <ul className="subagents-list" aria-labelledby={`${row.id}-agents`}>{agents.map(({ row: agent, depth }) => <AgentRow key={agent.id} threadId={threadId} row={agent} depth={depth} bridge={bridge} />)}</ul>
  </>
}

/**
 * `rosterSignal` is for a thread on a paired host, whose host pushes no roster changes: what the thread's shell says of
 * its agents, so a change there reads the roster again.
 */
export function AgentsSurface({ threadId, store, bridge, rosterSignal }: { readonly threadId: string; readonly store: SubagentsStore; readonly bridge: SubagentsBridge | undefined; readonly rosterSignal?: string | undefined }): ReactNode {
  const state = useThreadSubagents(store, threadId)
  useEffect(() => { store.activate(bridge, threadId); return () => store.deactivate() }, [store, bridge, threadId])
  const followed = useRef(rosterSignal)
  useEffect(() => {
    if (followed.current === rosterSignal) return
    followed.current = rosterSignal
    if (rosterSignal !== undefined) void store.page(threadId)
  }, [store, threadId, rosterSignal])
  const [page, setPage] = useState<{ threadId: string; id: string } | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  // Focus moves only after the user opens or leaves a workflow page, never when a thread switch or reset does it.
  const focusNext = useRef<{ back: true } | { row: string } | null>(null)
  useEffect(() => { setPage(null) }, [threadId])
  // A workflow's agents are on its page; the roster shows the workflow as one row.
  const { roster, members } = useMemo(() => {
    const workflows = new Set(state.rows.filter(row => row.kind === 'workflow').map(row => row.id))
    const members = new Map<string, SubagentRow[]>()
    for (const row of state.rows) if (row.parentId && workflows.has(row.parentId)) members.set(row.parentId, [...members.get(row.parentId) ?? [], row])
    return { roster: nestedSubagents(state.rows.filter(row => !row.parentId || !workflows.has(row.parentId))), members }
  }, [state.rows])
  const open = page?.threadId === threadId ? state.rows.find(row => row.id === page.id && row.kind === 'workflow') : undefined
  const pageAgents = useMemo(() => open ? nestedSubagents(members.get(open.id) ?? []) : [], [open, members])
  const openId = open?.id
  const back = (): void => { if (openId) focusNext.current = { row: openId }; setPage(null) }
  const openPage = useCallback((id: string): void => { focusNext.current = { back: true }; setPage({ threadId, id }) }, [threadId])
  useEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (next && 'back' in next) surface.current?.querySelector<HTMLButtonElement>('.subagents-back')?.focus()
    else if (next) surface.current?.querySelector<HTMLButtonElement>(`[data-agent-id="${CSS.escape(next.row)}"] .subagent-head`)?.focus()
  }, [openId])
  const { total, working, unknown } = state.summary
  const loadEarlier = state.before !== undefined ? <button type="button" className="files-link tt-focusable subagents-older" disabled={state.loading} onClick={() => void store.page(threadId, true)}>{state.loading ? 'Loading agents…' : 'Load earlier agents'}</button> : null
  const error = state.error ? <p role="status">{state.error} <button type="button" className="files-link tt-focusable" onClick={() => void store.page(threadId)}>Try again</button></p> : null
  // An open agent inside the page answers Escape first; only then does Escape leave the page.
  return <div className="subagents-surface" ref={surface} onKeyDown={event => { if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); back() } }}>
    {open ? <div className="tools-chrome">
      <button type="button" className="tools-chrome__button subagents-back tt-focusable" aria-label="Back to all agents" title="Back to all agents" onClick={back}><ArrowLeft size={15} aria-hidden="true" /><span className="tools-chrome__button-label">All agents</span></button>
      <span className="subagents-back__rule" aria-hidden="true" />
      <ToolsChromeLead title={open.title || 'Workflow'} detail={workflowCount(open.progress)} />
    </div>
    // The roster's count leads its line of chrome; what is working, or not confirmed, sits beside it.
      : <ToolsChrome title={total > 0 ? `${total} ${total === 1 ? 'agent' : 'agents'}` : 'Agents'} detail={total > 0 ? working ? `${working} working` : unknown ? 'Activity not confirmed' : 'None working' : null} />}
    <div className="subagents-roster">
      {open ? <WorkflowPage key={`${state.resetVersion}:${open.id}`} threadId={threadId} row={open} agents={pageAgents} bridge={bridge} /> : <>
        {!roster.length && !state.error ? <div className="subagents-empty"><Users size={25} aria-hidden="true" /><p>{state.loading ? 'Loading agents…' : 'No agents spawned in this thread yet.'}</p></div> : null}
        <ul className="subagents-list" aria-label="Spawned agents">{roster.map(({ row, depth }) => row.kind === 'workflow'
          ? <WorkflowRow key={`${state.resetVersion}:${row.id}`} row={row} agents={members.get(row.id) ?? []} onOpen={openPage} />
          : <AgentRow key={`${state.resetVersion}:${row.id}`} threadId={threadId} row={row} depth={depth} bridge={bridge} />)}</ul>
      </>}
      {error}
      {loadEarlier}
    </div>
  </div>
}

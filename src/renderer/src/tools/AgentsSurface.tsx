import React, { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import type { SubagentAssignment, SubagentRow, SubagentsBridge } from '../../../shared/subagents'
import { type SubagentsStore, useThreadSubagents } from './subagentsStore'
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
      <span className="subagent-main"><span className="subagent-title">{row.title || 'Agent task'}</span>
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

export function AgentsSurface({ threadId, store, bridge }: { readonly threadId: string; readonly store: SubagentsStore; readonly bridge: SubagentsBridge | undefined }): ReactNode {
  const state = useThreadSubagents(store, threadId)
  useEffect(() => { store.activate(bridge, threadId); return () => store.deactivate() }, [store, bridge, threadId])
  const rows = useMemo(() => nestedSubagents(state.rows), [state.rows])
  return <div className="subagents-surface">
    <div className="subagents-roster">
      {!rows.length && !state.error ? <div className="subagents-empty"><Users size={25} aria-hidden="true" /><p>{state.loading ? 'Loading agents…' : 'No agents spawned in this thread yet.'}</p></div> : null}
      <ul className="subagents-list" aria-label="Spawned agents">{rows.map(({ row, depth }) => <AgentRow key={row.id} threadId={threadId} row={row} depth={depth} bridge={bridge} />)}</ul>
      {state.error ? <p role="status">{state.error} <button type="button" className="files-link tt-focusable" onClick={() => void store.page(threadId)}>Try again</button></p> : null}
      {state.before !== undefined ? <button type="button" className="files-link tt-focusable subagents-older" disabled={state.loading} onClick={() => void store.page(threadId, true)}>{state.loading ? 'Loading agents…' : 'Load earlier agents'}</button> : null}
    </div>
    {state.summary.total > 0 ? <footer className="subagents-footer"><span>{state.summary.total} {state.summary.total === 1 ? 'agent' : 'agents'}</span><span>{state.summary.working ? `${state.summary.working} working` : state.summary.unknown ? 'Activity not confirmed' : 'None working'}</span></footer> : null}
  </div>
}

import React, { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Bot, Brain, ChevronRight, CircleAlert, FilePen, Info, ListChecks, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'
import { MessageContent } from './MessageContent'
import {
  activityLabel, agentStatusLabel, currentAction, fenced, formatDuration, groupSummary, isTurnRecord, liveTurnId, openActivityLabel,
  statusText, timingNote, turnHeadline, type ActivityGroup,
} from './threadActivityView'
import './activity.css'

/** A running turn shows its newest rows; older ones stay one click away. */
export const LIVE_ROWS = 6

const ICONS: Record<AgentActivity['kind'], LucideIcon> = {
  turn: Info, command: SquareTerminal, 'file-change': FilePen, tool: Wrench, reasoning: Brain, plan: ListChecks, subagent: Bot, status: Info,
}
const CHANGE_KINDS: Record<string, string> = { add: 'Created', delete: 'Deleted', update: 'Edited' }

export interface ActivityGroupViewProps {
  readonly group: ActivityGroup
  /** The group belongs to the turn still running: rows stay open. */
  readonly live: boolean
  readonly threadRunning: boolean
  /** The thread's provider is connected; clocks tick only then. */
  readonly connected: boolean
  /** Display name of the provider, for "Reported by Codex". */
  readonly provider: string
  /** Called before a disclosure changes height so the transcript can keep the control in place. */
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}

/** Whole seconds while the clock runs, so the number does not flicker through tenths. */
const elapsedText = (startedAt: string): string => {
  const ms = Date.now() - Date.parse(startedAt)
  if (!Number.isFinite(ms)) return ''
  return ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : formatDuration(ms)
}

/** Updates its own text once a second instead of re-rendering the transcript. */
export function Elapsed({ startedAt }: { readonly startedAt: string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = (): void => { if (ref.current) ref.current.textContent = elapsedText(startedAt) }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <span ref={ref} className="thread-activity__clock" data-elapsed>{elapsedText(startedAt)}</span>
}

function hasDetails(record: AgentActivity): boolean {
  return Boolean(record.command || record.cwd || record.output || record.error || record.text || record.changes?.length || record.agents?.length || record.truncated)
}

function ActivityDetails({ id, record, provider, connected }: { readonly id: string; readonly record: AgentActivity; readonly provider: string; readonly connected: boolean }): ReactNode {
  const notes = [timingNote(record, provider), record.truncated ? 'Some details were not kept.' : ''].filter(Boolean)
  return <div id={id} className="thread-activity__details">
    {record.command ? <MessageContent text={fenced(record.command, 'command')} /> : null}
    {record.cwd ? <p className="thread-activity__fact">In <code>{record.cwd}</code></p> : null}
    {record.text ? record.kind === 'reasoning'
      ? <MessageContent text={record.text} />
      : <p className="thread-activity__text">{record.text}</p> : null}
    {record.changes?.map((change, index, changes) => <div className="thread-activity__change" key={`${change.path}:${index}`}>
      {/* A single file is already named by its row. */}
      {changes.length > 1 ? <p className="thread-activity__fact">{CHANGE_KINDS[change.kind] ?? change.kind} <code>{change.path}</code></p> : null}
      {change.diff ? <MessageContent text={fenced(change.diff, 'diff')} /> : null}
    </div>)}
    {record.agents?.length ? <ol className="thread-activity__agents" aria-label="Agents" data-connected={connected || undefined}>
      {record.agents.map((agent, index) => <li key={agent.id} data-status={agent.status}>
        <span className="thread-activity__agent">Agent {index + 1}</span>
        <span className="thread-activity__agent-status">{agentStatusLabel(agent.status)}</span>
        {agent.message ? <span className="thread-activity__agent-message">{agent.message}</span> : null}
      </li>)}
    </ol> : null}
    {record.output ? <MessageContent text={fenced(record.output, 'output')} /> : null}
    {record.error ? <p className="thread-activity__error">{record.error}</p> : null}
    {notes.length ? <p className="thread-activity__fact">{notes.join(' · ')}</p> : null}
  </div>
}

const ActivityRow = memo(function ActivityRow({ record, connected, provider, quietUnknown, onDisclosure }: {
  readonly record: AgentActivity; readonly connected: boolean; readonly provider: string
  /** The group heading already says the outcome is unknown; the row keeps it for assistive tech only. */
  readonly quietUnknown: boolean
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const label = activityLabel(record)
  const shown = open ? openActivityLabel(record) : label
  const status = statusText(record, connected)
  const Icon = record.status === 'failed' ? CircleAlert : ICONS[record.kind]
  const running = record.status === 'running'
  const expandable = hasDetails(record)
  const spoken = [`${label.lead ? `${label.lead} ` : ''}${label.subject}`, label.preview,
    record.status === 'completed' ? `completed${status ? ` in ${status}` : ''}` : status].filter(Boolean).join(', ')
  const body = <>
    <Icon className="thread-activity__icon" size={15} strokeWidth={1.8} aria-hidden="true" />
    <span className="thread-activity__label">
      {shown.lead ? <span className="thread-activity__lead">{shown.lead} </span> : null}
      <span className={shown.mono ? 'thread-activity__subject thread-activity__subject--mono' : 'thread-activity__subject'}>{shown.subject}</span>
      {shown.preview ? <span className="thread-activity__preview"> {shown.preview}</span> : null}
    </span>
    <span className="thread-activity__meta" data-status={record.status} data-connected={connected || undefined}>
      {running ? <i className="thread-activity__pulse" data-connected={connected || undefined} aria-hidden="true" /> : null}
      {quietUnknown && record.status === 'unknown' ? null : status}
      {running && connected && record.startedAt ? <> <Elapsed startedAt={record.startedAt} /></> : null}
    </span>
    {expandable ? <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" /> : null}
  </>
  return <li className="thread-activity__row" data-kind={record.kind} data-status={record.status} data-open={open || undefined}>
    {expandable
      ? <button type="button" className="thread-activity__toggle tt-focusable" aria-expanded={open} aria-controls={open ? detailId : undefined} aria-label={spoken}
        onClick={event => { onDisclosure?.(event.currentTarget); setOpen(value => !value) }}>{body}</button>
      : <div className="thread-activity__toggle" role="group" aria-label={spoken}>{body}</div>}
    {open ? <ActivityDetails id={detailId} record={record} provider={provider} connected={connected} /> : null}
  </li>
})

/**
 * The work a provider reported after one message. A running turn lists its rows; a settled one folds
 * to a single line and keeps any failure in view. Nothing here can act on the provider or its agents.
 */
export const ActivityGroupView = memo(function ActivityGroupView({ group, live, threadRunning, connected, provider, onDisclosure }: ActivityGroupViewProps): ReactNode {
  const [choice, setChoice] = useState<boolean | null>(null)
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const expanded = choice ?? live
  const headline = turnHeadline(group.turn, threadRunning)
  const summary = groupSummary(group.records)
  const failures = group.records.filter(record => record.status === 'failed')
  const shown = expanded ? group.records : failures
  const earlier = live && expanded && !showAll ? Math.max(0, shown.length - LIVE_ROWS) : 0
  const rows = earlier ? shown.slice(-LIVE_ROWS) : shown
  const turnError = group.turn?.error
  const canFold = !live && group.records.length > 0
  const name = [headline, summary].filter(Boolean).join(', ') || 'Activity'
  return <section className="thread-activity" data-turn-id={group.turnId} data-live={live || undefined} data-expanded={expanded || undefined}
    aria-label={name}>
    {canFold ? <button type="button" className="thread-activity__summary tt-focusable" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-label={name}
      onClick={event => { onDisclosure?.(event.currentTarget); setChoice(!expanded) }}>
      <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" />
      {headline ? <span className="thread-activity__headline">{headline}</span> : null}
      {summary ? <span className="thread-activity__counts">{summary}</span> : null}
    </button> : !live && headline ? <p className="thread-activity__summary thread-activity__summary--static" data-status={group.turn?.status}>
      <CircleAlert className="thread-activity__chevron" size={14} aria-hidden="true" /><span className="thread-activity__headline">{headline}</span>
    </p> : null}
    {turnError ? <p className="thread-activity__error thread-activity__error--turn">{turnError}</p> : null}
    {rows.length ? <ul id={listId} className="thread-activity__rows">
      {earlier ? <li className="thread-activity__earlier"><button type="button" className="thread-activity__more tt-focusable"
        onClick={event => { onDisclosure?.(event.currentTarget); setShowAll(true) }}>Show {earlier} earlier</button></li> : null}
      {rows.map(record => <ActivityRow key={record.id} record={record} connected={connected} provider={provider} quietUnknown={group.turn?.status === 'unknown'} onDisclosure={onDisclosure} />)}
    </ul> : null}
  </section>
})

/**
 * One line at the end of a running turn: how long it has run and what it is doing now. The current
 * action is left out when it is the row directly above, so the line never repeats it.
 */
export function LiveActivity({ thread, connected, adjacentRecordId }: {
  readonly thread: Pick<AgentThread, 'status' | 'activities'>; readonly connected: boolean
  /** The last activity row rendered immediately before this line, if any. */
  readonly adjacentRecordId?: string | undefined
}): ReactNode {
  const turnId = liveTurnId(thread)
  if (turnId === null) return null
  const turn = thread.activities?.find(record => record.turnId === turnId && isTurnRecord(record))
  const action = currentAction(thread, turnId)
  const label = action && action.id !== adjacentRecordId ? activityLabel(action) : null
  return <div className="thread-activity-live" data-testid="thread-activity-live" data-connected={connected || undefined}>
    <i className="thread-activity__pulse" data-connected={connected || undefined} aria-hidden="true" />
    <span className="thread-activity-live__state">
      {connected ? 'Working' : 'Last seen working'}
      {connected && turn?.startedAt ? <> for <Elapsed startedAt={turn.startedAt} /></> : null}
    </span>
    {label ? <span className="thread-activity-live__action">
      {label.lead ? `${label.lead} ` : null}<span className={label.mono ? 'thread-activity__subject--mono' : undefined}>{label.subject}</span>
    </span> : null}
  </div>
}

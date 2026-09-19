import React, { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Bot, Brain, ChevronRight, CircleAlert, FilePen, Info, ListChecks, Shrink, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'
import { MessageContent } from './MessageContent'
import { isTerminalActivity } from '../../../shared/agentActivity'
import {
  activityChanges, activityInput, activityLabel, agentStatusLabel, changeVerb, compactionSummary, currentAction, displayDiff, fenced, formatDuration, groupSummary, inputDetail,
  isTurnRecord, liveTurnId, nestActivities, openActivityLabel, statusText, timingNote, turnHeadline, type ActivityGroup, type ActivityNode, type TurnChange,
} from './threadActivityView'
import './activity.css'

/** A running turn shows its newest rows; older ones stay one click away. */
const LIVE_ROWS = 6

const ICONS: Record<AgentActivity['kind'], LucideIcon> = {
  turn: Info, command: SquareTerminal, 'file-change': FilePen, tool: Wrench, reasoning: Brain, plan: ListChecks, subagent: Bot, status: Info, compaction: Shrink,
}

/**
 * A compaction is a boundary in the conversation rather than work inside a turn, so it reads as a rule across
 * the transcript naming what the context went from and to. Only the sides the provider reported are named.
 */
export function CompactionLine({ record }: { readonly record: AgentActivity }): ReactNode {
  const summary = compactionSummary(record)
  return <p className="thread-boundary" role="separator" aria-label={[record.title, summary].filter(Boolean).join(', ')}>
    <span className="thread-boundary__rule" aria-hidden="true" />
    <span className="thread-boundary__label">
      <Shrink className="thread-boundary__icon" size={13} strokeWidth={1.8} aria-hidden="true" />
      <span>{record.title}</span>
      {summary ? <span className="thread-boundary__count">{summary}</span> : null}
    </span>
    <span className="thread-boundary__rule" aria-hidden="true" />
  </p>
}

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
  /** How the turn ended, when a folded turn line above the group already says it. */
  readonly outcome?: AgentActivity['status'] | undefined
}

/** Whole seconds while the clock runs, so the number does not flicker through tenths. */
const elapsedText = (startedAt: string): string => {
  const ms = Date.now() - Date.parse(startedAt)
  if (!Number.isFinite(ms)) return ''
  return ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : formatDuration(ms)
}

/** Updates its own text once a second instead of re-rendering the transcript. */
function Elapsed({ startedAt }: { readonly startedAt: string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = (): void => { if (ref.current) ref.current.textContent = elapsedText(startedAt) }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <span ref={ref} className="thread-activity__clock" data-elapsed>{elapsedText(startedAt)}</span>
}

/**
 * What a finished turn left behind. The count stays in view while the work is folded, because the files
 * a turn changed are what a reader comes back for; the diffs are the ones the provider reported.
 */
export function TurnChangedFiles({ changes, onDisclosure }: {
  readonly changes: readonly TurnChange[]
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (!changes.length) return null
  const label = `Changed ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`
  return <div className="thread-changes" data-expanded={open || undefined}>
    <button type="button" className="thread-changes__summary tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      onClick={event => { onDisclosure?.(event.currentTarget); setOpen(value => !value) }}>
      <FilePen className="thread-activity__icon" size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
      <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" />
    </button>
    {open ? <ul id={bodyId} className="thread-changes__list" aria-label={label}>
      {changes.map(change => <li key={change.path}>
        <p className="thread-activity__fact">{change.verb} <code>{change.path}</code></p>
        {change.diffs.map((diff, index) => <MessageContent key={index} text={fenced(displayDiff(diff), 'diff')} />)}
      </li>)}
    </ul> : null}
  </div>
}

/**
 * Words for a turn that has reported nothing yet. They say only that the agent is still going: Sotto
 * cannot see inside a provider's turn, so no word here claims to know what it is thinking about.
 */
// A short turn only ever shows the first word, so that one still reads as work; the rest are for the longer waits.
const WORKING_WORDS = [
  'Combing the desert', 'Winding up the Schwartz', 'Going to plaid', 'Ludicrous speed', 'Consulting Yogurt',
  'Checking Mr. Radar', 'Cracking 1-2-3-4-5', 'Getting to now, now', 'Raising the air shield', 'Canning the Perri-air',
  'Waking Barf', 'Scanning for Druidia', 'Merchandising', 'Prepping for light speed',
] as const
const WORD_MS = 3800
const FADE_MS = 220

/** Changes its own word instead of re-rendering the transcript, and never repeats the word it is replacing. */
function WorkingWord(): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let current = 0
    const timer = window.setInterval(() => {
      const node = ref.current
      if (!node) return
      current = (current + 1 + Math.floor(Math.random() * (WORKING_WORDS.length - 1))) % WORKING_WORDS.length
      node.textContent = WORKING_WORDS[current]!
      const still = document.documentElement.dataset.reducedMotion === 'on' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
      if (!still) node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' })
    }, WORD_MS)
    return () => window.clearInterval(timer)
  }, [])
  // The word is decoration over one unchanging fact, so assistive tech hears that fact once instead of every change.
  return <>
    <span ref={ref} className="thread-activity-live__word" aria-hidden="true">{WORKING_WORDS[0]}</span>
    <span className="tt-visually-hidden">Working</span>
  </>
}

/** A finished subagent whose provider sent no result says so, instead of opening to nothing. */
function missingAgentOutput(record: AgentActivity): boolean {
  return record.kind === 'subagent' && isTerminalActivity(record.status) && !record.output && !record.error && !record.agents?.some(agent => agent.message)
}

function hasDetails(record: AgentActivity): boolean {
  return Boolean(record.command || record.cwd || record.output || record.error || record.text || record.changes?.length || record.steps?.length || record.agents?.length || record.truncated)
    || missingAgentOutput(record)
}

const STEP_LABELS: Record<string, string> = { completed: 'Done', running: 'In progress', pending: 'To do' }

/** The plan as the provider last reported it. Sotto shows its state; only the provider can change it. */
function PlanSteps({ record }: { readonly record: AgentActivity }): ReactNode {
  const steps = record.steps ?? []
  const done = steps.filter(step => step.status === 'completed').length
  return <ol className="thread-activity__steps" aria-label={`Plan, ${done} of ${steps.length} done`}>
    {steps.map((step, index) => <li key={`${index}:${step.text}`} data-status={step.status}>
      <span className="thread-activity__step-mark" aria-hidden="true" />
      <span className="thread-activity__step-text">{step.text}</span>
      <span className="tt-visually-hidden">{STEP_LABELS[step.status] ?? step.status}</span>
    </li>)}
  </ol>
}

function ActivityDetails({ record, provider, connected }: { readonly record: AgentActivity; readonly provider: string; readonly connected: boolean }): ReactNode {
  const notes = [timingNote(record, provider), record.truncated ? 'Some details were not kept.' : ''].filter(Boolean)
  // Native tool input arrives as JSON: it reads formatted, and is left out where the command or diff already shows it.
  const parsed = activityInput(record) !== null
  const text = parsed ? inputDetail(record) : record.text
  const json = parsed && record.kind !== 'command'
  return <div className="thread-activity__details">
    {record.steps?.length ? <PlanSteps record={record} /> : null}
    {record.command ? <MessageContent text={fenced(record.command, 'command')} /> : null}
    {record.cwd ? <p className="thread-activity__fact">In <code>{record.cwd}</code></p> : null}
    {text ? record.kind === 'reasoning'
      ? <MessageContent text={text} />
      : json ? <MessageContent text={fenced(text, 'json')} /> : <p className="thread-activity__text">{text}</p> : null}
    {activityChanges(record).map((change, index, changes) => <div className="thread-activity__change" key={`${change.path}:${index}`}>
      {/* A single changed file is already named by its row; a tool's files are what it touched. */}
      {changes.length > 1 || record.kind !== 'file-change' ? <p className="thread-activity__fact">{changeVerb(change.kind)} <code>{change.path}</code></p> : null}
      {change.diff ? <MessageContent text={fenced(displayDiff(change.diff), 'diff')} /> : null}
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
    {missingAgentOutput(record) ? <p className="thread-activity__fact">{provider} did not report this agent’s result.</p> : null}
    {notes.length ? <p className="thread-activity__fact">{notes.join(' · ')}</p> : null}
  </div>
}

const ActivityRow = memo(function ActivityRow({ node, connected, provider, quietUnknown, onDisclosure }: {
  readonly node: ActivityNode; readonly connected: boolean; readonly provider: string
  /** The group heading already says the outcome is unknown; the row keeps it for assistive tech only. */
  readonly quietUnknown: boolean
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const { record, children } = node
  const steps = children.length ? `${children.length} ${children.length === 1 ? 'step' : 'steps'}` : ''
  const base = activityLabel(record)
  const label = steps ? { ...base, preview: [base.preview, steps].filter(Boolean).join(' · ') } : base
  const shown = open ? { ...openActivityLabel(record), preview: steps } : label
  const status = statusText(record, connected)
  const Icon = record.status === 'failed' ? CircleAlert : ICONS[record.kind]
  const running = record.status === 'running'
  const expandable = hasDetails(record) || children.length > 0
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
    {open ? <div id={detailId} className="thread-activity__open">
      {hasDetails(record) ? <ActivityDetails record={record} provider={provider} connected={connected} /> : null}
      {children.length ? <ul className="thread-activity__rows thread-activity__rows--nested" aria-label={`Steps in ${label.subject}`}>
        {children.map(child => <ActivityRow key={child.record.id} node={child} connected={connected} provider={provider} quietUnknown={quietUnknown} onDisclosure={onDisclosure} />)}
      </ul> : null}
    </div> : null}
  </li>
})

/**
 * The work a provider reported after one message. A running turn lists its rows; a settled one folds
 * to a single line and keeps any failure in view. Nothing here can act on the provider or its agents.
 */
export const ActivityGroupView = memo(function ActivityGroupView({ group, live, threadRunning, connected, provider, onDisclosure, outcome }: ActivityGroupViewProps): ReactNode {
  const [choice, setChoice] = useState<boolean | null>(null)
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const expanded = choice ?? live
  const headline = turnHeadline(group.turn, threadRunning)
  const summary = groupSummary(group.records)
  const failures = group.records.filter(record => record.status === 'failed')
  // Expanded, work done for a subagent or tool sits under it; folded, every failure stays in view on its own.
  const shown: readonly ActivityNode[] = expanded ? nestActivities(group.records) : failures.map(record => ({ record, children: [] }))
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
      {rows.map(node => <ActivityRow key={node.record.id} node={node} connected={connected} provider={provider} quietUnknown={(group.turn?.status ?? outcome) === 'unknown'} onDisclosure={onDisclosure} />)}
    </ul> : null}
  </section>
})

/**
 * One line at the end of a running turn: how long it has run and what it is doing now. The current
 * action is left out when it is the row directly above, so the line never repeats it.
 */
export function LiveActivity({ thread, connected, adjacentRecordId, sendingSince }: {
  readonly thread: Pick<AgentThread, 'status' | 'activities' | 'messages'>; readonly connected: boolean
  /** The last activity row rendered immediately before this line, if any. */
  readonly adjacentRecordId?: string | undefined
  /**
   * When the user pressed Send, while that prompt is still on its way. The wait starts being shown
   * there rather than at the provider's first word; its own running turn takes the line over as soon as it arrives.
   */
  readonly sendingSince?: string | undefined
}): ReactNode {
  const turnId = liveTurnId(thread)
  if (turnId === null && sendingSince === undefined) return null
  const turn = turnId === null ? undefined : thread.activities?.find(record => record.turnId === turnId && isTurnRecord(record))
  const action = turnId === null ? undefined : currentAction(thread, turnId)
  const label = action && action.id !== adjacentRecordId ? activityLabel(action) : null
  const startedAt = turn?.startedAt ?? sendingSince
  return <div className="thread-activity-live" data-testid="thread-activity-live" data-connected={connected || undefined}>
    <i className="thread-activity__pulse" data-connected={connected || undefined} aria-hidden="true" />
    <span className="thread-activity-live__state">
      {/* With an action to name, the line says what is happening; without one, the words carry the wait. */}
      {connected ? label ? 'Working' : <WorkingWord /> : 'Last seen working'}
      {connected && startedAt ? <> for <Elapsed startedAt={startedAt} /></> : null}
    </span>
    {label ? <span className="thread-activity-live__action">
      {label.lead ? `${label.lead} ` : null}<span className={label.mono ? 'thread-activity__subject--mono' : undefined}>{label.subject}</span>
    </span> : null}
  </div>
}

import React, { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Bot, Brain, ChevronRight, CircleAlert, FilePen, Info, ListChecks, Shrink, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentThread } from '../../../shared/agents'
import { MessageContent } from './MessageContent'
import { isTerminalActivity } from '../../../shared/agentActivity'
import {
  activityChanges, activityInput, activityLabel, agentStatusLabel, changeDiffIsCut, changeVerb, compactionSummary, currentAction, displayDiff, fenced, formatDuration, groupSummary, inputDetail,
  isTurnRecord, liveTurnId, nestActivities, openActivityLabel, statusText, timingNote, turnHeadline, type ActivityGroup, type ActivityNode, type TurnChange,
  activityLeadKind, spokenActivity, type ActivityLabel, type ActivityLeadKind,
} from './threadActivityView'
import { useActivityBodies, useActivityBody } from './activityBodies'
import { CutCode, CutProse } from './ActivityBody'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { shownCount } from './interfaceWords'
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
  useInterfaceLanguageState()
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
 * Escape inside an open disclosure, on its button or anywhere in what it shows, folds it and leaves focus on its
 * button. The innermost open one answers first; a folded one leaves Escape to whatever holds it, such as a pane beside
 * Watcher, which closes. Set on the element whose first child is the disclosure's button.
 */
export function foldOnEscape(open: boolean, fold: (summary: HTMLElement) => void): (event: React.KeyboardEvent<HTMLElement>) => void {
  return event => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    const summary = event.currentTarget.querySelector<HTMLElement>(':scope > button[aria-expanded]')
    if (summary === null) return
    event.preventDefault()
    summary.focus()
    fold(summary)
  }
}

/**
 * What a finished turn left behind. The count stays in view while the work is folded, because the files
 * a turn changed are what a reader comes back for; the diffs are the ones the provider reported.
 */
export function TurnChangedFiles({ changes, onDisclosure }: {
  readonly changes: readonly TurnChange[]
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}): ReactNode {
  useInterfaceLanguageState()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // A diff its host sent cut is read whole when the list opens, from the same answer its Edit row reads.
  const sources = [...new Set(changes.flatMap(change => change.sources ?? []).flatMap(source => source ? [source.record] : []))]
  const views = new Map(useActivityBodies(sources, open).map(view => [view.sent, view]))
  if (!changes.length) return null
  const count = changes.length
  const label = plural(count, { one: `Changed ${{ files: shownCount(count) }} file`, other: `Changed ${{ files: shownCount(count) }} files` })
  return <div className="thread-changes" data-expanded={open || undefined} onKeyDown={foldOnEscape(open, summary => { onDisclosure?.(summary); setOpen(false) })}>
    <button type="button" className="thread-changes__summary tt-focusable" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      onClick={event => { onDisclosure?.(event.currentTarget); setOpen(value => !value) }}>
      <FilePen className="thread-activity__icon" size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
      <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" />
    </button>
    {open ? <ul id={bodyId} className="thread-changes__list" aria-label={label}>
      {changes.map(change => <li key={change.path}>
        <p className="thread-activity__fact">{change.verb} <code>{change.path}</code></p>
        {change.diffs.map((diff, index) => {
          const source = change.sources?.[index], view = source && views.get(source.record)
          if (!source || !view) return <MessageContent key={index} text={fenced(displayDiff(diff), 'diff')} />
          const whole = view.state === 'loaded' ? activityChanges(view.record)[source.index]?.diff ?? diff : diff
          return <CutCode key={index} view={view} kind="diff" text={displayDiff(whole)} language="diff" cut />
        })}
      </li>)}
    </ul> : null}
  </div>
}

/**
 * Words for a turn that has reported nothing yet. They say only that the agent is still going: Sotto
 * cannot see inside a provider's turn, so no word here claims to know what it is thinking about.
 */
// A short turn only ever shows the first word, so that one still reads as work; the rest are for the longer waits.
// Lines from the film Spaceballs. A translation may keep a line in English or use the film's own dubbed line.
const WORKING_WORDS: readonly MessageDescriptor[] = [
  msg({ message: 'Combing the desert', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Winding up the Schwartz', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Going to plaid', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Ludicrous speed', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Consulting Yogurt', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Checking Mr. Radar', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Cracking 1-2-3-4-5', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Getting to now, now', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Raising the air shield', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Canning the Perri-air', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Waking Barf', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Scanning for Druidia', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Merchandising', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
  msg({ message: 'Prepping for light speed', comment: 'A joke from the film Spaceballs, shown while an agent works. Keep it short and playful.' }),
]
const WORD_MS = 3800
const FADE_MS = 220

/** Changes its own word instead of re-rendering the transcript, and never repeats the word it is replacing. */
function WorkingWord(): ReactNode {
  const { t } = useLingui()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let current = 0
    const timer = window.setInterval(() => {
      const node = ref.current
      if (!node) return
      current = (current + 1 + Math.floor(Math.random() * (WORKING_WORDS.length - 1))) % WORKING_WORDS.length
      node.textContent = i18n._(WORKING_WORDS[current]!)
      const still = document.documentElement.dataset.reducedMotion === 'on' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
      if (!still) node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' })
    }, WORD_MS)
    return () => window.clearInterval(timer)
  }, [])
  // The word is decoration over one unchanging fact, so assistive tech hears that fact once instead of every change.
  return <>
    <span ref={ref} className="thread-activity-live__word" aria-hidden="true">{t(WORKING_WORDS[0]!)}</span>
    <span className="tt-visually-hidden">{t({ message: 'Working', comment: 'A turn that is running.' })}</span>
  </>
}

/** A finished subagent whose provider sent no result says so, instead of opening to nothing. */
function missingAgentOutput(record: AgentActivity): boolean {
  // Output its host kept back is there, at its whole size, even when none of it came with the record.
  return record.kind === 'subagent' && isTerminalActivity(record.status) && !record.output && record.cut?.output === undefined && !record.error && !record.agents?.some(agent => agent.message)
}

function hasDetails(record: AgentActivity): boolean {
  return Boolean(record.command || record.cwd || record.output || record.error || record.text || record.changes?.length || record.steps?.length || record.agents?.length || record.truncated || record.cut)
    || missingAgentOutput(record)
}

const STEP_LABELS: Record<string, MessageDescriptor> = {
  completed: msg({ message: 'Done', context: 'plan step', comment: 'A plan step\'s state.' }),
  running: msg({ message: 'In progress', comment: 'A plan step\'s state.' }),
  pending: msg({ message: 'To do', comment: 'A plan step\'s state.' }),
}

/** The plan as the provider last reported it. Sotto shows its state; only the provider can change it. */
function PlanSteps({ record }: { readonly record: AgentActivity }): ReactNode {
  const { t } = useLingui()
  const steps = record.steps ?? []
  const done = steps.filter(step => step.status === 'completed').length, total = steps.length
  return <ol className="thread-activity__steps" aria-label={t`Plan, ${{ done: shownCount(done) }} of ${{ total: shownCount(total) }} done`}>
    {steps.map((step, index) => <li key={`${index}:${step.text}`} data-status={step.status}>
      <span className="thread-activity__step-mark" aria-hidden="true" />
      <span className="thread-activity__step-text">{step.text}</span>
      <span className="tt-visually-hidden">{Object.hasOwn(STEP_LABELS, step.status) ? t(STEP_LABELS[step.status]!) : step.status}</span>
    </li>)}
  </ol>
}

function ActivityDetails({ record: sent, provider, connected }: { readonly record: AgentActivity; readonly provider: string; readonly connected: boolean }): ReactNode {
  // A remote row whose host kept its long bodies back reads the record whole now that it is open (ADR-0025, October 18
  // amendment), and draws the part it was sent until then. Every other row draws exactly as it always has.
  // Only a body the row draws is worth the link: cut input that a command or an edit leaves out is not asked for.
  const sentParsed = activityInput(sent) !== null
  const textShown = sent.cut?.text !== undefined && !(sentParsed && (sent.kind === 'command' || sent.kind === 'file-change'))
  const needed = sent.cut !== undefined && (sent.cut.output !== undefined || textShown || activityChanges(sent).some((_, index) => changeDiffIsCut(sent, index)))
  const { t } = useLingui()
  const body = useActivityBody(sent, needed)
  const record = body.record, cut = body.state === 'whole' ? undefined : sent.cut
  const notes = [timingNote(record, provider), record.truncated ? t`Some details were not kept.` : ''].filter(Boolean)
  const cwd = record.cwd
  // Native tool input arrives as JSON: it reads formatted, and is left out where the command or diff already shows it.
  const parsed = activityInput(record) !== null
  const text = parsed ? inputDetail(record) : record.text
  const json = parsed && record.kind !== 'command'
  // Cut input matters only where the row shows it: a command shows its description and an edit its diff instead.
  const cutText = cut !== undefined && textShown
  return <div className="thread-activity__details">
    {record.steps?.length ? <PlanSteps record={record} /> : null}
    {record.command ? <MessageContent text={fenced(record.command, 'command')} /> : null}
    {cwd ? <p className="thread-activity__fact tt-paragraph"><Trans comment="Before the folder a command ran in.">In <code dir="ltr">{cwd}</code></Trans></p> : null}
    {cutText ? record.kind === 'reasoning' || !json
      ? <CutProse view={body} kind={record.kind === 'reasoning' ? 'thinking' : 'text'} text={text ?? ''} cut />
      : <CutCode view={body} kind="input" text={text ?? ''} language="json" cut />
      : text ? record.kind === 'reasoning'
        ? <MessageContent text={text} />
        : json ? <MessageContent text={fenced(text, 'json')} /> : <p className="thread-activity__text">{text}</p> : null}
    {activityChanges(record).map((change, index, changes) => <div className="thread-activity__change" key={`${change.path}:${index}`}>
      {/* A single changed file is already named by its row; a tool's files are what it touched. */}
      {changes.length > 1 || record.kind !== 'file-change' ? <p className="thread-activity__fact">{changeVerb(change.kind)} <code>{change.path}</code></p> : null}
      {cut && changeDiffIsCut(sent, index)
        ? <CutCode view={body} kind="diff" text={displayDiff(change.diff ?? '')} language="diff" cut />
        : change.diff ? <MessageContent text={fenced(displayDiff(change.diff), 'diff')} /> : null}
    </div>)}
    {/* A workflow's own entry stands for its run; the list is its agents. */}
    {record.agents?.some(agent => agent.kind !== 'workflow') ? <ol className="thread-activity__agents" aria-label={t`Agents`} data-connected={connected || undefined}>
      {record.agents.filter(agent => agent.kind !== 'workflow').map((agent, index) => {
        const number = index + 1
        return <li key={agent.id} data-status={agent.status}>
          <span className="thread-activity__agent">{t({ message: `Agent ${{ number: shownCount(number) }}`, comment: 'One of the background agents a step started, numbered from 1.' })}</span>
          <span className="thread-activity__agent-status">{agentStatusLabel(agent.status)}</span>
          {agent.message ? <span className="thread-activity__agent-message">{agent.message}</span> : null}
        </li>
      })}
    </ol> : null}
    {cut?.output !== undefined
      // Held output opens at its end, before and after the rest arrives.
      ? <CutCode view={body} kind="output" text={record.output ?? ''} language="output" cut />
      : record.output ? <MessageContent text={fenced(record.output, 'output')} /> : null}
    {record.error ? <p className="thread-activity__error">{record.error}</p> : null}
    {missingAgentOutput(record) ? <p className="thread-activity__fact tt-paragraph"><Trans comment="{provider} is the provider's name, such as Codex.">{provider} did not report this agent’s result.</Trans></p> : null}
    {notes.length ? <p className="thread-activity__fact">{notes.join(' · ')}</p> : null}
  </div>
}

const ActivityRow = memo(function ActivityRow({ node, connected, provider, quietUnknown, onDisclosure }: {
  readonly node: ActivityNode; readonly connected: boolean; readonly provider: string
  /** The group heading already says the outcome is unknown; the row keeps it for assistive tech only. */
  readonly quietUnknown: boolean
  readonly onDisclosure?: ((element: HTMLElement) => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const { record, children } = node
  const count = children.length
  const steps = count ? plural(count, { one: `${{ files: shownCount(count) }} step`, other: `${{ files: shownCount(count) }} steps` }) : ''
  const base = activityLabel(record)
  const label = steps ? { ...base, preview: [base.preview, steps].filter(Boolean).join(' · ') } : base
  const shown = open ? { ...openActivityLabel(record), preview: steps } : label
  const status = statusText(record, connected)
  const Icon = record.status === 'failed' ? CircleAlert : ICONS[record.kind]
  const running = record.status === 'running'
  const expandable = hasDetails(record) || children.length > 0
  const spoken = [spokenActivity(activityLeadKind(record), label), label.preview,
    record.status === 'completed' ? status ? t({ message: `completed in ${status}`, comment: 'Read aloud after an action\'s name: how long it took.' }) : t({ message: 'completed', comment: 'Read aloud after an action\'s name.' }) : status].filter(Boolean).join(', ')
  const subject = label.subject
  const body = <>
    <Icon className="thread-activity__icon" size={15} strokeWidth={1.8} aria-hidden="true" />
    <span className="thread-activity__label">
      <ActivityWords kind={activityLeadKind(record, open)} label={shown} subjectClass={shown.mono ? 'thread-activity__subject thread-activity__subject--mono' : 'thread-activity__subject'} />
      {shown.preview ? <span className="thread-activity__preview"> {shown.preview}</span> : null}
    </span>
    <span className="thread-activity__meta" data-status={record.status} data-connected={connected || undefined}>
      {running ? <i className="thread-activity__pulse" data-connected={connected || undefined} aria-hidden="true" /> : null}
      {quietUnknown && record.status === 'unknown' ? null : status}
      {running && connected && record.startedAt ? <> <Elapsed startedAt={record.startedAt} /></> : null}
    </span>
    {expandable ? <ChevronRight className="thread-activity__chevron" size={14} aria-hidden="true" /> : null}
  </>
  return <li className="thread-activity__row" data-kind={record.kind} data-status={record.status} data-open={open || undefined}
    onKeyDown={foldOnEscape(open, summary => { onDisclosure?.(summary); setOpen(false) })}>
    {expandable
      ? <button type="button" className="thread-activity__toggle tt-focusable" aria-expanded={open} aria-controls={open ? detailId : undefined} aria-label={spoken}
        onClick={event => { onDisclosure?.(event.currentTarget); setOpen(value => !value) }}>{body}</button>
      : <div className="thread-activity__toggle" role="group" aria-label={spoken}>{body}</div>}
    {open ? <div id={detailId} className="thread-activity__open">
      {hasDetails(record) ? <ActivityDetails record={record} provider={provider} connected={connected} /> : null}
      {children.length ? <ul className="thread-activity__rows thread-activity__rows--nested" aria-label={t({ message: `Steps in ${subject}`, comment: '{subject} is the name of the action the steps belong to.' })}>
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
  const { t } = useLingui()
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
  const name = [headline, summary].filter(Boolean).join(', ') || t({ message: 'Activity', comment: 'A group of work an agent did, when it has no summary.' })
  // A failed turn's own group is where a press that opens the thread at its failed turn lands.
  return <section className="thread-activity" data-turn-id={group.turnId} data-live={live || undefined} data-expanded={expanded || undefined}
    data-turn-outcome={group.turn?.status === 'failed' ? 'failed' : undefined}
    aria-label={name} onKeyDown={foldOnEscape(canFold && expanded, summary => { onDisclosure?.(summary); setChoice(false) })}>
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
        onClick={event => { onDisclosure?.(event.currentTarget); setShowAll(true) }}><Trans comment="Shows the rows of work above the newest ones.">Show {earlier} earlier</Trans></button></li> : null}
      {rows.map(node => <ActivityRow key={node.record.id} node={node} connected={connected} provider={provider} quietUnknown={(group.turn?.status ?? outcome) === 'unknown'} onDisclosure={onDisclosure} />)}
    </ul> : null}
  </section>
})

/**
 * One line at the end of a running turn: how long it has run and what it is doing now. The current
 * action is left out when it is the row directly above, so the line never repeats it.
 */
export function LiveActivity({ thread, connected, adjacentRecordId, sendingSince }: {
  readonly thread: Pick<AgentThread, 'status' | 'activities' | 'messages'> & Partial<Pick<AgentThread, 'compaction'>>; readonly connected: boolean
  /** The last activity row rendered immediately before this line, if any. */
  readonly adjacentRecordId?: string | undefined
  /**
   * When the user pressed Send, while that prompt is still on its way. The wait starts being shown
   * there rather than at the provider's first word; its own running turn takes the line over as soon as it arrives.
   */
  readonly sendingSince?: string | undefined
}): ReactNode {
  const { t } = useLingui()
  // Compaction holds the thread in the running state without a turn of its own, and a line saying the agent
  // is working would be the wrong thing to read while the only thing happening is the context being folded up.
  if (thread.compaction?.status === 'running') {
    return <div className="thread-activity-live" data-testid="thread-activity-live" data-connected={connected || undefined}>
      <i className="thread-activity__pulse" data-connected={connected || undefined} aria-hidden="true" />
      <span className="thread-activity-live__state" role="status">{connected ? t`Compacting context` : t`Last seen compacting context`}</span>
    </div>
  }
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
      {!connected ? t`Last seen working`
        : startedAt
          ? label
            ? <Trans comment="A turn that is running, and for how long.">Working for <Elapsed startedAt={startedAt} /></Trans>
            : <Trans comment="A playful word for a turn that is running, and for how long."><WorkingWord /> for <Elapsed startedAt={startedAt} /></Trans>
          : label ? t({ message: 'Working', comment: 'A turn that is running.' }) : <WorkingWord />}
    </span>
    {label ? <span className="thread-activity-live__action">
      <ActivityWords kind={action ? activityLeadKind(action) : null} label={label} subjectClass={label.mono ? 'thread-activity__subject--mono' : undefined} plain />
    </span> : null}
  </div>
}

/**
 * A row's verb and subject as one message, so a language puts the path where its grammar wants it (ADR-0123). A path
 * or command keeps its own left-to-right box inside the sentence. `plain` leaves the verb in the line's own colour.
 */
function ActivityWords({ kind, label, subjectClass, plain = false }: {
  readonly kind: ActivityLeadKind | null
  readonly label: Pick<ActivityLabel, 'lead' | 'subject' | 'mono'>
  readonly subjectClass: string | undefined
  readonly plain?: boolean
}): ReactNode {
  const subject = <span className={subjectClass} {...(label.mono ? { dir: 'ltr' } : {})}>{label.subject}</span>
  const words = kind === 'created' ? <Trans comment="A file change; {subject} is the file's path.">Created {subject}</Trans>
    : kind === 'deleted' ? <Trans comment="A file change; {subject} is the file's path.">Deleted {subject}</Trans>
      : kind === 'edited' ? <Trans comment="A file change; {subject} is the file's path.">Edited {subject}</Trans>
        : kind === 'moved' ? <Trans comment="A file change; {subject} is the file's path.">Moved {subject}</Trans>
          : kind === 'wrote' ? <Trans comment="A file change; {subject} is the file's path.">Wrote {subject}</Trans>
            : kind === 'changed' ? <Trans comment="An open change of several files; {subject} is how many, such as 3 files.">Changed {subject}</Trans>
              : null
  if (words === null) return <>{label.lead ? plain ? `${label.lead} ` : <span className="thread-activity__lead">{label.lead} </span> : null}{subject}</>
  return plain ? words : <span className="thread-activity__lead">{words}</span>
}

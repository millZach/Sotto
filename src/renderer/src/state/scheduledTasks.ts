import { useEffect, useState } from 'react'
import type { ScheduledTasksBridge, ScheduledTasksState, TaskSpec } from '../../../shared/scheduledTasks'
import type { TaskSchedule } from '../../../shared/taskSchedules'

/** The window's scheduled tasks bridge, present only while the `scheduled-tasks` Owl feature is on (ADR-0218). */
export const scheduledTasksBridge = (): ScheduledTasksBridge | undefined => window.sotto?.scheduledTasks

/**
 * Scheduled tasks' state, read once and again whenever main says a task, a run or a playbook changed. Undefined until
 * the first read answers, or while `reading` is false.
 */
export function useScheduledTasks(reading: boolean, bridge: ScheduledTasksBridge | undefined = scheduledTasksBridge()): ScheduledTasksState | undefined {
  const [state, setState] = useState<ScheduledTasksState | undefined>(undefined)
  useEffect(() => {
    if (!reading || !bridge) { setState(undefined); return }
    let live = true
    const stop = bridge.onChanged(next => { if (live) setState(next) })
    void bridge.read().then(next => { if (live) setState(next) }, () => undefined)
    return () => { live = false; stop() }
  }, [reading, bridge])
  return state
}

/** This computer's time zone, as a task's weekly schedule names it. */
export const localTimeZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** `HH:MM` clock times from what the user typed, such as `9:00, 17:30`; null when one can't be read. */
export function parseClockTimes(text: string): string[] | null {
  const parts = text.split(/[,;\s]+/u).filter(Boolean)
  if (parts.length === 0) return null
  const times: string[] = []
  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(part)
    if (!match) return null
    const hour = Number(match[1]), minute = Number(match[2])
    if (hour > 23 || minute > 59) return null
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (!times.includes(time)) times.push(time)
  }
  return times.sort()
}

/** A `datetime-local` field's value for an instant, in this computer's time. */
export function localDateTimeValue(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The kinds of schedule the editor offers, `none` for a task that only a webhook, GitHub or Run now starts. */
export type ScheduleKind = 'none' | TaskSchedule['kind']

/** What the editor holds while the user writes a task: strings as typed, turned into a spec on Save. */
export interface TaskDraft {
  readonly name: string
  readonly workKind: 'prompt' | 'playbook'
  readonly prompt: string
  readonly playbookId: string
  readonly inputs: Readonly<Record<string, string>>
  readonly targetKind: 'new-thread' | 'thread'
  readonly projectId: string
  readonly modelId: string
  readonly reasoningEffort: string
  readonly runtimeMode: string
  readonly workingCopy: 'shared' | 'independent'
  readonly threadId: string
  readonly scheduleKind: ScheduleKind
  readonly onceAt: string
  readonly everyAmount: string
  readonly everyUnit: 'minutes' | 'hours' | 'days'
  readonly everyFrom?: string | undefined
  readonly days: readonly number[]
  readonly times: string
  readonly timeZone: string
  readonly missed: TaskSpec['missed']
  readonly overlap: TaskSpec['overlap']
  readonly webhook: boolean
  readonly github: boolean
  readonly githubIssues: boolean
  readonly githubPullRequests: boolean
  readonly githubRepository: string
  readonly githubLabel: string
}

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const

/** A new task's draft: tomorrow at nine on weekdays, in this computer's zone, against the first project and model offered. */
export function emptyDraft(now: number, defaults: { readonly projectId?: string | undefined; readonly modelId?: string | undefined; readonly playbookId?: string | undefined }): TaskDraft {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  return {
    name: '', workKind: 'prompt', prompt: '', playbookId: defaults.playbookId ?? '', inputs: {},
    targetKind: 'new-thread', projectId: defaults.projectId ?? '', modelId: defaults.modelId ?? '', reasoningEffort: '', runtimeMode: '', workingCopy: 'shared', threadId: '',
    scheduleKind: 'weekly', onceAt: localDateTimeValue(tomorrow.getTime()), everyAmount: '1', everyUnit: 'hours', days: [1, 2, 3, 4, 5], times: '09:00', timeZone: localTimeZone(),
    missed: 'run-once', overlap: 'skip', webhook: false, github: false, githubIssues: true, githubPullRequests: false, githubRepository: '', githubLabel: '',
  }
}

/** An existing task's draft, so the editor opens on what is saved. */
export function draftOf(spec: TaskSpec, now: number): TaskDraft {
  const base = emptyDraft(now, {})
  const schedule = spec.schedule
  const every = schedule?.kind === 'every' ? schedule.minutes : undefined
  const unit = every === undefined ? base.everyUnit : every % 1440 === 0 ? 'days' : every % 60 === 0 ? 'hours' : 'minutes'
  return {
    ...base,
    name: spec.name,
    workKind: spec.work.kind,
    prompt: spec.work.kind === 'prompt' ? spec.work.prompt : '',
    playbookId: spec.work.kind === 'playbook' ? spec.work.playbookId : '',
    inputs: spec.work.kind === 'playbook' ? Object.fromEntries(Object.entries(spec.work.inputs ?? {}).map(([key, value]) => [key, String(value)])) : {},
    targetKind: spec.target.kind,
    projectId: spec.target.kind === 'new-thread' ? spec.target.projectId : '',
    modelId: spec.target.kind === 'new-thread' ? spec.target.modelId : '',
    reasoningEffort: spec.target.kind === 'new-thread' ? spec.target.reasoningEffort ?? '' : '',
    runtimeMode: spec.target.kind === 'new-thread' ? spec.target.runtimeMode ?? '' : '',
    workingCopy: spec.target.kind === 'new-thread' ? spec.target.workingCopy : 'shared',
    threadId: spec.target.kind === 'thread' ? spec.target.threadId : '',
    scheduleKind: schedule?.kind ?? 'none',
    onceAt: schedule?.kind === 'once' ? localDateTimeValue(Date.parse(schedule.at)) : base.onceAt,
    everyAmount: every === undefined ? base.everyAmount : String(every / UNIT_MINUTES[unit]),
    everyUnit: unit,
    everyFrom: schedule?.kind === 'every' ? schedule.from : undefined,
    days: schedule?.kind === 'weekly' ? schedule.days : base.days,
    times: schedule?.kind === 'weekly' ? schedule.times.join(', ') : base.times,
    timeZone: schedule?.kind === 'weekly' ? schedule.timeZone : base.timeZone,
    missed: spec.missed, overlap: spec.overlap, webhook: spec.webhook,
    github: spec.github !== null,
    githubIssues: spec.github?.issues ?? true, githubPullRequests: spec.github?.pullRequests ?? false,
    githubRepository: spec.github?.repository ?? '', githubLabel: spec.github?.label ?? '',
  }
}

/** Why a draft can't be saved, as a key the editor says in words, or its spec. */
export type DraftProblem = 'name' | 'prompt' | 'playbook' | 'project' | 'model' | 'thread' | 'once-at' | 'every' | 'days' | 'times' | 'github-kinds' | 'repository' | 'input'

export function specOf(draft: TaskDraft, now: number, inputTypes: Readonly<Record<string, 'string' | 'number' | 'boolean'>>): { readonly spec: TaskSpec } | { readonly problem: DraftProblem; readonly input?: string } {
  const name = draft.name.trim()
  if (!name) return { problem: 'name' }
  let work: TaskSpec['work']
  if (draft.workKind === 'prompt') {
    if (!draft.prompt.trim()) return { problem: 'prompt' }
    work = { kind: 'prompt', prompt: draft.prompt.trim() }
  } else {
    if (!draft.playbookId) return { problem: 'playbook' }
    const inputs: Record<string, string | number | boolean> = {}
    for (const [key, text] of Object.entries(draft.inputs)) {
      const type = inputTypes[key]
      if (!type || text.trim() === '') continue
      if (type === 'number') { const value = Number(text); if (!Number.isFinite(value)) return { problem: 'input', input: key }; inputs[key] = value }
      else if (type === 'boolean') inputs[key] = text === 'true'
      else inputs[key] = text
    }
    work = { kind: 'playbook', playbookId: draft.playbookId, ...Object.keys(inputs).length ? { inputs } : {} }
  }
  let target: TaskSpec['target']
  if (draft.targetKind === 'thread' && draft.workKind === 'prompt') {
    if (!draft.threadId) return { problem: 'thread' }
    target = { kind: 'thread', threadId: draft.threadId }
  } else {
    if (!draft.projectId) return { problem: 'project' }
    if (!draft.modelId) return { problem: 'model' }
    target = { kind: 'new-thread', projectId: draft.projectId, modelId: draft.modelId, workingCopy: draft.workingCopy,
      ...draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {},
      ...draft.runtimeMode ? { runtimeMode: draft.runtimeMode as NonNullable<Extract<TaskSpec['target'], { kind: 'new-thread' }>['runtimeMode']> } : {} }
  }
  let schedule: TaskSchedule | null = null
  if (draft.scheduleKind === 'once') {
    const at = Date.parse(draft.onceAt)
    if (!Number.isFinite(at) || at <= now) return { problem: 'once-at' }
    schedule = { kind: 'once', at: new Date(at).toISOString() }
  } else if (draft.scheduleKind === 'every') {
    const minutes = Math.round(Number(draft.everyAmount) * UNIT_MINUTES[draft.everyUnit])
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 40_320) return { problem: 'every' }
    schedule = { kind: 'every', minutes, from: draft.everyFrom ?? new Date(now).toISOString() }
  } else if (draft.scheduleKind === 'weekly') {
    if (draft.days.length === 0) return { problem: 'days' }
    const times = parseClockTimes(draft.times)
    if (!times || times.length > 12) return { problem: 'times' }
    schedule = { kind: 'weekly', days: [...draft.days].sort((a, b) => a - b), times, timeZone: draft.timeZone || localTimeZone() }
  }
  let github: TaskSpec['github'] = null
  if (draft.github) {
    if (!draft.githubIssues && !draft.githubPullRequests) return { problem: 'github-kinds' }
    const repository = draft.githubRepository.trim()
    if (repository && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u.test(repository)) return { problem: 'repository' }
    github = { issues: draft.githubIssues, pullRequests: draft.githubPullRequests, ...repository ? { repository } : {}, ...draft.githubLabel.trim() ? { label: draft.githubLabel.trim() } : {} }
  }
  return { spec: { name, work, target, schedule, missed: draft.missed, overlap: draft.overlap, webhook: draft.webhook, github } }
}

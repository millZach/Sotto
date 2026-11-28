import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { plural, t } from '@lingui/core/macro'
import type { AgentHostSnapshot } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { bindInputs, PLAYBOOK_FORMAT, PLAYBOOK_OUTPUT_BYTES_MAX, stepTitle, type Playbook, type PlaybookValue } from '../../shared/playbooks'
import {
  RUN_VIEWS_MAX, TASK_RUNS_AT_ONCE, TASK_RUNS_KEPT, TASKS_MAX, webhookPath, type PlaybookView, type RunView, type ScheduledTaskCommand, type ScheduledTaskResult,
  type ScheduledTasksState, type TaskProblem, type TaskSpec, type TaskTrigger, type TaskView,
} from '../../shared/scheduledTasks'
import { isTimeZone, OCCURRENCE_COUNT_MAX } from '../../shared/taskSchedules'
import type { Authority } from '../agents/authority'
import type { AgentCredentials } from '../agents/credentials'
import { runGitStatusCommand, type RunGitCommand } from '../agents/git/gitStatus'
import { runCodeStep, type CodeRunner } from './codeSteps'
import { GITHUB_POLL_MS, GitHubReadError, projectRepository, readGitHubEvents, type GitHubEvent } from './githubEvents'
import { addExamplePlaybook, playbooksFolder, readPlaybooks, type PlaybookFile } from './playbookFiles'
import { emptyTaskFile, SEEN_KEYS_MAX, TaskStore, type RunTarget, type StoredRun, type StoredTask, type TaskFile } from './taskRecords'
import { currentStep, TaskRuns, type AutomationCoordinator, type AutomationHost } from './taskRuns'
import { nextDue, scheduleDue, scheduleKey, SCHEDULER_WAKE_MAX_MS } from './taskTiming'
import { WebhookListener, type WebhookDelivery } from './taskWebhooks'

/**
 * Scheduled tasks on this computer (ADR-0218, the Owl feature `scheduled-tasks`). The host that runs a task owns it:
 * this service keeps every task in `scheduled-tasks.json`, reads the clock for their schedules, takes their webhooks
 * and asks GitHub for their issues and pull requests, makes each run and hands it to `TaskRuns`. Settings' **Run
 * scheduled tasks** switch turns starting on and off; off, nothing starts and every task and run is kept, and turned
 * back on, a time that passed meanwhile counts as missed. A trigger is known by its key, so one that comes twice starts
 * one run. It logs stable event names only: never a prompt, a payload, a secret or a task's name.
 */

export interface ScheduledTaskServiceOptions {
  /** Sotto's data folder, where `scheduled-tasks.json` and the playbooks folder are. */
  readonly directory: string
  readonly control: AutomationCoordinator
  readonly host: AutomationHost
  readonly enabled: () => boolean
  readonly historyEnabled: () => boolean
  readonly credentials?: Pick<AgentCredentials, 'available' | 'has' | 'get' | 'set'> | undefined
  readonly clipboard?: ((text: string) => Promise<void>) | undefined
  readonly openPath?: ((path: string) => Promise<string>) | undefined
  readonly authority?: Pick<Authority, 'authorizes'> | undefined
  readonly runGit?: RunGitCommand
  readonly runCode?: CodeRunner
  /** False keeps the webhook listener from starting, as a test that posts nothing wants. */
  readonly webhooks?: boolean
  readonly now?: () => number
  readonly newId?: () => string
  readonly schedule?: (callback: () => void, delay: number) => () => void
  readonly log?: (code: string) => void
}

const iso = (at: number): string => new Date(at).toISOString()
const secretSlot = (taskId: string): string => `scheduled-task-webhook:${taskId}`
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export class ScheduledTaskService {
  private file: TaskFile = emptyTaskFile()
  private storageProblem: string | undefined
  private playbooks: PlaybookFile[] = []
  private playbookRead: Promise<void> | undefined
  private readonly store: TaskStore
  private readonly runs: TaskRuns
  private readonly listeners = new Set<(state: ScheduledTasksState) => void>()
  private readonly clock: () => number
  private readonly newId: () => string
  private readonly schedule: (callback: () => void, delay: number) => () => void
  private readonly runGit: RunGitCommand
  private webhook: WebhookListener | undefined
  private webhookProblem: string | undefined
  private cancelTick: (() => void) | undefined
  private cancelPoll: (() => void) | undefined
  private wakeAt: number | undefined
  private polling = false
  private unhook: (() => void) | undefined
  private closed = false
  private readonly pendingWork = new Set<Promise<unknown>>()

  constructor(private readonly options: ScheduledTaskServiceOptions) {
    this.clock = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, Math.max(0, delay)); timer.unref?.(); return () => clearTimeout(timer) })
    this.runGit = options.runGit ?? runGitStatusCommand
    this.store = new TaskStore(options.directory)
    this.runs = new TaskRuns({
      control: options.control, host: options.host, runCode: options.runCode ?? runCodeStep, authority: options.authority,
      now: () => this.clock(), newId: () => this.newId(), enabled: () => this.running(), historyEnabled: options.historyEnabled,
      task: id => this.task(id), save: () => this.save(), changed: () => this.changed(), freed: () => this.startQueued(),
      wake: at => this.wake(at),
    })
  }

  private running(): boolean { return !this.closed && this.storageProblem === undefined && this.options.enabled() }
  private task(id: string): StoredTask | undefined { return this.file.tasks.find(task => task.id === id) }
  private log(code: string): void { this.options.log?.(code) }

  /** Reads the file and the playbooks, follows the coordinator, and starts the clock while scheduled tasks are on. */
  async recover(): Promise<void> {
    const read = await this.store.read()
    if ('problem' in read) {
      this.storageProblem = read.problem === 'newer'
        ? t`Scheduled tasks were saved by a newer Sotto. Their file was kept unchanged. Update Sotto to see and change them.`
        : t`The scheduled tasks file could not be read. It was kept unchanged, and nothing can be saved until it is fixed or moved away.`
      this.log('scheduled-tasks-unreadable')
    } else this.file = read.file
    this.playbooks = await readPlaybooks(playbooksFolder(this.options.directory)).catch(() => [])
    this.runs.recover(this.file.runs)
    this.unhook = this.options.control.useAutomation(this.runs.hooks())
    if (!this.storageProblem) await this.save()
    this.settingsChanged()
  }

  /** The switch moved, or Sotto started: the clock, the webhook listener and GitHub's reads follow it. */
  settingsChanged(): void {
    if (this.closed) return
    if (this.running()) {
      this.tick()
      this.pollSoon(0)
      for (const run of this.file.runs) if (run.state === 'running') this.runs.kick(run)
    } else {
      this.cancelTick?.(); this.cancelTick = undefined; this.wakeAt = undefined
      this.cancelPoll?.(); this.cancelPoll = undefined
    }
    void this.track(this.syncWebhook()).catch(() => undefined)
    this.changed()
  }

  async close(): Promise<void> {
    this.closed = true
    this.cancelTick?.(); this.cancelPoll?.()
    this.unhook?.(); this.unhook = undefined
    await this.runs.close()
    await this.webhook?.close()
  }

  /** Done once the saves, sends and commands already under way have ended. */
  async settled(): Promise<void> {
    while (this.pendingWork.size) await Promise.allSettled(this.pendingWork)
    await this.runs.settled()
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const pending = work.finally(() => { this.pendingWork.delete(pending) })
    this.pendingWork.add(pending)
    return pending
  }

  onChanged(listener: (state: ScheduledTasksState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changedQueued = false
  private changed(): void {
    if (this.changedQueued || this.listeners.size === 0) return
    this.changedQueued = true
    queueMicrotask(() => {
      this.changedQueued = false
      const state = this.state()
      for (const listener of this.listeners) listener(state)
    })
  }

  private save(): Promise<void> {
    if (this.storageProblem) return Promise.reject(new Error(this.storageProblem))
    return this.store.write(() => this.file)
  }

  // The clock.

  private wake(at: number): void {
    if (!this.running()) return
    const delay = Math.min(Math.max(0, at - this.clock()), SCHEDULER_WAKE_MAX_MS)
    const when = this.clock() + delay
    if (this.cancelTick && this.wakeAt !== undefined && this.wakeAt <= when) return
    this.cancelTick?.()
    this.wakeAt = when
    this.cancelTick = this.schedule(() => { this.cancelTick = undefined; this.wakeAt = undefined; this.tick() }, delay)
  }

  /** Reads the clock: each task's due and missed times make their runs, waiting runs start, and the next wake is set. */
  tick(): void {
    if (!this.running()) return
    const now = this.clock()
    const playbookDue = this.file.tasks.some(task => {
      if (task.paused || task.spec.work.kind !== 'playbook') return false
      const at = nextDue(task.spec.schedule, Date.parse(task.evaluatedAt))
      return at !== null && at <= now
    })
    if (playbookDue) {
      void this.track(this.refreshPlaybooks().then(() => this.tickScheduled(now))).catch(() => undefined)
      return
    }
    this.tickScheduled(now)
  }

  private tickScheduled(now: number): void {
    if (!this.running()) return
    let dirty = false
    for (const task of this.file.tasks) {
      const schedule = task.spec.schedule
      if (task.paused || !schedule) continue
      const evaluated = Date.parse(task.evaluatedAt)
      // A task's clock only moves on: set back, nothing is due until it passes the last time read, so no time runs twice.
      if (now <= evaluated) continue
      const due = scheduleDue(schedule, task.spec.missed, evaluated, now)
      if (due.missed > 0) { this.recordMissed(task, due.missed, evaluated, now); dirty = true }
      if (due.run) { this.trigger(task, due.run.trigger, scheduleKey(due.run.dueAt), { dueAt: due.run.dueAt }); dirty = true }
      // Read up to now in memory every tick, and on disk with any run it made, so a restart counts only what truly passed.
      task.evaluatedAt = iso(now)
    }
    if (dirty) { void this.save().catch(() => undefined); this.changed() }
    this.startQueued()
    for (const run of this.file.runs) {
      const step = run.state === 'running' ? run.steps[currentStep(run)] : undefined
      if (step?.state === 'pending' && step.nextAttemptAt && Date.parse(step.nextAttemptAt) <= now) this.runs.kick(run)
    }
    let next = now + SCHEDULER_WAKE_MAX_MS
    for (const task of this.file.tasks) if (!task.paused) { const at = nextDue(task.spec.schedule, now); if (at !== null) next = Math.min(next, at) }
    for (const run of this.file.runs) {
      const step = run.state === 'running' ? run.steps[currentStep(run)] : undefined
      if (step?.state === 'pending' && step.nextAttemptAt) {
        const at = Date.parse(step.nextAttemptAt)
        if (at > now) next = Math.min(next, at)
      }
    }
    this.wake(next)
  }

  // Triggers.

  private seen(taskId: string, key: string): boolean { return (this.file.seen[taskId] ?? []).some(([seen]) => seen === key) }
  private markSeen(taskId: string, key: string): void {
    this.file.seen[taskId] = [[key, iso(this.clock())] as [string, string], ...this.file.seen[taskId] ?? []].slice(0, SEEN_KEYS_MAX)
  }

  private recordMissed(task: StoredTask, count: number, from: number, to: number): void {
    const key = `missed:${iso(from)}/${iso(to)}`
    this.addRun({ id: this.newId(), taskId: task.id, taskName: task.spec.name, key, trigger: 'missed', createdAt: iso(this.clock()), endedAt: iso(this.clock()),
      state: 'done', outcome: 'missed', missedCount: count, target: {}, steps: [],
      note: count >= OCCURRENCE_COUNT_MAX
        ? t`Sotto wasn't running scheduled tasks at ${OCCURRENCE_COUNT_MAX} or more of this task's times.`
        : plural(count, { one: 'Sotto wasn\'t running scheduled tasks at one of this task\'s times.', other: 'Sotto wasn\'t running scheduled tasks at # of this task\'s times.' }) })
  }

  /**
   * Makes a trigger's run, or says it was seen before. A trigger that comes while the task's last run is still going is
   * skipped, or waits as the one run in line, as the task says; Run now always waits in line.
   */
  private trigger(task: StoredTask, trigger: TaskTrigger, key: string, extra: {
    readonly dueAt?: number; readonly data?: Readonly<Record<string, unknown>>; readonly source?: 'webhook' | 'github'; readonly eventRef?: string
    readonly inputs?: Readonly<Record<string, PlaybookValue>>
  } = {}): { readonly run: StoredRun; readonly duplicate?: undefined } | { readonly run: StoredRun | undefined; readonly duplicate: true } {
    // A delivery or an issue seen before starts nothing again, though its run may have left the history. A scheduled
    // time needs no list: the task's clock only moves on. Run now's keys are new each time.
    if (this.seen(task.id, key)) return { run: this.file.runs.find(run => run.taskId === task.id && run.key === key), duplicate: true }
    if (trigger === 'webhook' || trigger === 'github') this.markSeen(task.id, key)
    const base = { id: this.newId(), taskId: task.id, taskName: task.spec.name, key, trigger, createdAt: iso(this.clock()), ...extra.dueAt !== undefined ? { dueAt: iso(extra.dueAt) } : {},
      ...extra.eventRef ? { eventRef: extra.eventRef.slice(0, 200) } : {}, target: this.runTarget(task.spec) }
    const active = this.file.runs.filter(run => run.taskId === task.id && run.state !== 'done')
    if (active.length && (active.some(run => run.state === 'queued') || trigger !== 'manual' && task.spec.overlap === 'skip')) {
      return { run: this.addRun({ ...base, state: 'done', outcome: 'skipped', endedAt: base.createdAt, steps: [],
        note: active.some(run => run.state === 'queued') ? t`Another run was already waiting to start.` : t`The last run was still going.` }) }
    }
    const made = this.definitionFor(task, extra)
    if ('problem' in made) return { run: this.addRun({ ...base, state: 'done', outcome: 'failed', endedAt: base.createdAt, steps: [], note: made.problem }) }
    return { run: this.addRun({ ...base, state: 'queued', ...made, steps: made.definition.steps.map(step => ({ id: step.id, state: 'pending' as const, attempts: 0 })) }) }
  }

  private runTarget(spec: TaskSpec): RunTarget {
    const target = spec.target
    return target.kind === 'thread' ? { threadId: target.threadId } : { projectId: target.projectId, modelId: target.modelId, workingCopy: target.workingCopy,
      ...target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}, ...target.runtimeMode ? { runtimeMode: target.runtimeMode } : {} }
  }

  /** What a run of the task runs: its prompt as one step, or its playbook's steps with their inputs bound. */
  private definitionFor(task: StoredTask, extra: { readonly data?: Readonly<Record<string, unknown>>; readonly source?: 'webhook' | 'github'; readonly inputs?: Readonly<Record<string, PlaybookValue>> }):
    Pick<StoredRun, 'definition' | 'literal' | 'playbook' | 'inputs' | 'outside' | 'source' | 'data'> & { definition: Playbook } | { readonly problem: string } {
    const work = task.spec.work
    if (work.kind === 'prompt') {
      const data = extra.data ? JSON.stringify(extra.data, null, 2) : undefined
      return { definition: { format: PLAYBOOK_FORMAT, name: task.spec.name, steps: [{ id: 'prompt', kind: 'agent', prompt: work.prompt }] }, literal: true,
        ...data !== undefined ? data.length <= PLAYBOOK_OUTPUT_BYTES_MAX ? { data, source: extra.source! } : { data: t`(What started this run was longer than 16 KB, so it was left out.)`, source: extra.source! } : {} }
    }
    const file = this.playbooks.find(item => item.id === work.playbookId)
    if (!file?.playbook || !file.revision) {
      const id = work.playbookId, problem = file?.problem ?? ''
      return { problem: file ? t`Its playbook can't be read: ${problem}` : t`Its playbook ${id} is not in the playbooks folder.` }
    }
    // A webhook's or GitHub's values fill only the inputs the playbook declares, and never one the user set.
    const own: Record<string, unknown> = { ...work.inputs, ...extra.inputs }
    const bound = bindInputs(file.playbook.inputs ?? {}, { ...extra.data, ...own })
    if (bound.problems.length) { const problems = bound.problems.join(' '); return { problem: t`Its inputs can't be filled: ${problems}` } }
    const data = extra.data
    const outside = data ? Object.keys(bound.inputs).filter(name => !Object.hasOwn(own, name) && Object.hasOwn(data, name) && data[name] !== undefined && data[name] !== null && data[name] !== '') : []
    return { definition: file.playbook, playbook: { id: file.id, revision: file.revision }, inputs: bound.inputs,
      ...outside.length ? { outside, source: extra.source! } : {} }
  }

  private addRun(run: StoredRun): StoredRun {
    if (run.note && run.note.length > 500) run.note = `${run.note.slice(0, 499)}…`
    this.file.runs.push(run)
    this.prune(run.taskId)
    this.runs.replaced(this.file.runs)
    return run
  }

  /** Keeps every run still going and the task's newest ended ones. */
  private prune(taskId: string): void {
    const ended = this.file.runs.filter(run => run.taskId === taskId && run.state === 'done').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const drop = new Set(ended.slice(TASK_RUNS_KEPT).map(run => run.id))
    if (drop.size) this.file.runs = this.file.runs.filter(run => !drop.has(run.id))
  }

  /** Starts waiting runs while slots last: a few at once in all, one per task, and a playbook's own limit. */
  private startQueued(): void {
    if (!this.running()) return
    let started = false
    let running = this.file.runs.filter(run => run.state === 'running').length
    for (const run of [...this.file.runs].filter(item => item.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (running >= TASK_RUNS_AT_ONCE) break
      const task = this.task(run.taskId)
      if (!task || (task.paused && !run.startedAt)) continue
      if (this.file.runs.some(other => other !== run && other.taskId === run.taskId && other.state !== 'done' && other.state !== 'queued')) continue
      if (run.playbook) {
        const limit = run.definition?.concurrency ?? 1
        if (this.file.runs.filter(other => other.playbook?.id === run.playbook!.id && (other.state === 'running' || other.state === 'waiting')).length >= limit) continue
      }
      running++; started = true
      this.runs.start(run)
    }
    if (started) this.changed()
  }

  // GitHub.

  private pollSoon(delay: number): void {
    this.cancelPoll?.()
    if (!this.running() || !this.file.tasks.some(task => task.spec.github && !task.paused)) { this.cancelPoll = undefined; return }
    this.cancelPoll = this.schedule(() => { this.cancelPoll = undefined; void this.track(this.pollGitHub()).catch(() => undefined) }, delay)
  }

  /** Asks GitHub, through gh, for each GitHub trigger's new issues and pull requests, and makes a run for each. */
  async pollGitHub(): Promise<void> {
    if (this.polling || !this.running()) return
    this.polling = true
    try {
      const snapshot = this.options.control.watcherSnapshot()
      for (const task of this.file.tasks) {
        const spec = task.spec
        const github = spec.github
        if (!github || task.paused || !this.running()) continue
        const folder = this.taskFolder(snapshot, spec)
        if (!folder) { task.githubProblem = t`Its project is no longer on this computer, so GitHub was not asked.`; continue }
        const since = task.githubSince ?? task.updatedAt
        const stillCurrent = (): boolean => this.running() && this.task(task.id) === task && !task.paused && task.spec === spec
          && (task.githubSince ?? task.updatedAt) === since
        try {
          const repository = github.repository ?? task.githubRepository ?? await projectRepository(this.runGit, folder)
          if (!stillCurrent()) continue
          task.githubRepository = repository
          const events = await readGitHubEvents(this.runGit, folder, { repository, since, issues: github.issues, pullRequests: github.pullRequests, label: github.label })
          if (events.length && spec.work.kind === 'playbook') await this.refreshPlaybooks()
          if (!stillCurrent()) continue
          for (const event of events) {
            this.trigger(task, 'github', `github:${repository}#${event.number}`, { data: eventData(event), source: 'github', eventRef: `${repository}#${event.number}` })
            if (event.createdAt > (task.githubSince ?? '')) task.githubSince = event.createdAt
          }
          delete task.githubProblem
        } catch (error) {
          if (!stillCurrent()) continue
          task.githubProblem = error instanceof GitHubReadError ? error.message : t`GitHub could not be read. Sotto will ask again in a couple of minutes.`
          this.log('scheduled-task-github-read-failed')
        }
      }
      await this.save().catch(() => undefined)
      this.changed()
      this.startQueued()
    } finally {
      this.polling = false
      this.pollSoon(GITHUB_POLL_MS)
    }
  }

  private taskFolder(snapshot: AgentHostSnapshot, spec: TaskSpec): string | undefined {
    if (spec.target.kind === 'thread') { const threadId = spec.target.threadId; return snapshot.threads.find(thread => thread.id === threadId)?.workingDirectory }
    const projectId = spec.target.projectId
    return snapshot.projects.find(project => project.id === projectId)?.path
  }

  // Webhooks.

  private async syncWebhook(): Promise<void> {
    const want = this.running() && this.options.webhooks !== false && this.file.tasks.some(task => task.spec.webhook)
    if (want && !this.webhook) {
      const listener = new WebhookListener({ handler: { secretFor: id => this.secretFor(id), deliver: (id, delivery, body) => this.deliver(id, delivery, body) },
        preferredPort: this.file.webhookPort, now: () => this.clock() })
      this.webhook = listener
      try {
        await listener.start()
        if (this.closed || this.webhook !== listener) return
        this.webhookProblem = undefined
        if (this.file.webhookPort !== listener.boundPort) { this.file.webhookPort = listener.boundPort; await this.save().catch(() => undefined) }
      } catch {
        if (this.closed || this.webhook !== listener) return
        this.webhook = undefined
        this.webhookProblem = t`The webhook listener could not start on this computer. Webhooks start nothing until it does.`
        this.log('scheduled-task-webhooks-failed')
      }
      this.changed()
    } else if (!want && this.webhook) {
      const listener = this.webhook
      this.webhook = undefined
      await listener.close()
      this.changed()
    }
  }

  private secretFor(taskId: string): string | undefined {
    const task = this.task(taskId)
    if (!this.running() || !task?.spec.webhook || !this.options.credentials?.has(secretSlot(taskId))) return undefined
    try { return this.options.credentials.get(secretSlot(taskId)) || undefined } catch { return undefined }
  }

  private async deliver(taskId: string, delivery: string, body: Readonly<Record<string, unknown>>): Promise<WebhookDelivery> {
    if (this.task(taskId)?.spec.work.kind === 'playbook') await this.refreshPlaybooks()
    const task = this.task(taskId)
    if (!task?.spec.webhook || !this.running()) return { status: 404, error: 'Not found.' }
    if (task.paused) return { status: 409, error: 'This task is paused.' }
    const made = this.trigger(task, 'webhook', `hook:${delivery}`, { data: body, source: 'webhook', eventRef: delivery })
    if (made.duplicate) return { status: 200, duplicate: true, ...made.run ? { run: made.run.id } : {} }
    await this.save(); this.changed(); this.startQueued()
    return { status: 202, run: made.run.id }
  }

  // The window's commands.

  async command(command: ScheduledTaskCommand): Promise<ScheduledTaskResult> {
    if (this.closed) return { ok: false, message: t`Sotto is closing. Nothing was changed.` }
    if (command.type === 'open-playbooks') {
      const folder = playbooksFolder(this.options.directory)
      await mkdir(folder, { recursive: true })
      if (!this.options.openPath || await this.options.openPath(folder)) return { ok: false, message: t`The playbooks folder could not be opened.` }
      return { ok: true }
    }
    if (command.type === 'add-example') {
      const id = await addExamplePlaybook(playbooksFolder(this.options.directory))
      await this.refreshPlaybooks()
      return { ok: true, id, message: t`The example playbook is in the playbooks folder as ${id}.json.` }
    }
    if (this.storageProblem) return { ok: false, message: this.storageProblem }
    try {
      const result = await this.act(command)
      await this.save()
      this.changed()
      void this.track(this.syncWebhook()).catch(() => undefined)
      this.startQueued()
      this.tick()
      if (command.type === 'save' || command.type === 'resume' || command.type === 'remove') this.pollSoon(command.type === 'remove' ? GITHUB_POLL_MS : 0)
      return result
    } catch (error) {
      return { ok: false, message: error instanceof Error && error.message ? error.message.slice(0, 500) : t`That could not be done. Nothing was changed.` }
    }
  }

  private needTask(id: string): StoredTask {
    const task = this.task(id)
    if (!task) throw new Error(t`That task is no longer here.`)
    return task
  }
  private needRun(id: string): StoredRun {
    const run = this.file.runs.find(item => item.id === id)
    if (!run) throw new Error(t`That run is no longer here.`)
    return run
  }

  private async act(command: Exclude<ScheduledTaskCommand, { type: 'open-playbooks' | 'add-example' }>): Promise<ScheduledTaskResult> {
    switch (command.type) {
      case 'save': return await this.saveTask(command.id, command.spec)
      case 'remove': {
        const task = this.needTask(command.id)
        // Drop the task first, so releasing a slot during cancellation cannot start another of its runs.
        this.file.tasks = this.file.tasks.filter(item => item !== task)
        for (const run of this.file.runs) if (run.taskId === task.id && run.state !== 'done') await this.runs.cancel(run)
        this.file.runs = this.file.runs.filter(run => run.taskId !== task.id)
        delete this.file.seen[task.id]
        this.runs.replaced(this.file.runs)
        if (this.options.credentials?.has(secretSlot(task.id))) await this.options.credentials.set(secretSlot(task.id), '').catch(() => undefined)
        const name = task.spec.name
        return { ok: true, message: t`${name} was removed with its history. The threads its runs made are kept.` }
      }
      case 'pause': {
        const task = this.needTask(command.id), name = task.spec.name
        task.paused = true; task.updatedAt = iso(this.clock())
        return { ok: true, message: t`${name} is paused. Runs already going carry on.` }
      }
      case 'resume': {
        const task = this.needTask(command.id)
        // Times that passed, and issues opened, while it was paused are not owed.
        task.paused = false; task.evaluatedAt = iso(this.clock()); task.updatedAt = task.evaluatedAt
        if (task.spec.github) task.githubSince = task.evaluatedAt
        const name = task.spec.name
        return { ok: true, message: t`${name} is running on its schedule again.` }
      }
      case 'run-now': {
        if (this.needTask(command.id).spec.work.kind === 'playbook') await this.refreshPlaybooks()
        if (!this.options.enabled()) throw new Error(t`Turn on Run scheduled tasks first. Nothing was started.`)
        const task = this.needTask(command.id)
        if (task.paused) throw new Error(t`Resume the task first. Nothing was started.`)
        const { run } = this.trigger(task, 'manual', `manual:${this.newId()}`, command.inputs ? { inputs: command.inputs } : {})
        if (!run || run.state === 'done') return { ok: false, message: run?.note ?? t`The run could not start.` }
        const name = task.spec.name
        return { ok: true, id: run.id, message: t`${name} will run as soon as a slot is free.` }
      }
      case 'new-secret': {
        const task = this.needTask(command.id)
        const credentials = this.options.credentials
        if (!task.spec.webhook) throw new Error(t`Turn on the task's webhook first.`)
        if (!credentials?.available() || !this.options.clipboard) throw new Error(t`This computer's credential store is locked or missing, so no secret was made.`)
        const secret = randomBytes(32).toString('base64url')
        await credentials.set(secretSlot(task.id), secret)
        await this.options.clipboard(secret)
        return { ok: true, message: t`A new secret is on the clipboard. Any older one no longer works.` }
      }
      case 'allow-playbook': {
        const task = this.needTask(command.id)
        task.allowedRevision = command.revision; task.updatedAt = iso(this.clock())
        for (const run of this.file.runs) if (run.taskId === task.id && run.playbook?.revision === command.revision) this.runs.allowed(run)
        return { ok: true, message: t`This version of the playbook may run its commands.` }
      }
      case 'decide': this.runs.decide(this.needRun(command.run), command.step, command.choice, command.note); return { ok: true }
      case 'resolve': this.runs.resolve(this.needRun(command.run), command.step, command.choice); return { ok: true }
      case 'resume-run': this.runs.resume(this.needRun(command.run)); return { ok: true, message: t`The run will go on as soon as a slot is free.` }
      case 'cancel-run': await this.runs.cancel(this.needRun(command.run)); return { ok: true, message: t`The run was cancelled.` }
    }
  }

  private async saveTask(id: string | undefined, spec: TaskSpec): Promise<ScheduledTaskResult> {
    const problem = this.specProblem(spec)
    if (problem) throw new Error(problem)
    const now = iso(this.clock())
    const existing = id ? this.needTask(id) : undefined
    if (!existing) {
      if (this.file.tasks.length >= TASKS_MAX) throw new Error(t`Sotto keeps ${TASKS_MAX} scheduled tasks. Remove one first.`)
      if (spec.schedule?.kind === 'once' && Date.parse(spec.schedule.at) <= this.clock()) throw new Error(t`That time has passed. Choose a time to come.`)
      const task: StoredTask = { id: this.newId(), createdAt: now, updatedAt: now, paused: false, evaluatedAt: now, spec, ...spec.github ? { githubSince: now } : {} }
      this.file.tasks.push(task)
      const name = spec.name
      return { ok: true, id: task.id, message: t`${name} is saved.` }
    }
    const before = existing.spec
    if (!sameJson(before.schedule, spec.schedule)) existing.evaluatedAt = now
    if (!sameJson(before.github, spec.github) || !sameJson(before.target, spec.target)) {
      delete existing.githubRepository; delete existing.githubProblem
      if (spec.github) existing.githubSince = now; else delete existing.githubSince
    }
    if (before.work.kind !== 'playbook' || spec.work.kind !== 'playbook' || before.work.playbookId !== spec.work.playbookId) delete existing.allowedRevision
    if (before.webhook && !spec.webhook && this.options.credentials?.has(secretSlot(existing.id))) await this.options.credentials.set(secretSlot(existing.id), '').catch(() => undefined)
    existing.spec = spec; existing.updatedAt = now
    const name = spec.name
    return { ok: true, id: existing.id, message: t`${name} is saved.` }
  }

  /** Why a task can't be saved as it is, or undefined. */
  private specProblem(spec: TaskSpec): string | undefined {
    if (spec.target.kind === 'thread' && spec.work.kind === 'playbook') return t`A playbook makes its own threads. Choose a project and a model for it.`
    if (spec.schedule?.kind === 'weekly' && !isTimeZone(spec.schedule.timeZone)) { const zone = spec.schedule.timeZone; return t`This computer doesn't know the time zone ${zone}.` }
    const snapshot = this.options.control.watcherSnapshot()
    const target = spec.target
    if (target.kind === 'thread') {
      const thread = snapshot.threads.find(item => item.id === target.threadId)
      if (!thread || thread.remoteHost === true) return t`A scheduled task runs on the computer that keeps it. Choose a thread on this computer.`
    } else if (!snapshot.projects.some(project => project.id === target.projectId)) return t`A scheduled task runs on the computer that keeps it. Choose a project on this computer.`
    return undefined
  }

  private refreshPlaybooks(): Promise<void> {
    return this.playbookRead ??= readPlaybooks(playbooksFolder(this.options.directory))
      .catch(() => [])
      .then(files => { this.playbooks = files })
      .finally(() => { this.playbookRead = undefined })
  }

  /** The state for the window, after reading the playbooks folder again. */
  async read(): Promise<ScheduledTasksState> {
    await this.refreshPlaybooks()
    return this.state()
  }

  // Views, in this computer's own IDs; the bridge turns them into the window's.

  state(): ScheduledTasksState {
    const snapshot = this.options.control.watcherSnapshot()
    const now = this.clock()
    const runs = [...this.file.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RUN_VIEWS_MAX)
    return {
      available: true, enabled: this.options.enabled(),
      ...this.storageProblem ? { storageProblem: this.storageProblem } : {},
      tasks: this.file.tasks.map(task => this.taskView(task, snapshot, now)),
      runs: runs.map(run => this.runView(run)),
      playbooks: this.playbooks.map(playbookView),
      playbooksFolder: playbooksFolder(this.options.directory),
      webhooks: { listening: this.webhook?.listening === true, ...this.webhook?.address ? { address: this.webhook.address } : {}, ...this.webhookProblem ? { problem: this.webhookProblem } : {} },
      credentials: this.options.credentials?.available() === true,
    }
  }

  private taskView(task: StoredTask, snapshot: AgentHostSnapshot, now: number): TaskView {
    const next = task.paused || !this.options.enabled() ? null : nextDue(task.spec.schedule, Math.max(now, Date.parse(task.evaluatedAt)))
    const problem = this.taskProblem(task, snapshot)
    return {
      ...task.spec, id: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt, paused: task.paused,
      ...next !== null ? { nextAt: iso(next) } : {},
      webhookSecret: this.options.credentials?.has(secretSlot(task.id)) === true,
      ...task.spec.webhook ? { webhookPath: webhookPath(task.id) } : {},
      ...task.allowedRevision ? { allowedRevision: task.allowedRevision } : {},
      ...problem ? { problem } : {},
      ...task.githubProblem ? { githubProblem: task.githubProblem } : {},
    }
  }

  private taskProblem(task: StoredTask, snapshot: AgentHostSnapshot): TaskProblem | undefined {
    const target = task.spec.target
    if (target.kind === 'thread') {
      const thread = snapshot.threads.find(item => item.id === target.threadId)
      return !thread ? 'thread-gone' : thread.remoteHost === true ? 'remote' : undefined
    }
    if (!snapshot.projects.some(project => project.id === target.projectId)) return 'project-gone'
    const model = resolveModel(snapshot.models, target.modelId)
    if (!model) return 'model-gone'
    if (!model.ready) return 'provider-off'
    const work = task.spec.work
    if (work.kind === 'playbook') {
      const file = this.playbooks.find(item => item.id === work.playbookId)
      if (!file) return 'playbook-gone'
      if (!file.playbook) return 'playbook-broken'
      if (task.allowedRevision && task.allowedRevision !== file.revision && file.playbook.steps.some(step => step.kind === 'code')) return 'playbook-changed'
    }
    return undefined
  }

  private runView(run: StoredRun): RunView {
    const steps = run.steps.map((step, index) => {
      const definition = run.definition?.steps[index]
      const output = step.output !== undefined ? JSON.stringify(step.output, null, 2) : undefined
      return {
        id: step.id, kind: definition?.kind ?? 'agent', title: definition ? stepTitle(definition) : step.id, state: step.state, attempts: step.attempts,
        maxAttempts: definition && definition.kind !== 'decision' ? (definition.retries ?? 0) + 1 : 1,
        ...step.threadId ? { threadId: step.threadId } : {},
        ...definition?.kind === 'decision' ? { question: this.runs.question(run, definition.question), ...definition.note ? { noteLabel: definition.note.label, noteRequired: definition.note.required === true } : {} } : {},
        ...definition?.kind === 'code' ? { command: definition.run.join(' ') } : {},
        ...step.exitCode !== undefined ? { exitCode: step.exitCode } : {},
        ...step.note ? { note: step.note } : {},
        ...step.decision ? { decision: { choice: step.decision.choice, at: step.decision.at } } : {},
        ...output !== undefined ? { output: output.length > 4000 ? `${output.slice(0, 3999)}…` : output } : {},
      }
    })
    const promptStep = run.literal ? run.steps[0] : undefined
    return {
      id: run.id, taskId: run.taskId, taskName: run.taskName, trigger: run.trigger, createdAt: run.createdAt, state: run.state,
      ...run.dueAt ? { dueAt: run.dueAt } : {}, ...run.startedAt ? { startedAt: run.startedAt } : {}, ...run.endedAt ? { endedAt: run.endedAt } : {},
      ...run.outcome ? { outcome: run.outcome } : {}, ...run.wait ? { wait: run.wait } : {},
      ...run.note ?? promptStep?.note ? { note: (run.note ?? promptStep!.note)! } : {},
      ...run.eventRef ? { eventRef: run.eventRef } : {}, ...run.missedCount !== undefined ? { missedCount: run.missedCount } : {},
      ...run.playbook && run.definition ? { playbook: { id: run.playbook.id, name: run.definition.name, revision: run.playbook.revision } } : {},
      steps,
      threadIds: [...new Set(run.steps.flatMap(step => step.threadId ? [step.threadId] : []))],
    }
  }

}

/** A GitHub event as a run's data: what a prompt shows below it, and what a playbook's inputs are filled from. */
function eventData(event: GitHubEvent): Record<string, unknown> {
  return { kind: event.kind, repository: event.repository, number: event.number, title: event.title, body: event.body, url: event.url, author: event.author, labels: event.labels }
}

function playbookView(file: PlaybookFile): PlaybookView {
  const playbook = file.playbook
  return {
    id: file.id, ...file.revision ? { revision: file.revision } : {}, ...file.problem ? { problem: file.problem.slice(0, 2000) } : {},
    ...playbook ? { name: playbook.name, concurrency: playbook.concurrency ?? 1, ...playbook.description ? { description: playbook.description } : {} } : {},
    inputs: Object.entries(playbook?.inputs ?? {}).map(([name, input]) => ({ name, type: input.type, required: input.required === true, ...input.description ? { description: input.description } : {} })),
    steps: (playbook?.steps ?? []).map(step => ({ id: step.id, kind: step.kind, title: stepTitle(step), ...step.kind === 'code' ? { command: step.run.join(' ') } : {} })),
  }
}

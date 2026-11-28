import { z } from 'zod'
import { agentRuntimeModeSchema } from './agents'
import { PLAYBOOK_ID_PATTERN, PLAYBOOK_INPUT_PATTERN, PLAYBOOKS_MAX, playbookValueSchema } from './playbooks'
import { taskScheduleSchema } from './taskSchedules'

/**
 * Scheduled tasks (ADR-0218, an Owl feature, `scheduled-tasks`): one prompt, or one **playbook**, that Sotto starts on
 * this computer at set times, on a signed webhook or on a new GitHub issue or pull request, against an explicit project
 * and model or an existing thread, with a history of its runs. Settings › Scheduled tasks reads and changes them through
 * this bridge. The window names threads and projects by its own keys; main turns them into this computer's IDs and
 * refuses another machine's. Nothing here carries a webhook secret, or a run's inputs once the run has ended.
 */

export const TASKS_MAX = 100
/** The most runs one task keeps once they have ended; runs still going are always kept. */
export const TASK_RUNS_KEPT = 30
/** The most runs the window is sent. */
export const RUN_VIEWS_MAX = 300
export const TASK_PROMPT_MAX = 20_000
export const TASK_NAME_MAX = 80
/** The most runs of all tasks running at once on this computer; more wait in turn. */
export const TASK_RUNS_AT_ONCE = 3

const windowId = z.string().min(1).max(6_144)
const name = z.string().trim().min(1).max(TASK_NAME_MAX)
const inputName = z.string().regex(PLAYBOOK_INPUT_PATTERN)
const at = z.iso.datetime({ offset: true })

export const taskTargetSchema = z.discriminatedUnion('kind', [
  /** Each run makes a new thread in the project, on the model, at the effort and permission chosen here. */
  z.object({
    kind: z.literal('new-thread'), projectId: windowId, modelId: windowId,
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(),
    workingCopy: z.enum(['shared', 'independent']),
  }).strict(),
  /** Each run sends to this one thread once it is free. A prompt only: a playbook makes its own threads. */
  z.object({ kind: z.literal('thread'), threadId: windowId }).strict(),
])
export type TaskTarget = z.infer<typeof taskTargetSchema>

export const taskWorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX) }).strict(),
  /** The playbook's inputs the user set. A webhook's or GitHub's values fill only those left unset, never these. */
  z.object({ kind: z.literal('playbook'), playbookId: z.string().regex(PLAYBOOK_ID_PATTERN), inputs: z.record(inputName, playbookValueSchema).optional() }).strict(),
])
export type TaskWork = z.infer<typeof taskWorkSchema>

/** New GitHub issues or pull requests in a repository start a run; `label`, when set, only those carrying it. */
export const taskGitHubSchema = z.object({
  issues: z.boolean(), pullRequests: z.boolean(),
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u).optional(),
  label: z.string().trim().min(1).max(50).optional(),
}).strict().refine(github => github.issues || github.pullRequests, 'Choose issues, pull requests or both.')
export type TaskGitHub = z.infer<typeof taskGitHubSchema>

/** Everything the user sets on a task in Settings › Scheduled tasks. */
export const taskSpecSchema = z.object({
  name,
  work: taskWorkSchema,
  target: taskTargetSchema,
  schedule: taskScheduleSchema.nullable(),
  /** A time that passed while Sotto was closed, or while scheduled tasks were off: run once, late, or skip it. */
  missed: z.enum(['run-once', 'skip']),
  /** A time that comes while the task's last run is still going: skip it, or run once that run ends. */
  overlap: z.enum(['skip', 'queue']),
  webhook: z.boolean(),
  github: taskGitHubSchema.nullable(),
}).strict()
export type TaskSpec = z.infer<typeof taskSpecSchema>

export const TASK_TRIGGERS = ['schedule', 'late', 'manual', 'webhook', 'github', 'missed'] as const
export type TaskTrigger = (typeof TASK_TRIGGERS)[number]
/** `held` waits for the user to say how to go on: an uncertain step, a changed playbook, or a failure to resume from. */
export const RUN_STATES = ['queued', 'running', 'waiting', 'held', 'done'] as const
export type RunState = (typeof RUN_STATES)[number]
export const RUN_OUTCOMES = ['finished', 'failed', 'stopped', 'cancelled', 'declined', 'unknown', 'skipped', 'missed'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]
export const STEP_STATES = ['pending', 'dispatching', 'running', 'waiting', 'done', 'failed', 'uncertain', 'skipped', 'cancelled'] as const
export type StepState = (typeof STEP_STATES)[number]
/** What a waiting or held run waits on the user for. */
export const RUN_WAITS = ['decision', 'confirm', 'allow', 'uncertain', 'card', 'failed'] as const
export type RunWait = (typeof RUN_WAITS)[number]
/** Why a task can't run as it is set, said in words by the window. */
export const TASK_PROBLEMS = ['project-gone', 'model-gone', 'provider-off', 'thread-gone', 'playbook-gone', 'playbook-broken', 'playbook-changed', 'remote'] as const
export type TaskProblem = (typeof TASK_PROBLEMS)[number]

export const runStepViewSchema = z.object({
  id: z.string().max(32), kind: z.enum(['agent', 'code', 'decision']), title: z.string().max(80),
  state: z.enum(STEP_STATES), attempts: z.number().int().min(0), maxAttempts: z.number().int().min(1),
  threadId: windowId.optional(),
  /** A decision's question with its references filled, and the label of the note it takes. */
  question: z.string().max(20_000).optional(), noteLabel: z.string().max(200).optional(), noteRequired: z.boolean().optional(),
  /** A code step's command as the playbook writes it. */
  command: z.string().max(70_000).optional(),
  exitCode: z.number().int().optional(),
  /** Sotto's own words on the step: why it failed or what it waits for. Never a payload's words. */
  note: z.string().max(500).optional(),
  decision: z.object({ choice: z.enum(['approve', 'decline']), at }).optional(),
  /** An acknowledged output, as JSON, cut to what the window shows. */
  output: z.string().max(4000).optional(),
})
export type RunStepView = z.infer<typeof runStepViewSchema>

export const runViewSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), taskName: z.string().max(TASK_NAME_MAX),
  trigger: z.enum(TASK_TRIGGERS), dueAt: at.optional(), createdAt: at, startedAt: at.optional(), endedAt: at.optional(),
  state: z.enum(RUN_STATES), outcome: z.enum(RUN_OUTCOMES).optional(), wait: z.enum(RUN_WAITS).optional(),
  note: z.string().max(500).optional(),
  /** What started it from outside, by reference alone: `owner/name#12`, or a webhook delivery's ID. */
  eventRef: z.string().max(200).optional(),
  missedCount: z.number().int().min(0).optional(),
  playbook: z.object({ id: z.string(), name: z.string().max(80), revision: z.string().max(64) }).optional(),
  steps: z.array(runStepViewSchema).max(40),
  threadIds: z.array(windowId).max(40),
})
export type RunView = z.infer<typeof runViewSchema>

export const taskViewSchema = taskSpecSchema.extend({
  id: z.uuid(), createdAt: at, updatedAt: at, paused: z.boolean(),
  nextAt: at.optional(),
  /** Whether the task has a webhook secret in the credential store; the secret itself never leaves main. */
  webhookSecret: z.boolean(),
  webhookPath: z.string().max(200).optional(),
  /** The playbook revision the user allowed to run commands, when it has code steps. */
  allowedRevision: z.string().max(64).optional(),
  problem: z.enum(TASK_PROBLEMS).optional(),
  /** The last GitHub read's failure, in Sotto's words, until a read succeeds. */
  githubProblem: z.string().max(300).optional(),
})
export type TaskView = z.infer<typeof taskViewSchema>

export const playbookViewSchema = z.object({
  id: z.string().max(48), name: z.string().max(80).optional(), description: z.string().max(500).optional(),
  revision: z.string().max(64).optional(),
  concurrency: z.number().int().min(1).optional(),
  inputs: z.array(z.object({ name: inputName, type: z.enum(['string', 'number', 'boolean']), required: z.boolean(), description: z.string().max(300).optional() })).max(50),
  steps: z.array(z.object({ id: z.string().max(32), kind: z.enum(['agent', 'code', 'decision']), title: z.string().max(80), command: z.string().max(70_000).optional() })).max(40),
  /** Why the file can't be run, in plain words. */
  problem: z.string().max(2000).optional(),
})
export type PlaybookView = z.infer<typeof playbookViewSchema>

export const scheduledTasksStateSchema = z.object({
  /** False where this computer's host does not run tasks, with why in `unavailable`. */
  available: z.boolean(), unavailable: z.string().max(500).optional(),
  /** Settings' **Run scheduled tasks** switch. Off, nothing starts and every task is kept. */
  enabled: z.boolean(),
  /** The tasks file could not be read; it was kept unchanged and nothing can be saved until it is. */
  storageProblem: z.string().max(500).optional(),
  tasks: z.array(taskViewSchema).max(TASKS_MAX),
  runs: z.array(runViewSchema).max(RUN_VIEWS_MAX),
  playbooks: z.array(playbookViewSchema).max(PLAYBOOKS_MAX),
  playbooksFolder: z.string().max(4096),
  webhooks: z.object({ listening: z.boolean(), address: z.string().max(200).optional(), problem: z.string().max(500).optional() }),
  /** Whether the operating system's credential store can hold webhook secrets. */
  credentials: z.boolean(),
})
export type ScheduledTasksState = z.infer<typeof scheduledTasksStateSchema>

const taskId = z.uuid()
const runId = z.uuid()
const stepId = z.string().max(32)
export const scheduledTaskCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('save'), id: taskId.optional(), spec: taskSpecSchema }).strict(),
  z.object({ type: z.literal('remove'), id: taskId }).strict(),
  z.object({ type: z.literal('pause'), id: taskId }).strict(),
  z.object({ type: z.literal('resume'), id: taskId }).strict(),
  z.object({ type: z.literal('run-now'), id: taskId, inputs: z.record(inputName, playbookValueSchema).optional() }).strict(),
  /** Mints a new webhook secret, keeps it in the credential store and copies it to the clipboard; the window never holds it. */
  z.object({ type: z.literal('new-secret'), id: taskId }).strict(),
  /** Lets this revision of the task's playbook run its code steps. */
  z.object({ type: z.literal('allow-playbook'), id: taskId, revision: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('decide'), run: runId, step: stepId, choice: z.enum(['approve', 'decline']), note: z.string().max(4000).optional() }).strict(),
  /** An uncertain step: `again` runs it again, `continue` goes on as though it had finished. */
  z.object({ type: z.literal('resolve'), run: runId, step: stepId, choice: z.enum(['again', 'continue']) }).strict(),
  /** A failed or held run goes on from the step that stopped it. */
  z.object({ type: z.literal('resume-run'), run: runId }).strict(),
  z.object({ type: z.literal('cancel-run'), run: runId }).strict(),
  z.object({ type: z.literal('open-playbooks') }).strict(),
  z.object({ type: z.literal('add-example') }).strict(),
])
export type ScheduledTaskCommand = z.infer<typeof scheduledTaskCommandSchema>

export const scheduledTaskResultSchema = z.union([
  z.object({ ok: z.literal(true), id: z.string().optional(), message: z.string().max(500).optional() }),
  z.object({ ok: z.literal(false), message: z.string().max(500) }),
])
export type ScheduledTaskResult = z.infer<typeof scheduledTaskResultSchema>

export const SCHEDULED_TASKS_READ = 'sotto:scheduled-tasks:read'
export const SCHEDULED_TASKS_COMMAND = 'sotto:scheduled-tasks:command'
/** Main sends the whole state again whenever a task, a run or a playbook changes. */
export const SCHEDULED_TASKS_CHANGED = 'sotto:scheduled-tasks:changed'
/** The main window's argument while the `scheduled-tasks` Owl feature is on: without it, preload builds no bridge. */
export const SCHEDULED_TASKS_RENDERER_ARGUMENT = '--sotto-scheduled-tasks-enabled'

export interface ScheduledTasksBridge {
  read(): Promise<ScheduledTasksState>
  command(command: ScheduledTaskCommand): Promise<ScheduledTaskResult>
  onChanged(listener: (state: ScheduledTasksState) => void): () => void
}

/** The headers a webhook request signs with, and how far its clock may be from this computer's. */
export const WEBHOOK_HEADERS = { timestamp: 'x-sotto-timestamp', delivery: 'x-sotto-delivery', signature: 'x-sotto-signature' } as const
export const WEBHOOK_CLOCK_SKEW_SECONDS = 300
export const WEBHOOK_BODY_BYTES_MAX = 64 * 1024
/** A delivery's ID: what the sender names it, unique per request. */
export const WEBHOOK_DELIVERY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u
/** The path a task's webhook is posted to on the loopback listener. */
export const webhookPath = (taskId: string): string => `/v1/scheduled-tasks/${taskId}/runs`

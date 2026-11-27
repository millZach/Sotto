import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { literalPromptDefinitionSchema, playbookDefinitionSchema, playbookSchema, playbookValueSchema, PLAYBOOK_OUTPUT_BYTES_MAX } from '../../shared/playbooks'
import { RUN_OUTCOMES, RUN_STATES, RUN_WAITS, STEP_STATES, TASK_TRIGGERS, taskSpecSchema } from '../../shared/scheduledTasks'
import { AtomicJsonStore, hasErrorCode } from '../storage/atomicJsonStore'

/**
 * What `scheduled-tasks.json` in Sotto's data folder keeps (ADR-0218): every task as the user set it, with this
 * computer's own IDs; every run with its steps and each step's acknowledged output; and the delivery keys each task has
 * seen, so a trigger that comes twice starts one run. A run keeps a copy of what it runs, so editing a task or its
 * playbook never changes a run already started. A run's inputs, which may hold a webhook's or GitHub's words, leave the
 * file once the run ends.
 */

export const TASK_FILE = 'scheduled-tasks.json'
export const TASK_FILE_VERSION = 1
/** The delivery keys kept per task, newest first. */
export const SEEN_KEYS_MAX = 500

const at = z.iso.datetime({ offset: true })

export const storedTaskSchema = z.object({
  id: z.uuid(), createdAt: at, updatedAt: at, paused: z.boolean(),
  /** The instant the schedule was last read up to: times after it and up to now are due, and earlier ones are spent. */
  evaluatedAt: at,
  spec: taskSpecSchema,
  allowedRevision: z.string().max(64).optional(),
  /** New GitHub issues and pull requests count from this instant: those opened before the trigger was set start nothing. */
  githubSince: at.optional(),
  githubRepository: z.string().max(200).optional(),
  githubProblem: z.string().max(300).optional(),
}).strict()
export type StoredTask = z.infer<typeof storedTaskSchema>

export const storedStepSchema = z.object({
  id: z.string().max(32),
  state: z.enum(STEP_STATES),
  /** Tries started, counted as each is sent or run. */
  attempts: z.number().int().min(0),
  nextAttemptAt: at.optional(),
  threadId: z.string().max(512).optional(),
  draftId: z.uuid().optional(), messageId: z.uuid().optional(), replyMessageId: z.string().max(512).optional(),
  /** The step's output, written before the next step starts: what an acknowledged step hands on. */
  output: z.unknown().optional(),
  stdout: z.string().max(8000).optional(), exitCode: z.number().int().optional(),
  decision: z.object({ choice: z.enum(['approve', 'decline']), note: z.string().max(4000).optional(), at }).strict().optional(),
  /** The user allowed the next attempt of this risky command. */
  confirmed: z.literal(true).optional(),
  note: z.string().max(500).optional(),
  startedAt: at.optional(), endedAt: at.optional(),
}).strict()
export type StoredStep = z.infer<typeof storedStepSchema>

/** The target a run was started with, in this computer's own IDs. */
const runTargetSchema = z.object({
  projectId: z.string().max(512).optional(), threadId: z.string().max(512).optional(), modelId: z.string().max(6_144).optional(),
  reasoningEffort: z.string().max(64).optional(), runtimeMode: z.string().max(64).optional(), workingCopy: z.enum(['shared', 'independent']).optional(),
}).strict()
export type RunTarget = z.infer<typeof runTargetSchema>

export const storedRunSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), taskName: z.string().max(80),
  /** What made it: `schedule:<instant>`, `hook:<delivery>`, `github:<owner/name>#<number>`, `manual:<uuid>`. */
  key: z.string().max(300),
  trigger: z.enum(TASK_TRIGGERS), dueAt: at.optional(), createdAt: at, startedAt: at.optional(), endedAt: at.optional(),
  state: z.enum(RUN_STATES), outcome: z.enum(RUN_OUTCOMES).optional(), wait: z.enum(RUN_WAITS).optional(),
  note: z.string().max(500).optional(), eventRef: z.string().max(200).optional(), missedCount: z.number().int().min(0).optional(),
  target: runTargetSchema,
  /** What it runs: the playbook as it was when the run was made, or a prompt task's one step. */
  definition: playbookDefinitionSchema.optional(),
  /** A prompt task's text is sent as written, with no references filled. */
  literal: z.literal(true).optional(),
  playbook: z.object({ id: z.string().max(64), revision: z.string().max(64) }).strict().optional(),
  inputs: z.record(z.string(), playbookValueSchema).optional(),
  /** The inputs a webhook or GitHub filled, so their words are marked as outside words wherever they go. */
  outside: z.array(z.string().max(32)).max(50).optional(),
  /** Where outside words came from, for the note beside them. */
  source: z.enum(['webhook', 'github']).optional(),
  /** A prompt task's outside data, as JSON, added below its prompt. */
  data: z.string().max(PLAYBOOK_OUTPUT_BYTES_MAX).optional(),
  steps: z.array(storedStepSchema).max(40),
}).strict().superRefine((run, context) => {
  if (!run.definition) return
  const result = (run.literal ? literalPromptDefinitionSchema : playbookSchema).safeParse(run.definition)
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue, path: ['definition', ...issue.path] })
})
export type StoredRun = z.infer<typeof storedRunSchema>

export const taskFileSchema = z.object({
  version: z.literal(TASK_FILE_VERSION),
  tasks: z.array(storedTaskSchema),
  runs: z.array(storedRunSchema),
  /** Each task's delivery keys, newest first, as [key, when seen]. */
  seen: z.record(z.string(), z.array(z.tuple([z.string().max(300), at])).max(SEEN_KEYS_MAX)),
  /** The loopback port webhooks were last served on, tried first at the next start. */
  webhookPort: z.number().int().min(1).max(65_535).optional(),
}).strict()
export type TaskFile = z.infer<typeof taskFileSchema>

export const emptyTaskFile = (): TaskFile => ({ version: TASK_FILE_VERSION, tasks: [], runs: [], seen: {} })

/**
 * Reads and writes `scheduled-tasks.json`. A file this build can't read, from a newer Sotto or damaged, is never
 * replaced: reading says why, and the service refuses to save until it is fixed.
 */
export class TaskStore {
  readonly file: string
  private readonly store: AtomicJsonStore<TaskFile>
  constructor(directory: string) {
    this.file = join(directory, TASK_FILE)
    this.store = new AtomicJsonStore(this.file, input => taskFileSchema.parse(input), emptyTaskFile)
  }

  async read(): Promise<{ readonly file: TaskFile } | { readonly problem: 'newer' | 'damaged' }> {
    let bytes: string
    try { bytes = await readFile(this.file, 'utf8') } catch (error) { if (hasErrorCode(error, 'ENOENT')) return { file: emptyTaskFile() }; return { problem: 'damaged' } }
    let input: unknown
    try { input = JSON.parse(bytes) } catch { return { problem: 'damaged' } }
    if (typeof input === 'object' && input !== null && 'version' in input && typeof input.version === 'number' && input.version > TASK_FILE_VERSION) return { problem: 'newer' }
    const parsed = taskFileSchema.safeParse(input)
    return parsed.success ? { file: parsed.data } : { problem: 'damaged' }
  }

  /** Writes whatever `latest` holds when the write starts; resolves once a write at least that new is on disk. */
  write(latest: () => TaskFile): Promise<void> { return this.store.writeLatest(latest) }
}

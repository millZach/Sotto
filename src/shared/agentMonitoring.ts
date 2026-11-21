import { z } from 'zod'

export const MAX_AGENT_MONITORS = 64
export const MAX_MONITOR_LABEL = 240
/** The same ceiling as watches: a workflow that fans out wider than this is still one "Working" readout. */
export const MAX_BACKGROUND_WORK = 64

const label = z.string().trim().min(1).max(MAX_MONITOR_LABEL).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))

/** A live provider-confirmed watch. Neither activity history nor permission to act. */
export const agentMonitoringSchema = z.array(z.object({
  id: z.string().uuid(),
  label,
}).strict()).max(MAX_AGENT_MONITORS)

export type AgentMonitoringTask = z.infer<typeof agentMonitoringSchema>[number]

/**
 * What kind of background work the provider confirmed, or Sotto found. Sotto's own names, not a provider's task types, so
 * the renderer never learns a native discriminant: a workflow, a subagent, a teammate, a remote agent, a command left
 * running in the background, or a detached run (#2476). A command is not an agent: it waits rather than works. A detached
 * run is an agent client the thread started and cut loose from its own process, which Sotto finds itself.
 */
export const backgroundWorkTypes = ['workflow', 'subagent', 'teammate', 'remote-agent', 'command', 'detached-run'] as const
export type BackgroundWorkType = typeof backgroundWorkTypes[number]
/** Each kind of background work in a word: what the readout and a row under the reply call it, and a task's label when the provider gave none. */
export const BACKGROUND_WORK_LABELS: Record<BackgroundWorkType, string> = { workflow: 'Workflow', subagent: 'Subagent', teammate: 'Teammate', 'remote-agent': 'Remote agent', command: 'Background command', 'detached-run': 'Detached run' }

/** The most detached runs one thread lists; past it the rest still run, unlisted. */
export const MAX_DETACHED_RUNS = 16
/** The longest command a detached run's row shows; a longer one is cut there. */
export const MAX_DETACHED_RUN_COMMAND = 2_000
const words = z.string().trim().min(1).max(MAX_MONITOR_LABEL).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))
/**
 * What Sotto read about a detached run from its process (#2476): the client that runs it, the model and effort its command
 * names, the folder it works in where the system says, and its command, with the value after any flag that names a key,
 * a token, a secret or a password left out. Read on the computer the thread runs on, and never logged.
 */
export const detachedRunDetailSchema = z.object({
  client: words,
  model: words.optional(),
  effort: words.optional(),
  folder: z.string().min(1).max(4_096).refine(value => !/\p{Cc}/u.test(value)).optional(),
  command: z.string().min(1).max(MAX_DETACHED_RUN_COMMAND).refine(value => !/\p{Cc}/u.test(value)),
  /**
   * The machine the run works on, by the name this computer gives it, where that is not the thread's own: a run a thread
   * started on another machine, as over ssh, which that machine found and reported (#2749).
   */
  machine: words.optional(),
}).strict()
export type DetachedRunDetail = z.infer<typeof detachedRunDetailSchema>

/**
 * Background work: agent work or a command started from this thread that the provider confirms is still running, whether
 * or not a turn is, and the thread's detached runs Sotto finds running. Observation only, like a watch; never restored
 * from history and grants nothing.
 */
const backgroundWorkItemSchema = z.object({
  id: z.string().uuid(),
  label,
  type: z.enum(backgroundWorkTypes),
  /** When Sotto saw it start, so a command's wait can be counted; for a detached run, when its process started. */
  startedAt: z.string().datetime().optional(),
  /** A detached run's detail. Only a detached run has it, and it always does. */
  run: detachedRunDetailSchema.optional(),
}).strict().refine(work => (work.type === 'detached-run') === (work.run !== undefined), 'Only a detached run has run detail, and it always has it.')
export const agentBackgroundWorkSchema = z.array(backgroundWorkItemSchema).max(MAX_BACKGROUND_WORK)

export type AgentBackgroundWork = z.infer<typeof agentBackgroundWorkSchema>[number]

/**
 * The environment variables that name the provider session a process was started from (ADR-0204). `HERMES_SESSION_KEY`
 * is the ACP session Hermes binds for the commands it runs (#2637); no Hermes client is an agent client a thread detaches
 * with it.
 */
export const RUN_MARKS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'HERMES_SESSION_KEY'] as const
export type RunMarkName = typeof RUN_MARKS[number]
export interface RunMark { readonly name: RunMarkName; readonly value: string }
const runMarkSchema = z.object({ name: z.enum(RUN_MARKS), value: z.string().min(1).max(512).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)) }).strict()

/** The most runs from elsewhere one host reports at a time; past it the rest still run, unreported. */
export const MAX_DETACHED_RUNS_ELSEWHERE = 64
/**
 * Detached runs a host found that carry a mark none of its own threads owns (#2749): a run another machine's thread started
 * there, as over ssh with its session passed along. The host sends each one's marks and what it read of it to its recorded
 * desktops, and the desktop whose own adapter knows a mark shows the run as that thread's. Observation only; grants nothing.
 */
export const detachedRunsElsewhereSchema = z.array(z.object({
  marks: z.array(runMarkSchema).min(1).max(RUN_MARKS.length),
  work: backgroundWorkItemSchema.refine(work => work.type === 'detached-run', 'Only a detached run is reported from elsewhere.'),
}).strict()).max(MAX_DETACHED_RUNS_ELSEWHERE)
export type DetachedRunElsewhere = z.infer<typeof detachedRunsElsewhereSchema>[number]
/** A host's answer to a desktop's Stop of a run it reported: null once it ended, or why it did not, in the host's words. */
export const detachedRunElsewhereStopSchema = z.object({ error: z.string().min(1).max(400).nullable() }).strict()

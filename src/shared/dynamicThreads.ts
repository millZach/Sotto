import { z } from 'zod'
import { providerIdSchema, type AgentThread, type ProviderId } from './agents'

/**
 * Dynamic threads (CONTEXT.md, **Dynamic thread**; ADR-0191): a thread whose model oversees and chooses a model for each
 * piece of work, inside the limits saved here. An Owl feature, `dynamic-threads`. This is the one reader every part asks.
 */

/** The providers an overseer runs on for now, whose standing instructions are checked (ADR-0191 decision 13). */
export const DYNAMIC_OVERSEERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['claude', 'codex'])
export const DYNAMIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const dynamicEffortSchema = z.enum(DYNAMIC_EFFORTS)
export type DynamicEffort = z.infer<typeof dynamicEffortSchema>
export const DEFAULT_HIGHEST_EFFORT: DynamicEffort = 'xhigh'
export const DEFAULT_WORKERS_AT_ONCE = 4
export const WORKERS_AT_ONCE_MAX = 100
export const workersAtOnceSchema = z.number().int().min(1).max(WORKERS_AT_ONCE_MAX)

/**
 * What Settings → Threads holds for every Dynamic thread on this computer. `providers` is the allowed list, absent until
 * the user has seen it: the first time they turn Dynamic on is when it is made, so a provider connected later never joins
 * a list they already agreed to.
 */
const allowedProvidersSchema = z.array(providerIdSchema).max(providerIdSchema.options.length)
export const dynamicThreadSettingsSchema = z.object({
  providers: allowedProvidersSchema.optional(),
  highestEffort: dynamicEffortSchema,
  workersAtOnce: workersAtOnceSchema,
}).strict()
export type DynamicThreadSettings = z.infer<typeof dynamicThreadSettingsSchema>
export const DEFAULT_DYNAMIC_THREADS: DynamicThreadSettings = { highestEffort: DEFAULT_HIGHEST_EFFORT, workersAtOnce: DEFAULT_WORKERS_AT_ONCE }

/** Read one field at a time, so a damaged value costs only itself. A damaged list is no list, so it is asked for again. */
export function parseDynamicThreadSettings(input: unknown): DynamicThreadSettings {
  const saved = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const providers = allowedProvidersSchema.safeParse(saved.providers)
  const highestEffort = dynamicEffortSchema.safeParse(saved.highestEffort)
  const workersAtOnce = workersAtOnceSchema.safeParse(saved.workersAtOnce)
  return { ...providers.success ? { providers: [...new Set(providers.data)] } : {},
    highestEffort: highestEffort.success ? highestEffort.data : DEFAULT_HIGHEST_EFFORT,
    workersAtOnce: workersAtOnce.success ? workersAtOnce.data : DEFAULT_WORKERS_AT_ONCE }
}

/** The most a reason line on a worker's row holds (ADR-0191 decision 11). */
export const DYNAMIC_WHY_MAX = 200

/** The company a provider's work goes to, which the allowed list and its first-use question name (ADR-0191 decisions 1 and 7). OpenCode has none of its own: its work goes to a model source. */
export const PROVIDER_COMPANIES: Readonly<Record<Exclude<ProviderId, 'opencode'>, string>> = { claude: 'Anthropic', codex: 'OpenAI', grok: 'xAI', muse: 'Meta', devin: 'Cognition', cursor: 'Cursor', deepseek: 'your own model servers' }

/** What the allowed list holds. Until the user has seen one there is none, so an overseer keeps to its own provider. */
export const allowedProviders = (settings: DynamicThreadSettings, own: ProviderId | undefined): ReadonlySet<ProviderId> =>
  new Set(settings.providers ?? (own ? [own] : []))

/** What a provider can do that a model's own efforts, speeds and permissions do not say, for an overseer choosing (ADR-0191 decision 9). */
export const providerAbilities = (provider: ProviderId, takesSottoTools: boolean): readonly string[] =>
  [...provider === 'codex' ? ['Computer Use, for clicking and typing in apps'] : [], ...takesSottoTools ? ['Sotto\'s browser, for clicking and typing in a page'] : []]

/** What can hold the mark: a project's thread of this computer, on an overseer's provider, that no thread delegated to. */
type DynamicThreadFacts = Pick<AgentThread, 'providerId' | 'kind' | 'delegatedBy' | 'remoteHost' | 'archivedAt'>

/** Why a thread cannot be turned Dynamic, in plain words, or undefined where it can. */
export function whyNotDynamic(thread: DynamicThreadFacts): string | undefined {
  if (thread.archivedAt) return 'An archived thread cannot change. Nothing changed.'
  if ((thread.kind ?? 'project') !== 'project') return 'Only a thread in a project can be Dynamic. Nothing changed.'
  if (thread.remoteHost) return 'A thread on another machine cannot be Dynamic yet. Nothing changed.'
  if (thread.delegatedBy !== undefined) return 'A thread another thread started cannot be Dynamic. Nothing changed.'
  if (!thread.providerId || !DYNAMIC_OVERSEERS.has(thread.providerId)) return 'Only a Claude Code or Codex thread can be Dynamic for now. Nothing changed.'
  return undefined
}

/**
 * Whether a thread runs as a Dynamic thread now: the mark, on a thread that can hold it, while the Owl feature is on. A
 * mark left on a thread that moved to another provider before its first send, or read where the feature is off, stays
 * whole and does nothing.
 */
export function isDynamicThread(thread: DynamicThreadFacts & Pick<AgentThread, 'dynamic'>, enabled: boolean): boolean {
  return enabled && thread.dynamic === true && whyNotDynamic(thread) === undefined
}

/** The line an overseer's reply gives its reason on, if it changed anything itself (ADR-0191 decision 2). */
export const OVERSEER_REASON_PREFIX = 'Overseer change reason:'

/**
 * What a Dynamic thread's model is told, in place of the role table, each time its provider session loads (ADR-0191). It
 * is told and marked rather than blocked, so nothing here grants or holds back anything: `delegate` holds the limits.
 */
export function overseerInstructions(): string {
  return [
    'The user made you this thread\'s overseer. Plan the work and hand each piece to a delegated thread with the delegate tool, on the model you judge best for that piece. You do no work yourself: you read code, write briefs, check what comes back and answer the user.',
    'Call read_delegation with no delegation to see the models you may use, what each can do and how much of its limit is left. Choose from those alone, and prefer a provider with room.',
    'For each new thread, name its provider, model, effort and permission, and give why in one short plain line the user will read. Leave speed out unless the user\'s message asks for one. A brief is all a worker sees of this thread, so write it in full.',
    'Do not edit project files or run commands that change anything. If you must, list the files or commands in your reply, and give the reason once, on a line of its own that starts with exactly "' + OVERSEER_REASON_PREFIX + '". Sotto marks the reply either way.',
    'One worker at a time may write in the shared checkout. Give any other writer its own worktree with working_copy, and say so in its brief.',
    'If a worker stopped at a limit, give the piece to another model and name its delegation in replaces. Its partial work stays in the folder, so tell the new worker.',
    'When the user names a model, use it. If delegate refuses a provider because it is off the list, tell the user they can tick it in Settings, under Threads.',
  ].join('\n\n')
}

/**
 * What a provider session has been told of Dynamic (ADR-0191). A session keeps the instructions it was created with and
 * ignores new ones on resume, so a thread that changes after its first send is told by an **overseer note** with its next
 * message: `created` is what the session began as, and `told` what it last heard. Absent, a session that began ordinary.
 */
export type DynamicSession = NonNullable<AgentThread['dynamicSession']>

/** The note that turns a session into its thread's overseer, once, beside the user's message. */
export const overseerNoteOn = (): string => `From this message on, this thread is Dynamic. Earlier instructions about worker roles no longer apply to you.\n\n${overseerInstructions()}`
/** The note that ends it. */
export const OVERSEER_NOTE_OFF = 'From this message on, this thread is no longer Dynamic. You are not its overseer any more, whatever you were told before: do the work yourself, or hand pieces on as your other instructions say.'

/** The note a thread's next message must carry, or undefined when its session already knows where it stands. */
export function overseerNoteFor(thread: DynamicThreadFacts & Pick<AgentThread, 'dynamic' | 'dynamicSession'>, enabled: boolean): string | undefined {
  if (!enabled) return undefined
  const dynamic = isDynamicThread(thread, true), told = thread.dynamicSession?.told ?? false
  return dynamic === told ? undefined : dynamic ? overseerNoteOn() : OVERSEER_NOTE_OFF
}

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
/** The most **your note** holds: a few lines of advice (ADR-0191 decision 9). */
export const DYNAMIC_NOTE_MAX_CHARACTERS = 600
const dynamicNoteSchema = z.string().max(DYNAMIC_NOTE_MAX_CHARACTERS)

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
  /** **Your note**: advice in the user's own words, which an overseer is told when its session starts and once after a change. */
  note: dynamicNoteSchema.optional(),
}).strict()
export type DynamicThreadSettings = z.infer<typeof dynamicThreadSettingsSchema>
export const DEFAULT_DYNAMIC_THREADS: DynamicThreadSettings = { highestEffort: DEFAULT_HIGHEST_EFFORT, workersAtOnce: DEFAULT_WORKERS_AT_ONCE }

/** Read one field at a time, so a damaged value costs only itself. A damaged list is no list, so it is asked for again. */
export function parseDynamicThreadSettings(input: unknown): DynamicThreadSettings {
  const saved = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const providers = allowedProvidersSchema.safeParse(saved.providers)
  const highestEffort = dynamicEffortSchema.safeParse(saved.highestEffort)
  const workersAtOnce = workersAtOnceSchema.safeParse(saved.workersAtOnce)
  // A note past the limit keeps the user's words up to it rather than losing them all.
  const note = typeof saved.note === 'string' ? saved.note.slice(0, DYNAMIC_NOTE_MAX_CHARACTERS) : undefined
  return { ...providers.success ? { providers: [...new Set(providers.data)] } : {},
    highestEffort: highestEffort.success ? highestEffort.data : DEFAULT_HIGHEST_EFFORT,
    workersAtOnce: workersAtOnce.success ? workersAtOnce.data : DEFAULT_WORKERS_AT_ONCE,
    ...note ? { note } : {} }
}

/** The note as an overseer is told it, or undefined when there is nothing but space in it. */
export const dynamicNoteText = (note: string | undefined): string | undefined => note?.trim() || undefined

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

/** How **your note** reaches an overseer, in its instructions or in a note of its own. */
const userNoteWords = (note: string): string => `The user's note, advice in their own words. Weigh it when you choose and brief. delegate still holds the allowed list and the limits.\n\n${note}`

/**
 * What a Dynamic thread's model is told, in place of the role table, each time its provider session loads (ADR-0191). It
 * is told and marked rather than blocked, so nothing here grants or holds back anything: `delegate` holds the limits.
 * `note` is **your note**, as `dynamicNoteText` reads it.
 */
export function overseerInstructions(note?: string): string {
  return [
    'The user made you this thread\'s overseer. Plan the work and hand each piece to a delegated thread with the delegate tool, on the model you judge best for that piece. You do no work yourself: you read code, write briefs, check what comes back and answer the user.',
    'Call read_delegation with no delegation to see the models you may use, what each can do and how much of its limit is left. Choose from those alone, and prefer a provider with room.',
    'For each new thread, name its provider, model, effort and permission, and give why in one short plain line the user will read. Leave speed out unless the user\'s message asks for one. A brief is all a worker sees of this thread, so write it in full.',
    'Do not edit project files or run commands that change anything. If you must, list the files or commands in your reply, and give the reason once, on a line of its own that starts with exactly "' + OVERSEER_REASON_PREFIX + '". Sotto marks the reply either way.',
    'One worker at a time may write in the shared checkout. Give any other writer its own worktree with working_copy, and say so in its brief.',
    'If a worker stopped at a limit, give the piece to another model and name its delegation in replaces. Its partial work stays in the folder, so tell the new worker.',
    'When the user names a model, use it. If delegate refuses a provider because it is off the list, tell the user they can tick it in Settings, under Threads.',
    ...note ? [userNoteWords(note)] : [],
  ].join('\n\n')
}

/**
 * What a provider session has been told of Dynamic (ADR-0191). A session keeps the instructions it was created with and
 * ignores new ones on resume, so a thread that changes after its first send is told by an **overseer note** with its next
 * message: `created` is what the session began as, and `told` what it last heard. `createdNote` and `toldNote` are digests
 * of **your note** at those two times, never its words, absent where there was none. `noteHeard`: a note of the user's,
 * or its clearing, reached the session in its conversation, where a compaction can lose it; `noteOwed`: one did, and a
 * compaction since means it goes again. Absent, a session that began ordinary.
 */
export type DynamicSession = NonNullable<AgentThread['dynamicSession']>

/** **Your note** as the workspace holds it while a send goes: its words, and the digest a session's record keeps of them. */
export interface OverseerUserNote { readonly text: string; readonly digest: string }

/**
 * The note that turns a session into its thread's overseer, once, beside the user's message. `replacing`: the session
 * heard a note of the user's before, which the one in these instructions, or none, now replaces.
 */
export const overseerNoteOn = (note?: string, replacing = false): string => `From this message on, this thread is Dynamic. Earlier instructions about worker roles no longer apply to you.${replacing ? ' Set aside any earlier note from the user: only one in these instructions stands.' : ''}\n\n${overseerInstructions(note)}`
/** The note that ends it. */
export const OVERSEER_NOTE_OFF = 'From this message on, this thread is no longer Dynamic. You are not its overseer any more, whatever you were told before: do the work yourself, or hand pieces on as your other instructions say.'
/** The note that tells an overseer **your note** changed, or was cleared, since it was last told. */
export const overseerNoteChanged = (note: string | undefined): string => note
  ? `The user changed their note. From this message on, set aside any earlier note from them.\n\n${userNoteWords(note)}`
  : 'The user cleared their note. From this message on, set aside any earlier note from them.'

type OverseerThread = DynamicThreadFacts & Pick<AgentThread, 'dynamic' | 'dynamicSession'>

/**
 * What a send owes its thread's provider session, and what the session's record becomes once the send is accepted.
 * `first` is a first message: its session was created with the instructions its launch read, and `launchedNote` the
 * digest of the note in them, which can be older than the note now if the process started before a change.
 */
export function overseerSend(thread: OverseerThread, enabled: boolean, note?: OverseerUserNote, first?: { readonly launchedNote: string | undefined }): { readonly note?: string; readonly session?: DynamicSession } {
  if (!enabled) return {}
  const dynamic = isDynamicThread(thread, true), digest = note?.digest
  if (first) {
    // A session created ordinary keeps no record. One created as overseer is told at once of a change since its launch.
    if (!dynamic) return {}
    const changed = first.launchedNote !== digest
    return { ...changed ? { note: overseerNoteChanged(note?.text) } : {},
      session: { created: true, told: true, ...first.launchedNote ? { createdNote: first.launchedNote } : {}, ...digest ? { toldNote: digest } : {}, ...changed ? { noteHeard: true as const } : {} } }
  }
  const was = thread.dynamicSession, told = was?.told ?? false
  const words = dynamic !== told ? dynamic ? overseerNoteOn(note?.text, Boolean(was?.createdNote || was?.noteHeard)) : OVERSEER_NOTE_OFF
    : dynamic && (was?.noteOwed || was?.toldNote !== digest) ? overseerNoteChanged(note?.text) : undefined
  if (!words) return {}
  // Whatever of the note went in a note's words is now in the conversation, where a compaction can lose it.
  const heard = was?.noteHeard || dynamic && (digest !== undefined || dynamic === told)
  return { note: words, session: { created: was?.created ?? false, told: dynamic, ...was?.createdNote ? { createdNote: was.createdNote } : {},
    ...dynamic && digest ? { toldNote: digest } : {}, ...heard ? { noteHeard: true as const } : {} } }
}

/** The note a thread's next message must carry, or undefined when its session already knows where it stands. */
export const overseerNoteFor = (thread: OverseerThread, enabled: boolean, note?: OverseerUserNote): string | undefined => overseerSend(thread, enabled, note).note

/**
 * What a session holds after its provider compacted it: what it was created with, since a compaction can lose a note. A
 * note of the user's that reached it in its conversation is owed again, even where the note now matches its creation.
 */
export function dynamicSessionAfterCompaction(session: DynamicSession): DynamicSession {
  const { toldNote: _toldNote, noteOwed: _noteOwed, ...kept } = session
  void _toldNote; void _noteOwed
  return { ...kept, told: session.created, ...session.createdNote ? { toldNote: session.createdNote } : {}, ...session.noteHeard ? { noteOwed: true as const } : {} }
}

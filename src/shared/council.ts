import { z } from 'zod'
import type { AgentModel } from './agents'
import { modelInForce } from './modelLineup'
import { resolveModel } from './modelCatalog'
import { everyProvider, providerIdSchema, type ProviderId } from './providerIds'
import { withoutUltracode } from './ultracode'
import { effortRank } from './reasoningEfforts'
import { defaultModel, fitEffort, type WorkerRoleDefault } from './workerRoles'

/**
 * The Council (ADR-0177, an Owl feature): one question from a thread put to two to five **panelists** and a **chair**,
 * each an ordinary Sotto thread on its own provider, working in a snapshot of the thread's folder, or in the folder itself
 * when it is not a Git repository. These are the shapes both processes share: the four settings, the seats Sotto fills
 * when the user chose none, and the window's bridge.
 */
export const COUNCIL_PANELISTS_MIN = 2
export const COUNCIL_PANELISTS_MAX = 5
export const COUNCIL_PANELISTS_DEFAULT = 3
/** A panelist's stable letter in one Council, by seat: the same for every reader (decision 4). */
export const COUNCIL_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const
export type CouncilLetter = typeof COUNCIL_LETTERS[number]
/** The chair's seat, which is never a panelist's. */
export const COUNCIL_CHAIR = 'chair'
export const COUNCIL_LAYOUTS = ['long-table', 'half-circle', 'round-table'] as const
export type CouncilLayout = typeof COUNCIL_LAYOUTS[number]
export const DEFAULT_COUNCIL_LAYOUT: CouncilLayout = 'long-table'
/** How long a stage waits for a thread before its row offers Retry, Use another model and Go on without it, in minutes. */
export const COUNCIL_STAGE_DEADLINE = { min: 1, max: 120, default: 10 } as const
/** How long Send to the thread waits for the fairness check when not every panelist has answered (decision 5). */
export const COUNCIL_FAIRNESS_WAIT_MS = 2 * 60_000
export const COUNCIL_QUESTION_MAX = 20_000
/** The effort a seat Sotto filled starts on (decision 7). */
export const COUNCIL_SEAT_EFFORT = 'high'
/**
 * The effort the fairness check runs at (decision 7): low, or the lowest a model offers at or above low; a model whose
 * every level is below low runs it at its highest. Null for a model with no effort setting.
 */
export function councilFairnessEffort(model: AgentModel | undefined): string | null {
  const offered = withoutUltracode(model?.reasoningEfforts ?? [])
  if (!offered.length) return null
  const low = effortRank('low') ?? 0
  return offered.find(level => (effortRank(level) ?? -1) >= low) ?? offered.at(-1)!
}

/**
 * The first line of every prompt a Council sends. The host records each prompt as Sotto's, as it records a wake-up, so no
 * client shows it as the user's; this line lets a window tag it as the Council's rather than as a wake-up.
 */
export const COUNCIL_PROMPT_LEAD = '[Sotto Council]'
export function isCouncilPromptText(text: string): boolean { return text.startsWith(COUNCIL_PROMPT_LEAD) }

/** A seat as the user chose it in Settings → Council or on the Ask screen: a model and its effort. */
export const councilSeatChoiceSchema = z.object({
  modelId: z.string().min(1).max(512),
  reasoningEffort: z.string().min(1).max(64).nullable(),
}).strict()
export type CouncilSeatChoice = z.infer<typeof councilSeatChoiceSchema>
/** The panel in Settings: one entry per seat, two to five; null is a seat Sotto fills from what is connected. */
export const councilPanelistsSchema = z.array(councilSeatChoiceSchema.nullable()).min(COUNCIL_PANELISTS_MIN).max(COUNCIL_PANELISTS_MAX)
export const councilChairSchema = councilSeatChoiceSchema.nullable()
export const councilLayoutSchema = z.enum(COUNCIL_LAYOUTS)
export const councilStageDeadlineSchema = z.number().int().min(COUNCIL_STAGE_DEADLINE.min).max(COUNCIL_STAGE_DEADLINE.max)
export const DEFAULT_COUNCIL_PANELISTS: readonly (CouncilSeatChoice | null)[] = Array.from({ length: COUNCIL_PANELISTS_DEFAULT }, () => null)

/** Read leniently, one seat at a time, so a damaged seat costs the user only that seat. */
export function parseCouncilPanelists(input: unknown): (CouncilSeatChoice | null)[] {
  if (!Array.isArray(input) || input.length < COUNCIL_PANELISTS_MIN) return [...DEFAULT_COUNCIL_PANELISTS]
  return input.slice(0, COUNCIL_PANELISTS_MAX).map(seat => councilSeatChoiceSchema.safeParse(seat).data ?? null)
}

/** The providers whose threads cannot read this computer's files, so their claims about the code stay unchecked. */
export const COUNCIL_REMOTE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['devin'])

/** Each provider's strongest model, where Sotto names one, as the worker roles' defaults name them. */
const STRONGEST: readonly WorkerRoleDefault[] = [
  { provider: 'claude', name: 'Opus', models: ['opus', 'claude-opus-*'], effort: COUNCIL_SEAT_EFFORT },
  { provider: 'codex', name: 'GPT-6.1 Sol', models: ['gpt-6.1-sol', 'gpt-6-sol'], effort: COUNCIL_SEAT_EFFORT },
  { provider: 'grok', name: 'Grok 4.7', models: ['grok-4.7-build', 'grok-4.7*'], effort: COUNCIL_SEAT_EFFORT },
  { provider: 'muse', name: 'Muse Wonder Full', models: ['muse-wonder-full*'], effort: COUNCIL_SEAT_EFFORT },
]
/** The order empty seats are filled in. Devin comes last: it cannot read the snapshot. */
const SEAT_PROVIDER_ORDER = everyProvider(['claude', 'codex', 'grok', 'muse', 'opencode', 'cursor', 'deepseek', 'devin'])

/** A provider's ready models, its strongest first, then the one it recommends, then the rest as it lists them. */
function strongestFirst(provider: ProviderId, models: readonly AgentModel[]): AgentModel[] {
  const ready = models.filter(model => model.ready && model.providerId === provider && model.legacy !== true)
  const named = STRONGEST.find(entry => entry.provider === provider)
  const top = named ? defaultModel(named, ready) : undefined
  const rest = ready.filter(model => model !== top).sort((left, right) => Number(right.recommended === true) - Number(left.recommended === true))
  return top ? [top, ...rest] : rest
}

/**
 * The models empty seats are filled from, in order: the strongest of each connected provider, then each provider's next,
 * and so on (decision 7). Three seats on three providers leave the chair the strongest of a fourth, or the next model of
 * the first when there is no fourth.
 */
export function councilModelOrder(models: readonly AgentModel[]): AgentModel[] {
  const lists = SEAT_PROVIDER_ORDER.map(provider => strongestFirst(provider, models)).filter(list => list.length > 0)
  const order: AgentModel[] = []
  for (let depth = 0; lists.some(list => list.length > depth); depth++) for (const list of lists) if (list[depth]) order.push(list[depth]!)
  return order
}

/** One seat as it would start now: the user's choice, or the model Sotto filled it with. */
export interface CouncilSeatInForce {
  readonly modelId: string
  readonly model: AgentModel | undefined
  readonly reasoningEffort: string | null
  readonly from: 'choice' | 'default'
  /** Its model is ready, so its provider is connected. A choice whose provider is away keeps its seat and says so. */
  readonly ready: boolean
  readonly provider: ProviderId | undefined
}

/** The level a model offers nearest a wanted one, without Ultracode, which is the user's own choice in a thread. */
export function councilEffort(wanted: string | null | undefined, model: AgentModel | undefined): string | null {
  if (!model) return wanted ?? null
  const offered = withoutUltracode(model.reasoningEfforts ?? [])
  if (!offered.length) return null
  return fitEffort(wanted, { ...model, reasoningEfforts: offered })
}

function seatOf(choice: CouncilSeatChoice, models: readonly AgentModel[]): CouncilSeatInForce {
  const modelId = modelInForce(models, choice.modelId)
  const model = resolveModel(models, modelId)
  return { modelId, model, reasoningEffort: councilEffort(choice.reasoningEffort, model), from: 'choice', ready: model?.ready === true,
    provider: model?.providerId }
}
function filled(model: AgentModel): CouncilSeatInForce {
  return { modelId: model.id, model, reasoningEffort: councilEffort(COUNCIL_SEAT_EFFORT, model), from: 'default', ready: true, provider: model.providerId }
}

/**
 * Every seat as it would start now (decision 7). An empty seat takes the next model in `councilModelOrder` that no other
 * seat holds, and the chair one on a provider no panelist uses where there is one; with too few models, seats share. A
 * seat with no ready model at all is undefined.
 */
export function councilSeatsInForce(panelists: readonly (CouncilSeatChoice | null)[], chair: CouncilSeatChoice | null, models: readonly AgentModel[]):
  { readonly panelists: readonly (CouncilSeatInForce | undefined)[]; readonly chair: CouncilSeatInForce | undefined } {
  const order = councilModelOrder(models)
  const chosen = panelists.map(seat => seat ? seatOf(seat, models) : undefined)
  const chosenChair = chair ? seatOf(chair, models) : undefined
  const used = new Set([...chosen, chosenChair].flatMap(seat => seat ? [seat.model?.id ?? seat.modelId] : []))
  let cursor = 0
  const next = (prefer?: (model: AgentModel) => boolean): AgentModel | undefined => {
    const unused = order.filter(model => !used.has(model.id))
    const pick = (prefer ? unused.find(prefer) : undefined) ?? unused[0] ?? (order.length ? order[cursor++ % order.length] : undefined)
    if (pick) used.add(pick.id)
    return pick
  }
  const seats = chosen.map(seat => seat ?? (() => { const model = next(); return model ? filled(model) : undefined })())
  const providers = new Set(seats.flatMap(seat => seat?.provider ? [seat.provider] : []))
  const chairModel = chosenChair ? undefined : next(model => model.providerId !== undefined && !providers.has(model.providerId))
  return { panelists: seats, chair: chosenChair ?? (chairModel ? filled(chairModel) : undefined) }
}

/** What Settings → Council and the Ask screen say about the seats (decision 7). Seats are named by their place, 0 first. */
export type CouncilSeatNote =
  | { readonly kind: 'not-ready'; readonly seat: number | 'chair' }
  | { readonly kind: 'no-seat'; readonly seat: number | 'chair' }
  | { readonly kind: 'remote'; readonly seat: number | 'chair' }
  | { readonly kind: 'same-model'; readonly seats: readonly (number | 'chair')[] }

export function councilSeatNotes(seats: { readonly panelists: readonly (CouncilSeatInForce | undefined)[]; readonly chair: CouncilSeatInForce | undefined }): CouncilSeatNote[] {
  const notes: CouncilSeatNote[] = []
  const all: [number | 'chair', CouncilSeatInForce | undefined][] = [...seats.panelists.map((seat, index): [number, CouncilSeatInForce | undefined] => [index, seat]), ['chair', seats.chair]]
  for (const [seat, inForce] of all) {
    if (!inForce) notes.push({ kind: 'no-seat', seat })
    else if (!inForce.ready) notes.push({ kind: 'not-ready', seat })
    else if (inForce.provider && COUNCIL_REMOTE_PROVIDERS.has(inForce.provider)) notes.push({ kind: 'remote', seat })
  }
  const byModel = new Map<string, (number | 'chair')[]>()
  for (const [seat, inForce] of all) if (inForce) {
    const key = inForce.model?.id ?? inForce.modelId
    byModel.set(key, [...byModel.get(key) ?? [], seat])
  }
  for (const held of byModel.values()) if (held.length > 1) notes.push({ kind: 'same-model', seats: held })
  return notes
}

/** Whether every seat can start now: each has a ready model. */
export function councilSeatsReady(seats: { readonly panelists: readonly (CouncilSeatInForce | undefined)[]; readonly chair: CouncilSeatInForce | undefined }): boolean {
  return seats.panelists.every(seat => seat?.ready === true) && seats.chair?.ready === true
}

// The window's bridge.

export const COUNCIL_READ = 'sotto:council:read'
export const COUNCIL_ESTIMATE = 'sotto:council:estimate'
export const COUNCIL_COMMAND = 'sotto:council:command'
export const COUNCIL_CHANGED = 'sotto:council:changed'
/** Passed to the main window's preload only while the Owl list turns the Council on; without it there is no bridge. */
export const COUNCIL_RENDERER_ARGUMENT = '--sotto-council-enabled'
/** The newest Councils a read returns, settled ones among them. */
export const COUNCIL_VIEWS_MAX = 50

export const COUNCIL_KINDS = ['decision', 'fact', 'review', 'ideas'] as const
export type CouncilKind = typeof COUNCIL_KINDS[number]
export const councilKindSchema = z.enum(COUNCIL_KINDS)
/** Where one asking of the Council stands. */
export const COUNCIL_STAGES = ['framing', 'answers', 'reviews', 'crux', 'verdict', 'fairness', 'done'] as const
export type CouncilStage = typeof COUNCIL_STAGES[number]
/**
 * What one prompt to one thread is for. A repair asks again for a result block, under the same stage. `history` is one part
 * of a conversation too long for one prompt, sent before the thread's first stage prompt.
 */
export const COUNCIL_TURN_STAGES = ['history', 'framing', 'answer', 'review', 'crux', 'verdict', 'fairness', 'amend'] as const
export type CouncilTurnStage = typeof COUNCIL_TURN_STAGES[number]
/** A thread's state in its row (decision 4). */
export const COUNCIL_THREAD_STATES = ['working', 'waiting', 'done', 'failed', 'stopped', 'unknown'] as const
export type CouncilThreadState = typeof COUNCIL_THREAD_STATES[number]
/** What a row offers once its thread has passed the stage deadline, failed, stopped or is unknown. */
export const COUNCIL_ROW_ACTIONS = ['retry', 'replace', 'skip'] as const
export type CouncilRowAction = typeof COUNCIL_ROW_ACTIONS[number]

const id = z.string().min(1).max(512)
const seatId = z.string().min(1).max(8)
const count = z.number().int().nonnegative()

export const councilCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), originThread: id, question: z.string().trim().min(1).max(COUNCIL_QUESTION_MAX),
    panelists: z.array(councilSeatChoiceSchema).min(COUNCIL_PANELISTS_MIN).max(COUNCIL_PANELISTS_MAX), chair: councilSeatChoiceSchema }).strict(),
  z.object({ type: z.literal('retry'), council: z.uuid(), turn: z.uuid() }).strict(),
  z.object({ type: z.literal('skip'), council: z.uuid(), turn: z.uuid() }).strict(),
  z.object({ type: z.literal('replace'), council: z.uuid(), turn: z.uuid(), seat: councilSeatChoiceSchema }).strict(),
  z.object({ type: z.literal('follow-up'), council: z.uuid(), question: z.string().trim().min(1).max(COUNCIL_QUESTION_MAX) }).strict(),
  /** The user changes the round's kind, or whether it needs outside research, in the record; the panelists answer again. */
  z.object({ type: z.literal('reframe'), council: z.uuid(), kinds: z.array(councilKindSchema).min(1).max(2).optional(), research: z.boolean().optional(),
    criteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(5).optional() }).strict(),
  z.object({ type: z.literal('stop'), council: z.uuid() }).strict(),
  z.object({ type: z.literal('settle'), council: z.uuid() }).strict(),
])
export type CouncilCommand = z.infer<typeof councilCommandSchema>
export const councilCommandResultSchema = z.union([
  z.object({ ok: z.literal(true), council: z.uuid() }).strict(),
  z.object({ ok: z.literal(false), message: z.string().max(1_000) }).strict(),
])
export type CouncilCommandResult = z.infer<typeof councilCommandResultSchema>

export const councilEstimateRequestSchema = z.object({ originThread: id }).strict()
/** What the Ask screen says each thread reads before Ask the Council (decision 3): the origin conversation's size. */
export const councilEstimateSchema = z.union([
  /** `characters` is the conversation as quoted; `parts` how many prompts every thread reads it in, one when it fits in the first. */
  z.object({ messages: count, words: count, tools: count, characters: count, parts: count.min(1) }).strict(),
  z.object({ unavailable: z.string().max(1_000) }).strict(),
])
export type CouncilEstimate = z.infer<typeof councilEstimateSchema>
export const councilChangedSchema = z.object({ councils: z.array(z.uuid()).max(COUNCIL_VIEWS_MAX) }).strict()

/** Sotto's own counts from the result blocks, never the chair's (decision 5): each with its denominator, or partial. */
export const councilCountsSchema = z.object({
  /** Panelists whose answers the verdict had. */
  answered: count,
  /** Some review or answer block it counts from was unavailable, so a count may be short. */
  partial: z.boolean(),
  rankings: z.array(z.object({ letter: seatId, first: count, of: count }).strict()).max(COUNCIL_PANELISTS_MAX),
  findings: z.array(z.object({ finding: seatId, confirmed: count, rejected: count, unchecked: count, of: count }).strict()).max(200),
  supports: z.array(z.object({ letter: seatId, count, of: count }).strict()).max(COUNCIL_PANELISTS_MAX + 1),
  favourites: z.array(z.object({ finding: seatId, count, of: count }).strict()).max(200),
  changed: z.array(seatId).max(COUNCIL_PANELISTS_MAX),
}).strict()
export type CouncilCounts = z.infer<typeof councilCountsSchema>

/**
 * A cited `path:lines` as Sotto checked it against the snapshot (decision 4). Evidence Sotto cannot check is unchecked
 * and says what it was: a command, whose output Sotto never runs, or a source cited when the question needs no research.
 */
export const councilCitationSchema = z.object({
  finding: seatId,
  path: z.string().max(2_048),
  lines: z.string().max(32),
  check: z.enum(['matches', 'differs', 'missing', 'unchecked']),
  of: z.enum(['command', 'source']).optional(),
}).strict()
export type CouncilCitation = z.infer<typeof councilCitationSchema>

export const councilRowSchema = z.object({
  turn: z.uuid(),
  seat: seatId,
  stage: z.enum(COUNCIL_TURN_STAGES),
  state: z.enum(COUNCIL_THREAD_STATES),
  /** It has passed the stage deadline while working or waiting on the user. */
  late: z.boolean(),
  /** This row asked again for a missing or unreadable result block. */
  repair: z.boolean(),
  /** Whether Sotto could read its result block: a result still missing after its repair is unavailable. */
  result: z.enum(['pending', 'valid', 'unavailable', 'none']),
  /** What its result block says, in a line, from the block's own words: an answer, a ranking, Fair. */
  summary: z.string().max(2_000).optional(),
  citations: z.array(councilCitationSchema).max(40).optional(),
  /** An answer's sources by finding: links Sotto checked only for their shape, which reviewers open. */
  sources: z.array(z.object({ finding: seatId, url: z.string().max(2_048) }).strict()).max(40).optional(),
  /** A review whose panelist changed its own answer in it, read from its result block: the chamber's changed-answer mark. */
  changed: z.literal(true).optional(),
  thread: id,
  actions: z.array(z.enum(COUNCIL_ROW_ACTIONS)).max(COUNCIL_ROW_ACTIONS.length),
}).strict()
export type CouncilRow = z.infer<typeof councilRowSchema>

export const councilSeatViewSchema = z.object({
  seat: seatId,
  role: z.enum(['panelist', 'chair']),
  modelId: id,
  modelName: z.string().max(512),
  provider: providerIdSchema.optional(),
  effort: z.string().max(64).nullable(),
  thread: id,
  /** Its provider cannot read this computer's files, so its claims about the code are unchecked. */
  remote: z.boolean(),
}).strict()
export type CouncilSeatView = z.infer<typeof councilSeatViewSchema>

export const councilFramingViewSchema = z.object({
  kinds: z.array(councilKindSchema).min(1).max(2),
  /** Each criterion and where it came from: the question, the chair, or the user, who changed them in the record. */
  criteria: z.array(z.object({ id: seatId, source: z.enum(['question', 'assumed', 'user']), text: z.string().max(2_000) }).strict()).max(5),
  headings: z.array(z.string().max(200)).max(8),
  words: count,
  angles: z.array(z.object({ seat: seatId, text: z.string().max(2_000) }).strict()).max(COUNCIL_PANELISTS_MAX),
  /** Whether the panelists research outside the snapshot, the chair's reason, and whether the user set it in the record. */
  research: z.object({ needed: z.boolean(), reason: z.string().max(2_000), byUser: z.boolean() }).strict(),
  /** The chair's framing failed or could not be read, so the Council went on with the question alone. */
  fallback: z.boolean(),
}).strict()
export type CouncilFramingView = z.infer<typeof councilFramingViewSchema>

export const councilObjectionViewSchema = z.object({
  seat: seatId,
  claim: z.string().max(2_000),
  passage: z.string().max(2_000),
  answer: z.enum(['pending', 'amended', 'stands']),
  reason: z.string().max(2_000).optional(),
}).strict()

export const councilRoundViewSchema = z.object({
  index: count,
  /** The question, verbatim; null once it is not kept, as after a restart with Keep local history off. */
  question: z.string().max(COUNCIL_QUESTION_MAX).nullable(),
  askedAt: z.iso.datetime(),
  stage: z.enum(COUNCIL_STAGES),
  framing: councilFramingViewSchema.nullable(),
  rows: z.array(councilRowSchema).max(200),
  leftOut: z.array(seatId).max(COUNCIL_PANELISTS_MAX + 1),
  /** The user can change the kind or research now: framing is in and the verdict is not. */
  reframable: z.boolean(),
  crux: z.object({ test: z.string().max(2_000), lookup: z.boolean(), sides: z.array(z.array(seatId).max(COUNCIL_PANELISTS_MAX)).length(2), meanings: z.array(z.string().max(4_100)).max(4),
    result: z.string().max(2_000).optional() }).strict().nullable(),
  verdict: z.object({
    /** The chair's words, amended where the fairness check changed them; null once they are not kept. */
    text: z.string().max(400_000).nullable(),
    counts: councilCountsSchema,
    /** Every panelist has answered the fairness check, or two minutes have passed. */
    fairnessDone: z.boolean(),
    objections: z.array(councilObjectionViewSchema).max(COUNCIL_PANELISTS_MAX * 2),
  }).strict().nullable(),
  /** The text Send to the thread puts in its message box, once the fairness check allows it. */
  draft: z.string().max(400_000).nullable(),
}).strict()
export type CouncilRoundView = z.infer<typeof councilRoundViewSchema>

export const councilViewSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  origin: z.object({ thread: id, title: z.string().max(512) }).strict(),
  status: z.enum(['working', 'waiting', 'done', 'stopped', 'settled']),
  /** Why it stopped when Sotto stopped it: its words were lost to a restart with Keep local history off. */
  stoppedBecause: z.enum(['user', 'words-lost', 'snapshot']).optional(),
  /**
   * Where the Council works: the branch and commit, and whether the snapshot carried uncommitted changes and how many
   * untracked files. Absent when the thread's folder is not a Git repository, so the Council works in that folder itself.
   */
  snapshot: z.object({ commit: z.string().max(64), branch: z.string().max(512), untracked: count, dirty: z.boolean(), removed: z.boolean() }).strict().optional(),
  /** How each thread read the whole conversation: in its first prompt, or in parts before it when it was too long for one. */
  history: z.object({ messages: count, words: count, parts: count }).strict(),
  seats: z.array(councilSeatViewSchema).max(COUNCIL_PANELISTS_MAX + 1),
  rounds: z.array(councilRoundViewSchema).min(1).max(50),
  deadlineMinutes: count,
}).strict()
export type CouncilView = z.infer<typeof councilViewSchema>
export const councilViewsSchema = z.array(councilViewSchema).max(COUNCIL_VIEWS_MAX)

/** The main window's bridge, present only while the `council` Owl feature is on. */
export interface CouncilBridge {
  read(): Promise<CouncilView[]>
  estimate(request: z.infer<typeof councilEstimateRequestSchema>): Promise<CouncilEstimate>
  command(command: CouncilCommand): Promise<CouncilCommandResult>
  onChanged(listener: (change: z.infer<typeof councilChangedSchema>) => void): () => void
}

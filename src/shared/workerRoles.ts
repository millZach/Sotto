import { z } from 'zod'
import { agentRuntimeModeSchema, everyProvider, parsePublicProviderEntityId, PROVIDER_LABELS, type AgentModel, type AgentRuntimeMode, type ProviderId } from './agents'
import { resolveModel } from './modelCatalog'
import { watcherProviderIds } from './providerProfile'
import { nearestRuntimeMode, RUNTIME_MODE_ORDER } from './newThreadDefaults'
import { effortKey, effortRank } from './reasoningEfforts'

/**
 * Worker roles (CONTEXT.md, **Worker role**; #1041): the kinds of work a thread is started for, and what Settings, under
 * Watcher, says each one starts on. This is the one reader every part asks: Settings, Watcher's `start_thread`, a
 * thread's `delegate` (ADR-0081), and each provider's own sub-agents after it (#1042). Only the rows the user chose are
 * saved. Every other row follows its role's defaults over the models that are ready now, so a provider connecting or
 * disconnecting needs no migration and never overwrites a choice.
 */
export const WORKER_KINDS = ['building', 'ui', 'code-review', 'research', 'computer-use'] as const
/** Orchestrating is Watcher itself; the five kinds after it are the work Watcher and delegating threads start. */
export const WORKER_ROLE_IDS = ['orchestrating', ...WORKER_KINDS] as const
export const workerKindSchema = z.enum(WORKER_KINDS)
export const workerRoleIdSchema = z.enum(WORKER_ROLE_IDS)
export type WorkerKind = z.infer<typeof workerKindSchema>
export type WorkerRoleId = z.infer<typeof workerRoleIdSchema>

/**
 * A row as the user chose it. The whole row counts as their choice once any of its three settings changed, and it stays
 * until they reset it. Orchestrating saves no permission: Watcher's permission is its own, chosen in its room.
 */
export const workerRoleChoiceSchema = z.object({
  modelId: z.string().min(1).max(512),
  reasoningEffort: z.string().min(1).max(64).nullable(),
  runtimeMode: agentRuntimeModeSchema.optional(),
}).strict()
export type WorkerRoleChoice = z.infer<typeof workerRoleChoiceSchema>
export const workerRoleChoicesSchema = z.partialRecord(workerRoleIdSchema, workerRoleChoiceSchema)
export type WorkerRoleChoices = z.infer<typeof workerRoleChoicesSchema>

/** Read leniently, one row at a time, so a damaged or retired row costs the user only that row. */
export function parseWorkerRoleChoices(input: unknown): WorkerRoleChoices {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const choices: WorkerRoleChoices = {}
  for (const [key, value] of Object.entries(input)) {
    const role = workerRoleIdSchema.safeParse(key), choice = workerRoleChoiceSchema.safeParse(value)
    if (!role.success || !choice.success) continue
    const { runtimeMode, ...rest } = choice.data
    choices[role.data] = role.data === 'orchestrating' || runtimeMode === undefined ? rest : { ...rest, runtimeMode }
  }
  return choices
}

/** One of a role's defaults: a model of one provider, and the effort to start it on. */
export interface WorkerRoleDefault {
  readonly provider: ProviderId
  /** What the list calls it when the provider's catalog cannot, as for a provider that is not set up. */
  readonly name: string
  /** The provider's own model IDs, first match wins; one ending in `*` matches any ID that starts with the rest. */
  readonly models: readonly string[]
  /** One of Sotto's level words; the nearest level the model offers is used, and null takes the model's own default. */
  readonly effort: string | null
}
export interface WorkerRole {
  readonly id: WorkerRoleId
  readonly name: string
  /** The kind of work, in a line. */
  readonly what: string
  /** In order: the first whose model is ready is the one in force. */
  readonly defaults: readonly WorkerRoleDefault[]
  /** What a worker in this role may do without asking, before the new-thread default caps it. Orchestrating has none. */
  readonly permission: AgentRuntimeMode | null
}

const claude = (name: string, ids: readonly string[]) => (effort: string | null): WorkerRoleDefault => ({ provider: 'claude', name, models: ids, effort })
const codex = (name: string, ids: readonly string[]) => (effort: string | null): WorkerRoleDefault => ({ provider: 'codex', name, models: ids, effort })
const grok = (name: string, ids: readonly string[]) => (effort: string | null): WorkerRoleDefault => ({ provider: 'grok', name, models: ids, effort })
const muse = (name: string, ids: readonly string[]) => (effort: string | null): WorkerRoleDefault => ({ provider: 'muse', name, models: ids, effort })
const OPUS = claude('Opus', ['opus', 'claude-opus-*'])
const SONNET = claude('Sonnet', ['sonnet', 'claude-sonnet-*'])
const HAIKU = claude('Haiku', ['haiku', 'claude-haiku-*'])
const SOL = codex('GPT-6.1 Sol', ['gpt-6.1-sol', 'gpt-6-sol'])
const ASTRA = codex('GPT-6 Astra', ['gpt-6-astra'])
const LUNA = codex('GPT-6 Luna', ['gpt-6-luna'])
const GROK_47 = grok('Grok 4.7', ['grok-4.7-build', 'grok-4.7*'])
const GROK_46 = grok('Grok 4.6', ['grok-4.6-build', 'grok-4.6*'])
const WONDER_FULL = muse('Muse Wonder Full', ['muse-wonder-full*'])
const WONDER = muse('Muse Wonder', ['muse-wonder', 'muse-wonder-1*'])

/**
 * The roles, each with its defaults in order (decided October 14, 2026, from the prototype at
 * `prototype/watcher-worker-roles`). With Claude Code, Codex, Muse and Grok Build connected: Orchestrating on Opus,
 * Building and UI on Opus at Extra high, Code review on Muse Wonder Full at Extra high, Research on Haiku, Computer use on
 * GPT-6 Astra with Full access, which the new-thread default still caps. With one provider, its own models.
 */
export const WORKER_ROLES: readonly WorkerRole[] = [
  { id: 'orchestrating', name: 'Orchestrating', what: 'Watcher itself.', defaults: [OPUS('high'), SOL('high'), GROK_47('high')], permission: null },
  { id: 'building', name: 'Building', what: 'Writing and changing code.',
    defaults: [OPUS('xhigh'), SONNET('xhigh'), SOL('xhigh'), WONDER_FULL('xhigh'), GROK_47('xhigh')], permission: 'auto-accept-edits' },
  { id: 'ui', name: 'UI', what: 'Screens, styles and how they look.',
    defaults: [OPUS('xhigh'), SOL('xhigh'), WONDER_FULL('xhigh'), GROK_47('xhigh')], permission: 'auto-accept-edits' },
  { id: 'code-review', name: 'Code review', what: 'Reading a change and saying what is wrong with it.',
    defaults: [WONDER_FULL('xhigh'), SOL('xhigh'), OPUS('xhigh'), GROK_47('xhigh')], permission: 'approval-required' },
  { id: 'research', name: 'Research', what: 'Reading code, docs and the web, and reporting back.',
    defaults: [HAIKU(null), LUNA('medium'), GROK_46('medium'), WONDER('low')], permission: 'approval-required' },
  { id: 'computer-use', name: 'Computer use', what: 'Clicking and typing in apps and the browser.',
    defaults: [ASTRA('medium'), OPUS('high'), GROK_47('high')], permission: 'full-access' },
]
const ROLES = new Map(WORKER_ROLES.map(role => [role.id, role]))
export function workerRole(id: WorkerRoleId): WorkerRole { return ROLES.get(id)! }

/** Sotto's four modes in words, as every permission control says them. */
export const RUNTIME_MODE_WORDS: Readonly<Record<AgentRuntimeMode, string>> = {
  'approval-required': 'Ask for approval', 'auto-accept-edits': 'Allow edits', auto: 'Auto', 'full-access': 'Full access',
}

/**
 * The providers Watcher runs on, as `watcherProviderSchema` names them (ADR-0073, ADR-0079): Orchestrating's model is one
 * of theirs. Each provider's profile says whether Watcher runs on it; one that does not is never Orchestrating's.
 */
export const WATCHER_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(watcherProviderIds())
/**
 * Watcher's providers in words, less those held to Owl on this run (ADR-0072): "Codex, Claude Code or Grok Build" on
 * stable, with Muse added on Owl. Every sentence that names where Watcher can run asks this.
 */
export function watcherProvidersInWords(held: ReadonlySet<ProviderId>): string {
  const named = [...WATCHER_PROVIDERS].filter(id => !held.has(id)).map(id => PROVIDER_LABELS[id])
  return named.length < 2 ? named.join('') : `${named.slice(0, -1).join(', ')} or ${named.at(-1)}`
}
/**
 * The order a role with no ready default looks through for one of a provider's own models. OpenCode comes last: a fresh
 * one offers only OpenCode Zen's free models, which no role names as a default.
 */
const PROVIDER_ORDER = everyProvider(['claude', 'codex', 'grok', 'muse', 'devin', 'opencode', 'cursor'])
/** Whether a role can run on a model: Orchestrating only on a provider Watcher can run on. */
export function roleCanUse(role: WorkerRoleId, model: Pick<AgentModel, 'providerId'>): boolean {
  return role !== 'orchestrating' || (model.providerId !== undefined && WATCHER_PROVIDERS.has(model.providerId))
}
const usable = (role: WorkerRoleId, model: AgentModel | undefined): model is AgentModel => model?.ready === true && roleCanUse(role, model)
const nativeId = (model: AgentModel): string => parsePublicProviderEntityId(model.id)?.value ?? model.id
const matches = (id: string, pattern: string): boolean => pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern

/** The catalog model a default names, a ready one first, or undefined when its provider lists none. */
export function defaultModel(entry: WorkerRoleDefault, models: readonly AgentModel[]): AgentModel | undefined {
  const named = (model: AgentModel) => model.providerId === entry.provider && entry.models.some(pattern => matches(nativeId(model), pattern))
  for (const pattern of entry.models) {
    const found = models.find(model => model.ready && model.providerId === entry.provider && matches(nativeId(model), pattern))
    if (found) return found
  }
  return models.find(named)
}

/**
 * The level a model offers nearest a wanted one: the same level, else the closest known level (the lower of two as
 * close), else the model's own default. Null for a model with no effort setting.
 */
export function fitEffort(wanted: string | null | undefined, model: AgentModel | undefined): string | null {
  const offered = model?.reasoningEfforts ?? []
  if (!offered.length) return null
  if (!wanted) return model?.defaultReasoningEffort ?? null
  const exact = offered.find(level => effortKey(level) === effortKey(wanted))
  if (exact) return exact
  const rank = effortRank(wanted)
  let best: string | undefined, distance = Infinity
  if (rank !== undefined) for (const level of offered) {
    const at = effortRank(level)
    if (at !== undefined && Math.abs(at - rank) < distance) { best = level; distance = Math.abs(at - rank) }
  }
  return best ?? model?.defaultReasoningEffort ?? null
}
/** A wanted mode as a model can take it: the nearest it offers, none for a provider with its own permission profiles. */
export function fitRuntimeMode(wanted: AgentRuntimeMode | null | undefined, model: AgentModel | undefined): AgentRuntimeMode | undefined {
  if (!wanted || !model || model.providerModes?.length) return undefined
  return nearestRuntimeMode(wanted, model.runtimeModes ?? [])
}
/** The narrower of a wanted mode and a ceiling: a worker never starts wider than the new-thread default (ADR-0073). */
export function capRuntimeMode(wanted: AgentRuntimeMode, ceiling: AgentRuntimeMode): AgentRuntimeMode {
  return RUNTIME_MODE_ORDER.indexOf(wanted) > RUNTIME_MODE_ORDER.indexOf(ceiling) ? ceiling : wanted
}

/** A role's default in force: which of its defaults (-1 for a provider's own model when none is ready) and how it starts. */
export interface RoleDefaultInForce {
  readonly index: number
  readonly model: AgentModel
  readonly reasoningEffort: string | null
  readonly runtimeMode: AgentRuntimeMode | undefined
}
/**
 * The first of a role's defaults whose model is ready. With none ready, the first ready model of a provider that can do
 * the work, the one it recommends first, so someone with one subscription still gets that provider's own.
 */
export function roleDefaultInForce(id: WorkerRoleId, models: readonly AgentModel[]): RoleDefaultInForce | undefined {
  const role = workerRole(id)
  for (const [index, entry] of role.defaults.entries()) {
    const model = defaultModel(entry, models)
    if (usable(id, model)) return { index, model, reasoningEffort: fitEffort(entry.effort, model), runtimeMode: fitRuntimeMode(role.permission, model) }
  }
  for (const provider of PROVIDER_ORDER) {
    const ready = models.filter(model => model.providerId === provider && usable(id, model))
    const model = ready.find(item => item.recommended) ?? ready[0]
    if (model) return { index: -1, model, reasoningEffort: fitEffort(null, model), runtimeMode: fitRuntimeMode(role.permission, model) }
  }
  return undefined
}

/** What one role starts new work on now, and why. */
export interface RoleInForce {
  readonly role: WorkerRole
  /** The row as the user chose it, when they did. It stays saved whatever is connected. */
  readonly choice: WorkerRoleChoice | undefined
  /** Whether the chosen model is ready now. While it is not, new work starts on the default in force. */
  readonly choiceReady: boolean
  /** The default in force: what Reset puts back, and what starts while a choice's provider is away. */
  readonly fallback: RoleDefaultInForce | undefined
  /** What new work starts on, before the new-thread default caps its permission; undefined when nothing ready can do it. */
  readonly start: RoleStartChoice | undefined
}
export interface RoleStartChoice {
  readonly model: AgentModel
  /** The ID to start on: a choice's own, which may name a long-context variant the catalog lists under its base. */
  readonly modelId: string
  readonly reasoningEffort: string | null
  readonly runtimeMode: AgentRuntimeMode | undefined
  readonly from: 'choice' | 'default'
}
export function roleInForce(id: WorkerRoleId, choices: WorkerRoleChoices, models: readonly AgentModel[]): RoleInForce {
  const role = workerRole(id), choice = choices[id], fallback = roleDefaultInForce(id, models)
  const chosen = choice ? resolveModel(models, choice.modelId) : undefined
  const choiceReady = usable(id, chosen)
  const start: RoleStartChoice | undefined = choice && choiceReady
    ? { model: chosen!, modelId: choice.modelId, reasoningEffort: fitEffort(choice.reasoningEffort, chosen), runtimeMode: fitRuntimeMode(choice.runtimeMode ?? role.permission, chosen), from: 'choice' }
    // While a chosen model's provider is away, the default in force starts on the permission the user chose, as near as
    // its model offers at or below it, never on the role's own wider one.
    : fallback ? { model: fallback.model, modelId: fallback.model.id, reasoningEffort: fallback.reasoningEffort,
      runtimeMode: choice ? fitRuntimeMode(choice.runtimeMode ?? role.permission, fallback.model) : fallback.runtimeMode, from: 'default' } : undefined
  return { role, choice, choiceReady, fallback, start }
}

/** Whether a row as it would be saved is the role's default in force exactly, so it follows the defaults again. */
export function isRoleDefault(id: WorkerRoleId, row: WorkerRoleChoice, models: readonly AgentModel[]): boolean {
  const fallback = roleDefaultInForce(id, models)
  if (!fallback || row.modelId !== fallback.model.id || (row.reasoningEffort ?? null) !== fallback.reasoningEffort) return false
  return id === 'orchestrating' || (row.runtimeMode ?? workerRole(id).permission) === (fallback.runtimeMode ?? workerRole(id).permission)
}

/**
 * The saved rows with one role's row as it would be saved: kept as the user's choice, or left out once it is exactly
 * the role's default in force, so the role follows its defaults again. Settings and Watcher's composer both save so.
 */
export function withRoleRow(choices: WorkerRoleChoices, id: WorkerRoleId, row: WorkerRoleChoice, models: readonly AgentModel[]): WorkerRoleChoices {
  const next: WorkerRoleChoices = { ...choices }
  if (isRoleDefault(id, row, models)) delete next[id]
  else next[id] = row
  return next
}

/** What a start asked for in its own words: anything named overrides the role for that start only. */
export interface RoleStartRequest {
  readonly modelId?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
}
export type RoleField = 'model' | 'effort' | 'permission'
/** A start by role: the role's model, effort and permission, with whatever the request named in their place. */
export interface RoleStart {
  readonly role: WorkerKind
  readonly modelId: string | undefined
  readonly reasoningEffort: string | undefined
  /** Before the new-thread default caps it. */
  readonly runtimeMode: AgentRuntimeMode | undefined
  /** What the request named itself. */
  readonly named: readonly RoleField[]
  /** What the role alone would have started on. */
  readonly roleModelId: string | undefined
}
/**
 * Fills a start from its role when it is asked for, never on the update path: main calls this once per `start_thread` or
 * `delegate`, with the settings and the catalog it already holds. Named fields win; a named model takes the role's effort
 * and permission as near as it offers them.
 */
export function startFromRole(role: WorkerKind, choices: WorkerRoleChoices, models: readonly AgentModel[], request: RoleStartRequest = {}): RoleStart {
  const inForce = roleInForce(role, choices, models).start
  const named: RoleField[] = [...(request.modelId ? ['model' as const] : []), ...(request.reasoningEffort ? ['effort' as const] : []), ...(request.runtimeMode ? ['permission' as const] : [])]
  const modelId = request.modelId ?? inForce?.modelId
  const model = modelId ? resolveModel(models, modelId) : undefined
  const sameModel = inForce !== undefined && model !== undefined && model.id === inForce.modelId
  const reasoningEffort = request.reasoningEffort ?? (sameModel ? inForce.reasoningEffort : fitEffort(inForce?.reasoningEffort, model)) ?? undefined
  const wanted = choices[role]?.runtimeMode ?? workerRole(role).permission
  const runtimeMode = request.runtimeMode ?? (sameModel ? inForce.runtimeMode : fitRuntimeMode(wanted, model))
  return { role, modelId, reasoningEffort, runtimeMode, named, roleModelId: inForce?.modelId }
}

/**
 * A role's permission a ceiling held back: what the role wanted, what the start got, and which limit held it: the
 * user's new-thread default; for a delegation, the delegating thread's own permission when that is the narrower; for a
 * start on a paired host, what that host lets this computer give a thread there when that is the narrower.
 */
export interface HeldPermission {
  readonly wanted: AgentRuntimeMode
  readonly startedOn: AgentRuntimeMode
  readonly by?: 'new-thread-default' | 'delegating-thread' | 'paired-host'
  /** That limit's own mode when the model does not offer it, so the start took the nearest mode the model does. */
  readonly unoffered?: AgentRuntimeMode | undefined
}
/** Each limit as a receipt names it. */
const HELD_BY: Readonly<Record<NonNullable<HeldPermission['by']>, string>> = {
  'new-thread-default': "the user's new-thread default", 'delegating-thread': "the delegating thread's own permission",
  'paired-host': 'the most that host lets this computer give a thread there',
}
/**
 * What a start by role says in its receipt, for the agent that asked to pass on: the role, what the request named in
 * the role's place, and a permission a ceiling held back. Plain words, no IDs the user would not know.
 */
export function roleStartNote(start: RoleStart, models: readonly AgentModel[], held?: HeldPermission): string {
  const role = workerRole(start.role)
  const name = (id: string | undefined) => id ? resolveModel(models, id)?.name ?? id : 'no model'
  const words: Record<RoleField, string> = { model: 'model', effort: 'effort', permission: 'permission' }
  const rest = (['model', 'effort', 'permission'] as const).filter(field => !start.named.includes(field)).map(field => words[field])
  const list = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  const parts = [`Started as ${role.name}, a worker role in the user's Settings.`]
  if (!start.named.length) parts.push(`Its model, ${name(start.modelId)}, its effort and its permission came from that role.`)
  else {
    const model = start.named.includes('model') ? ` (${name(start.modelId)}, where ${role.name} uses ${name(start.roleModelId)})` : ''
    parts.push(`This request named its ${list(start.named.map(field => words[field]))}${model}, which overrides ${role.name} for this start only.`)
    if (rest.length) parts.push(`Its ${list(rest)} came from the role.`)
  }
  if (held) {
    const wanted = RUNTIME_MODE_WORDS[held.wanted], startedOn = RUNTIME_MODE_WORDS[held.startedOn]
    parts.push(held.unoffered ? `Its permission, ${wanted}, was held to ${startedOn}: ${HELD_BY[held.by ?? 'new-thread-default']} is ${RUNTIME_MODE_WORDS[held.unoffered]}, which this model does not offer, so it starts on the nearest mode the model does.`
      : held.by === 'delegating-thread' ? `Its permission, ${wanted}, was held to ${startedOn}, the delegating thread's own, since a delegated thread gets no more.`
      : held.by === 'paired-host' ? `Its permission, ${wanted}, was held to ${startedOn}, the most that host lets this computer give a thread it starts there.`
        : `Its permission, ${wanted}, was held to the user's new-thread default, ${startedOn}.`)
  }
  return parts.join(' ')
}

/** The roles in a line, for instructions that name them. */
export const WORKER_KIND_LIST = WORKER_KINDS.join(', ')

/**
 * The name a role's own sub-agent goes by in Claude Code and Codex (#1042). Sotto's prefix keeps it clear of the
 * provider's built-in agents and of any the user made, so neither is replaced and neither replaces it.
 */
export function subagentName(kind: WorkerKind): string { return `sotto_${kind.replaceAll('-', '_')}` }

/** One kind of work as a thread's own sub-agents follow it (#1042): what the role runs on now. */
export interface SubagentRole {
  readonly kind: WorkerKind
  readonly name: string
  readonly what: string
  readonly provider: ProviderId
  /** The provider's own ID for the model, as its client takes it. */
  readonly model: string
  /** The model as the user knows it. */
  readonly modelName: string
  readonly reasoningEffort: string | null
  /** Before the thread's own permission caps it; undefined for a model with its own permission profiles. */
  readonly runtimeMode: AgentRuntimeMode | undefined
}
/**
 * What each kind of work runs on now, for a thread's own sub-agents to follow: read once at a thread's launch and when
 * Settings change, never on the update path. A kind nothing ready can do is left out.
 */
export function subagentRoleTable(choices: WorkerRoleChoices, models: readonly AgentModel[]): readonly SubagentRole[] {
  return WORKER_KINDS.flatMap(kind => {
    const start = roleInForce(kind, choices, models).start, provider = start?.model.providerId
    if (!start || !provider) return []
    const role = workerRole(kind)
    return [{ kind, name: role.name, what: role.what, provider, model: parsePublicProviderEntityId(start.modelId)?.value ?? start.modelId,
      modelName: start.model.name, reasoningEffort: start.reasoningEffort, runtimeMode: start.runtimeMode }]
  })
}

/** How one launch reaches the roles: its own named sub-agents for some, Sotto's `delegate` for the rest while it may delegate. */
export interface SubagentReach {
  readonly provider: ProviderId
  /** The roles this launch has as named sub-agents of its own; empty where the provider gets instructions only. */
  readonly agents: ReadonlySet<WorkerKind>
  /** The tool that starts one of them. */
  readonly agentTool?: 'claude' | 'codex'
  /** Whether this launch was offered `delegate` (ADR-0081): a second-level delegated thread is not. */
  readonly canDelegate: boolean
}
/** A role's kind of work as words inside a sentence: "writing and changing code". */
export const roleWork = (role: Pick<WorkerRole, 'what'>): string => `${role.what.charAt(0).toLowerCase()}${role.what.slice(1).replace(/\.$/u, '')}`
const atEffort = (effort: string | null): string => effort ? ` at ${effort} effort` : ''
/** One role's line: which agent, which model on this provider, or the delegation that reaches another provider. */
function reachLine(role: SubagentRole, reach: SubagentReach): string {
  const name = subagentName(role.kind), on = `${role.modelName}${atEffort(role.reasoningEffort)}`
  if (reach.agents.has(role.kind)) return reach.agentTool === 'codex'
    ? `call spawn_agent with agent_type "${name}" (${on}).`
    : `use the Agent tool with subagent_type "${name}" (${on}).`
  if (role.provider === reach.provider) return reach.agentTool === 'codex'
    ? `call spawn_agent with model "${role.model}"${role.reasoningEffort ? ` and reasoning_effort "${role.reasoningEffort}"` : ''}.`
    : `start your sub-agent on ${role.model}${atEffort(role.reasoningEffort)} when you can choose its model.`
  return reach.canDelegate
    ? `${on} on ${PROVIDER_LABELS[role.provider]}, another provider: call delegate with work "${role.kind}".`
    : `${on} on ${PROVIDER_LABELS[role.provider]}, which this thread cannot start: do that work yourself.`
}
/**
 * The role table as a thread's own instructions carry it (#1042), through its provider's background channel: which
 * sub-agent to use for which kind of work, and which kinds go to another provider by delegation. Undefined when no
 * kind of work has anything ready to run on.
 */
export function subagentRoleInstructions(table: readonly SubagentRole[], reach: SubagentReach): string | undefined {
  if (!table.length) return undefined
  return [
    'The user\'s Settings give each kind of work a worker role and the model it runs on. When you hand part of your work to a sub-agent or another thread, follow them:',
    ...table.map(role => `- ${role.name} (${roleWork(role)}): ${reachLine(role, reach)}`),
    'A model, effort or permission the user names for a request wins over the role. Work you do yourself needs no role.',
  ].join('\n')
}

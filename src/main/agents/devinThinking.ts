import { join } from 'node:path'
import { z } from 'zod'
import type { AgentModel } from '../../shared/agents'
import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { DevinRejected } from './devinRpc'

/**
 * Devin's thinking levels (Devin CLI 3000.14): a session's `thought_level` config option, whose choices depend on the
 * session's model. Devin says a model's levels only once a session is on it, about half a second a model, so Sotto reads
 * them after connecting, in the background, and keeps them until Devin's version changes. A model not read yet has no
 * levels in the catalog and its chip waits; one Devin gives none is marked so its chip says so (Zach's picks, prototype
 * `prototype/devin-effort`).
 */
export const DEVIN_THINKING_OPTION = 'thought_level'

const choiceSchema = z.object({ value: z.string().min(1).max(64) })
const optionsSchema = z.object({ configOptions: z.array(z.object({
  id: z.string(), currentValue: z.string(),
  options: z.array(z.union([choiceSchema, z.object({ options: z.array(choiceSchema) })])).optional(),
})) })
const levelsSchema = z.object({ levels: z.array(z.string().min(1).max(64)).max(20), default: z.string().min(1).max(64).optional() })
const catalogSchema = z.object({ devinVersion: z.string(), models: z.record(z.string(), levelsSchema) })

/** A model's levels, least to most thorough, and the one a session switched to it starts on. */
export type DevinLevels = z.infer<typeof levelsSchema>
type Catalog = z.infer<typeof catalogSchema>

/**
 * The thinking option a config answer reports: its level now and the levels on offer. Undefined where the answer has
 * none, which is a model Devin gives no levels.
 */
export function thinkingConfig(value: unknown): { current: string; levels: DevinLevels } | undefined {
  const option = optionsSchema.parse(value).configOptions.find(candidate => candidate.id === DEVIN_THINKING_OPTION)
  if (!option) return undefined
  const levels = orderReasoningEfforts((option.options ?? []).flatMap(choice => 'value' in choice ? [choice.value] : choice.options.map(inner => inner.value)))
  return { current: option.currentValue, levels: { levels, ...(levels.includes(option.currentValue) ? { default: option.currentValue } : {}) } }
}

/** What a model's levels make of its catalog entry: none read leaves it as it is, none offered marks it. */
export function withLevels(model: AgentModel, levels: DevinLevels | undefined): AgentModel {
  const rest: AgentModel = { ...model }
  delete rest.reasoningEfforts; delete rest.defaultReasoningEffort; delete rest.noReasoningEfforts
  if (!levels) return rest
  if (!levels.levels.length) return { ...rest, reasoningEfforts: [], noReasoningEfforts: true }
  return { ...rest, reasoningEfforts: levels.levels, ...(levels.default ? { defaultReasoningEffort: levels.default } : {}) }
}

/** The levels Sotto has read, saved beside the catalog session's folder and kept for one Devin version. */
export class DevinThinkingLevels {
  private readonly store: AtomicJsonStore<Catalog>
  private catalog: Catalog = { devinVersion: '', models: {} }
  constructor(devinDirectory: string) {
    this.store = new AtomicJsonStore(join(devinDirectory, 'thinking-levels.json'), catalogSchema.parse, () => ({ devinVersion: '', models: {} }), undefined, undefined, undefined, 'compact')
  }
  /** Reads what was saved, keeping it only if it was read from this Devin version. An unreadable file reads as nothing saved. */
  async load(devinVersion: string): Promise<void> {
    let saved: Catalog
    try { saved = await this.store.read() } catch { saved = { devinVersion: '', models: {} } }
    this.catalog = saved.devinVersion === devinVersion ? saved : { devinVersion, models: {} }
  }
  get(modelId: string): DevinLevels | undefined { return this.catalog.models[modelId] }
  /** Records what Devin said for a model; true when that changed what Sotto had. */
  set(modelId: string, levels: DevinLevels): boolean {
    const before = this.catalog.models[modelId]
    if (before && before.default === levels.default && before.levels.join() === levels.levels.join()) return false
    this.catalog.models[modelId] = levels; return true
  }
  save(): Promise<void> { return this.store.write(structuredClone(this.catalog)) }
}

/** One catalog process with a session of its own to switch between models. */
export interface ThinkingLane {
  request(method: string, params: unknown, apply: (value: unknown) => void): Promise<void>
  readonly sessionId: string
  close(): Promise<void>
}

/** How many catalog processes share the reading. Devin serves one process's switches one at a time; four took 22 s for 169 models. */
export const THINKING_LANES = 4

/**
 * Switches catalog sessions to each model in turn and hands back what Devin says of its levels. `models` comes in the
 * order to read, so the ones threads use go first. Several processes share the list, since one takes a model at a time.
 * A model Devin refuses, or one left when a process fails, is left unread rather than guessed at. Stops as soon as
 * `current` says the connection that asked has gone.
 */
export async function readThinkingLevels(options: {
  models: readonly string[]
  open: () => Promise<ThinkingLane>
  current: () => boolean
  found: (modelId: string, levels: DevinLevels) => void
  lanes?: number
}): Promise<void> {
  const queue = [...options.models]
  const lanes = Math.min(options.lanes ?? THINKING_LANES, queue.length)
  await Promise.all(Array.from({ length: lanes }, async () => {
    let lane: ThinkingLane | undefined
    try {
      if (!options.current()) return
      lane = await options.open()
      for (let next = queue.shift(); next !== undefined && options.current(); next = queue.shift()) {
        const modelId = next
        try {
          await lane.request('session/set_config_option', { sessionId: lane.sessionId, configId: 'model', value: modelId }, value => {
            if (!options.current()) return
            options.found(modelId, thinkingConfig(value)?.levels ?? { levels: [] })
          })
        } catch (error) {
          // Devin refusing one model leaves it unread; anything else is the process gone, and so is this lane.
          if (!(error instanceof DevinRejected) || !options.current()) return
        }
      }
    } catch { /* A lane that could not open leaves its models to the others, or unread. */ }
    finally { await lane?.close().catch(() => undefined) }
  }))
}

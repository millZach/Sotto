import { parsePublicProviderEntityId, type AgentModel } from './agents'
import { baseModelId, resolveModel, servedModelName } from './modelCatalog'
import type { ProviderId } from './providerIds'

/**
 * Which of a provider's models a menu leads with, and what a model the provider has stopped offering becomes (ADR-0171).
 * Only Claude Code's and Codex's lists are ordered this way; every other provider's list is left as its provider gives it.
 *
 * - A model's **line** is its name without its version: Opus 5.5 and Opus 4.8 are both Opus, GPT-6.1-Sol and GPT-5.6-Sol
 *   both GPT Sol. Claude Code's long-context naming ("with 1M context") is part of the model, not of the line.
 * - A **legacy** model is one with a newer model of the same line in the same catalog. The provider's recommended model
 *   is never legacy. Menus show the rest first and the legacy ones under a closed Legacy section.
 * - A **retired** model is one the provider's catalog no longer lists as ready while that provider has sent a catalog.
 *   It is never shown. What was on it moves to its **successor**: the newest ready model of its line.
 */
export const LINEUP_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['claude', 'codex'])

const VERSION = /\d+(?:\.\d+)*/u
/** IDs in the shape Claude Code and Codex give their own models, as against a name typed for a model they never listed. */
const OWN_MODEL_IDS: Readonly<Partial<Record<ProviderId, RegExp>>> = {
  claude: /^(?:claude-)?(?:opus|sonnet|haiku|fable)\b/iu,
  codex: /^(?:gpt|codex)-/iu,
}
const LONG_CONTEXT_WORDS = /\(?\b(?:with\s+)?1m\s+context\)?/giu

/** A model's version as numbers, from its name or else its ID; empty when neither carries one. */
export function modelVersion(model: Pick<AgentModel, 'name' | 'id'>): number[] {
  return (model.name.match(VERSION)?.[0] ?? model.id.match(VERSION)?.[0] ?? '').split('.').filter(Boolean).map(Number)
}

/** Positive when `left` is newer than `right`, by version number, part by part. */
export function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/** A model's line: its name without its version or a long-context note, lower-cased, as words. */
export function modelLine(name: string): string {
  return name.toLowerCase().replace(VERSION, ' ').replace(LONG_CONTEXT_WORDS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * One provider's catalog with `legacy` set on every model that has a newer model of its line in it, and taken off the rest.
 * The adapters of the lineup's providers call this once per catalog they read, so every surface reads the same answer
 * from the catalog itself, the iPhone too, and nothing works it out per update.
 */
export function markLegacyModels<T extends Pick<AgentModel, 'id' | 'name' | 'recommended' | 'legacy'>>(models: readonly T[]): T[] {
  const newest = new Map<string, number[]>()
  for (const model of models) {
    if (model.recommended) continue
    const line = modelLine(model.name), version = modelVersion(model), held = newest.get(line)
    if (!held || compareVersions(version, held) > 0) newest.set(line, version)
  }
  return models.map(model => {
    const legacy = !model.recommended && compareVersions(newest.get(modelLine(model.name)) ?? [], modelVersion(model)) > 0
    if (legacy === (model.legacy === true)) return model
    if (legacy) return { ...model, legacy: true }
    const rest = { ...model }
    delete rest.legacy
    return rest
  })
}

/** Whether this model belongs to a provider whose menus lead with the newest models (Claude Code and Codex). */
export const inLineup = (model: Pick<AgentModel, 'providerId'>): boolean => model.providerId !== undefined && LINEUP_PROVIDERS.has(model.providerId)

/**
 * The model a retired model's ID moves to: for a long-context variant whose base is ready, the base; otherwise the newest
 * ready model of its line, then, with `anyModel`, the provider's recommended model, then the first it lists. Undefined when
 * the ID is no lineup provider's, or that provider has no ready model, which is a provider not connected rather than a
 * retired model. `name` is the retired model's name where the catalog still holds it; otherwise it is read from the ID.
 */
export function retiredModelSuccessor<T extends AgentModel>(models: readonly T[], modelId: string, name?: string, anyModel = true): T | undefined {
  const parsed = parsePublicProviderEntityId(modelId)
  if (!parsed || parsed.kind !== 'model' || !LINEUP_PROVIDERS.has(parsed.provider)) return undefined
  const ready = models.filter(model => model.ready && model.providerId === parsed.provider)
  if (!ready.length) return undefined
  const base = baseModelId(modelId)
  const baseEntry = base === undefined ? undefined : ready.find(model => model.id === base)
  if (baseEntry) return baseEntry
  const line = modelLine(name ?? servedModelName(parsed.provider, parsed.value).replace(/^Claude /u, ''))
  let best: T | undefined
  for (const model of ready) {
    if (model.recommended || modelLine(model.name) !== line) continue
    if (!best || compareVersions(modelVersion(model), modelVersion(best)) > 0) best = model
  }
  return best ?? (anyModel ? ready.find(model => model.recommended) ?? ready[0] : undefined)
}

/**
 * The model ID a saved choice runs on: the choice itself while its provider lists it ready, or the provider is not
 * connected, or it is no lineup provider's; for a retired Claude Code or Codex model, its successor's ID. Settings rows,
 * new-thread defaults and Watcher's choice read their saved model through this, so a retired one is never offered or run.
 * A choice the catalog holds no entry for, once retired models have left it, moves the same way when its ID is in the
 * shape the provider gives its own models (`claude-fable-5-1`, `gpt-5.5`); any other may be a model the user named
 * rather than one retired, so it moves only to a ready model of its own line, never to the provider's default.
 */
/** Whether a public model ID is in the shape Claude Code or Codex gives its own models. */
export function namesOwnModel(modelId: string): boolean {
  const parsed = parsePublicProviderEntityId(modelId)
  return parsed?.kind === 'model' && OWN_MODEL_IDS[parsed.provider]?.test(parsed.value) === true
}

export function modelInForce(models: readonly AgentModel[], modelId: string): string {
  if (!modelId) return modelId
  const entry = resolveModel(models, modelId)
  if (entry?.ready) return modelId
  return retiredModelSuccessor(models, modelId, entry?.name, entry !== undefined || namesOwnModel(modelId))?.id ?? modelId
}

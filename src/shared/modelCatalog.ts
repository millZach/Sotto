import { parsePublicProviderEntityId, publicProviderEntityId } from './agents'

/**
 * Which catalog model a thread, a default or a setting is on. A thread keeps the model ID it was given, but a
 * provider's catalog need not list it: Claude Code lists `opus` and no longer `opus[1m]`, its 1M-context variant,
 * though it still runs `--model opus[1m]` (#344). A Claude model ID ending in `[1m]` is that base model with more
 * context, so it answers from the base model's entry. Everything that asks what a model is called, whether it is
 * ready, which efforts, modes and images it takes reads it through here rather than matching IDs itself, so a
 * variant is never mistaken for an unknown model.
 */

/**
 * The one context suffix Claude Code documents: `[1m]`, which its settings reference names beside a model's dated,
 * Bedrock and Vertex spellings. Nothing looser, so `opus[beta]` or `[1m]` alone is no variant.
 */
const LONG_CONTEXT = /^(.+)\[1m\]$/iu

/**
 * The base model's ID a 1M-context variant's ID names, in the same form: a Claude public ID, or a native ID as the
 * Claude adapter and client hold them. Undefined for any other ID, and for another provider's public ID.
 */
export function baseModelId(modelId: string): string | undefined {
  const parsed = parsePublicProviderEntityId(modelId)
  if (parsed && (parsed.provider !== 'claude' || parsed.kind !== 'model')) return undefined
  if (!parsed && modelId.startsWith('native:')) return undefined
  const base = LONG_CONTEXT.exec(parsed ? parsed.value : modelId)?.[1]
  if (!base) return undefined
  return parsed ? publicProviderEntityId('claude', 'model', base) : base
}

/**
 * The catalog's own entry for a model ID, under the entry's own ID: the exact entry when the catalog lists it,
 * otherwise its base model's when the ID is a 1M-context variant of one. Use it to find which entry a picker
 * marks as current, or to compare entries; use `resolveModel` for what the thread is on.
 */
export function catalogEntry<T extends { readonly id: string }>(models: readonly T[], modelId: string | null | undefined): T | undefined {
  if (!modelId) return undefined
  const exact = models.find(model => model.id === modelId)
  if (exact) return exact
  const base = baseModelId(modelId)
  return base === undefined ? undefined : models.find(model => model.id === base)
}

/**
 * The model a thread, default or setting is on, resolved against the catalog and carrying the ID it was asked
 * about, so selection and equality still hold: the catalog entry itself for an ID it lists, and for a variant it
 * does not, a copy of the base model's entry (its name, readiness, efforts and modes) under the variant's ID.
 * Undefined when neither the ID nor its base is in the catalog.
 */
export function resolveModel<T extends { readonly id: string }>(models: readonly T[], modelId: string | null | undefined): T | undefined {
  const entry = catalogEntry(models, modelId)
  return entry && modelId && entry.id !== modelId ? { ...entry, id: modelId } : entry
}

/**
 * The ID a press on a catalog entry leaves its owner on. When the pressed entry is the one an ID the owner holds is
 * shown on (the model in force, the one pressed before it, a default), the press keeps that ID, so choosing "Opus"
 * again never drops a thread from `opus[1m]` to `opus`; the first such ID wins. Any other entry is its own ID.
 */
export function chosenModelId<T extends { readonly id: string }>(models: readonly T[], pressedId: string, ...held: readonly (string | null | undefined)[]): string {
  return held.find(id => id && catalogEntry(models, id)?.id === pressedId) ?? pressedId
}

/**
 * One spelling per served model, for counting: the provider's own model name with Sotto's public prefix, Claude's
 * `[1m]` context suffix, dated and Bedrock or Vertex spellings removed, lower-cased. Aliases such as `opus` stay
 * as they are: only a provider's own report can say which model an alias served, so callers prefer a served name.
 */
export function canonicalModelId(provider: string, modelId: string): string {
  const parsed = parsePublicProviderEntityId(modelId)
  let id = (parsed?.kind === 'model' ? parsed.value : modelId.replace(/^native:[a-z]+:model:/u, '')).trim().toLowerCase()
  if (provider === 'claude') {
    id = id.replace(/\[1m\]$/u, '').replace(/^(?:[a-z]{2}\.)?anthropic\./u, '').replace(/-v\d+(?::\d+)?$/u, '').replace(/@\d{8}$/u, '').replace(/-\d{8}$/u, '')
  } else id = id.replace(/-\d{4}-\d{2}-\d{2}$/u, '')
  return id || 'unknown'
}

const MODEL_WORDS: Readonly<Record<string, string>> = { gpt: 'GPT', codex: 'Codex', mini: 'Mini', nano: 'Nano', pro: 'Pro', auto: 'auto', review: 'review' }

/**
 * A served model's name when no catalog lists it: `claude-opus-5-5` reads Claude Opus 5.5, `gpt-6.1-sol` reads
 * GPT-6.1 Sol and `codex-auto-review` Codex auto review. A missing name reads as such rather than as an ID.
 */
export function servedModelName(provider: string, modelId: string): string {
  const id = canonicalModelId(provider, modelId)
  if (id === 'unknown') return 'Model not reported'
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/u.exec(id)
  if (claude) return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] === undefined ? '' : `.${claude[3]}`}`
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/u.exec(id)
  const words = (rest: string): string => rest.split('-').map((word, index) => MODEL_WORDS[word] ?? (index === 0 || /^\d/u.test(word) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word)).join(' ')
  if (gpt) return `GPT-${gpt[1]}${gpt[2] === undefined ? '' : ` ${words(gpt[2]).replace(/^./u, letter => letter.toUpperCase())}`}`
  const grok = /^grok-(.+)$/u.exec(id)
  if (grok) return `Grok ${grok[1]!.replace(/-/gu, ' ')}`
  return words(id)
}

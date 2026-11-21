import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import { effortRank, orderReasoningEfforts } from '../../shared/reasoningEfforts'

/**
 * Antigravity's model catalog, permission modes and session modes, as T3 Code reads them (the research note, "Models"
 * and "Permissions"). The models are the signed-in account's, read from a session's `model` option, never a list
 * shipped with Sotto: Gemini, and Claude and GPT models when the account is entitled to them.
 */

const choiceSchema = z.object({ value: z.string().min(1).max(256), name: z.string().max(256).optional() }).passthrough()
const groupSchema = z.object({ name: z.string().max(256).optional(), options: z.array(choiceSchema).max(256) }).passthrough()
const configOptionSchema = z.object({ id: z.string().min(1).max(128), type: z.string().max(64).optional(), category: z.string().max(128).optional(),
  name: z.string().max(256).optional(), currentValue: z.union([z.string(), z.boolean(), z.number()]).optional(),
  options: z.array(z.union([choiceSchema, groupSchema])).max(256).default([]) }).passthrough()
const modeSchema = z.object({ id: z.string().min(1).max(128), name: z.string().max(256).optional() }).passthrough()
/** What `session/new`, `session/resume` and `session/set_config_option` answer with, as far as Sotto reads it. */
export const antigravitySessionSettingsSchema = z.object({
  configOptions: z.array(configOptionSchema).max(64).optional(),
  modes: z.object({ currentModeId: z.string().max(128).optional(), availableModes: z.array(modeSchema).max(32).default([]) }).passthrough().nullish(),
}).passthrough()
export type AntigravitySessionSettings = z.infer<typeof antigravitySessionSettingsSchema>
type ConfigOption = z.infer<typeof configOptionSchema>
type Choice = z.infer<typeof choiceSchema>

const choicesOf = (option: ConfigOption | undefined): Choice[] =>
  (option?.options ?? []).flatMap(entry => 'value' in entry ? [entry as Choice] : (entry as z.infer<typeof groupSchema>).options)

/** The account's models in `agy`'s order, without repeats; a name two models share gets its ID after it, as T3 does. */
export function antigravityModelChoices(settings: AntigravitySessionSettings): { id: string; name: string }[] {
  const seen = new Set<string>()
  const models = choicesOf(settings.configOptions?.find(option => option.id === 'model')).filter(choice => !seen.has(choice.value) && seen.add(choice.value))
  const names = new Map<string, number>()
  for (const model of models) { const name = model.name?.trim() || model.value; names.set(name, (names.get(name) ?? 0) + 1) }
  return models.map(model => { const name = model.name?.trim() || model.value; return { id: model.value, name: names.get(name)! > 1 ? `${name} (${model.value})` : name } })
}
/** The model a session is on. */
export function antigravityCurrentModel(settings: AntigravitySessionSettings): string | undefined {
  const value = settings.configOptions?.find(option => option.id === 'model')?.currentValue
  return typeof value === 'string' ? value : undefined
}
/**
 * The model's thinking: the option in category `thought_level` whose values are effort levels, whatever `agy` calls it
 * (commonly `thinking_level`). Its values become the model's effort levels in Sotto's order (ADR-0044).
 */
export function antigravityThinking(settings: AntigravitySessionSettings): { id: string; levels: string[]; current?: string } | undefined {
  const option = settings.configOptions?.find(entry => entry.category === 'thought_level' && choicesOf(entry).some(level => effortRank(level.value) !== undefined))
  if (!option) return undefined
  const levels = orderReasoningEfforts(choicesOf(option).map(level => level.value))
  const current = typeof option.currentValue === 'string' && levels.includes(option.currentValue) ? option.currentValue : undefined
  return { id: option.id, levels, ...(current ? { current } : {}) }
}

/** Whether the session offers `agy`'s own Auto, by its modes or its `mode` option. Auto is offered only then, as in T3. */
export function antigravityOffersAuto(settings: AntigravitySessionSettings): boolean {
  if (settings.modes?.availableModes.some(mode => mode.id === 'auto')) return true
  return choicesOf(settings.configOptions?.find(option => option.id === 'mode')).some(choice => choice.value === 'auto')
}
/** The session mode a session is in, by its `mode` option or its modes. */
export function antigravityCurrentMode(settings: AntigravitySessionSettings): string | undefined {
  const option = settings.configOptions?.find(entry => entry.id === 'mode')?.currentValue
  return typeof option === 'string' ? option : settings.modes?.currentModeId
}
/** Whether the session sets its mode by a `mode` config option (newer `agy`) rather than `session/set_mode`. */
export function antigravityModeIsOption(settings: AntigravitySessionSettings): boolean {
  return settings.configOptions?.some(option => option.id === 'mode') === true
}

/**
 * The permission modes an Antigravity thread offers: T3's four (Zach's choice, November 20, 2026), with Auto only
 * where the account's sessions offer `agy`'s own Auto.
 */
export const ANTIGRAVITY_RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const satisfies readonly AgentRuntimeMode[]
export type AntigravityRuntimeMode = typeof ANTIGRAVITY_RUNTIME_MODES[number]
export function antigravityRuntimeMode(mode: AgentRuntimeMode | undefined): AntigravityRuntimeMode {
  return (ANTIGRAVITY_RUNTIME_MODES as readonly string[]).includes(mode ?? '') ? mode as AntigravityRuntimeMode : 'approval-required'
}
/**
 * The session mode a permission mode runs in. `agy` refuses an edit-only or run-everything mode over ACP, so every mode
 * but Auto runs in `default`, where `agy` asks before acting, and Sotto answers by the thread's mode (`antigravityAutoAnswer`).
 * Auto runs `agy`'s own Auto where the session offers it and `default` where it does not, as in T3.
 */
export function antigravitySessionMode(mode: AntigravityRuntimeMode, offersAuto: boolean): string {
  return mode === 'auto' && offersAuto ? 'auto' : 'default'
}

/** The company that made a model, from its ID, for the menu's groups. A model Sotto cannot place is Google's. */
export const ANTIGRAVITY_MAKERS = ['Google', 'Anthropic', 'OpenAI'] as const
export type AntigravityMaker = typeof ANTIGRAVITY_MAKERS[number]
export function antigravityModelMaker(modelId: string): AntigravityMaker {
  const id = modelId.trim().toLowerCase()
  return /^claude/u.test(id) ? 'Anthropic' : /^(?:gpt|o\d)/u.test(id) ? 'OpenAI' : 'Google'
}

/** One Antigravity model as Sotto keeps it, with the option its effort is set by. */
export interface AntigravityModelFacts { readonly model: AgentModel; readonly effortOption?: string }
/** The thinking each model offers, read by choosing it in a session of its own (`AntigravityAcpHost.readCatalog`). */
export interface AntigravityModelThinking { readonly id: string; readonly name: string; readonly thinking?: ReturnType<typeof antigravityThinking> }

/** The account's models as Sotto's catalog, in `agy`'s order within each maker. */
export function antigravityCatalog(models: readonly AntigravityModelThinking[], options: { images: boolean; offersAuto: boolean; current?: string | undefined }): AntigravityModelFacts[] {
  const rank = (maker: AntigravityMaker): number => ANTIGRAVITY_MAKERS.indexOf(maker)
  const runtimeModes: AgentRuntimeMode[] = ANTIGRAVITY_RUNTIME_MODES.filter(mode => mode !== 'auto' || options.offersAuto)
  return models.map((entry, index) => ({ entry, index, maker: antigravityModelMaker(entry.id) }))
    .sort((a, b) => rank(a.maker) - rank(b.maker) || a.index - b.index)
    .map(({ entry, maker }) => ({
      model: { id: entry.id, name: entry.name, provider: 'Antigravity', providerId: 'antigravity', source: maker, ready: true, runtimeModes: [...runtimeModes],
        supportsImages: options.images, reasoningEfforts: entry.thinking?.levels ?? [],
        ...(entry.thinking?.current ? { defaultReasoningEffort: entry.thinking.current } : {}),
        ...(options.current === entry.id ? { recommended: true } : {}) },
      ...(entry.thinking ? { effortOption: entry.thinking.id } : {}),
    }))
}
/** The least effort a model offers, which Sotto's short text runs at (ADR-0026). */
export function leastEffort(model: AgentModel | undefined): string | undefined { return model?.reasoningEfforts?.[0] }

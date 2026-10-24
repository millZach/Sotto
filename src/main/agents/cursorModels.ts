import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import { effortRank, orderReasoningEfforts } from '../../shared/reasoningEfforts'

/**
 * Cursor's model catalog as Sotto offers it (ADR-0128). Cursor runs every model on the user's Cursor plan, so the menu
 * groups them by **model maker**, the company that made each one, read from its name. The maker travels in the
 * model's `source`, the field the menu already groups OpenCode's model sources by, while `provider` stays 'Cursor', so
 * a Cursor thread on Claude never reads as Claude Code.
 */

/** Cursor's makers in the menu's order. Auto and Composer are Cursor's own; a model Sotto cannot place is Cursor's too. */
export const CURSOR_MAKERS = ['Cursor', 'Anthropic', 'OpenAI', 'Google', 'xAI', 'Moonshot', 'Z.ai', 'Meta'] as const
export type CursorMaker = typeof CURSOR_MAKERS[number]
const MAKER_PREFIXES: readonly (readonly [RegExp, CursorMaker])[] = [
  [/^claude/u, 'Anthropic'], [/^(?:gpt|o\d|codex)/u, 'OpenAI'], [/^gemini/u, 'Google'], [/^grok/u, 'xAI'],
  [/^kimi/u, 'Moonshot'], [/^glm/u, 'Z.ai'], [/^muse/u, 'Meta'],
]
/** The company that made a model, from Cursor's own name for it. */
export function cursorModelMaker(modelId: string): CursorMaker {
  const id = modelId.trim().toLowerCase()
  return MAKER_PREFIXES.find(([pattern]) => pattern.test(id))?.[1] ?? 'Cursor'
}

/** The permission modes a Cursor thread offers: Allow edits would do on Cursor exactly what Ask for approval does (ADR-0128). */
export const CURSOR_RUNTIME_MODES = ['approval-required', 'auto', 'full-access'] as const satisfies readonly AgentRuntimeMode[]
export type CursorRuntimeMode = typeof CURSOR_RUNTIME_MODES[number]
/** The mode a saved one becomes: Allow edits, as a thread continued from another provider may carry, asks for approval. */
export function cursorRuntimeMode(mode: AgentRuntimeMode | undefined): CursorRuntimeMode {
  return (CURSOR_RUNTIME_MODES as readonly string[]).includes(mode ?? '') ? mode as CursorRuntimeMode : 'approval-required'
}
/** The flags that set a process's approval mode: allowlist (none), Cursor's auto-review, or run everything. */
export function cursorModeArguments(mode: CursorRuntimeMode): string[] {
  return mode === 'auto' ? ['--auto-review'] : mode === 'full-access' ? ['--force'] : []
}

const optionSchema = z.object({ value: z.string().min(1).max(256), name: z.string().max(256).optional() }).passthrough()
const configOptionSchema = z.object({ id: z.string().min(1).max(128), category: z.string().max(128).optional(), currentValue: z.union([z.string(), z.boolean(), z.number()]).optional(),
  options: z.array(optionSchema).max(64).default([]) }).passthrough()
export const cursorModelListSchema = z.object({ models: z.array(z.object({ value: z.string().min(1).max(256), name: z.string().min(1).max(256),
  configOptions: z.array(configOptionSchema).max(32).default([]) }).passthrough()).max(500) })
export type CursorModelList = z.infer<typeof cursorModelListSchema>
type ConfigOption = z.infer<typeof configOptionSchema>

/**
 * A model's effort: the `thought_level` option whose values are effort levels, whatever Cursor calls it (`effort`,
 * `reasoning`, `reasoning_effort`). A thought-level option that is only on or off, such as `thinking`, is not an effort
 * and is left at Cursor's own default, as `model_config` options (`context`, `fast`) are.
 */
export function cursorEffortOption(options: readonly ConfigOption[]): { id: string; levels: string[]; current?: string } | undefined {
  const option = options.find(entry => entry.category === 'thought_level' && entry.options.some(level => effortRank(level.value) !== undefined))
  if (!option) return undefined
  const levels = orderReasoningEfforts(option.options.map(level => level.value))
  const current = typeof option.currentValue === 'string' && levels.includes(option.currentValue) ? option.currentValue : undefined
  return { id: option.id, levels, ...(current ? { current } : {}) }
}

/** One Cursor model as Sotto keeps it, with the option ID its effort is set by. */
export interface CursorModelFacts { readonly model: AgentModel; readonly effortOption?: string }
/**
 * Cursor's list as Sotto's catalog: one model per entry, grouped by maker in the menu's order and in Cursor's own order
 * within each, every one taking images when the client says it does.
 */
export function cursorCatalog(list: CursorModelList, supportsImages: boolean): CursorModelFacts[] {
  const rank = (maker: CursorMaker): number => CURSOR_MAKERS.indexOf(maker)
  return list.models.map((entry, index) => ({ entry, index, maker: cursorModelMaker(entry.value) }))
    .sort((a, b) => rank(a.maker) - rank(b.maker) || a.index - b.index)
    .map(({ entry, maker }) => {
      const effort = cursorEffortOption(entry.configOptions)
      return { model: { id: entry.value, name: entry.name, provider: 'Cursor', source: maker, ready: true, runtimeModes: [...CURSOR_RUNTIME_MODES], supportsImages,
        reasoningEfforts: effort?.levels ?? [], ...(effort?.current ? { defaultReasoningEffort: effort.current } : {}) },
      ...(effort ? { effortOption: effort.id } : {}) }
    })
}
/** The least effort a model offers, which Sotto's short text runs at (ADR-0026). */
export function leastEffort(model: AgentModel | undefined): string | undefined { return model?.reasoningEfforts?.[0] }

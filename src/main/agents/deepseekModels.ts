import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import type { OwnServer } from '../../shared/ownModelServers'
import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import { DEEPSEEK_DEFAULT_EFFORT, DEEPSEEK_REASONING_EFFORTS, keylessServers } from '../ownModelServers/deepseekPatch'
import type { DeepSeekSandboxMode } from './deepseekRpc'

/**
 * DeepSeek Harness's models and permission modes as Sotto names them (ADR-0138). The models are the user's own
 * keyless model servers, one entry per model, grouped by server the way OpenCode groups by model source; a model
 * ID is `<server ID>/<model ID>`, so a thread is never read as running on another provider's model, and the pair
 * the harness encodes in its `model` config option is exactly that. A model reads images when its record says so and
 * the harness, started with Sotto's overlay, advertised image prompts.
 */

/** The permission modes a DeepSeek Harness thread offers: Automatic is not one of them. */
export const DEEPSEEK_RUNTIME_MODES: readonly AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'full-access']

/** A permission mode as the harness's process sandbox (ADR-0138). The mode is a process's, so changing it restarts one. */
export function deepseekSandboxMode(mode: AgentRuntimeMode): DeepSeekSandboxMode {
  return mode === 'approval-required' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write'
}

/** A saved or chosen model, split into the server and model IDs its wire pair names. */
export function deepseekModelRoute(modelId: string): { serverId: string; model: string } | undefined {
  const cut = modelId.indexOf('/')
  if (cut <= 0 || cut === modelId.length - 1) return undefined
  return { serverId: modelId.slice(0, cut), model: modelId.slice(cut + 1) }
}

/**
 * The catalog's models, from the keyless servers of the user's own record. `harnessImages` is whether the harness
 * advertised image prompts; until it has, and when it said no, no model offers images.
 */
export function deepseekCatalog(servers: readonly OwnServer[], harnessImages = false): AgentModel[] {
  return keylessServers(servers).flatMap(server => server.models.map((model): AgentModel => ({
    id: `${server.id}/${model.id}`,
    provider: 'DeepSeek Harness',
    name: model.name,
    runtimeModes: [...DEEPSEEK_RUNTIME_MODES],
    ready: true,
    source: server.name,
    ...(harnessImages && model.images ? { supportsImages: true } : {}),
    ...(model.thinking ? { reasoningEfforts: orderReasoningEfforts([...DEEPSEEK_REASONING_EFFORTS]), defaultReasoningEffort: DEEPSEEK_DEFAULT_EFFORT } : {}),
  })))
}

/** The `model` config option's value, as the harness encodes the chosen route and model. */
export function deepseekModelValue(modelId: string): string | undefined {
  const route = deepseekModelRoute(modelId)
  return route ? JSON.stringify([route.serverId, route.model]) : undefined
}

const optionsSchema = z.object({
  configOptions: z.array(z.object({
    id: z.string().max(128),
    currentValue: z.union([z.string().max(4_096), z.boolean(), z.number()]).optional(),
  }).passthrough()).max(64),
}).passthrough()

/**
 * The model and effort one of the harness's answers names: its `model` option, whose value encodes the route and
 * model as `["<server>","<model>"]`, and its `reasoning_effort` option, whose empty value is the route's own
 * default rather than a level. Either is undefined when the answer does not name it.
 */
export function deepseekSettingsOf(value: unknown): { model: string | undefined; effort: string | undefined } {
  const parsed = optionsSchema.safeParse(value)
  if (!parsed.success) return { model: undefined, effort: undefined }
  const encoded = parsed.data.configOptions.find(option => option.id === 'model')?.currentValue
  let model: string | undefined
  if (typeof encoded === 'string') {
    try {
      const pair: unknown = JSON.parse(encoded)
      if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string')) model = `${pair[0]}/${pair[1]}`
    } catch { /* An unencoded model value is not one of ours; leave the model unnamed. */ }
  }
  const effort = parsed.data.configOptions.find(option => option.id === 'reasoning_effort')?.currentValue
  return { model, effort: typeof effort === 'string' && effort !== '' ? effort : undefined }
}

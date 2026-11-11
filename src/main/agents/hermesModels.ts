import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import { type OwnServer } from '../../shared/ownModelServers'

/** Full access is the only mode Sotto runs Hermes in. */
export const HERMES_RUNTIME_MODES: readonly AgentRuntimeMode[] = ['full-access']

/** A saved or chosen model, split into the server and model IDs its wire pair names. */
export function hermesModelRoute(modelId: string): { serverId: string; model: string } | undefined {
  const cut = modelId.indexOf('/')
  if (cut <= 0 || cut === modelId.length - 1) return undefined
  return { serverId: modelId.slice(0, cut), model: modelId.slice(cut + 1) }
}

/**
 * The catalog's models, from the servers `hermesServers` kept: the keyless ones and each keyed one Hermes holds a key for. `harnessImages` is whether the harness
 * advertised image prompts; until it has, and when it said no, no model offers images.
 */
export function hermesCatalog(servers: readonly OwnServer[], harnessImages = false, harnessEffort = false): AgentModel[] {
  return servers.flatMap(server => server.models.map((model): AgentModel => {
    const efforts = (model.reasoningEfforts ?? ['default']).map(level => level === 'none' ? 'off' : level)
    return {
    id: `${server.id}/${model.id}`,
    provider: 'Hermes', ownServer: true,
    name: model.name,
    runtimeModes: [...HERMES_RUNTIME_MODES],
    ready: true,
    ...(server.keptModelIds && !server.keptModelIds.includes(model.id) ? { hiddenFromMenu: true } : {}),
    ...(harnessEffort && model.thinking ? { reasoningEfforts: efforts, defaultReasoningEffort: efforts.includes('default') ? 'default' : efforts.includes('medium') ? 'medium' : efforts[0] } : {}),
    source: server.name,
    ...(harnessImages && model.images ? { supportsImages: true } : {}),

    }
  }))
}

/** The `model` config option's value, as the harness encodes the chosen route and model. */
export function hermesModelValue(modelId: string): string | undefined {
  const route = hermesModelRoute(modelId)
  return route ? `custom:${route.serverId}:${route.model}` : undefined
}

const optionsSchema = z.object({
  models: z.object({ currentModelId: z.string() }).optional(),
  configOptions: z.array(z.object({ id: z.string(), currentValue: z.string().optional() }).passthrough()).optional(),
}).passthrough()

export function hermesSettingsOf(value: unknown): { model: string | undefined; effort: string | undefined } {
  const parsed = optionsSchema.safeParse(value)
  const wire = parsed.success ? parsed.data.models?.currentModelId : undefined
  const match = wire?.match(/^custom:([^:]+):(.+)$/u)
  return { model: match ? `${match[1]}/${match[2]}` : undefined, effort: parsed.success ? sottoEffort(parsed.data.configOptions?.find(option => option.id === 'reasoning_effort')?.currentValue) : undefined }
}

export function hermesEffortValue(effort: string | undefined): string { return effort === 'off' ? 'none' : effort ?? 'default' }
export function hermesHasEffort(value: unknown): boolean {
  const parsed = optionsSchema.safeParse(value)
  return parsed.success && !!parsed.data.configOptions?.some(option => option.id === 'reasoning_effort')
}

function sottoEffort(value: string | undefined): string | undefined { return value === 'none' ? 'off' : value }

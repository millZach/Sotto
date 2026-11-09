import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import type { OwnServer } from '../../shared/ownModelServers'
import { keylessServers } from '../ownModelServers/deepseekPatch'

/** Full access is the only mode Sotto runs Hermes in. */
export const HERMES_RUNTIME_MODES: readonly AgentRuntimeMode[] = ['full-access']

/** A saved or chosen model, split into the server and model IDs its wire pair names. */
export function hermesModelRoute(modelId: string): { serverId: string; model: string } | undefined {
  const cut = modelId.indexOf('/')
  if (cut <= 0 || cut === modelId.length - 1) return undefined
  return { serverId: modelId.slice(0, cut), model: modelId.slice(cut + 1) }
}

/**
 * The catalog's models, from the configured server routes. `harnessImages` is whether the harness
 * advertised image prompts; until it has, and when it said no, no model offers images.
 */
export function hermesCatalog(servers: readonly OwnServer[], harnessImages = false): AgentModel[] {
  return keylessServers(servers).flatMap(server => server.models.map((model): AgentModel => ({
    id: `${server.id}/${model.id}`,
    provider: 'Hermes',
    name: model.name,
    runtimeModes: [...HERMES_RUNTIME_MODES],
    ready: true,
    source: server.name,
    ...(harnessImages && model.images ? { supportsImages: true } : {}),

  })))
}

/** The `model` config option's value, as the harness encodes the chosen route and model. */
export function hermesModelValue(modelId: string): string | undefined {
  const route = hermesModelRoute(modelId)
  return route ? `custom:${route.serverId}:${route.model}` : undefined
}

const optionsSchema = z.object({
  models: z.object({ currentModelId: z.string() }).optional(),
}).passthrough()

export function hermesSettingsOf(value: unknown): { model: string | undefined; effort: string | undefined } {
  const parsed = optionsSchema.safeParse(value)
  const wire = parsed.success ? parsed.data.models?.currentModelId : undefined
  const match = wire?.match(/^custom:([^:]+):(.+)$/u)
  return { model: match ? `${match[1]}/${match[2]}` : undefined, effort: undefined }
}

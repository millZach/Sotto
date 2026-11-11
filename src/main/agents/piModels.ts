import { z } from 'zod'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import type { OwnServer } from '../../shared/ownModelServers'

export const PI_RUNTIME_MODES: readonly AgentRuntimeMode[] = ['full-access']
export const PI_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high']

export function piModelRoute(modelId: string): { serverId: string; model: string } | undefined {
  const cut = modelId.indexOf('/')
  return cut > 0 && cut < modelId.length - 1 ? { serverId: modelId.slice(0, cut), model: modelId.slice(cut + 1) } : undefined
}

export function piCatalog(servers: readonly OwnServer[]): AgentModel[] {
  return servers.filter(server => !server.keyed).flatMap(server => server.models.map(model => ({
    id: `${server.id}/${model.id}`, provider: 'Pi', name: model.name, source: server.name,
    runtimeModes: [...PI_RUNTIME_MODES], ready: true,
    ...(model.images ? { supportsImages: true } : {}),
    ...(model.thinking ? { reasoningEfforts: [...PI_EFFORTS], defaultReasoningEffort: 'medium' } : {}),
  })))
}

/** Generated from the main process's record. No key from another provider is read. */
export function piModels(servers: readonly OwnServer[]): string {
  return JSON.stringify({ providers: Object.fromEntries(servers.filter(server => !server.keyed).map(server => [server.id, {
    name: server.name, baseUrl: server.address, api: 'openai-completions', apiKey: 'sotto-keyless',
    models: server.models.map(model => ({ id: model.id, name: model.name, reasoning: model.thinking,
      input: model.images ? ['text', 'image'] : ['text'], contextWindow: model.context, maxTokens: model.output ?? Math.min(16_384, model.context),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  }])) })
}

const stateSchema = z.object({ sessionId: z.string().min(1), model: z.object({ provider: z.string(), id: z.string() }).optional(), thinkingLevel: z.string().optional() })
export function piSettingsOf(value: unknown): { sessionId: string; model: string | undefined; effort: string | undefined } {
  const state = stateSchema.parse(value)
  return { sessionId: state.sessionId, model: state.model ? `${state.model.provider}/${state.model.id}` : undefined, effort: state.thinkingLevel }
}

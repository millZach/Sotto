import type { OwnServer, OwnServerModel } from '../../shared/ownModelServers'

/**
 * How a saved server reaches OpenCode (ADR-0124): one provider block per server in `OPENCODE_CONFIG_CONTENT`, built from
 * Sotto's record at each start, so nothing is written into Sotto's OpenCode folder. OpenCode never asks such a server for
 * its models, so each is declared with its limits, its input and whether it thinks (checked against OpenCode 2.1.4).
 */

/** OpenCode's own package for any OpenAI-compatible server. */
export const OPENCODE_OPENAI_COMPATIBLE = '@opencode/ai/providers/openai-compatible'
/**
 * What a server without a key is given as its key: OpenCode lists a provider's models only when it has one. It is no
 * secret, and a key signed in through `connect/key` wins over it.
 */
export const OWN_SERVER_PLACEHOLDER_KEY = 'sotto-no-key'
/** The effort levels a thinking model is given; OpenCode sends the chosen one as `reasoning_effort`. */
const THINKING_EFFORTS = ['low', 'medium', 'high'] as const
/** The longest answer a model is told it may give when the server does not say. */
const OUTPUT_CAP = 32_000

/** The answer length a model is declared with: what the user saved, or a quarter of its context up to 32K tokens. */
export function ownModelOutput(model: Pick<OwnServerModel, 'context' | 'output'>): number {
  return model.output ?? Math.min(OUTPUT_CAP, Math.floor(model.context / 4))
}

function modelBlock(model: OwnServerModel): Record<string, unknown> {
  return {
    name: model.name,
    capabilities: {
      tools: true,
      input: model.images ? ['text', 'image'] : ['text'],
      output: ['text'],
      // Declared either way: a model that declares nothing is given effort levels by OpenCode.
      reasoning: model.thinking ? { supported: true, effort: [...THINKING_EFFORTS] } : { supported: false },
    },
    limit: { context: model.context, output: ownModelOutput(model) },
  }
}

/** One server as an OpenCode provider block, under its own ID. */
export function openCodeProviderBlock(server: OwnServer): Record<string, unknown> {
  return {
    name: server.name,
    package: OPENCODE_OPENAI_COMPATIBLE,
    settings: { baseURL: server.address, apiKey: OWN_SERVER_PLACEHOLDER_KEY },
    models: Object.fromEntries(server.models.map(model => [model.id, modelBlock(model)])),
  }
}

/** Every saved server as OpenCode's `providers` record, by server ID. */
export function openCodeProviders(servers: readonly OwnServer[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map(server => [server.id, openCodeProviderBlock(server)]))
}

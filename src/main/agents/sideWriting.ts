import type { AgentModel } from '../../shared/agents'

/**
 * How long a thread's client has to answer a side call (ADR-0026). A client starts cold for each one, so
 * this is far longer than an OpenRouter request needed; a title that arrives late still arrives, and a call
 * that hangs is abandoned rather than retried.
 */
export const SIDE_WRITING_TIMEOUT_MS = 90_000

/**
 * The effort a side call runs at: the least thorough level the thread's model reports, or the model's own
 * default when it reports none. A name or a commit subject needs no deliberation, and the call is paid for
 * from the same subscription limits as the thread's own work, so it asks for as little as the model allows.
 */
export function sideWritingEffort(models: readonly AgentModel[], modelId: string): string | undefined {
  return models.find(model => model.id === modelId)?.reasoningEfforts?.[0]
}

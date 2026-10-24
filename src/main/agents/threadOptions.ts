import { agentAttachmentHandlesSchema, FILES_NOT_DELIVERED_YET, isImageAttachment, type AgentAttachmentHandle, type AgentHostSnapshot, type AgentThreadOptions } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'

/** Validate against the active provider's advertised model, never a substitute. */
export function validateThreadOptions(snapshot: AgentHostSnapshot, options: AgentThreadOptions, currentModelId?: string): void {
  const model = resolveModel(snapshot.models, options.modelId ?? currentModelId)
  if (!model?.ready) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
  if (options.reasoningEffort !== undefined && !model.reasoningEfforts?.includes(options.reasoningEffort)) throw new Error('That reasoning level is not supported by this model.')
  if (options.runtimeMode !== undefined && !model.runtimeModes?.includes(options.runtimeMode)) throw new Error('That permission mode is not supported by this provider.')
  if (options.providerMode !== undefined && !model.providerModes?.some(mode => mode.id === options.providerMode)) throw new Error('That permission mode is not supported by this provider.')
}

/**
 * The effort a settings change leaves a thread on. A change that names an effort sets it, checked above against
 * the model the change leaves the thread on. One that names a model and no effort takes that model's default, or
 * none when it reports none, rather than carrying the old model's level to a model that may not offer it. Any
 * other change keeps the thread's effort.
 */
export function effortAfterChange(snapshot: AgentHostSnapshot, options: AgentThreadOptions, current: string | undefined): string | undefined {
  if (options.reasoningEffort !== undefined) return options.reasoningEffort
  if (options.modelId === undefined) return current
  return resolveModel(snapshot.models, options.modelId)?.defaultReasoningEffort
}

/**
 * A prompt's staged images against the thread's model. The content itself was checked when it was staged; what is
 * checked here is the handles (count, total, unique IDs) and that the model takes images at all.
 */
export function validatePromptAttachments<T extends AgentAttachmentHandle>(snapshot: AgentHostSnapshot, modelId: string, attachments: readonly T[] = []): T[] {
  agentAttachmentHandlesSchema.parse(attachments.map(({ id, name, mimeType, sizeBytes, digest }) => ({ id, name, mimeType, sizeBytes, digest })))
  // Only an image needs a model that reads images; an attached file goes to every model (ADR-0127).
  if (attachments.some(attachment => isImageAttachment(attachment.mimeType)) && !resolveModel(snapshot.models, modelId)?.supportsImages) throw new Error('This model does not advertise image support.')
  return [...attachments]
}

/**
 * Refuses a prompt that carries an attached file, at the provider boundary, until adapters hand files to their providers
 * (the first phase of ADR-0127). Drafts, follow-ups and the outbox carry the file meanwhile; only the send is refused.
 */
export function refuseUndeliveredFiles(attachments: readonly Pick<AgentAttachmentHandle, 'mimeType'>[] = []): void {
  if (attachments.some(attachment => !isImageAttachment(attachment.mimeType))) throw new Error(FILES_NOT_DELIVERED_YET)
}

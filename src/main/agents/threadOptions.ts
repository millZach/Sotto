import { agentAttachmentHandlesSchema, ATTACHED_FILES_NEED_A_FOLDER, imagesNotReadRefusal, isImageAttachment, SCREENSHOT_WRONG_TYPE, type AgentAttachmentHandle, type AgentHostSnapshot, type AgentThreadOptions } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'

/** Validate against the active provider's advertised model, never a substitute. */
export function validateThreadOptions(snapshot: AgentHostSnapshot, options: AgentThreadOptions, currentModelId?: string): void {
  const model = resolveModel(snapshot.models, options.modelId ?? currentModelId)
  if (!model?.ready) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
  if (options.reasoningEffort !== undefined && !model.reasoningEfforts?.includes(options.reasoningEffort)) throw new Error('That reasoning level is not supported by this model.')
  if (options.runtimeMode !== undefined && !model.runtimeModes?.includes(options.runtimeMode)) throw new Error('That permission mode is not supported by this provider.')
  if (options.providerMode !== undefined && !model.providerModes?.some(mode => mode.id === options.providerMode)) throw new Error('That permission mode is not supported by this provider.')
  // Turning fast mode on needs a model that has it. A change of model keeps the thread's choice whichever model it lands
  // on (ADR-0143): that model runs at normal speed and a later model with fast mode takes it up again.
  if (options.fastMode === true && options.modelId === undefined && !model.fastMode) throw new Error('This model does not offer fast mode.')
}

/** Whether fast mode runs for a thread on this model: the user turned it on and the model offers it (ADR-0143). */
export function fastModeRuns(snapshot: Pick<AgentHostSnapshot, 'models'>, modelId: string, fastMode: boolean | undefined): boolean {
  return fastMode === true && resolveModel(snapshot.models, modelId)?.fastMode !== undefined
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
 * A prompt's staged attachments against the thread's model and folder. The content itself was checked when it was staged;
 * what is checked here is the handles (count, totals, unique IDs), that the model takes images when an image is attached,
 * and, for an attached file (ADR-0131), that this build takes files (`acceptsFiles`, the coordinator's Owl answer, a
 * defence behind the composer) and that the thread has a working folder to copy it into, when the caller names the folder.
 */
export function validatePromptAttachments<T extends AgentAttachmentHandle>(snapshot: AgentHostSnapshot, modelId: string, attachments: readonly T[] = [],
  options: { readonly acceptsFiles?: boolean; readonly workingDirectory?: string | null | undefined } = {}): T[] {
  agentAttachmentHandlesSchema.parse(attachments.map(({ id, name, mimeType, sizeBytes, digest }) => ({ id, name, mimeType, sizeBytes, digest })))
  // Only an image needs a model that reads images; an attached file goes to every model. Where files can be attached
  // (ADR-0131) the refusal names the first image, since the draft may hold files the model does take.
  const image = attachments.find(attachment => isImageAttachment(attachment.mimeType))
  if (image && !resolveModel(snapshot.models, modelId)?.supportsImages) {
    throw new Error(options.acceptsFiles === true ? imagesNotReadRefusal(image.name) : 'This model does not advertise image support.')
  }
  if (attachments.some(attachment => !isImageAttachment(attachment.mimeType))) {
    if (options.acceptsFiles === false) throw new Error(SCREENSHOT_WRONG_TYPE)
    if ('workingDirectory' in options && !options.workingDirectory) throw new Error(ATTACHED_FILES_NEED_A_FOLDER)
  }
  return [...attachments]
}

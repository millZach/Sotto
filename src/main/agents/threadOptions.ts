import { agentAttachmentsSchema, type AgentAttachment, type AgentHostSnapshot, type AgentThreadOptions } from '../../shared/agents'

/** Validate against the active provider's advertised model, never a substitute. */
export function validateThreadOptions(snapshot: AgentHostSnapshot, options: AgentThreadOptions, currentModelId?: string): void {
  const model = snapshot.models.find(candidate => candidate.id === (options.modelId ?? currentModelId))
  if (!model?.ready) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
  if (options.reasoningEffort !== undefined && !model.reasoningEfforts?.includes(options.reasoningEffort)) throw new Error('That reasoning level is not supported by this model.')
  if (options.runtimeMode !== undefined && !model.runtimeModes?.includes(options.runtimeMode)) throw new Error('That permission mode is not supported by this provider.')
}

export function validatePromptAttachments(snapshot: AgentHostSnapshot, modelId: string, attachments: AgentAttachment[] = []): AgentAttachment[] {
  const parsed = agentAttachmentsSchema.parse(attachments)
  if (parsed.length && !snapshot.models.find(model => model.id === modelId)?.supportsImages) throw new Error('This model does not advertise image support.')
  for (const attachment of parsed) {
    const bytes = Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), 'base64')
    const valid = attachment.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : attachment.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : attachment.mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
          : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    if (!valid) throw new Error('The image content does not match its file type.')
  }
  return parsed
}

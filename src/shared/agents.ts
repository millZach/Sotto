import { z } from 'zod'

export const AGENT_GET = 'sotto:agents:get'
export const AGENT_CHOOSE_PROJECT_DIRECTORY = 'sotto:agents:choose-project-directory'
export const AGENT_COMMAND = 'sotto:agents:command'
export const AGENT_STATE = 'sotto:agents:state'
export const AGENT_E2E = 'sotto:e2e:agents'
export const AGENT_SPEECH = 'sotto:agents:speech'
export const AGENT_SPEECH_CANCEL = 'sotto:agents:speech-cancel'
export const AGENT_GROK_VOICES = 'sotto:agents:grok-voices'
export const AGENT_VOICE_MODEL = 'sotto:agents:voice-model'
export const AGENT_WAKE = 'sotto:agents:wake'
export const agentWakeDetectionSchema = z.object({ detected: z.boolean(), endSeconds: z.number().min(0).max(8.25) })
export type AgentWakeDetection = z.infer<typeof agentWakeDetectionSchema>
export const agentSpeechSchema = z.object({ audioBase64: z.string().max(20_000_000), mimeType: z.literal('audio/wav') })
export const agentVoiceModelStatusSchema = z.object({ ready: z.boolean(), completedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() })
export type AgentVoiceModelStatus = z.infer<typeof agentVoiceModelStatusSchema>
export const NATURAL_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const
export const grokSpeechVoiceSchema = z.string().trim().min(1).max(256).refine(value => !/\p{Cc}/u.test(value), 'Choose a valid Grok voice ID.')
export const agentSpeechVoicesSchema = z.array(z.object({ id: grokSpeechVoiceSchema, name: z.string().min(1).max(300) })).max(5_000)
export type AgentSpeechVoice = z.infer<typeof agentSpeechVoicesSchema>[number]

const id = z.string().min(1).max(512)
const text = z.string().max(100_000)
export const AGENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const AGENT_MAX_ATTACHMENTS = 8
export const AGENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const AGENT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const agentRuntimeModeSchema = z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
export type AgentRuntimeMode = z.infer<typeof agentRuntimeModeSchema>
export function attachmentSizeBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
}
export const agentAttachmentSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/iu), name: z.string().trim().min(1).max(255),
  mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), dataUrl: z.string().max(14_000_000),
}).strict().refine(attachment => {
  const prefix = `data:${attachment.mimeType};base64,`
  if (!attachment.dataUrl.startsWith(prefix)) return false
  const base64 = attachment.dataUrl.slice(prefix.length)
  return base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
    && attachmentSizeBytes(attachment.dataUrl) > 0 && attachmentSizeBytes(attachment.dataUrl) <= AGENT_MAX_IMAGE_BYTES
}, 'Choose a valid PNG, JPEG, GIF or WebP image no larger than 10 MiB.')
export const agentAttachmentsSchema = z.array(agentAttachmentSchema).max(AGENT_MAX_ATTACHMENTS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Attachment IDs must be unique.')
  .refine(items => items.reduce((size, item) => size + attachmentSizeBytes(item.dataUrl), 0) <= AGENT_MAX_ATTACHMENT_BYTES, 'Images must total no more than 20 MiB.')
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>
export const agentAttachmentReferenceSchema = z.object({ id, name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative() })
export type AgentAttachmentReference = z.infer<typeof agentAttachmentReferenceSchema>
export const agentThreadOptionsSchema = z.object({ modelId: id.optional(), reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional() })
export type AgentThreadOptions = z.infer<typeof agentThreadOptionsSchema>
export const agentModelSchema = z.object({ id, provider: id, name: id, ready: z.boolean(),
  reasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  runtimeModes: z.array(agentRuntimeModeSchema).optional(), supportsImages: z.boolean().optional(),
})
export const agentProjectSchema = z.object({ id, title: id, path: z.string().max(4_096) })
export const agentRequestSchema = z.object({
  id, kind: z.enum(['question', 'permission']), text,
  options: z.array(z.object({ id, label: text })).default([]),
})
export const agentMessageSchema = z.object({
  id, role: z.enum(['user', 'assistant']), text, createdAt: z.string(),
  commandId: z.string().optional(),
  attachments: z.array(agentAttachmentReferenceSchema).optional(),
})
export const agentThreadSchema = z.object({
  id, projectId: id, title: id, modelId: z.string(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(),
  status: z.enum(['idle', 'running', 'error']),
  /** Provider activity time; omitted when unknown, never the time Sotto observed the thread. */
  updatedAt: z.string().optional(),
  /** Explicit lifecycle metadata. Null clears a prior value; omission means unknown. */
  settledAt: z.string().nullable().optional(), archivedAt: z.string().nullable().optional(),
  settledOverride: z.enum(['settled', 'active']).nullable().optional(),
  messages: z.array(agentMessageSchema), requests: z.array(agentRequestSchema),
  /** Omitted by providers that already supply history; absence means ready. */
  historyStatus: z.enum(['loading', 'ready', 'error']).optional(), historyError: z.string().optional(),
})
export const agentCapabilitiesSchema = z.object({
  projects: z.boolean(), threads: z.boolean(), submit: z.boolean(),
  observe: z.boolean(), questions: z.boolean(), permissions: z.boolean(),
  interrupt: z.boolean(), messageOrigin: z.boolean(), reconcile: z.boolean(),
  configureThread: z.boolean().optional(),
})
export const agentHostSnapshotSchema = z.object({
  connected: z.boolean(), name: z.string(), version: z.string(),
  error: z.string().optional(),
  capabilities: agentCapabilitiesSchema,
  models: z.array(agentModelSchema), projects: z.array(agentProjectSchema),
  threads: z.array(agentThreadSchema),
})
export type AgentModel = z.infer<typeof agentModelSchema>
export type AgentProject = z.infer<typeof agentProjectSchema>
export type AgentRequest = z.infer<typeof agentRequestSchema>
export type AgentMessage = z.infer<typeof agentMessageSchema>
export type AgentThread = z.infer<typeof agentThreadSchema>
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>
export function supportsAgentSupervision(capabilities: AgentCapabilities): boolean {
  return capabilities.observe && capabilities.questions && capabilities.permissions
    && capabilities.messageOrigin && capabilities.reconcile
}
export type AgentHostSnapshot = z.infer<typeof agentHostSnapshotSchema>

export const subscriptionProviderSchema = z.enum(['codex', 'claude', 'grok'])
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>
export const subscriptionAccountSchema = z.object({
  provider: subscriptionProviderSchema, label: z.string(), installed: z.boolean(), ready: z.boolean(),
  detail: z.string(), models: z.array(z.object({
    id: z.string(), name: z.string(), reasoningEfforts: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().optional(),
  })),
  defaultModelId: z.string().optional(), allowCustomModel: z.boolean().optional(),
})
export type SubscriptionAccount = z.infer<typeof subscriptionAccountSchema>
export function isSubscriptionReasoning(provider: string): provider is SubscriptionProvider {
  return provider === 'codex' || provider === 'claude' || provider === 'grok'
}

export const providerIdSchema = z.enum(['codex', 'claude', 'grok'])
export type ProviderId = z.infer<typeof providerIdSchema>
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build',
}
export const ORB_COLORS = ['teal', 'violet', 'ice', 'amber', 'mono'] as const
export const orbColorSchema = z.enum(ORB_COLORS)
export type OrbColor = z.infer<typeof orbColorSchema>
export const speechProviderSchema = z.enum(['grok', 'kokoro', 'natural', 'system'])
export const agentConfigurationSchema = z.object({
  provider: providerIdSchema.default('codex'),
  orbColor: orbColorSchema.default('teal'),
  enabled: z.boolean(),
  projectsDirectory: z.string().max(4_096),
  defaultModelId: z.string().max(512),
  followupLimit: z.number().int().min(0).max(100),
  speak: z.boolean(),
  speechProvider: speechProviderSchema.default('grok'),
  speechVoice: z.enum(NATURAL_VOICES).default('F1'),
  grokSpeechVoice: grokSpeechVoiceSchema.default('altair'),
  wakeModelDirectory: z.string().max(4_096),
  wakeRuntimeDirectory: z.string().max(4_096),
  reasoning: z.enum(['none', 'codex', 'claude', 'grok', 'openrouter', 'openai']),
  reasoningModel: z.string().max(512),
  reasoningEffort: z.string().max(64).default(''),
  membershipEndpoint: z.string().max(2_048),
}).strict()
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>
export const defaultAgentConfiguration = (): AgentConfiguration => ({
  provider: 'codex',
  orbColor: 'teal',
  enabled: false, projectsDirectory: '', defaultModelId: '',
  followupLimit: 5, speak: true, speechProvider: 'grok', speechVoice: 'F1', grokSpeechVoice: 'altair', wakeModelDirectory: '', wakeRuntimeDirectory: '', reasoning: 'none', reasoningModel: '', reasoningEffort: '', membershipEndpoint: '',
})

export const agentAssignmentSchema = z.object({
  threadId: id, mode: z.enum(['managed', 'manual']), instruction: text,
  followups: z.number().int().nonnegative(), paused: z.boolean(),
  seenMessageIds: z.array(z.string()), ownMessageIds: z.array(z.string()),
  handledRequestIds: z.array(z.string()), lastFailure: z.string(),
  contextUpdatedAt: z.number().default(0),
  /** ISO time the assignment began (assign or create-thread). Empty for assignments saved before it was recorded. */
  startedAt: z.string().default(''),
  /** How the current instruction reached the thread: a spoken "send it", a typed Send, or not yet known. */
  origin: z.enum(['voice', 'typed', 'unknown']).default('unknown'),
  /** Why Sotto stopped managing on its own; 'none' while managing or after a user pause. Cleared by resume. */
  stopReason: z.enum(['none', 'limit', 'repeat', 'error']).default('none'),
  /** ISO time of that stop; empty when stopReason is 'none'. */
  stoppedAt: z.string().default(''),
})
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>
export const agentQueueItemSchema = z.object({
  id, threadId: id, kind: z.enum(['ready', 'question', 'permission', 'blocked']),
  text, requestId: z.string().optional(), createdAt: z.string(), deferred: z.boolean(),
})
export type AgentQueueItem = z.infer<typeof agentQueueItemSchema>
export const MAX_DELIVERED_DRAFTS = 128
export const agentDeliveryReceiptsSchema = z.array(z.object({ threadId: id, draftId: z.uuid() })).max(MAX_DELIVERED_DRAFTS)
export const providerUpgradeSchema = z.object({ recoveryPath: z.string(), migratedAt: z.number() })
export const agentStateSchema = z.object({
  configuration: agentConfigurationSchema,
  providerUpgrade: providerUpgradeSchema.nullable().optional(),
  connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  host: agentHostSnapshotSchema,
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(),
  draft: text, draftThreadId: z.string().nullable(), composing: z.boolean(),
  draftAttachments: agentAttachmentsSchema.optional(),
  deliveredDrafts: agentDeliveryReceiptsSchema.optional(),
  draftRequestId: z.string().nullable(),
  pendingRequest: z.string().max(20_000),
  busy: z.boolean(), notice: z.string(), error: z.string().nullable(),
  speech: z.object({ id: z.number(), text: z.string(), preview: z.boolean().optional() }),
  voice: z.object({ status: z.string(), error: z.string().nullable(), action: z.enum(['none', 'mute', 'unmute', 'stop-speaking', 'sleep']), revision: z.number() }),
  credentials: z.object({ reasoning: z.boolean(), grokSpeech: z.boolean().default(false), secure: z.boolean() }),
  reasoningAccounts: z.array(subscriptionAccountSchema).default([]),
  membership: z.object({
    status: z.enum(['beta', 'free', 'active', 'expired', 'unavailable']),
    label: z.string(), expiresAt: z.string().nullable(),
  }),
})
export type AgentState = z.infer<typeof agentStateSchema>
export const agentCommandSchema = z.discriminatedUnion('type', [
  // Re-extend defaulted fields: Zod 4 applies defaults through partial(), resetting omitted settings.
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.partial().extend({ provider: providerIdSchema.optional(), orbColor: orbColorSchema.optional(), reasoningEffort: z.string().max(64).optional(), speechProvider: speechProviderSchema.optional(), speechVoice: z.enum(NATURAL_VOICES).optional(), grokSpeechVoice: grokSpeechVoiceSchema.optional() }) }).strict(),
  z.object({ type: z.literal('credential'), slot: z.enum(['reasoning', 'membership', 'grokSpeech']), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('connect') }).strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('refresh') }).strict(),
  z.object({ type: z.literal('check-reasoning'), provider: subscriptionProviderSchema }).strict(),
  z.object({ type: z.literal('preview-voice') }).strict(),
  z.object({ type: z.literal('utterance'), text }).strict(),
  z.object({ type: z.literal('voice'), action: z.enum(['mute', 'unmute', 'stop-speaking', 'sleep']) }).strict(),
  z.object({ type: z.literal('voice-state'), status: z.string().max(32), error: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal('compose'), text, attachments: agentAttachmentsSchema.optional() }).strict(),
  z.object({ type: z.literal('recover-draft'), threadId: id }).strict(),
  z.object({ type: z.literal('send') }).strict(),
  z.object({ type: z.literal('manual-send'), threadId: id, text, attachments: agentAttachmentsSchema.optional(), draftId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('cancel-draft') }).strict(),
  z.object({ type: z.literal('cancel-request') }).strict(),
  z.object({ type: z.literal('create-project'), title: id, path: z.string().max(4_096).optional(), useExisting: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select-project'), projectId: id }).strict(),
  z.object({ type: z.literal('create-thread'), projectId: id, title: id, modelId: id,
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(), managed: z.boolean().optional() }).strict(),
  agentThreadOptionsSchema.extend({ type: z.literal('configure-thread'), threadId: id }).strict()
    .refine(value => value.modelId !== undefined || value.reasoningEffort !== undefined || value.runtimeMode !== undefined, 'Choose a thread setting to change.'),
  z.object({ type: z.literal('select-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('select-attention'), itemId: id }).strict(),
  z.object({ type: z.literal('assign'), threadId: id, instruction: text.optional() }).strict(),
  z.object({ type: z.literal('unassign'), threadId: id }).strict(),
  z.object({ type: z.literal('resume'), threadId: id }).strict(),
  z.object({ type: z.literal('pause'), threadId: id }).strict(),
  z.object({ type: z.literal('interrupt'), threadId: id }).strict(),
  z.object({ type: z.enum(['next', 'later']) }).strict(),
  z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: text, approved: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('membership'), action: z.enum(['refresh', 'signin', 'checkout', 'portal']) }).strict(),
])
export type AgentCommand = z.infer<typeof agentCommandSchema>
export interface AgentBridge {
  chooseProjectDirectory?(): Promise<string | null>
  prepareWake?(): Promise<AgentWakeDetection>
  detectWake?(audio: Float32Array): Promise<AgentWakeDetection>
  releaseWake?(): Promise<AgentWakeDetection>
  synthesizeSpeech?(text: string): Promise<{ audioBase64: string; mimeType: 'audio/wav' }>
  cancelSpeech?(): Promise<void>
  grokVoices?(): Promise<AgentSpeechVoice[]>
  voiceModel?(action: 'status' | 'download'): Promise<AgentVoiceModelStatus>
  get(): Promise<AgentState>
  command(command: AgentCommand): Promise<AgentState>
  onState(listener: (state: AgentState) => void): () => void
}

export const EMPTY_AGENT_HOST: AgentHostSnapshot = {
  connected: false, name: 'Codex', version: '', projects: [], threads: [], models: [],
  capabilities: { projects: false, threads: false, submit: false, observe: false,
    questions: false, permissions: false, interrupt: false, messageOrigin: false, reconcile: false },
}

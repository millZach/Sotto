import { z } from 'zod'
import { agentSkillCatalogSchema, agentSkillReferencesSchema } from './agentSkills'
import { agentFileReferencesSchema } from './agentFiles'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES } from './agentActivity'
import { threadUsageSchema } from './threadUsage'
import { compactionSchema } from './compaction'

/** Clock origin is the last voiced PCM frame received by the renderer, not hardware acoustic capture. */
export const agentVoiceTimingSchema = z.object({
  speechEndedAt: z.string().datetime(),
  phase: z.enum(['cold', 'warm']),
  basis: z.literal('detector-frame-received'),
}).strict()
export type AgentVoiceTiming = z.infer<typeof agentVoiceTimingSchema>

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
export const AGENT_ATTACHMENT_PREVIEW = 'sotto:agents:attachment-preview'
/** Pushed per thread: the messages of a thread the window is actually looking at. */
export const AGENT_THREAD_DETAIL = 'sotto:agents:thread-detail'
/** Asked for by the window when it opens a thread whose detail it has not been sent. */
export const AGENT_THREAD_DETAIL_GET = 'sotto:agents:thread-detail-get'
export const agentWakeDetectionSchema = z.object({ detected: z.boolean(), endSeconds: z.number().min(0).max(8.25) })
export type AgentWakeDetection = z.infer<typeof agentWakeDetectionSchema>
export const agentSpeechSchema = z.object({ audioBase64: z.string().max(20_000_000), mimeType: z.literal('audio/wav') })
export const agentVoiceModelStatusSchema = z.object({ ready: z.boolean(), completedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() })
export type AgentVoiceModelStatus = z.infer<typeof agentVoiceModelStatusSchema>
export const NATURAL_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const
export const grokSpeechVoiceSchema = z.string().trim().min(1).max(256).refine(value => !/\p{Cc}/u.test(value), 'Choose a valid Grok voice ID.')
export const agentSpeechVoicesSchema = z.array(z.object({ id: grokSpeechVoiceSchema, name: z.string().min(1).max(300) })).max(5_000)
export type AgentSpeechVoice = z.infer<typeof agentSpeechVoicesSchema>[number]

export const providerIdSchema = z.enum(['codex', 'claude', 'grok'])
export type ProviderId = z.infer<typeof providerIdSchema>

const id = z.string().min(1).max(512)
// Scoped public model/project IDs include an encoded native identifier.
const providerEntityId = z.string().min(1).max(6_144)
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
/** Signature check shared by native submission and preview validation; never accepts SVG/HTML. */
export function hasRasterImageSignature(attachment: Pick<AgentAttachment, 'mimeType' | 'dataUrl'>): boolean {
  let header: string
  try { header = atob(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1, attachment.dataUrl.indexOf(',') + 25)) }
  catch { return false }
  return attachment.mimeType === 'image/png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : attachment.mimeType === 'image/jpeg' ? header.startsWith('\xff\xd8\xff')
      : attachment.mimeType === 'image/gif' ? /^(GIF87a|GIF89a)/u.test(header)
        : attachment.mimeType === 'image/webp' && header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
}
/** Preview bytes themselves: an unsent draft's own image, or one main hands back on request. */
export const agentAttachmentPreviewDataSchema = z.object({ dataUrl: z.string().max(14_000_000) }).strict().refine(preview => {
  const parsed = agentAttachmentSchema.safeParse({ id: 'preview', name: 'preview',
    mimeType: preview.dataUrl.slice(5, preview.dataUrl.indexOf(';')), dataUrl: preview.dataUrl })
  return parsed.success && hasRasterImageSignature(parsed.data)
}, 'Choose a valid raster image preview.')
/** Published state carries the marker alone; the window asks for the bytes when it draws the image. */
export const agentAttachmentPreviewMarkerSchema = z.object({ available: z.literal(true) }).strict()
export const agentAttachmentPreviewSchema = z.union([agentAttachmentPreviewDataSchema, agentAttachmentPreviewMarkerSchema])
export type AgentAttachmentPreview = z.infer<typeof agentAttachmentPreviewSchema>
export const agentAttachmentPreviewRequestSchema = z.object({ threadId: id, messageId: id, attachmentId: id }).strict()
export type AgentAttachmentPreviewRequest = z.infer<typeof agentAttachmentPreviewRequestSchema>
export const agentAttachmentPreviewResultSchema = agentAttachmentPreviewDataSchema.nullable()
export type AgentAttachmentPreviewResult = z.infer<typeof agentAttachmentPreviewResultSchema>
export const agentAttachmentReferenceSchema = z.object({ id, name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative(),
  /** Supplied by Sotto for submitted images; never a filesystem path or a provider URL. */
  preview: agentAttachmentPreviewSchema.optional(),
})
export type AgentAttachmentReference = z.infer<typeof agentAttachmentReferenceSchema>
export const agentThreadOptionsSchema = z.object({ modelId: providerEntityId.optional(), reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional() })
export type AgentThreadOptions = z.infer<typeof agentThreadOptionsSchema>
export const agentModelSchema = z.object({ id: providerEntityId, provider: id, providerId: providerIdSchema.optional(), name: id, ready: z.boolean(),
  reasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  runtimeModes: z.array(agentRuntimeModeSchema).optional(), supportsImages: z.boolean().optional(),
})
export const agentProjectSchema = z.object({ id: providerEntityId, providerId: providerIdSchema.optional(), title: id, path: z.string().max(4_096), workspaceSettledAt: z.string().datetime().nullable().optional() })
export const agentRequestSchema = z.object({
  id, kind: z.enum(['question', 'permission']), text,
  options: z.array(z.object({ id, label: text })).default([]),
  questions: z.array(z.object({ id, question: text, header: text.optional(), options: z.array(z.object({ id, label: text, description: text.optional(), preview: text.optional() })), multiSelect: z.boolean(), allowFreeText: z.boolean(), required: z.boolean().optional(), unavailableReason: text.optional() })).max(100).optional(),
  permissionChoices: z.array(z.object({ id, label: text, kind: z.enum(['allow-once', 'allow-session', 'allow-always', 'deny', 'cancel']), description: text.optional() })).optional(),
  context: z.object({ toolName: text.optional(), toolCallId: id.optional(), command: text.optional(), cwd: text.optional(), details: text.optional() }).optional(),
  delivery: z.literal('uncertain').optional(),
})
export const agentQuestionAnswersSchema = z.record(id, z.object({ optionIds: z.array(id).max(100), text: text.optional() }).strict())
export type AgentQuestionAnswers = z.infer<typeof agentQuestionAnswersSchema>
export const agentMessageSchema = z.object({
  id, role: z.enum(['user', 'assistant']), text, createdAt: z.string(),
  commandId: z.string().optional(),
  attachments: z.array(agentAttachmentReferenceSchema).optional(),
})
/**
 * What the sidebar reads about a thread's history without holding that history. The shell stream
 * carries it in place of `messages`; a thread whose messages are present derives the same facts.
 */
export const AGENT_THREAD_EXCERPT_MAX = 2_000
const excerpt = z.string().max(AGENT_THREAD_EXCERPT_MAX)
const threadExcerptSchema = z.object({ id, text: excerpt, createdAt: z.string() }).strict()
export const agentThreadSummarySchema = z.object({
  messageCount: z.number().int().nonnegative(),
  /** The newest `createdAt` across every message, so a row's clock survives without them. */
  lastMessageAt: z.string().optional(),
  lastUser: threadExcerptSchema.optional(),
  lastAssistant: threadExcerptSchema.optional(),
  activityCount: z.number().int().nonnegative().default(0),
  /** When the run on screen began, for a row that no longer carries the turn record itself. */
  runningTurnStartedAt: z.string().optional(),
}).strict()
export type AgentThreadSummary = z.infer<typeof agentThreadSummarySchema>
export const agentWorktreeSchema = z.object({
  mode: z.enum(['independent', 'shared']), status: z.enum(['pending', 'ready', 'error']),
  path: z.string().optional(), repositoryRoot: z.string().optional(), branch: z.string().optional(),
  baseCommit: z.string().optional(), error: z.string().optional(), dirty: z.boolean().optional(),
  projectRelativePath: z.string().optional(),
})
export type AgentWorktree = z.infer<typeof agentWorktreeSchema>
export const agentThreadSchema = z.object({
  id, providerId: providerIdSchema.optional(), projectId: providerEntityId, title: id, modelId: z.string(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(),
  status: z.enum(['idle', 'running', 'error']),
  workingDirectory: z.string().optional(), worktree: agentWorktreeSchema.optional(),
  /** Sotto organization only: does not close native work or suppress attention. */
  workspaceSettledAt: z.string().datetime().nullable().optional(),
  /** False only before Sotto dispatches native creation. Unknown is conservatively locked. */
  nativeSessionStarted: z.boolean().optional(),
  /** Provider activity time; omitted when unknown, never the time Sotto observed the thread. */
  updatedAt: z.string().optional(),
  /** Explicit lifecycle metadata. Null clears a prior value; omission means unknown. */
  settledAt: z.string().nullable().optional(), archivedAt: z.string().nullable().optional(),
  settledOverride: z.enum(['settled', 'active']).nullable().optional(),
  messages: z.array(agentMessageSchema), requests: z.array(agentRequestSchema),
  /** Present on the shell stream, where `messages` is empty; absent when the messages themselves are here. */
  summary: agentThreadSummarySchema.optional(),
  activities: z.array(agentActivitySchema).max(MAX_AGENT_ACTIVITIES).optional(),
  usage: threadUsageSchema.optional(),
  compaction: compactionSchema.optional(),
  manualCompactionSupported: z.boolean().optional(),
  resumeCompactionDismissed: z.boolean().optional(),
  /** Native outcome evidence for queue admission; never an authority to replay work. */
  lastTurn: z.object({ id: z.string(), status: z.enum(['running', 'completed', 'interrupted', 'failed']) }).optional(),
  /** Omitted by providers that already supply history; absence means ready. */
  historyStatus: z.enum(['loading', 'ready', 'error']).optional(), historyError: z.string().optional(),
  /** Changes only on a confirmed native rewind; cached activity must not cross it. */
  historyEpoch: z.string().optional(),
})
export const agentCapabilitiesSchema = z.object({
  projects: z.boolean(), threads: z.boolean(), submit: z.boolean(),
  observe: z.boolean(), questions: z.boolean(), permissions: z.boolean(),
  interrupt: z.boolean(), messageOrigin: z.boolean(), reconcile: z.boolean(),
  configureThread: z.boolean().optional(), skills: z.boolean().optional(),
  /** False when a started thread can change only its permission mode, not its model or reasoning. */
  configureThreadModel: z.boolean().optional(),
  steer: z.boolean().optional(),
  compact: z.boolean().optional(),
})
export const agentProviderStatusSchema = z.object({
  id: providerIdSchema, connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  name: z.string(), version: z.string(), error: z.string().optional(), capabilities: agentCapabilitiesSchema,
})
export type AgentProviderStatus = z.infer<typeof agentProviderStatusSchema>
export const agentHostSnapshotSchema = z.object({
  providers: z.array(agentProviderStatusSchema).optional(),
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

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build',
}
export const ORB_COLORS = ['teal', 'violet', 'ice', 'amber', 'mono'] as const
export const orbColorSchema = z.enum(ORB_COLORS)
export type OrbColor = z.infer<typeof orbColorSchema>
export const speechProviderSchema = z.enum(['grok', 'kokoro', 'natural', 'system'])
export const agentConfigurationSchema = z.object({
  provider: providerIdSchema.default('codex'),
  enabledProviders: z.array(providerIdSchema).max(3).refine(ids => new Set(ids).size === ids.length, 'Choose each provider once.').optional(),
  orbColor: orbColorSchema.default('teal'),
  enabled: z.boolean(),
  projectsDirectory: z.string().max(4_096),
  defaultModelId: z.string().max(6_144),
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
export const agentThreadDraftSchema = z.object({
  threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentsSchema, skills: agentSkillReferencesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
  requestId: id.nullable(), updatedAt: z.string().datetime(),
})
export type AgentThreadDraft = z.infer<typeof agentThreadDraftSchema>
/** User-authored follow-ups; independent of attention and dispatched outbox intent. */
export const agentFollowupSchema = z.object({
  id: z.uuid(), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentsSchema, skills: agentSkillReferencesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  status: z.enum(['queued', 'dispatching', 'uncertain', 'failed', 'paused']),
  error: z.string().optional(), commandId: id.optional(), messageId: id.optional(), resumeAfterTurnId: id.optional(),
})
export type AgentFollowup = z.infer<typeof agentFollowupSchema>
export const agentDeliverySchema = z.object({
  threadId: id, draftId: z.uuid(),
  status: z.enum(['queued', 'submitting', 'accepted', 'failed', 'uncertain']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  commandId: id.optional(), messageId: id.optional(),
  localFeedbackMs: z.number().nonnegative().optional(), providerLatencyMs: z.number().nonnegative().optional(),
})
export type AgentDelivery = z.infer<typeof agentDeliverySchema>
export const agentDeliveryReceiptsSchema = z.array(z.object({ threadId: id, draftId: z.uuid() })).max(MAX_DELIVERED_DRAFTS)
export const providerUpgradeSchema = z.object({ recoveryPath: z.string(), migratedAt: z.number() })
export const agentStateSchema = z.object({
  configuration: agentConfigurationSchema,
  skillCatalogs: z.array(agentSkillCatalogSchema).optional(),
  providerUpgrade: providerUpgradeSchema.nullable().optional(),
  connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  host: agentHostSnapshotSchema,
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(),
  draft: text, draftThreadId: z.string().nullable(), composing: z.boolean(),
  draftAttachments: agentAttachmentsSchema.optional(),
  deliveredDrafts: agentDeliveryReceiptsSchema.optional(),
  threadDrafts: z.array(agentThreadDraftSchema).optional(),
  /** Main-only, ephemeral evidence for these exact revisions, including empty draft clears.
   * Missing evidence never confirms persistence. It is rebuilt from disk on startup. */
  threadDraftPersistence: z.array(z.object({
    threadId: id, draftId: z.uuid(), status: z.enum(['saved', 'saving', 'unsaved']),
  })).optional(),
  deliveries: z.array(agentDeliverySchema).optional(),
  followups: z.array(agentFollowupSchema).optional(),
  followupReceipts: agentDeliveryReceiptsSchema.optional(),
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
  /** Whether the user keeps local history; the window persists its startup shell only when true. */
  historyEnabled: z.boolean().optional(),
  /** True only for the shell the window painted from its own cache before main answered. */
  stale: z.boolean().optional(),
})
export type AgentState = z.infer<typeof agentStateSchema>
/**
 * One viewed thread's history, pushed and fetched apart from the shell stream: its messages and the
 * activity beside them. Activity is the larger half by far â€” a working thread reports hundreds of
 * records â€” and, like the messages, only the open pane draws it.
 */
export const agentThreadDetailSchema = z.object({
  threadId: id, revision: z.number().int().nonnegative(), messages: z.array(agentMessageSchema),
  activities: z.array(agentActivitySchema).max(MAX_AGENT_ACTIVITIES).optional(),
}).strict()
export type AgentThreadDetail = z.infer<typeof agentThreadDetailSchema>
export const agentThreadDetailResultSchema = agentThreadDetailSchema.nullable()
export const agentThreadDetailRequestSchema = id
/**
 * What changed in one viewed thread since the revision the window already holds, sent in place of the
 * whole detail while an agent streams into it: a message that grew by a chunk costs the chunk, not the
 * thread. A message delta is a whole message â€” new, or changed in a way an append cannot say â€” or the
 * suffix a streaming message grew by; an activity delta is one record as it now stands, or its removal.
 * The window applies one only when `baseRevision` is the revision it holds, and asks for the whole
 * detail when it is not. The full form remains for first delivery and for that resync.
 */
export const agentMessageDeltaSchema = z.union([
  z.object({ message: agentMessageSchema }).strict(),
  z.object({ id, appendText: text }).strict(),
])
export type AgentMessageDelta = z.infer<typeof agentMessageDeltaSchema>
export const agentActivityDeltaSchema = z.union([
  z.object({ record: agentActivitySchema }).strict(),
  z.object({ id: z.string(), removed: z.literal(true) }).strict(),
])
export type AgentActivityDelta = z.infer<typeof agentActivityDeltaSchema>
export const agentThreadDetailDeltaSchema = z.object({
  threadId: id, baseRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  messageDeltas: z.array(agentMessageDeltaSchema),
  activityDeltas: z.array(agentActivityDeltaSchema).max(MAX_AGENT_ACTIVITIES),
}).strict()
export type AgentThreadDetailDelta = z.infer<typeof agentThreadDetailDeltaSchema>
export const agentThreadDetailUpdateSchema = z.union([agentThreadDetailSchema, agentThreadDetailDeltaSchema])
export type AgentThreadDetailUpdate = z.infer<typeof agentThreadDetailUpdateSchema>

/** The sidebar's facts about a thread's history, derived from the history itself. */
export function summarizeThread(thread: Pick<AgentThread, 'messages' | 'activities'>): AgentThreadSummary {
  const { messages, activities = [] } = thread
  const cut = (message: AgentMessage): z.infer<typeof threadExcerptSchema> =>
    ({ id: message.id, text: message.text.slice(0, AGENT_THREAD_EXCERPT_MAX), createdAt: message.createdAt })
  const lastUser = messages.findLast(message => message.role === 'user')
  const lastAssistant = messages.findLast(message => message.role === 'assistant')
  const lastMessageAt = messages.reduce<string | undefined>((latest, message) => {
    const at = Date.parse(message.createdAt)
    return Number.isFinite(at) && (latest === undefined || at > Date.parse(latest)) ? message.createdAt : latest
  }, undefined)
  const running = activities.filter(record => record.kind === 'turn' && record.status === 'running')
    .sort((first, second) => first.sequence - second.sequence).at(-1)
  return { messageCount: messages.length, activityCount: activities.length,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastUser === undefined ? {} : { lastUser: cut(lastUser) }),
    ...(lastAssistant === undefined ? {} : { lastAssistant: cut(lastAssistant) }),
    ...(running?.startedAt === undefined ? {} : { runningTurnStartedAt: running.startedAt }) }
}
/** The same facts, from the summary the shell carries or from the history a full state holds. */
export function threadSummaryOf(thread: Pick<AgentThread, 'messages' | 'activities' | 'summary'>): AgentThreadSummary {
  return thread.summary ?? summarizeThread(thread)
}
/** One thread as the shell stream carries it: the sidebar's facts, none of its history. */
export function threadShell(thread: AgentThread): AgentThread {
  return { ...thread, messages: [], ...(thread.activities === undefined ? {} : { activities: [] }), summary: threadSummaryOf(thread) }
}
/** The published state with every thread's history replaced by its summary. */
export function agentShell(state: AgentState): AgentState {
  return { ...state, host: { ...state.host, threads: state.host.threads.map(threadShell) } }
}
export const agentCommandSchema = z.discriminatedUnion('type', [
  // Re-extend defaulted fields: Zod 4 applies defaults through partial(), resetting omitted settings.
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.partial().extend({ provider: providerIdSchema.optional(), orbColor: orbColorSchema.optional(), reasoningEffort: z.string().max(64).optional(), speechProvider: speechProviderSchema.optional(), speechVoice: z.enum(NATURAL_VOICES).optional(), grokSpeechVoice: grokSpeechVoiceSchema.optional() }) }).strict(),
  z.object({ type: z.literal('credential'), slot: z.enum(['reasoning', 'membership', 'grokSpeech']), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('connect'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('disconnect'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('refresh'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('refresh-thread-skills'), threadId: id, forceReload: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('check-reasoning'), provider: subscriptionProviderSchema }).strict(),
  z.object({ type: z.literal('preview-voice') }).strict(),
  z.object({ type: z.literal('utterance'), text, voiceTiming: agentVoiceTimingSchema.optional() }).strict(),
  z.object({ type: z.literal('voice'), action: z.enum(['mute', 'unmute', 'stop-speaking', 'sleep']) }).strict(),
  z.object({ type: z.literal('voice-state'), status: z.string().max(32), error: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal('compose'), text, attachments: agentAttachmentsSchema.optional() }).strict(),
  z.object({ type: z.literal('save-thread-draft'), threadId: id, draftId: z.uuid(), text,
    attachments: agentAttachmentsSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional(), requestId: id.nullable().optional(), composer: z.literal('manual').optional() }).strict(),
  z.object({ type: z.literal('recover-draft'), threadId: id }).strict(),
  z.object({ type: z.literal('send') }).strict(),
  z.object({ type: z.literal('manual-send'), threadId: id, text, attachments: agentAttachmentsSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional(), draftId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('queue-followup'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentsSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('edit-followup'), threadId: id, itemId: z.uuid(), text, attachments: agentAttachmentsSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('remove-followup'), threadId: id, itemId: z.uuid() }).strict(),
  z.object({ type: z.literal('reorder-followups'), threadId: id, itemIds: z.array(z.uuid()).max(100) }).strict(),
  z.object({ type: z.literal('resume-followups'), threadId: id }).strict(),
  z.object({ type: z.literal('steer'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentsSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('cancel-draft') }).strict(),
  z.object({ type: z.literal('pause-draft') }).strict(),
  z.object({ type: z.literal('resume-draft'), threadId: id }).strict(),
  z.object({ type: z.literal('cancel-request') }).strict(),
  z.object({ type: z.literal('create-project'), provider: providerIdSchema.optional(), title: id, path: z.string().max(4_096).optional(), useExisting: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('restore-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('restore-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('create-thread'), projectId: providerEntityId, title: id, modelId: providerEntityId,
    /** The Sotto thread ID the window already minted and is showing. Absent from voice and older callers, which let main mint one. */
    threadId: z.uuid().optional(),
    workingCopy: z.enum(['independent', 'shared']).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(), managed: z.boolean().optional() }).strict(),
  z.object({ type: z.enum(['retry-thread-worktree', 'refresh-thread-worktree', 'open-thread-folder']), threadId: id }).strict(),
  agentThreadOptionsSchema.extend({ type: z.literal('configure-thread'), threadId: id }).strict()
    .refine(value => value.modelId !== undefined || value.reasoningEffort !== undefined || value.runtimeMode !== undefined, 'Choose a thread setting to change.'),
  z.object({ type: z.literal('select-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('observe-threads'), threadIds: z.array(id).max(100) }).strict(),
  z.object({ type: z.literal('select-attention'), itemId: id }).strict(),
  z.object({ type: z.literal('assign'), threadId: id, instruction: text.optional(), expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('unassign'), threadId: id }).strict(),
  z.object({ type: z.literal('resume'), threadId: id, expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('pause'), threadId: id }).strict(),
  z.object({ type: z.literal('interrupt'), threadId: id }).strict(),
  z.object({ type: z.literal('compact-thread'), threadId: id }).strict(),
  z.object({ type: z.enum(['next', 'later']) }).strict(),
  z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: text, approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional() }).strict(),
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
  /** The bytes behind one published `preview: { available: true }` marker, or null when nothing is eligible. */
  attachmentPreview?(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult>
  command(command: AgentCommand): Promise<AgentState>
  onState(listener: (state: AgentState) => void): () => void
  /** One viewed thread's messages, for a thread the window opened before main pushed them. */
  threadDetail?(threadId: string): Promise<AgentThreadDetail | null>
  /** Whole details and the deltas between them; a delta the window cannot apply sends it back to `threadDetail`. */
  onThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
}

export const EMPTY_AGENT_HOST: AgentHostSnapshot = {
  connected: false, name: 'Codex', version: '', projects: [], threads: [], models: [],
  capabilities: { projects: false, threads: false, submit: false, observe: false,
    questions: false, permissions: false, interrupt: false, messageOrigin: false, reconcile: false },
}

/** Legacy installations retain their selected native provider until explicitly changed. */
export function enabledThreadProviders(configuration: AgentConfiguration): ProviderId[] {
  return [...(configuration.enabledProviders ?? [configuration.provider])]
}
export function capabilitiesForThread(host: AgentHostSnapshot, thread: AgentThread): AgentCapabilities {
  if (!host.providers || !thread.providerId) return host.capabilities
  return host.providers.find(provider => provider.id === thread.providerId)?.capabilities ?? EMPTY_AGENT_HOST.capabilities
}
/** Public model and project IDs; only the provider boundary reverses them. */
export function publicProviderEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  return `native:${provider}:${kind}:${encodeURIComponent(value)}`
}
/**
 * The model a new thread starts with: the default chosen for new threads, then the agent account's model
 * (or that provider's first model), then the legacy provider's first model, then any ready model.
 */
export function defaultThreadModelId(configuration: AgentConfiguration, models: readonly AgentModel[]): string {
  const ready = models.filter(model => model.ready)
  const agent = isSubscriptionReasoning(configuration.reasoning) ? configuration.reasoning : null
  const chosen = ready.find(model => model.id === configuration.defaultModelId)
    ?? (agent && configuration.reasoningModel ? ready.find(model => model.id === publicProviderEntityId(agent, 'model', configuration.reasoningModel)) : undefined)
    ?? (agent ? ready.find(model => model.providerId === agent) : undefined)
    ?? ready.find(model => model.providerId === configuration.provider)
    ?? ready[0]
  return chosen?.id ?? ''
}
export function isThreadProviderConnected(host: AgentHostSnapshot, thread: AgentThread): boolean {
  if (!host.providers || !thread.providerId) return host.connected
  return host.providers.some(provider => provider.id === thread.providerId && provider.connection === 'connected')
}

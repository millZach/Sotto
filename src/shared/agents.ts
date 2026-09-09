import { z } from 'zod'

export const AGENT_GET = 'sotto:agents:get'
export const AGENT_COMMAND = 'sotto:agents:command'
export const AGENT_STATE = 'sotto:agents:state'
export const AGENT_E2E = 'sotto:e2e:agents'
export const AGENT_SPEECH = 'sotto:agents:speech'
export const AGENT_WAKE = 'sotto:agents:wake'
export const agentWakeDetectionSchema = z.object({ detected: z.boolean(), endSeconds: z.number().min(0).max(8.25) })
export type AgentWakeDetection = z.infer<typeof agentWakeDetectionSchema>
export const agentSpeechSchema = z.object({ audioBase64: z.string().max(20_000_000), mimeType: z.literal('audio/wav') })

const id = z.string().min(1).max(512)
const text = z.string().max(100_000)
export const agentModelSchema = z.object({ id, provider: id, name: id, ready: z.boolean() })
export const agentProjectSchema = z.object({ id, title: id, path: z.string().max(4_096) })
export const agentRequestSchema = z.object({
  id, kind: z.enum(['question', 'permission']), text,
  options: z.array(z.object({ id, label: text })).default([]),
})
export const agentMessageSchema = z.object({
  id, role: z.enum(['user', 'assistant']), text, createdAt: z.string(),
  commandId: z.string().optional(),
})
export const agentThreadSchema = z.object({
  id, projectId: id, title: id, modelId: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  messages: z.array(agentMessageSchema), requests: z.array(agentRequestSchema),
})
export const agentCapabilitiesSchema = z.object({
  projects: z.boolean(), threads: z.boolean(), submit: z.boolean(),
  observe: z.boolean(), questions: z.boolean(), permissions: z.boolean(),
  interrupt: z.boolean(), messageOrigin: z.boolean(), reconcile: z.boolean(),
})
export const agentHostSnapshotSchema = z.object({
  connected: z.boolean(), name: z.string(), version: z.string(),
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

export const agentConfigurationSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().max(2_048),
  projectsDirectory: z.string().max(4_096),
  defaultModelId: z.string().max(512),
  followupLimit: z.number().int().min(0).max(100),
  speak: z.boolean(),
  wakeModelDirectory: z.string().max(4_096),
  wakeRuntimeDirectory: z.string().max(4_096),
  reasoning: z.enum(['none', 'openrouter', 'openai']),
  reasoningModel: z.string().max(512),
  membershipEndpoint: z.string().max(2_048),
}).strict()
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>
export const defaultAgentConfiguration = (): AgentConfiguration => ({
  enabled: false, endpoint: 'http://127.0.0.1:3773', projectsDirectory: '', defaultModelId: '',
  followupLimit: 5, speak: true, wakeModelDirectory: '', wakeRuntimeDirectory: '', reasoning: 'none', reasoningModel: '', membershipEndpoint: '',
})

export const agentAssignmentSchema = z.object({
  threadId: id, mode: z.enum(['managed', 'manual']), instruction: text,
  followups: z.number().int().nonnegative(), paused: z.boolean(),
  seenMessageIds: z.array(z.string()), ownMessageIds: z.array(z.string()),
  handledRequestIds: z.array(z.string()), lastFailure: z.string(),
  contextUpdatedAt: z.number().default(0),
})
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>
export const agentQueueItemSchema = z.object({
  id, threadId: id, kind: z.enum(['ready', 'question', 'permission', 'blocked']),
  text, requestId: z.string().optional(), createdAt: z.string(), deferred: z.boolean(),
})
export type AgentQueueItem = z.infer<typeof agentQueueItemSchema>
export const agentStateSchema = z.object({
  configuration: agentConfigurationSchema,
  connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  host: agentHostSnapshotSchema,
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(),
  draft: text, draftThreadId: z.string().nullable(), composing: z.boolean(),
  draftRequestId: z.string().nullable(),
  pendingRequest: z.string().max(20_000),
  busy: z.boolean(), notice: z.string(), error: z.string().nullable(),
  speech: z.object({ id: z.number(), text: z.string() }),
  voice: z.object({ status: z.string(), error: z.string().nullable(), action: z.enum(['none', 'mute', 'unmute', 'stop-speaking', 'sleep']), revision: z.number() }),
  credentials: z.object({ t3: z.boolean(), reasoning: z.boolean(), secure: z.boolean() }),
  membership: z.object({
    status: z.enum(['beta', 'free', 'active', 'expired', 'unavailable']),
    label: z.string(), expiresAt: z.string().nullable(),
  }),
})
export type AgentState = z.infer<typeof agentStateSchema>
export const agentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.partial() }).strict(),
  z.object({ type: z.literal('credential'), slot: z.enum(['t3', 'reasoning', 'membership']), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('connect') }).strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('refresh') }).strict(),
  z.object({ type: z.literal('utterance'), text }).strict(),
  z.object({ type: z.literal('voice'), action: z.enum(['mute', 'unmute', 'stop-speaking', 'sleep']) }).strict(),
  z.object({ type: z.literal('voice-state'), status: z.string().max(32), error: z.string().max(2000).nullable() }).strict(),
  z.object({ type: z.literal('compose'), text }).strict(),
  z.object({ type: z.literal('send') }).strict(),
  z.object({ type: z.literal('cancel-draft') }).strict(),
  z.object({ type: z.literal('cancel-request') }).strict(),
  z.object({ type: z.literal('create-project'), title: id, path: z.string().max(4_096).optional(), useExisting: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select-project'), projectId: id }).strict(),
  z.object({ type: z.literal('create-thread'), projectId: id, title: id, modelId: id }).strict(),
  z.object({ type: z.literal('select-thread'), threadId: id }).strict(),
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
  prepareWake?(): Promise<AgentWakeDetection>
  detectWake?(audio: Float32Array): Promise<AgentWakeDetection>
  releaseWake?(): Promise<AgentWakeDetection>
  synthesizeSpeech?(text: string): Promise<{ audioBase64: string; mimeType: 'audio/wav' }>
  get(): Promise<AgentState>
  command(command: AgentCommand): Promise<AgentState>
  onState(listener: (state: AgentState) => void): () => void
}

export const EMPTY_AGENT_HOST: AgentHostSnapshot = {
  connected: false, name: 'T3 Code', version: '', projects: [], threads: [], models: [],
  capabilities: { projects: false, threads: false, submit: false, observe: false,
    questions: false, permissions: false, interrupt: false, messageOrigin: false, reconcile: false },
}

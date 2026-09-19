import { z } from 'zod'

export const MEMORY_GET = 'memory:get'
export const MEMORY_COMMAND = 'memory:command'
export const MEMORY_CHANGED = 'memory:changed'

export const memoryTopics = ['communication', 'autonomy', 'verification', 'git', 'agents', 'workflow', 'privacy'] as const
export const MAX_MEMORY_CONTENT_CHARACTERS = 2000
// Every accepted questionnaire answer fits together, including at maximum length.
export const MAX_PREFERENCE_CONTEXT_CHARACTERS = memoryTopics.length * MAX_MEMORY_CONTENT_CHARACTERS
export const memoryTopicSchema = z.enum(memoryTopics)
export type MemoryTopic = z.infer<typeof memoryTopicSchema>
const memoryProvenanceSchema = z.union([
  z.object({ threadId: z.string().min(1).describe('Sotto thread ID'), ref: z.string() }),
  z.object({ source: z.enum(['questionnaire', 'inspector']), ref: z.string().min(1), recordedAt: z.iso.datetime() }).strict(),
])
export const memoryItemSchema = z.object({
  id: z.string().min(1), type: z.string(), scope: z.string(), content: z.string().min(1),
  sourceClass: z.enum(['explicit', 'observed', 'inferred', 'imported', 'agent-confirmed']),
  confidence: z.number().min(0).max(1), evidenceCount: z.number().int().min(0),
  importance: z.number().min(0).max(1), createdAt: z.iso.datetime(),
  lastConfirmedAt: z.iso.datetime().nullable(), lastUsedAt: z.iso.datetime().nullable(),
  validFrom: z.iso.datetime(), validTo: z.iso.datetime().nullable(),
  supersededBy: z.string().min(1).nullable(), provenance: z.array(memoryProvenanceSchema),
  tags: z.array(z.string()), state: z.enum(['active', 'superseded', 'disputed', 'temporary', 'archived']),
  authority: z.enum(['preference', 'policy', 'permission']),
})
export type MemoryItem = z.infer<typeof memoryItemSchema>
/** The four risky classes a permission request is classified into, and the only ones the questionnaire offers. */
export const riskBoundaryActionSchema = z.enum(['spend', 'publish', 'destroy', 'relax-verification'])
/**
 * Every action a policy record can be written about. `remote-answer` is not a risky class: it is the
 * record that a named client, scoped `client:<clientId>`, may have its answers counted as grants
 * (ADR-0004, ADR-0016). Only the user writes one, and only on this PC.
 */
export const memoryPolicyActionSchema = z.enum([...riskBoundaryActionSchema.options, 'remote-answer'])
export const memoryPolicySchema = z.object({
  id: z.string().min(1), action: memoryPolicyActionSchema,
  resource: z.string().min(1), scope: z.string().min(1),
  effect: z.enum(['allow', 'always-confirm']), source: z.enum(['user', 'questionnaire']),
  note: z.string(), grantedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
})
export type PolicyItem = z.infer<typeof memoryPolicySchema>
const contentSchema = z.string().trim().min(1).max(MAX_MEMORY_CONTENT_CHARACTERS)
export const memoryCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('complete-questionnaire'),
    answers: z.array(z.object({ topic: memoryTopicSchema, content: contentSchema }).strict()).length(7)
      .refine(answers => new Set(answers.map(answer => answer.topic)).size === 7, 'Answer each topic once'),
    boundaries: z.array(riskBoundaryActionSchema).max(4)
      .refine(boundaries => new Set(boundaries).size === boundaries.length, 'Choose each boundary once'),
  }).strict(),
  z.object({ type: z.literal('edit'), id: z.string().min(1), content: contentSchema }).strict(),
  z.object({ type: z.literal('supersede'), id: z.string().min(1), content: contentSchema }).strict(),
  z.object({ type: z.literal('delete'), id: z.string().min(1) }).strict(),
])
export type MemoryCommand = z.infer<typeof memoryCommandSchema>
export const memorySnapshotSchema = z.object({
  available: z.boolean(),
  questionnaireCompletedAt: z.iso.datetime().nullable(),
  memories: z.array(memoryItemSchema),
  policies: z.array(memoryPolicySchema),
}).strict()
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>
export interface MemoryBridge {
  get(): Promise<MemorySnapshot>
  command(command: MemoryCommand): Promise<MemorySnapshot>
  onChanged(listener: (snapshot: MemorySnapshot) => void): () => void
}

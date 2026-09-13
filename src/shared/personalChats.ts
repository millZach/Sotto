import { z } from 'zod'
import { agentThreadSchema, agentCommandSchema, agentRequestSchema, agentMessageSchema } from './agents'
import { agentSkillReferencesSchema, type AgentSkillCatalog } from './agentSkills'
const id = z.string().min(1).max(256)
const revision = z.number().int().nonnegative()
// Derive answers from the shared project request contract. Provider additions
// (structured questions and exact permission choices) flow through unchanged.
const agentAnswerSchema = agentCommandSchema.options.find((option): option is Extract<typeof option, { shape: { type: z.ZodLiteral<'answer'> } }> => option.shape.type.safeParse('answer').success)!
export const personalAnswerInputSchema = agentAnswerSchema.omit({ type: true, threadId: true }).extend({ chatId: id }).strict()
const personalDecisionSchema = personalAnswerInputSchema.omit({ chatId: true }).extend({ id, questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), request: agentRequestSchema.optional(), createdAt: z.string(), status: z.enum(['submitting', 'accepted', 'uncertain', 'failed']), error: z.string().optional() })
export const personalDraftSchema = z.object({ revision, text: z.string().max(24000), skills: agentSkillReferencesSchema }).strict()
export const personalSubmissionSchema = personalDraftSchema.extend({ id, messageId: id, status: z.enum(['submitting', 'accepted', 'uncertain', 'failed']), createdAt: z.string(), error: z.string().optional() })
// Native transcript text is not a bounded command input. Preserve complete
// answers and their original identities through both storage and renderer IPC.
const personalMessageSchema = agentMessageSchema.extend({ text: z.string() })
export const personalChatSchema = agentThreadSchema.omit({ projectId: true, workingDirectory: true, worktree: true, workspaceSettledAt: true, providerId: true }).extend({
  kind: z.literal('personal'), providerId: z.literal('codex'), createdAt: z.string(), updatedAt: z.string(),
  nativeState: z.enum(['unstarted', 'starting', 'ready', 'uncertain', 'error']),
  messages: z.array(personalMessageSchema),
  draft: personalDraftSchema, submissions: z.array(personalSubmissionSchema), decisions: z.array(personalDecisionSchema).optional(),
})
export type PersonalChat = z.infer<typeof personalChatSchema>
export type PersonalDraft = z.infer<typeof personalDraftSchema>
export const personalChatStateSchema = z.object({
  selectedChatId: id.nullable(), chats: z.array(personalChatSchema), connected: z.boolean(), connecting: z.boolean(), error: z.string().optional(),
  availability: z.object({ provider: z.string(), supported: z.boolean(), reason: z.string().optional() }),
})
export type PersonalChatState = z.infer<typeof personalChatStateSchema>
export const personalDraftInputSchema = personalDraftSchema.extend({ chatId: id }).strict()
export const personalSendInputSchema = z.object({ chatId: id, revision }).strict()
export const personalChatCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create') }).strict(), z.object({ type: z.literal('connect') }).strict(), z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('select'), chatId: id.nullable() }).strict(),
  z.object({ type: z.literal('refresh'), chatId: id }).strict(), z.object({ type: z.literal('interrupt'), chatId: id }).strict(),
  personalDraftInputSchema.extend({ type: z.literal('draft') }).strict(), personalSendInputSchema.extend({ type: z.literal('send') }).strict(),
  personalAnswerInputSchema.extend({ type: z.literal('answer') }).strict(),
])
export type PersonalChatCommand = z.infer<typeof personalChatCommandSchema>
export const personalSkillsInputSchema = z.object({ chatId: id, forceReload: z.boolean().optional() }).strict()
export const PERSONAL_CHAT_GET = 'personal-chat:get'
export const PERSONAL_CHAT_COMMAND = 'personal-chat:command'
export const PERSONAL_CHAT_SKILLS = 'personal-chat:skills'
export const PERSONAL_CHAT_STATE = 'personal-chat:state'
export interface PersonalChatBridge {
  get(): Promise<PersonalChatState>
  create(): Promise<PersonalChatState>
  select(chatId: string | null): Promise<PersonalChatState>
  saveDraft(input: z.infer<typeof personalDraftInputSchema>): Promise<PersonalChatState>
  send(input: z.infer<typeof personalSendInputSchema>): Promise<PersonalChatState>
  skills(chatId: string, forceReload?: boolean): Promise<AgentSkillCatalog>
  refresh(chatId: string): Promise<PersonalChatState>
  interrupt(chatId: string): Promise<PersonalChatState>
  answer(input: z.infer<typeof personalAnswerInputSchema>): Promise<PersonalChatState>
  connect(): Promise<PersonalChatState>
  disconnect(): Promise<PersonalChatState>
  onState(listener: (state: PersonalChatState) => void): () => void
}

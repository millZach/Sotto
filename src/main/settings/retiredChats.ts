import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentCommandSchema, agentMessageSchema, agentRequestSchema, agentThreadSchema } from '../../shared/agents'
import { agentSkillReferencesSchema } from '../../shared/agentSkills'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

// The retired service's storage contract, kept private to local privacy cleanup.
// Parsing strips unknown fields as that service did; an invalid record never becomes an empty store.
const id = z.string().min(1).max(256)
const draftSchema = z.object({ revision: z.number().int().nonnegative(), text: z.string().max(24000), skills: agentSkillReferencesSchema }).strict()
const answerSchema = agentCommandSchema.options.find((option): option is Extract<typeof option, { shape: { type: z.ZodLiteral<'answer'> } }> => option.shape.type.safeParse('answer').success)!
const decisionSchema = answerSchema.omit({ type: true, threadId: true }).strict().extend({ id,
  questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), request: agentRequestSchema.optional(), createdAt: z.string(),
  status: z.enum(['submitting', 'accepted', 'uncertain', 'failed']), error: z.string().optional() })
const chatSchema = agentThreadSchema.omit({ projectId: true, workingDirectory: true, worktree: true, workspaceSettledAt: true, providerId: true }).extend({
  kind: z.literal('personal'), providerId: z.enum(['codex', 'claude', 'grok']), connected: z.boolean().optional(), createdAt: z.string(), updatedAt: z.string(),
  nativeState: z.enum(['unstarted', 'starting', 'ready', 'uncertain', 'error']), messages: z.array(agentMessageSchema.extend({ text: z.string() })),
  draft: draftSchema, submissions: z.array(draftSchema.extend({ id, messageId: id, status: z.enum(['submitting', 'accepted', 'uncertain', 'failed']), createdAt: z.string(), error: z.string().optional() })),
  decisions: z.array(decisionSchema).optional(),
})
const savedSchema = z.object({ selectedChatId: chatSchema.shape.id.nullable(), chats: z.array(chatSchema) })
  .refine(saved => new Set(saved.chats.map(chat => chat.id)).size === saved.chats.length, 'Personal chat IDs must be unique.')
type Saved = z.infer<typeof savedSchema>
const unreadable = 'Local history is off, but saved Chats could not be read safely. The original personal-chat/chats.json is unchanged. Repair that file and save Settings again.'
const failed = 'Local history is off, but saved Chats could not be cleared. Restore access to personal-chat/chats.json and save Settings again.'

/** Local files only. This owns no provider, replay, navigation or conversation operations. */
export class RetiredChatHistory {
  private readonly directory: string
  private readonly path: string
  private readonly store: Pick<AtomicJsonStore<Saved>, 'write'>
  private writing: Promise<unknown> = Promise.resolve()

  constructor(directory: string, private readonly historyEnabled: () => boolean, store?: Pick<AtomicJsonStore<Saved>, 'write'>) {
    this.directory = join(directory, 'personal-chat')
    this.path = join(this.directory, 'chats.json')
    this.store = store ?? new AtomicJsonStore(this.path, savedSchema.parse, () => ({ selectedChatId: null, chats: [] }))
  }

  privacyChanged(): Promise<void> {
    if (this.historyEnabled()) return Promise.resolve()
    const work = this.writing.catch(() => undefined).then(async () => {
      if (this.historyEnabled()) return
      let source: string
      try { source = await readFile(this.path, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error(unreadable, { cause: error }) }
      let saved: Saved
      try { saved = savedSchema.parse(JSON.parse(source)) } catch { throw new Error(unreadable) }
      for (const chat of saved.chats) {
        chat.messages = []; chat.requests = []; chat.title = 'Personal chat'; delete chat.activities
        for (const submission of chat.submissions) { submission.text = ''; submission.skills = [] }
        // Retain delivery identity, never the submitted answer, request, choice or diagnostic body.
        chat.decisions = chat.decisions?.map(({ id, requestId, questionsDigest, status, createdAt, error }) => ({
          id, requestId, status, createdAt, answer: '',
          ...(questionsDigest !== undefined ? { questionsDigest } : {}),
          ...(error !== undefined ? { error: 'Answer could not be confirmed. Local history is off.' } : {}),
        }))
      }
      if (this.historyEnabled()) return
      try {
        // No backup or default read: replace only a validated primary, atomically.
        if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(saved)) await this.store.write(savedSchema.parse(saved))
        // A killed atomic write can retain old content. Only this store's exact temporary names are removed,
        // after its primary has been read safely; native histories and other files remain provider-owned.
        for (const name of await readdir(this.directory)) {
          if (/^chats\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) await unlink(join(this.directory, name))
        }
      } catch { throw new Error(failed) }
    })
    this.writing = work
    return work
  }
}

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MAX_ACTIVITY_TEXT } from '../../shared/agentActivity'

/**
 * What a child agent `agy` launched is doing (parity slice 7), read from its records in Sotto's own Antigravity folder as
 * T3 Code reads them. `agy` 1.5 runs a child detached: its `invoke_subagent` call ends at once and the child works on
 * in a conversation of its own. Read live on 1.5.14 (November 21, 2026):
 *
 * - `brain/<parent>/.system_generated/subagents/<child>.json` names each child the parent launched, with its `state`.
 * - The child's own inbox, `brain/<child>/.system_generated/messages/<id>.json`, opens with the parent's launch, whose
 *   `sourceMetadata.tool.toolCall.id` is the parent's `invoke_subagent` tool call: the ID Sotto's row is keyed by.
 * - The child answers into the parent's inbox, `brain/<parent>/.system_generated/messages/<id>.json`, `sender` the
 *   child: its `content` is the child's result.
 *
 * A child is done once its answer is in the parent's inbox, and was stopped when its record says it was killed. Only
 * these records are read, each bounded, and nothing is ever written.
 */

/** Most children, and most messages in an inbox, read for one parent: past these the reader proves nothing. */
const MOST_FILES = 200
/** A record or message larger than this is not read. */
const MOST_BYTES = 256 * 1024
const conversationId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u)
const childRecordSchema = z.object({ conversationId, state: z.string().max(64).optional() }).passthrough()
const messageSchema = z.object({
  sender: z.string().max(64), content: z.string().optional(), timestamp: z.string().max(64).optional(),
  sourceMetadata: z.object({ tool: z.object({ toolCall: z.object({ id: z.string().max(512) }).passthrough() }).passthrough() }).passthrough().optional(),
}).passthrough()
type Message = z.infer<typeof messageSchema>

/** What Sotto knows of a child: the conversation it runs in, whether it is done, and its answer when it has one. */
export interface AntigravityChild {
  readonly conversationId: string
  readonly status: 'running' | 'completed' | 'interrupted'
  readonly message?: string
  readonly completedAt?: string
}

const generated = (appData: string, conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    if ((await stat(path)).size > MOST_BYTES) return undefined
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
async function jsonFiles(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith('.json')).slice(0, MOST_FILES).map(name => join(directory, name)) }
  catch { return [] }
}
async function messages(appData: string, conversation: string): Promise<Message[]> {
  const read = await Promise.all((await jsonFiles(generated(appData, conversation, 'messages'))).map(path => readJson(path, messageSchema)))
  return read.filter((message): message is Message => message !== undefined)
}

/**
 * The child that the parent's `invoke_subagent` tool call `toolCallId` launched, or undefined when the records do not
 * (yet) name one. `known` is the child's conversation once found, so a later read goes straight to it.
 */
export async function readAntigravityChild(appData: string, parent: string, toolCallId: string, known?: string): Promise<AntigravityChild | undefined> {
  if (!conversationId.safeParse(parent).success) return undefined
  const records = (await Promise.all((await jsonFiles(generated(appData, parent, 'subagents'))).map(path => readJson(path, childRecordSchema))))
    .filter((record): record is z.infer<typeof childRecordSchema> => record !== undefined)
  let record = known ? records.find(item => item.conversationId === known) : undefined
  if (!record) {
    for (const candidate of records) {
      const launches = await messages(appData, candidate.conversationId)
      if (launches.some(message => message.sender === parent && message.sourceMetadata?.tool.toolCall.id === toolCallId)) { record = candidate; break }
    }
  }
  if (!record) return undefined
  const answers = (await messages(appData, parent)).filter(message => message.sender === record.conversationId && message.content !== undefined)
    .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  const answer = answers.at(-1)
  if (answer) {
    return { conversationId: record.conversationId, status: 'completed', message: answer.content!.slice(0, MAX_ACTIVITY_TEXT),
      ...(answer.timestamp && !Number.isNaN(Date.parse(answer.timestamp)) ? { completedAt: new Date(answer.timestamp).toISOString() } : {}) }
  }
  return { conversationId: record.conversationId, status: /KILL|CANCEL|TERMINAT/iu.test(record.state ?? '') ? 'interrupted' : 'running' }
}

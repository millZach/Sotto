import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
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
 * these records are read: plain files, each bounded, in folders whose real path is inside `brain`, so a link never
 * leads a read anywhere else, `agy`'s sign-in among them (ADR-0212's amendment). Nothing is ever written.
 */

/** Most records or messages read in one pass; the rest are read in the next, so none is hidden past a cut. */
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

/**
 * What one watch has learned so far, so each read does only new work: the child's conversation once found, the
 * children ruled out because their launch named another tool call, and the parent's inbox files already read.
 */
export interface AntigravityChildReading { childConversation?: string; readonly ruledOut: Set<string>; readonly readAnswers: Set<string> }
export const antigravityChildReading = (): AntigravityChildReading => ({ ruledOut: new Set(), readAnswers: new Set() })

const generated = (appData: string, conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)

/** The `.json` files in a folder inside `brain`, by name, or none when its real path leads elsewhere. */
async function jsonNames(brain: string, directory: string): Promise<string[]> {
  try {
    const real = await realpath(directory), within = relative(brain, real)
    if (!within || within.startsWith('..') || isAbsolute(within)) return []
    return (await readdir(real)).filter(name => name.endsWith('.json'))
  } catch { return [] }
}
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MOST_BYTES) return undefined
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}
async function messages(directory: string, names: readonly string[]): Promise<Message[]> {
  const read = await Promise.all(names.map(name => readJson(join(directory, name), messageSchema)))
  return read.filter((message): message is Message => message !== undefined)
}

/**
 * The child that the parent's `invoke_subagent` tool call `toolCallId` launched, or undefined when the records do not
 * (yet) name one. `reading` carries what earlier reads of the same watch learned.
 */
export async function readAntigravityChild(appData: string, parent: string, toolCallId: string, reading: AntigravityChildReading = antigravityChildReading()): Promise<AntigravityChild | undefined> {
  if (!conversationId.safeParse(parent).success) return undefined
  let brain: string
  try { brain = await realpath(join(appData, 'brain')) } catch { return undefined }
  const recordsAt = generated(appData, parent, 'subagents')
  const records = (await Promise.all((await jsonNames(brain, recordsAt)).filter(name => !reading.ruledOut.has(name.slice(0, -'.json'.length))).slice(0, MOST_FILES)
    .map(name => readJson(join(recordsAt, name), childRecordSchema))))
    .filter((record): record is z.infer<typeof childRecordSchema> => record !== undefined)
  let record = reading.childConversation ? records.find(item => item.conversationId === reading.childConversation) : undefined
  if (!record) {
    for (const candidate of records) {
      if (reading.ruledOut.has(candidate.conversationId)) continue
      const inbox = generated(appData, candidate.conversationId, 'messages')
      const launches = (await messages(inbox, (await jsonNames(brain, inbox)).slice(0, MOST_FILES))).filter(message => message.sender === parent && message.sourceMetadata)
      if (launches.some(message => message.sourceMetadata!.tool.toolCall.id === toolCallId)) { record = candidate; break }
      // Ruled out only once its launch names another call: a child whose launch is not written yet is read again.
      if (launches.length) reading.ruledOut.add(candidate.conversationId)
    }
  }
  if (!record) return undefined
  reading.childConversation = record.conversationId
  const inbox = generated(appData, parent, 'messages')
  const unread = (await jsonNames(brain, inbox)).filter(name => !reading.readAnswers.has(name)).slice(0, MOST_FILES)
  for (const name of unread) reading.readAnswers.add(name)
  const answers = (await messages(inbox, unread)).filter(message => message.sender === record.conversationId && message.content !== undefined)
    .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  const answer = answers.at(-1)
  if (answer) {
    return { conversationId: record.conversationId, status: 'completed', message: answer.content!.slice(0, MAX_ACTIVITY_TEXT),
      ...(answer.timestamp && !Number.isNaN(Date.parse(answer.timestamp)) ? { completedAt: new Date(answer.timestamp).toISOString() } : {}) }
  }
  return { conversationId: record.conversationId, status: /KILL|CANCEL|TERMINAT/iu.test(record.state ?? '') ? 'interrupted' : 'running' }
}

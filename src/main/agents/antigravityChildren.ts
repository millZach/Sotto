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
 * leads a read anywhere else, `agy`'s sign-in among them (ADR-0212's amendment). Nothing is ever written. Every file a
 * pass reads is taken from one budget the pass shares across all its watches, and what a pass did not reach is read in
 * the next, so no pass reads more than its budget however many children and messages there are.
 */

/** Files one pass reads across all its watches, when the caller gives no budget of its own. */
export const CHILD_PASS_FILES = 200
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
  readonly status: 'running' | 'completed' | 'interrupted' | 'unknown'
  readonly message?: string
  readonly completedAt?: string
}

/**
 * What one watch has learned so far, so each read does only new work: the child's conversation once found, the
 * children ruled out because their launch named another call, where the search for the child goes on from, and the
 * parent's inbox files already read whole.
 */
export interface AntigravityChildReading { childConversation?: string; readonly ruledOut: Set<string>; readonly readAnswers: Set<string>; resumeAt?: string | undefined }
export const antigravityChildReading = (): AntigravityChildReading => ({ ruledOut: new Set(), readAnswers: new Set() })
/** The files a pass may still read, shared by every watch the pass reads. */
export interface AntigravityReadBudget { left: number }

const generated = (appData: string, conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)

/** The `.json` files in a folder inside `brain`, by name in order, or none when its real path leads elsewhere. */
async function jsonNames(brain: string, directory: string): Promise<string[]> {
  try {
    const real = await realpath(directory), within = relative(brain, real)
    if (!within || within.startsWith('..') || isAbsolute(within)) return []
    return (await readdir(real)).filter(name => name.endsWith('.json')).sort()
  } catch { return [] }
}
/** One file read from the budget: undefined when the budget is spent, or the file is not a plain, readable, valid one. */
async function readJson<T>(path: string, schema: z.ZodType<T>, budget: AntigravityReadBudget): Promise<T | undefined> {
  if (budget.left <= 0) return undefined
  budget.left--
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MOST_BYTES) return undefined
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

/**
 * The child that the parent's `invoke_subagent` tool call `toolCallId` launched, or undefined when the records do not
 * (yet) name one or the budget ran out before they did. `reading` carries what earlier passes of the same watch learned.
 */
export async function readAntigravityChild(appData: string, parent: string, toolCallId: string, reading: AntigravityChildReading = antigravityChildReading(),
  budget: AntigravityReadBudget = { left: CHILD_PASS_FILES }): Promise<AntigravityChild | undefined> {
  if (!conversationId.safeParse(parent).success) return undefined
  let brain: string
  try { brain = await realpath(join(appData, 'brain')) } catch { return undefined }
  if (!reading.childConversation) {
    // A child's record is named for its conversation, so the candidates are known without reading a record.
    const candidates = (await jsonNames(brain, generated(appData, parent, 'subagents'))).map(name => name.slice(0, -'.json'.length))
      .filter(name => conversationId.safeParse(name).success && !reading.ruledOut.has(name))
    // The search goes on from the child it reached last, by name: the list shrinks as children are ruled out.
    const from = Math.max(0, reading.resumeAt === undefined ? 0 : candidates.findIndex(name => name >= reading.resumeAt!))
    for (let step = 0; step < candidates.length && !reading.childConversation; step++) {
      const at = (from + step) % candidates.length, candidate = candidates[at]!, inbox = generated(appData, candidate, 'messages')
      let launched = false, complete = true
      for (const name of await jsonNames(brain, inbox)) {
        if (budget.left <= 0) { complete = false; break }
        const message = await readJson(join(inbox, name), messageSchema, budget)
        if (message?.sender !== parent || !message.sourceMetadata) continue
        launched = true
        if (message.sourceMetadata.tool.toolCall.id === toolCallId) { reading.childConversation = candidate; break }
      }
      if (reading.childConversation) break
      // The search goes on from here next pass, so a later child is reached however the earlier ones stand.
      if (!complete) { reading.resumeAt = candidate; return undefined }
      // Ruled out only once its launch names another call: a child whose launch is not written yet is read again.
      if (launched) reading.ruledOut.add(candidate)
      reading.resumeAt = candidates[(at + 1) % candidates.length]
    }
    if (!reading.childConversation) return undefined
  }
  const child = reading.childConversation
  const record = await readJson(generated(appData, parent, 'subagents', `${child}.json`), childRecordSchema, budget)
  const inbox = generated(appData, parent, 'messages'), answers: Message[] = []
  for (const name of (await jsonNames(brain, inbox)).filter(item => !reading.readAnswers.has(item))) {
    if (budget.left <= 0) break
    const message = await readJson(join(inbox, name), messageSchema, budget)
    // Counted as read only once read whole: a file `agy` is still writing is read again next pass.
    if (!message) continue
    reading.readAnswers.add(name)
    if (message.sender === child && message.content !== undefined) answers.push(message)
  }
  const answer = answers.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1)
  if (answer) {
    return { conversationId: child, status: 'completed', message: answer.content!.slice(0, MAX_ACTIVITY_TEXT),
      ...(answer.timestamp && !Number.isNaN(Date.parse(answer.timestamp)) ? { completedAt: new Date(answer.timestamp).toISOString() } : {}) }
  }
  return { conversationId: child, status: /KILL|CANCEL|TERMINAT/iu.test(record?.state ?? '') ? 'interrupted' : 'running' }
}

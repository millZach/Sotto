import { z } from 'zod'
import { ASK_COUNCIL_TOOL, askCouncilInputSchema, COUNCIL_MCP_SERVER, namesCouncil, READ_COUNCIL_TOOL, readCouncilInputSchema, START_CLIMB_TOOL, startClimbInputSchema,
  type AskCouncilInput, type CouncilUserMessage, type StartClimbInput } from '../../shared/councilTools'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const schema = (input: z.ZodType): Record<string, unknown> => z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
const ONLY_WHEN_ASKED = 'Call it only when the user\'s own newest message in this thread asks for the Council: Sotto reads that message from its own record and refuses the call when it does not name the Council. Never call it on your own judgement, for a wake-up or for a brief from another thread.'
const WAKE_UP = 'It returns at once. Sotto sends this thread a message with the result when it is ready, tagged as the Council\'s: end your turn or carry on, and do not poll.'

export const COUNCIL_TOOL_DEFINITIONS: readonly ThreadToolDefinition[] = [
  { name: ASK_COUNCIL_TOOL, inputSchema: schema(askCouncilInputSchema), description: [
    'Ask Sotto\'s Council a question or a review about this thread\'s work: two to five panelists on several providers answer alone, review each other\'s answers anonymously, and a chair writes a verdict that keeps their disagreements.',
    ONLY_WHEN_ASKED,
    'The seats are the user\'s own, from Settings → Council; you choose only the question. The Council reads this whole conversation and works in a snapshot of this thread\'s folder, and the user watches it in the Council tab under this thread.',
    `${WAKE_UP} The verdict comes once its fairness check is done, which takes many minutes. One message from the user starts one Council.`,
  ].join(' '), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: START_CLIMB_TOOL, inputSchema: schema(startClimbInputSchema), description: [
    'Start a Council Climb with this thread as the builder: fresh read-only judges score the selected work against a rubric, and Sotto sends this thread a fix brief after each round until the target or a limit is met.',
    'Call it only when the user\'s own newest message in this thread asks for a Climb or the Council: Sotto reads that message from its own record and refuses the call when it does not name the Council or a Climb.',
    'It starts only the setup: a chair proposes the rubric, and nothing is judged and no brief is sent until the user approves the whole setup in the Council tab under this thread. Tell the user to approve it there. Judges are Claude or Codex models from Settings → Council.',
    'Sotto sends this thread a message when the Climb ends. Fix briefs arrive as messages tagged as the Council\'s; work on them as the builder.',
  ].join(' '), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: READ_COUNCIL_TOOL, inputSchema: schema(readCouncilInputSchema), description:
    'Read the Councils and Climbs this thread started: where each stands, and once a Council\'s verdict is ready, the verdict with Sotto\'s table of who sat and its counts. Reading charges nothing and starts nothing.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
]
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const INSTRUCTIONS = `${ASK_COUNCIL_TOOL} puts a question or a review to Sotto's Council of models on several providers, and ${START_CLIMB_TOOL} starts a Council Climb's setup with this thread as the builder. Use them only when the user's own message asks for the Council: Sotto refuses a call the user did not ask for. Each returns at once, and Sotto sends this thread the verdict, or how a Climb ended, as a message tagged as the Council's when it is ready; the user is shown it too. ${READ_COUNCIL_TOOL} reads where one stands. Where tools are found by search and called through use_tool, call them by their full names, such as ${COUNCIL_MCP_SERVER}__${ASK_COUNCIL_TOOL}.`

type Started = { readonly ok: true; readonly council?: string; readonly climb?: string } | { readonly ok: false; readonly message: string }
/** What the tools ask of Sotto for the thread that called. */
export interface CouncilToolHandlers {
  /** An ordinary thread on this computer, on a provider that takes Sotto's tools: not Watcher, a Council's own seat or a delegated thread. */
  admits(threadId: string): boolean
  /** The user's own newest message in the thread, from Sotto's record, when that newest message is the user's and not Sotto's, Watcher's or a brief. */
  userMessage(threadId: string): Promise<CouncilUserMessage | undefined>
  ask(threadId: string, input: AskCouncilInput, user: CouncilUserMessage): Promise<Started>
  climb(threadId: string, input: StartClimbInput, user: CouncilUserMessage): Promise<Started>
  read(threadId: string, council: string | undefined): Record<string, unknown>
}

const NOTHING = 'Nothing was started.'
export const NOT_ASKED = `The user's own newest message in this thread does not ask for the Council, so Sotto refused this. ${NOTHING} Do the work yourself, or tell the user they can ask for the Council.`

/**
 * `sotto_council`: the loopback MCP server through which an agent in an ordinary thread on this computer asks Sotto's
 * Council, or starts a Climb's setup, when the user's own message asks it to (ADR-0177, amendment of November 5, 2026).
 * The caller is known by its token, so a thread asks only from itself. The user's message is the gate, read from Sotto's
 * record on every call; what the agent writes never is.
 */
export class CouncilToolServer implements ScopedThreadTools {
  readonly name = COUNCIL_MCP_SERVER
  readonly definitions = COUNCIL_TOOL_DEFINITIONS
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: CouncilToolHandlers) {
    this.server = new ThreadToolServer({ name: COUNCIL_MCP_SERVER, serverName: 'sotto-council', instructions: INSTRUCTIONS,
      unavailable: `Sotto's Council tools are unavailable. ${NOTHING}`, failed: `Sotto could not complete this Council call. Call ${READ_COUNCIL_TOOL} to see whether anything started before trying again.`,
      maxRequestBytes: 256 * 1024 },
    this.definitions, (threadId, name, args) => this.invoke(threadId, name, args))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    return this.admits(threadId) ? this.server.mcpServer(threadId) : undefined
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  revoke(threadId: string): void { this.server.revoke(threadId) }
  close(): Promise<void> { return this.server.close() }
  private admits(threadId: string): boolean {
    try { return this.handlers.admits(threadId) } catch { return false }
  }
  private async invoke(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> {
    const answer = (result: Record<string, unknown>): ThreadToolResult => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
      ...result['status'] === 'refused' ? { isError: true } : {} })
    const refused = (message: string): ThreadToolResult => answer({ status: 'refused', message })
    if (!this.admits(threadId)) return refused(`This thread cannot ask the Council: only an ordinary thread on this computer can, not Watcher, a Council's own thread or a delegated thread. ${NOTHING}`)
    if (name === READ_COUNCIL_TOOL) {
      const input = readCouncilInputSchema.safeParse(args ?? {})
      return input.success ? answer(this.handlers.read(threadId, input.data.council)) : refused('Name a Council by the ID it was started with, or leave council out to list them.')
    }
    const climb = name === START_CLIMB_TOOL
    const input = climb ? startClimbInputSchema.safeParse(args) : askCouncilInputSchema.safeParse(args)
    if (!input.success) return refused(climb ? `Give the Climb a goal, and its evidence as paths inside this thread's folder. ${NOTHING}` : `Give the Council its question. ${NOTHING}`)
    const user = await this.handlers.userMessage(threadId)
    if (!user || !namesCouncil(user.text) && !(climb && /\bclimb\b/iu.test(user.text))) return refused(NOT_ASKED)
    const started = climb ? await this.handlers.climb(threadId, input.data as StartClimbInput, user) : await this.handlers.ask(threadId, input.data as AskCouncilInput, user)
    if (!started.ok) return refused(started.message)
    return climb
      ? answer({ status: 'started', council: started.climb, waiting: 'The Climb\'s chair is proposing a rubric. Nothing is judged and no fix brief comes until the user approves the setup in the Council tab under this thread. Tell the user so. Sotto sends this thread a message when the Climb ends.' })
      : answer({ status: 'started', council: started.council, waiting: `The Council is working; the user can watch it in the Council tab under this thread. Sotto sends this thread its verdict as a message once the fairness check is done, which takes many minutes. Tell the user you asked it, then end your turn or carry on; do not poll. ${READ_COUNCIL_TOOL} reads where it stands.` })
  }
}

type StoredMessage = { readonly id: string; readonly role: string; readonly text: string; readonly wakeUp?: boolean | undefined }
/**
 * The user's own newest message in a thread, read from Sotto's record (ADR-0177, November 5, 2026): the thread's newest
 * user message, when it is not Sotto's (a wake-up, a Council's prompt or verdict, a delegation's brief), not Watcher's
 * and not a handover's. Undefined otherwise, so a turn Sotto or Watcher began can never ask the Council.
 */
export function councilUserMessage(thread: { readonly id: string; readonly lastUserMessageId?: string | null | undefined; readonly wakeUpMessageIds?: readonly string[] | undefined
  readonly messages: readonly { readonly id: string; readonly role: string; readonly text: string; readonly wakeUp?: boolean | undefined }[]
  readonly startedFrom?: { readonly handover?: { readonly sent?: { readonly messageId: string } | undefined } | undefined } | undefined },
stored: { readonly message: (messageId: string) => StoredMessage | undefined; readonly newest: () => readonly StoredMessage[] }, machine: (messageId: string) => boolean): CouncilUserMessage | undefined {
  // The provider's newest user message, read by its ID; the history is read whole only when no ID names it.
  const head = thread.lastUserMessageId ?? undefined
  const message = head ? thread.messages.find(item => item.id === head) ?? stored.message(head)
    : thread.messages.findLast(item => item.role === 'user') ?? stored.newest().findLast(item => item.role === 'user')
  if (!message || message.role !== 'user' || message.wakeUp === true || thread.wakeUpMessageIds?.includes(message.id) === true
    || thread.startedFrom?.handover?.sent?.messageId === message.id || machine(message.id)) return undefined
  return { id: message.id, text: message.text }
}

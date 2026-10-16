import { AGENT_TEXT_MAX, PROVIDER_LABELS, type AgentCommand, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread,
  type ThreadContinuedFrom, type ThreadContinuedIn } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { CONTINUE_HANDOVER_CLOSE, CONTINUE_REFUSALS, continueProviderRefusal, continueReadRequestSchema, continueStartRequestSchema,
  continueThreadRefusal, type ContinueRead, type ContinueStart, type ContinueWorkingCopy } from '../../shared/continueThread'
import { HANDOVER_LEAD } from '../../shared/handover'
import { resolveModel } from '../../shared/modelCatalog'
import type { Handover } from './handover'
import { handoverCounts, handoverPrefix, handoverPrefixProof, splitHandover, type HandoverSplitProof } from './watcherHandover'

/**
 * Continuing a thread on another provider (ADR-0088, #1027). Sotto never moves a started thread between providers
 * (ADR-0002); it makes a new **continued thread** with its own Sotto thread ID, in the same project and, by default, the
 * same folder, on the provider and model the user chose, and keeps the source's title. Its first message is the
 * handover of the source (E3's, `handover.ts`) ahead of the user's own words, as one message, so no turn is spent on an
 * acknowledgement. The continued thread records the handover's length and digest, never its words, and every copy
 * shows the two apart by that record. Each thread's record links to the other, so the links survive a restart, and the
 * source stays as it was: readable, and sendable once its provider takes prompts again.
 *
 * The Owl list's answer decides whether this exists at all (ADR-0072): stable builds no service, registers no bridge,
 * and shows its saved records as they are. Only this computer's threads continue for now.
 */

/** What continuing asks of main's coordinator: its threads as they are, the user's own commands, and the display hook. */
export interface ContinueCoordinator {
  hostId(): string | undefined
  /** The host as the coordinator holds it, read in place and never copied. */
  watcherSnapshot(): AgentHostSnapshot
  /** The user's own command, as the window would send it: creating the continued thread and sending its first message. */
  commandShell(command: AgentCommand): Promise<AgentState>
  /** How a continued thread's messages are shown, asked only for a thread a window or phone is reading. Returns the unhook. */
  useContinuationDisplay(display: (thread: AgentThread) => readonly AgentMessage[]): () => void
}
/** What continuing asks of the host's workspace: a thread's handover, and the links on each thread's own record. */
export interface ContinueHost {
  threadHandover(threadId: string): Handover | undefined
  setContinuedFrom(threadId: string, from: ThreadContinuedFrom): Promise<void>
  addContinuedIn(threadId: string, link: ThreadContinuedIn): Promise<void>
  watcherCreationPhase(threadId: string): 'unstarted' | 'starting' | 'retryable' | 'started' | undefined
}

/** What goes ahead of the user's words in a continued thread's first message. */
export function continuePrefix(handover: string): string {
  return handoverPrefix(handover, CONTINUE_HANDOVER_CLOSE)
}

function proofOf(thread: Pick<AgentThread, 'continuedFrom'>): (HandoverSplitProof & { readonly key: string }) | undefined {
  const from = thread.continuedFrom
  const proof = from?.handover
  return from && proof ? { ...proof, provider: from.provider, key: `${proof.prefixLength}:${proof.prefixDigest}` } : undefined
}
/** Each provider message split once per proof, so a detail read again reuses the copy it made. */
const splitCopies = new WeakMap<AgentMessage, { readonly key: string; readonly text: string; readonly shown: AgentMessage }>()
function splitOne(message: AgentMessage, proof: HandoverSplitProof & { readonly key: string }): AgentMessage {
  // Only a user message that begins as a handover does and is long enough is looked at; its digest decides.
  if (message.role !== 'user' || message.handover !== undefined || message.text.length < proof.prefixLength || !message.text.startsWith(HANDOVER_LEAD)) return message
  const cached = splitCopies.get(message)
  if (cached?.key === proof.key && cached.text === message.text) return cached.shown
  const shown = splitHandover(message, proof)
  splitCopies.set(message, { key: proof.key, text: message.text, shown })
  return shown
}
/** Each thread's message list shown once per proof, while it holds the same messages. */
const shownLists = new WeakMap<readonly AgentMessage[], { readonly key: string; readonly length: number; readonly last: AgentMessage | undefined; readonly shown: readonly AgentMessage[] }>()

/**
 * A continued thread's messages as every copy shows them, its pane, Copy and the phone alike: the first message is the
 * user's words, with the handover that went ahead of them beside them as Sotto's. Only a message whose recorded
 * characters still match their digest is split; anything else is shown whole. Asked only for a thread something is
 * reading, never for every thread on every publish.
 */
export function continuedMessagesShown(thread: Pick<AgentThread, 'continuedFrom' | 'messages'>): readonly AgentMessage[] {
  const proof = proofOf(thread)
  if (proof === undefined || thread.messages.length === 0) return thread.messages
  const held = shownLists.get(thread.messages)
  if (held?.key === proof.key && held.length === thread.messages.length && held.last === thread.messages.at(-1)) return held.shown
  let changed = false
  const split = thread.messages.map(message => { const shown = splitOne(message, proof); if (shown !== message) changed = true; return shown })
  const shown = changed ? split : thread.messages
  shownLists.set(thread.messages, { key: proof.key, length: thread.messages.length, last: thread.messages.at(-1), shown })
  return shown
}

/**
 * One message of a continued thread as a handover of that thread carries it: the user's words alone. A handover of a
 * handover would only repeat an older thread, so a thread continued twice carries the words its own first message said.
 */
export function continuedWordsOnly(thread: Pick<AgentThread, 'continuedFrom'>, message: AgentMessage): AgentMessage {
  const proof = proofOf(thread)
  if (proof === undefined) return message
  const shown = splitOne(message, proof)
  if (shown.handover === undefined) return shown
  const { handover: _handover, ...words } = shown
  void _handover
  return words
}

/** The user's words in a prompt a continued thread sent, for what is named from them (its branch); otherwise the prompt. */
export function continuedPromptWords(thread: Pick<AgentThread, 'continuedFrom'>, prompt: string): string {
  const proof = proofOf(thread)
  if (proof === undefined || prompt.length < proof.prefixLength) return prompt
  return handoverPrefixProof(prompt.slice(0, proof.prefixLength)).prefixDigest === proof.prefixDigest ? prompt.slice(proof.prefixLength) : prompt
}

const MESSAGE_MAX = 600
const refused = (message: string): { readonly status: 'refused'; readonly message: string } =>
  ({ status: 'refused', message: message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message })
const UNREADABLE = 'Sotto could not read this thread’s history, so nothing was sent. Try again.'
const UNREAD_REQUEST = 'Sotto could not read that request. Nothing was sent.'
const GONE = 'This thread is no longer here. Nothing was sent.'

class Refusal extends Error {}
function refuse(message: string): never { throw new Refusal(message) }

export class ContinueService {
  private readonly unhook: () => void
  /** The threads being continued now, one continuation at a time for each. */
  private readonly continuing = new Set<string>()
  constructor(private readonly options: { readonly control: ContinueCoordinator; readonly host: ContinueHost }) {
    this.unhook = options.control.useContinuationDisplay(continuedMessagesShown)
  }
  close(): void { this.unhook() }

  /** What continuing this thread would hand over now: its counts, and its words when the user asks to read them. */
  read(input: unknown): ContinueRead {
    try {
      const parsed = continueReadRequestSchema.safeParse(input)
      if (!parsed.success) refuse(UNREAD_REQUEST)
      const source = this.source(parsed.data.threadId)
      const refusal = continueThreadRefusal(source)
      if (refusal !== null && refusal !== CONTINUE_REFUSALS.busy) refuse(refusal)
      const handover = this.handover(source.id)
      return { status: 'ok', counts: handoverCounts(handover.summary), ...(parsed.data.words === true ? { text: continuePrefix(handover.text).trimEnd() } : {}) }
    } catch (error) { return refused(error instanceof Refusal ? error.message : UNREADABLE) }
  }

  /**
   * Makes the continued thread and sends its first message: the handover of the source, then the user's words. A retry
   * after a refusal names the same new thread, which is used again while nothing has started in it. Main checks every
   * refusal the window draws again here, since the thread may have moved on since the window drew it.
   */
  async start(input: unknown): Promise<ContinueStart> {
    const parsed = continueStartRequestSchema.safeParse(input)
    if (!parsed.success) return refused(UNREAD_REQUEST)
    const request = parsed.data
    let sourceId: string | undefined
    try {
      const source = this.source(request.threadId)
      sourceId = source.id
      if (this.continuing.has(source.id)) refuse('This thread is already being continued. Wait for the new thread to start.')
      this.continuing.add(source.id)
      const refusal = continueThreadRefusal(source)
      if (refusal !== null) refuse(refusal)
      const snapshot = this.options.control.watcherSnapshot()
      const model = resolveModel(snapshot.models, request.modelId)
      if (model?.providerId === undefined || !model.ready) refuse('That model isn’t available now, so nothing was sent. Choose another model, then continue.')
      if (model.providerId === source.providerId) refuse(`This thread is already on ${PROVIDER_LABELS[model.providerId]}. Choose a model from another provider to continue there.`)
      const providerRefusal = continueProviderRefusal(snapshot, model.providerId)
      if (providerRefusal !== null) refuse(providerRefusal)
      const existing = snapshot.threads.find(thread => thread.id === request.newThreadId)
      if (existing && (existing.continuedFrom?.threadId !== source.id || this.options.host.watcherCreationPhase(existing.id) === 'started')) {
        refuse('That continued thread has started already, so nothing more was sent. Open it to carry on there.')
      }
      const handover = this.handover(source.id)
      const prefix = continuePrefix(handover.text)
      if (prefix.length + request.text.length > AGENT_TEXT_MAX) refuse('Your message and the handover together are too long to send. Shorten your message, then continue. Nothing was sent.')
      if (!existing) {
        const created = await this.options.control.commandShell({ type: 'create-thread', projectId: source.projectId, title: source.title, modelId: model.id,
          threadId: request.newThreadId, ...(source.titleSource === 'user' ? { titleSource: 'user' as const } : {}),
          ...workingCopyOf(source, request.workingCopy),
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          ...(request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}),
          ...(request.providerMode ? { providerMode: request.providerMode } : {}) })
        if (created.error) refuse(created.error)
      } else if (existing.modelId !== model.id || request.reasoningEffort !== undefined && existing.reasoningEffort !== request.reasoningEffort
        || request.runtimeMode !== undefined && existing.runtimeMode !== request.runtimeMode || request.providerMode !== undefined && existing.providerMode !== request.providerMode) {
        // A retry after a refusal, on another choice: the thread nothing was sent to takes it, as an unstarted thread does.
        const configured = await this.options.control.commandShell({ type: 'configure-thread', threadId: existing.id, modelId: model.id,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}), ...(request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}),
          ...(request.providerMode ? { providerMode: request.providerMode } : {}) })
        if (configured.error) refuse(configured.error)
      }
      const at = new Date().toISOString()
      await this.options.host.setContinuedFrom(request.newThreadId, { threadId: source.id, provider: source.providerId!, at,
        handover: { ...handoverPrefixProof(prefix), counts: handoverCounts(handover.summary) } })
      const sent = await this.options.control.commandShell({ type: 'manual-send', threadId: request.newThreadId, draftId: request.draftId, text: prefix + request.text,
        ...(request.attachments?.length ? { attachments: request.attachments } : {}), ...(request.files?.length ? { files: request.files } : {}) })
      // A send whose result the provider never gave may have gone, so the link is made for it as for one it took.
      const delivery = sent.deliveries?.find(item => item.threadId === request.newThreadId && item.draftId === request.draftId)?.status
      const went = delivery === 'accepted' || delivery === 'uncertain' || delivery === 'submitting'
        || sent.deliveredDrafts?.some(item => item.threadId === request.newThreadId && item.draftId === request.draftId) === true
      if (!went) refuse(sent.error ?? `${PROVIDER_LABELS[model.providerId]} didn’t take the first message, so nothing was sent. Check it under Settings → Providers, then continue again.`)
      await this.options.host.addContinuedIn(source.id, { threadId: request.newThreadId, provider: model.providerId, at })
      return { status: 'ok', threadId: hostEntityKey(this.options.control.hostId(), request.newThreadId) }
    } catch (error) {
      return refused(error instanceof Refusal ? error.message : error instanceof Error ? error.message : 'Sotto could not continue this thread. Nothing was sent. Try again.')
    } finally {
      if (sourceId !== undefined) this.continuing.delete(sourceId)
    }
  }

  /** The thread a window names, when it is one of this computer's threads. */
  private source(windowId: string): AgentThread {
    const key = parseHostEntityKey(windowId)
    if (key && key.hostId !== this.options.control.hostId()) refuse(CONTINUE_REFUSALS.remote)
    const id = key?.id ?? windowId
    const thread = this.options.control.watcherSnapshot().threads.find(item => item.id === id)
    if (!thread?.providerId) refuse(GONE)
    return thread
  }
  private handover(threadId: string): Handover {
    let handover: Handover | undefined
    try { handover = this.options.host.threadHandover(threadId) } catch { handover = undefined }
    if (handover === undefined) refuse(UNREADABLE)
    if (handover.summary.total === 0) refuse(CONTINUE_REFUSALS.empty)
    return handover
  }
}

/**
 * Where the continued thread works. The same folder is the source's own: its project folder, or the worktree it works
 * in, used again rather than copied. A new worktree is made from the branch the source is on.
 */
function workingCopyOf(source: AgentThread, choice: ContinueWorkingCopy): Pick<Extract<AgentCommand, { type: 'create-thread' }>, 'workingCopy' | 'baseBranch' | 'existingWorktreePath'> {
  const worktree = source.worktree
  if (choice === 'new-worktree') {
    const branch = worktree?.branch ?? worktree?.git?.branch ?? undefined
    if (!branch) refuse('This thread’s folder has no branch to start a new worktree from. Continue in the same folder instead.')
    return { workingCopy: 'independent', baseBranch: branch }
  }
  if (worktree?.mode === 'independent') {
    const path = worktree.path ?? worktree.existingWorktreePath
    if (!path || worktree.reclaimedAt) refuse('This thread’s worktree folder was put away. Send to this thread once to bring it back, or continue in a new worktree.')
    return { workingCopy: 'independent', existingWorktreePath: path }
  }
  return { workingCopy: 'shared' }
}

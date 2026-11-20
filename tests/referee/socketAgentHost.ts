// An `AgentHost` that speaks to a host over its socket, so `tests/integration/adapterContract.ts` can be pointed at a host
// started by a command line, a host in another language among them (docs/plans/2026-11-14-rust-native-port.md, Stage 0
// item 3). It is a client of the host as the desktop's own is (`src/main/agents/socketHostService.ts`): it says hello with
// the desktop's list, holds the shell and the observed threads' details as the pushes leave them (`fold.ts`), takes a
// command's answer as the state it shows, and sends only what `src/host/remoteCommands.ts` takes from a paired client.
//
// The socket is the coordinator's boundary, not the adapter's, so each adapter command is sent as the client command that
// does the same thing, and what comes back is read the way a client reads it:
//
// - A thread's ID is the client's own (`create-thread` takes one). A project's is the host's, so the one the contract named
//   is kept beside the host's and given back in what the contract reads.
// - A send names no message ID on the wire: the host makes one. The send goes as `manual-send` with a draft ID of its own,
//   the host's delivery record for that draft names the message it made, and that message is given back under the ID the
//   contract chose. The delivery's status is the send's result: `accepted`, or `uncertain` for an acknowledgement the
//   provider never gave.
// - Attached files and images are staged first (`stage-file-part`, `stage-attachment`), and their handles given back under
//   the contract's IDs.
// - A thread's messages are the detail the host pushes for an observed thread; the shell carries none.
//
// Whatever needs a seam inside the host (a stopwatch lent to a send, an in-process subscriber, a side call's prompt) has no
// form on the wire, so this host does not offer it, and the cases that need one are named where the contract is run
// across the socket (`tests/referee/socketFixture.ts`).
import { createHash, randomUUID } from 'node:crypto'
import type { AgentHost, AgentHostCommand, AgentHostResult, PromptImage, ThreadHostEvent } from '../../src/main/agents/host'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { ClientFold } from './fold'
import { deliveriesSettled, lanesIdle, started } from './scenario'
import type { RefereeProvider } from './providers'
import { DESKTOP_DEFLATE_OFFER, openSocket, type Socket } from './wire'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A copy of `value` without `keys`. */
const without = (value: object, ...keys: string[]): Json => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

/** The desktop's hello, from the first retained event on, so every event the host publishes reaches `subscribeEvents`. */
const HELLO_ACCEPTS = ['client-liveness', 'detail-delta', 'message-aliases', 'answer-receipts', 'model-catalog-revision', 'activity-bodies',
  'changed-thread-records', 'kept-parts', 'provider-opencode', 'provider-cursor']

/**
 * Deadline for a host to answer one request, or to show what a wait names: generous, since a deadline never reached costs
 * nothing, and half a case's own, so a host that never gets there fails with the sentence rather than the case's timeout.
 */
const ANSWER_DEADLINE_MS = 30_000

export class SocketAgentHost implements AgentHost {
  private readonly fold = new ClientFold()
  /**
   * The shell the client shows: whichever of a push and a command answer crossed last. Both are folded as they arrive, in
   * the order they crossed, so an answer is never laid over a push that came after it (#2723).
   */
  private shell: Json | undefined
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; foldAnswer: ((result: unknown) => unknown) | undefined }>()
  private next = 0
  private delivered = 0
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  private readonly changed = new Set<() => void>()
  /** Every event given to a listener, renamed in place when the host ID in it is given back under the contract's later. */
  private readonly given: ThreadHostEvent[] = []
  /** Commands the contract sent without waiting for them (a disconnect), until `settled` is asked. */
  private readonly inFlight: Promise<unknown>[] = []
  /** The threads this client last asked to observe. */
  private observed: readonly string[] = []
  private constructor(private readonly socket: Socket, private readonly session: string, private readonly provider: RefereeProvider, private readonly names: ContractNames) {
    let read = 0
    socket.onArrival(() => {
      for (; read < socket.crossings.length; read++) {
        const crossing = socket.crossings[read]!
        if (crossing.dir === 'in') this.arrive(crossing.frame)
      }
    })
  }

  /**
   * Opens a socket on a paired session and says hello, holding the shell it is answered with. `names` is kept by the
   * caller across a restart of the host, whose threads keep the IDs they had.
   */
  static async open(port: number, session: string, provider: RefereeProvider, names: ContractNames = newContractNames()): Promise<SocketAgentHost> {
    return SocketAgentHost.onSocket(await openSocket(port, session, DESKTOP_DEFLATE_OFFER), session, provider, names)
  }

  /** Says hello on a socket already open. Its own test hands it a socket it writes to itself. */
  static async onSocket(socket: Socket, session: string, provider: RefereeProvider, names: ContractNames = newContractNames()): Promise<SocketAgentHost> {
    const host = new SocketAgentHost(socket, session, provider, names)
    await host.request({ op: 'hello', afterSeq: 0, accepts: HELLO_ACCEPTS }, result => {
      const hello = host.fold.hello(result)
      host.shell = isObject(hello?.shell) ? hello.shell : undefined
      return hello
    })
    return host
  }

  close(): void {
    this.socket.close()
    for (const waiting of this.pending.values()) waiting.reject(new Error('The socket closed before the host answered.'))
    this.pending.clear()
  }

  private arrive(frame: Json): void {
    if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const waiting = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      if (frame.ok === false) {
        const error = isObject(frame.error) ? frame.error : {}
        waiting.reject(new Error(typeof error.message === 'string' ? error.message : `The host refused the request (${String(error.code)}).`))
        return
      }
      if (!waiting.foldAnswer) { waiting.resolve(frame.result); return }
      // Folded here, before any frame that crossed after it: an answer can carry the model catalog the next push names only
      // by its revision (#2721), and a push after it shows a newer state than it does (#2723). Awaiting the answer first
      // would fold every frame that arrived in the same read ahead of it.
      let result: unknown
      try { result = waiting.foldAnswer(frame.result); this.publish() }
      catch (error) { waiting.reject(error instanceof Error ? error : new Error(String(error))); return }
      waiting.resolve(result)
      return
    }
    if (typeof frame.event !== 'string') return
    this.fold.push(frame)
    if (frame.event === 'shell') this.shell = this.fold.held.shell
    if (this.fold.problems.length) throw new Error(`The host sent what a client cannot read: ${this.fold.problems.join(' ')}`)
    this.publish()
  }

  /** Tells every listener what the client holds now, and every event listener the events that arrived since. */
  private publish(): void {
    const events = this.fold.held.events
    for (; this.delivered < events.length; this.delivered++) {
      const event = this.translate(events[this.delivered]) as unknown as ThreadHostEvent
      const given = { threadId: event.threadId, event: event.event }
      this.given.push(given)
      for (const listener of this.eventListeners) listener(given)
    }
    if (this.listeners.size) { const snapshot = this.read(); for (const listener of this.listeners) listener(snapshot) }
    for (const wake of this.changed) wake()
  }

  /**
   * Sends a request. `foldAnswer`, for an answer that changes what the client holds, folds it as it arrives, and what it
   * gives back is what the request resolves to.
   */
  private request(frame: Json, foldAnswer?: (result: unknown) => unknown): Promise<unknown> {
    const id = `contract-${++this.next}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The host did not answer ${String(frame.op)} within ${ANSWER_DEADLINE_MS} ms.`)) }, ANSWER_DEADLINE_MS)
      this.pending.set(id, { foldAnswer, resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.socket.send({ v: 1, id, session: this.session, ...frame })
    })
  }

  /**
   * Sends a client command and holds its answer as the shell from the moment it arrives. A refused command throws its sentence,
   * unless `refusals` is `kept`, for a send, whose delivery says what became of it.
   */
  private async command(command: Json, refusals: 'thrown' | 'kept' = 'thrown'): Promise<Json> {
    const answer = await this.request({ op: 'command', command }, result => {
      const folded = this.fold.commandAnswer(result)
      if (isObject(folded)) this.shell = folded
      return folded
    })
    if (!isObject(answer)) throw new Error('The host answered a command with no shell.')
    if (refusals === 'thrown' && typeof answer.error === 'string' && answer.error) throw new Error(answer.error)
    return answer
  }

  /** Resolves once `ready` holds of what the client shows; the host's own pushes move it, so nothing here sleeps. */
  private until(ready: () => boolean, what: string): Promise<void> {
    if (ready()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.changed.delete(wake); reject(new Error(`The host never showed ${what}.`)) }, ANSWER_DEADLINE_MS)
      const wake = (): void => { if (ready()) { clearTimeout(timer); this.changed.delete(wake); resolve() } }
      this.changed.add(wake)
    })
  }

  /**
   * Gives a host ID back under the contract's. A send's events can arrive before its answer names the message, so an
   * event already given is renamed where it carries the ID.
   */
  private alias(hostId: string, contractId: string): void {
    this.names.aliases.set(hostId, contractId)
    const rename = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) rename(item); return }
      if (!isObject(value)) return
      for (const [key, item] of Object.entries(value)) {
        if (item === hostId && (key === 'id' || key.endsWith('Id'))) value[key] = contractId
        else rename(item)
      }
    }
    rename(this.given)
  }

  /** A value from the host, with each host ID the contract was given back under replaced by the contract's. */
  private translate(value: unknown): unknown {
    if (typeof value === 'string') return this.names.aliases.get(value) ?? value
    if (Array.isArray(value)) return value.map(item => this.translate(item))
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'id' || key.endsWith('Id') || typeof item === 'object' ? this.translate(item) : item]))
  }

  /**
   * The adapter snapshot the client shows: the shell's host part, with each observed thread's messages from its detail
   * unless `messages` is `left out`, as they are from every shell. A project record loses the fields the coordinator adds
   * when it joins its providers' projects, which an adapter's has no place for.
   */
  private read(messages: 'from details' | 'left out' = 'from details'): AgentHostSnapshot {
    const host = isObject(this.shell?.host) ? this.shell.host : {}
    const threads = (Array.isArray(host.threads) ? host.threads as Json[] : []).map(thread => {
      const detail = messages === 'from details' ? this.fold.held.details[String(thread.id)] : undefined
      return { ...thread, messages: detail?.messages ?? thread.messages ?? [] }
    })
    const projects = (Array.isArray(host.projects) ? host.projects as Json[] : [])
      .map(project => without(project, 'hostId', 'providerId', 'workspaceSettledAt'))
    return this.translate({ ...host, projects, threads }) as AgentHostSnapshot
  }

  /** What the client holds, as the referee's script reads it. */
  private held(): { shell: Json | undefined; details: Record<string, Json | null>; events: Json[] } {
    return { shell: this.shell, details: this.fold.held.details, events: [] }
  }

  private record(threadId: string): Json | undefined {
    return ((this.shell?.host as { threads?: Json[] } | undefined)?.threads ?? []).find(thread => thread.id === threadId)
  }

  /**
   * Connects the provider. An adapter has done what connecting asks once its `connect` returns; a host shows it in its
   * pushes, so this waits for the client to hold it: the provider connected with start-up over (`started`), no command
   * still in its lane, and each observed thread's detail held.
   */
  async connect(): Promise<AgentHostSnapshot> {
    await this.command({ type: 'connect', provider: this.provider })
    await this.until(() => started(this.provider)(this.held()) && lanesIdle(this.held()) && this.observed.every(id => this.fold.held.details[id] !== undefined),
      `${this.provider} connected, with its observed threads' details`)
    return this.read()
  }

  /**
   * An adapter's disconnect takes effect as it returns; a client's is a command, whose answer comes later. It is kept, and
   * `settled` waits for it, so nothing the contract reads after a disconnect is read before the host acted on it.
   */
  disconnect(): void { this.inFlight.push(this.command({ type: 'disconnect', provider: this.provider })) }

  /** Resolves once every command sent without being awaited has been answered, and throws the first one refused. */
  async settled(): Promise<void> { const waiting = this.inFlight.splice(0); await Promise.all(waiting) }

  async snapshot(): Promise<AgentHostSnapshot> { return this.read() }

  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  observeThreads(threadIds: readonly string[]): void {
    this.observed = [...threadIds]
    this.fold.observing(threadIds)
    void this.request({ op: 'observe', threadIds: [...threadIds] }).catch(() => undefined)
  }

  /** Stages each attachment the way a client does before it sends: an image whole, any other file in parts. */
  private async stage(attachments: readonly PromptImage[]): Promise<Json[]> {
    const handles: Json[] = []
    for (const attachment of attachments) {
      const bytes = Buffer.from(await attachment.read())
      const handle = attachment.mimeType.startsWith('image/')
        ? await this.request({ op: 'stage-attachment', image: { name: attachment.name, mimeType: attachment.mimeType, data: bytes.toString('base64') } })
        : await this.request({ op: 'stage-file-part', part: { uploadId: randomUUID(), index: 0, count: 1, name: attachment.name, mimeType: attachment.mimeType,
          sizeBytes: bytes.byteLength, digest: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') } })
      if (!isObject(handle) || typeof handle.id !== 'string') throw new Error(`The host kept no handle for ${attachment.name}.`)
      this.alias(handle.id, attachment.id)
      handles.push(handle)
    }
    return handles
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    switch (command.type) {
      case 'create-project': {
        const answer = await this.command({ type: 'create-project', provider: this.provider, title: command.title, path: command.path, useExisting: true })
        const project = ((answer.host as { projects?: { id: string; path: string }[] }).projects ?? []).find(item => item.path === command.path)
        if (!project) throw new Error('The host made no project for that folder.')
        this.names.projects.set(command.projectId, project.id)
        this.alias(project.id, command.projectId)
        return { accepted: true }
      }
      case 'create-thread': {
        // A title the adapter is given is the thread's title: the coordinator renames only a thread whose title is its own.
        await this.command({ ...without(command, 'commandId'), projectId: this.names.projects.get(command.projectId) ?? command.projectId,
          titleSource: command.titleSource ?? 'user', workingCopy: command.workingCopy ?? 'shared', managed: false })
        return { accepted: true }
      }
      case 'send': {
        if (command.expectedLastUserMessageId !== undefined) throw new Error('A client cannot name the user message its send follows: the host works it out.')
        const draftId = randomUUID()
        const attachments = command.attachments?.length ? await this.stage(command.attachments) : undefined
        const answer = await this.command({ type: 'manual-send', threadId: command.threadId, text: command.text, draftId, ...(attachments ? { attachments } : {}) }, 'kept')
        // The delivery says what became of the send; one still being written is read again from the host's next push.
        const delivery = (): Json | undefined => (this.shell?.deliveries as Json[] | undefined)?.find(item => item.draftId === draftId)
        await this.until(() => delivery() !== undefined && !['queued', 'submitting'].includes(String(delivery()!.status)), 'the send delivered or not')
        const { status, messageId, error } = delivery() ?? {}
        if (typeof messageId === 'string') this.alias(messageId, command.messageId)
        if (status === 'accepted' && !answer.error) {
          // An adapter's send returns with the thread showing it. A host's shows in the pushes after its answer: the thread
          // runs the turn and names the message as its last, the provider's acknowledgement is recorded, the lane is closed
          // and an observed thread's detail holds the message.
          const record = (): Json | undefined => this.record(command.threadId)
          await this.until(() => record()?.lastUserMessageId === messageId && record()?.status === 'running' && record()?.lastTurn !== undefined
            && deliveriesSettled(this.held()) && lanesIdle(this.held())
            && (!this.observed.includes(command.threadId) || ((this.fold.held.details[command.threadId]?.messages ?? []) as Json[]).some(message => message.id === messageId)),
          'the sent message on its thread')
          return { accepted: true }
        }
        if (status === 'uncertain') return { accepted: false, uncertain: true }
        throw new Error(typeof answer.error === 'string' && answer.error ? answer.error : typeof error === 'string' ? error : `The host did not deliver the send: its delivery is ${String(status)}.`)
      }
      case 'answer': {
        await this.command(without(command, 'commandId'))
        return { accepted: true }
      }
      case 'interrupt':
        await this.command({ type: 'interrupt', threadId: command.threadId })
        return { accepted: true }
      case 'configure-thread': {
        // Every client keeps its history from the host's events and details, so a shell never carries messages.
        await this.command(without(command, 'commandId', 'historyFromEvents'))
        return { accepted: true, snapshot: this.read('left out') }
      }
      default:
        throw new Error(`A client has no command that does what ${command.type} does.`)
    }
  }
}

/** The host's IDs the contract was given back under its own: projects, messages and attachments. */
export interface ContractNames {
  /** The contract's ID for each host ID. */
  readonly aliases: Map<string, string>
  /** The host's project ID for each project ID the contract chose. */
  readonly projects: Map<string, string>
}
export const newContractNames = (): ContractNames => ({ aliases: new Map(), projects: new Map() })

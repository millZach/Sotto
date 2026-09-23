import { userInfo } from 'node:os'

import type { AgentCommand, AgentState, AgentThreadDetail, AgentThreadDetailUpdate, AgentAttachmentPreviewRequest, AgentAttachmentPreviewResult } from '../../shared/agents'
import type { StoredThreadEvent } from '../../shared/threadEvents'

/**
 * Who is speaking to the host. The desktop window on this machine is `ipc`; a paired remote client
 * would be `socket`. It is evidence about a command, never authority in itself (ADR-0004): policy
 * records decide whether a client may grant, and `Authority.mayGrant` is where that is asked.
 *
 * `user` is the local account name, recorded in a thread's own log so a record says who answered. It
 * is never logged and never sent anywhere.
 */
export interface ClientIdentity {
  readonly clientId: string
  readonly user: string
  readonly transport: 'ipc' | 'socket'
}

/**
 * Everything a client may use, and nothing else. The host owns the providers, the worktrees and the
 * event store (ADR-0016); a client reads the stream and sends commands, and holds no provider
 * identity of its own. Today the only client is the app's window over IPC, so the only implementation
 * is `LocalHostService`; the interface exists so a second transport is a new client rather than a
 * rewrite. Threads are addressed by Sotto thread ID either way (ADR-0002).
 */
export interface HostService {
  /** Everything in the log after this sequence number, for a client catching up after a reconnection. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[]
  subscribe(listener: (state: AgentState) => void): () => void
  /** The whole published state, history included. */
  state(): AgentState
  /** The published state without any thread's history: what every client needs on every frame. */
  shell(): AgentState
  threadDetail(threadId: string): AgentThreadDetail | null
  command(command: AgentCommand, client: ClientIdentity): Promise<AgentState>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
}

/** The part of the event store a client is allowed to read through the host. */
export interface ThreadEventSource {
  eventsAfter(seq: number, threadId?: string, limit?: number): StoredThreadEvent[]
}

export const DESKTOP_WINDOW_CLIENT_ID = 'desktop-window'
/** Sotto's own supervision, so a record shows an answer that came from Sotto rather than the user. */
export const SUPERVISION_CLIENT_ID = 'sotto-supervision'

/** The account Sotto is running as. Recorded locally; never logged, never sent. */
export function localUser(): string {
  try { return userInfo().username } catch { return '' }
}

export function desktopWindowClient(user: string = localUser()): ClientIdentity {
  return { clientId: DESKTOP_WINDOW_CLIENT_ID, user, transport: 'ipc' }
}

/**
 * Supervision answers nothing on the user's behalf (ADR-0004); when it sends a follow-up the record
 * needs to say that Sotto sent it, which is bookkeeping and not a grant.
 */
export function supervisionClient(user: string = localUser()): ClientIdentity {
  return { clientId: SUPERVISION_CLIENT_ID, user, transport: 'ipc' }
}

/** What `LocalHostService` needs of the coordinator: the client-facing half of `AgentControl`. */
export interface LocalHostControl {
  get(): AgentState
  shell(): AgentState
  threadDetail(threadId: string): AgentThreadDetail | null
  subscribe(listener: (state: AgentState) => void): () => void
  command(command: AgentCommand, client?: ClientIdentity): Promise<AgentState>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult
}

/**
 * The host as it stands today: one process, one client, and the IPC the preload bridge already
 * carries between them. Every command arrives with the identity of the client that sent it, so the
 * boundary is the same one a socket would cross.
 */
export class LocalHostService implements HostService {
  private readonly observations = new Map<string, string[]>()
  private readonly control: LocalHostControl
  private readonly eventSource: ThreadEventSource | undefined

  constructor(options: { control: LocalHostControl; events?: ThreadEventSource }) {
    this.control = options.control
    this.eventSource = options.events
  }

  /** Empty when no event source is wired: the window reads history through the thread detail today. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[] {
    return this.eventSource?.eventsAfter(afterSeq, threadId, limit) ?? []
  }

  subscribe(listener: (state: AgentState) => void): () => void { return this.control.subscribe(listener) }
  state(): AgentState { return this.control.get() }
  shell(): AgentState { return this.control.shell() }
  threadDetail(threadId: string): AgentThreadDetail | null { return this.control.threadDetail(threadId) }
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void): () => void { return this.control.subscribeThreadDetail?.(listener) ?? (() => undefined) }
  attachmentPreview(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult { return this.control.attachmentPreview?.(request) ?? null }
  command(command: AgentCommand, client: ClientIdentity): Promise<AgentState> {
    if (command.type === 'observe-threads') {
      if (command.threadIds.length) this.observations.set(client.clientId, command.threadIds)
      else this.observations.delete(client.clientId)
      command = { type: 'observe-threads', threadIds: [...new Set([...this.observations.values()].flat())] }
    }
    return this.control.command(command, client)
  }
}

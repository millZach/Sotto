import type { AgentRuntimeMode } from '../../shared/agents'
import type { DesktopDefaultsInput, DesktopDefaultsReceipt } from '../../shared/desktopDefaults'
import type { WorkerRoleChoices } from '../../shared/workerRoles'

/** A host connection as the push uses it: its ID, whether it is remote, and whether it takes desktop defaults. */
export interface DesktopDefaultsTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsHostDelegation?: boolean | undefined
    desktopDefaults?(defaults: DesktopDefaultsInput): Promise<DesktopDefaultsReceipt>
  }
}
export type DesktopDefaultsEvent = 'desktop-defaults-sent' | 'desktop-defaults-failed'
export interface DesktopDefaultsPushOptions {
  /** The remote hosts connected now, read in place when the defaults change. */
  readonly connections: () => Iterable<DesktopDefaultsTarget>
  /** What happened, as stable event names; never a mode, a role or a host. */
  readonly log?: (event: DesktopDefaultsEvent) => void
}

/**
 * Sends the desktop defaults (#1310, Owl `cross-machine-work`) to each connected host that runs delegation for its own
 * threads: the user's new-thread default and, while worker roles are on, the worker roles, when the host connects and
 * whenever either changes. Main tells it what they are; it compares cheaply, by value for the mode and by identity for the
 * roles, which Settings replace whole when they change, so the update path that tells it many times a second copies
 * nothing. Sends to one host go one at a time, each reading the defaults as they are when it goes, so the last one a host
 * takes is the newest. A send that fails is tried again on the host's next connection. A host that does not list
 * `host-delegation`, an older or stable one, is never sent anything.
 */
export class DesktopDefaultsPush {
  private mode: AgentRuntimeMode | null = null
  private roles: WorkerRoleChoices | undefined
  private known = false
  private readonly sending = new Map<string, Promise<void>>()
  private closed = false
  constructor(private readonly options: DesktopDefaultsPushOptions) {}

  /** Main says what the defaults are now. Absent roles mean worker roles are off. Sends only when they changed. */
  update(mode: AgentRuntimeMode | null | undefined, roles: WorkerRoleChoices | undefined): void {
    const next = mode ?? null
    if (this.known && next === this.mode && roles === this.roles) return
    this.mode = next; this.roles = roles; this.known = true
    for (const connection of this.options.connections()) this.send(connection)
  }
  /** A host connected, new or again: it is told the defaults, once they are known. */
  connected(connection: DesktopDefaultsTarget): void { if (this.known) this.send(connection) }
  close(): void { this.closed = true }
  private send(connection: DesktopDefaultsTarget): void {
    if (this.closed || connection.kind !== 'remote' || connection.service.supportsHostDelegation !== true || !connection.service.desktopDefaults) return
    const service = connection.service
    const previous = this.sending.get(connection.hostId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.closed) return
      const defaults: DesktopDefaultsInput = { newThreadRuntimeMode: this.mode, ...(this.roles ? { workerRoles: this.roles } : {}) }
      try { await service.desktopDefaults!(defaults); this.options.log?.('desktop-defaults-sent') }
      catch { this.options.log?.('desktop-defaults-failed') }
    })
    this.sending.set(connection.hostId, next)
    void next.finally(() => { if (this.sending.get(connection.hostId) === next) this.sending.delete(connection.hostId) })
  }
  /** Settles once every send started so far has; for tests and for closing. */
  async settled(): Promise<void> { await Promise.allSettled([...this.sending.values()]) }
}

/** The window's host router as the push follows it: the states it publishes, and each connection it takes. */
export interface DesktopDefaultsSource {
  subscribe(listener: (state: { readonly configuration: { readonly newThreadRuntimeMode?: AgentRuntimeMode | undefined } }) => void): () => void
  subscribeConnected(listener: (connection: DesktopDefaultsTarget) => void): () => void
}

/**
 * Keeps the push on the desktop defaults that are in force, as Settings applies them (ADR-0074). The new-thread default is
 * read from each state the window's router publishes, in place: this computer's own while its host runs, and the selected
 * host's own while it does not, which is the one Settings shows and saves to then. The worker roles are this computer's
 * Settings, read through `roles` when a state is published and when Main says they changed. Each host is told on every
 * connection the router takes.
 */
export function followDesktopDefaults(push: DesktopDefaultsPush, source: DesktopDefaultsSource, roles: () => WorkerRoleChoices | undefined): { rolesChanged(): void; dispose(): void } {
  let mode: AgentRuntimeMode | undefined
  let seen = false
  const offConnected = source.subscribeConnected(connection => push.connected(connection))
  const offState = source.subscribe(state => { mode = state.configuration.newThreadRuntimeMode; seen = true; push.update(mode, roles()) })
  return {
    // Before the first state, the roles go with it.
    rolesChanged: () => { if (seen) push.update(mode, roles()) },
    dispose: () => { offConnected(); offState() },
  }
}

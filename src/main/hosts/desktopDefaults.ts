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

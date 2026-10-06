import type { SshHostConnection } from './sshLauncher'

/**
 * What a press that changes something on a host goes over (ADR-0053): the launch script's operations, and the host's
 * administrative routes on the port the connection forwards with the token its launch read. It is the SSH connection
 * while the host's socket is on it, and otherwise an admin connection, which has no socket on it.
 */
export type AdminConnection = Pick<SshHostConnection, 'url' | 'hostId' | 'owned' | 'node' | 'showHostPairingCode' | 'ensureDesktopAnswers'
  | 'revokeClient' | 'hostAdminToken' | 'stopHost' | 'updateHost'>

/** How long an admin connection stays open after its last press finishes. */
export const ADMIN_IDLE_MS = 60_000

export interface AdminLinkOptions {
  /** Signs in over SSH and finds the running host, starting none. Its prompts and approval go wherever the caller shows them. */
  readonly open: () => Promise<SshHostConnection>
  /** Ends the SSH connection `open` made, and anything it still has open. */
  readonly close: () => Promise<void>
  readonly idleMs?: number
}

/**
 * One saved host's admin connection: opened by the first press that needs it, shared by every press while it is open, and
 * closed a minute after the last one finishes, taking the host's administrative token with it. A press still running
 * keeps it open, so the Phones dialog's reads every couple of seconds hold it for as long as the dialog is open.
 */
export class AdminLink {
  private opening: Promise<AdminConnection> | undefined
  private uses = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly options: AdminLinkOptions) {}

  /** The open admin connection, or a new one. A connect that fails is not kept, so the next press tries again. */
  connection(): Promise<AdminConnection> {
    if (this.closed) return Promise.reject(new Error('The connection to the host was closed. Nothing was changed.'))
    if (this.opening) return this.opening
    const opening: Promise<AdminConnection> = this.options.open().then(connection => {
      if (this.opening !== opening) { void connection.close(); throw new Error('The connection to the host was closed. Nothing was changed.') }
      this.idle()
      return this.wrap(connection, opening)
    })
    this.opening = opening
    opening.catch(() => { if (this.opening === opening) this.opening = undefined })
    return opening
  }

  /** The SSH connection ended by itself: the next press opens another. */
  dropped(): void { this.discard() }

  /** Closes it now: the host was forgotten, edited or disconnected, or Sotto is quitting. Nothing opens it again. */
  async close(): Promise<void> {
    this.closed = true
    const had = this.opening !== undefined
    this.discard()
    if (had) await this.options.close().catch(() => undefined)
  }

  private discard(): void {
    clearTimeout(this.timer); this.timer = undefined
    this.opening = undefined
  }

  /** Closes the connection once no press has used it for the idle time. */
  private idle(): void {
    clearTimeout(this.timer)
    if (this.uses > 0) return
    this.timer = setTimeout(() => {
      if (this.uses > 0 || !this.opening) return
      this.discard()
      void this.options.close().catch(() => undefined)
    }, this.options.idleMs ?? ADMIN_IDLE_MS)
    this.timer.unref?.()
  }

  /** The connection, with every press counted as a use. Stop host ends the SSH connection it ran on, so the next press opens another. */
  private wrap(connection: SshHostConnection, opening: Promise<AdminConnection>): AdminConnection {
    const use = <T>(work: () => Promise<T>, ends = false): Promise<T> => {
      this.uses++; clearTimeout(this.timer)
      return work().finally(() => {
        this.uses--
        if (this.opening !== opening) return
        if (ends) this.discard(); else this.idle()
      })
    }
    return {
      url: connection.url, hostId: connection.hostId, owned: connection.owned, ...(connection.node ? { node: connection.node } : {}),
      showHostPairingCode: () => use(() => connection.showHostPairingCode()),
      ensureDesktopAnswers: clientId => use(() => connection.ensureDesktopAnswers(clientId)),
      revokeClient: clientId => use(() => connection.revokeClient(clientId)),
      hostAdminToken: () => use(() => connection.hostAdminToken()),
      stopHost: () => use(() => connection.stopHost(), true),
      updateHost: (operation, options) => use(() => connection.updateHost(operation, options)),
    }
  }
}

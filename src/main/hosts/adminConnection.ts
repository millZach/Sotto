import type { SshHostConnection } from './sshLauncher'

/**
 * What a press that changes something on a host goes over (ADR-0053): the launch script's operations, and the host's
 * administrative routes on the port the connection forwards with the token its launch read. It is the host's SSH
 * connection while the socket is on it, and otherwise its admin connection.
 */
export type PressConnection = Pick<SshHostConnection, 'url' | 'hostId' | 'owned' | 'revokeClient' | 'hostAdminToken' | 'stopHost' | 'updateHost' | 'bootStart' | 'boot'>

/** How long an admin connection stays open after its last press finishes. */
export const ADMIN_IDLE_MS = 60_000

/** The user stopped an admin connection's sign-in while it waited for them: nothing was sent to the host. */
export class SignInStopped extends Error {
  constructor() { super('Sotto stopped signing in to the host. Nothing was changed.') }
}

export interface AdminConnectionOptions {
  /**
   * Signs in over SSH and finds the running host, starting none. `dropped` is called if that SSH connection ends by
   * itself. Its prompts and approval go wherever the caller shows them.
   */
  readonly open: (dropped: () => void) => Promise<SshHostConnection>
  /** Ends the SSH connection `open` made, or the sign-in still under way, and anything it still has open. */
  readonly close: () => Promise<void>
  readonly idleMs?: number
}

/** One open SSH connection, with the presses running on it now. */
interface Open { readonly connection: SshHostConnection; uses: number; timer?: ReturnType<typeof setTimeout> | undefined }

const CLOSED = 'Sotto closed the connection to the host. Nothing was changed. Try again.'

/**
 * One saved host's admin connection (ADR-0053): opened by the first press that needs it, shared by every press while it
 * is open, and closed a minute after the last press finishes, taking the host's administrative token with it. A press
 * holds it for as long as the press runs, including any request it sends through the forward, so the Phones dialog's
 * reads every couple of seconds keep it open for as long as the dialog is open.
 */
export class AdminConnection {
  /** The sign-in under way, until it opens or fails. */
  private opening: Promise<Open> | undefined
  /** The sign-in the user stopped, whose press fails with `SignInStopped`. */
  private stopped: Promise<Open> | undefined
  private current: Open | undefined
  private closed = false

  constructor(private readonly options: AdminConnectionOptions) {}

  /** Runs one press over the open connection, or a new one. A connect that fails is not kept, so the next press tries again. */
  async run<T>(press: (connection: PressConnection) => Promise<T>): Promise<T> {
    return this.hold(await this.connect(), press)
  }

  /** Runs one press over the connection only if it is open now, opening none. Undefined when it is not. */
  async runIfOpen<T>(press: (connection: PressConnection) => Promise<T>): Promise<T | undefined> {
    return this.current ? this.hold(this.current, press) : undefined
  }

  /** Ends a sign-in still under way, before anything is sent: its press fails with `SignInStopped`. False when none was. */
  async stopSigningIn(): Promise<boolean> {
    const opening = this.opening
    if (!opening) return false
    this.stopped = opening
    this.opening = undefined
    await this.options.close().catch(() => undefined)
    return true
  }

  /** Closes it now: the host was forgotten, edited or disconnected, or Sotto is quitting. Nothing opens it again. */
  async close(): Promise<void> {
    this.closed = true
    const had = this.opening !== undefined || this.current !== undefined
    if (this.current) this.end(this.current)
    this.opening = undefined
    if (had) await this.options.close().catch(() => undefined)
  }

  private connect(): Promise<Open> {
    if (this.closed) return Promise.reject(new Error(CLOSED))
    if (this.current) return Promise.resolve(this.current)
    if (this.opening) return this.opening
    let open: Open | undefined, gone = false
    // The SSH connection ended by itself: the next press opens another.
    const dropped = (): void => { gone = true; if (open) this.end(open) }
    const opening: Promise<Open> = this.options.open(dropped).then(connection => {
      if (this.opening !== opening || gone) {
        if (this.opening === opening) this.opening = undefined
        void connection.close().catch(() => undefined)
        throw this.stopped === opening ? new SignInStopped() : new Error(CLOSED)
      }
      this.opening = undefined
      open = this.current = { connection, uses: 0 }
      this.idle(open)
      return open
    }, (error: unknown) => {
      if (this.opening === opening) this.opening = undefined
      throw this.stopped === opening ? new SignInStopped() : error
    })
    this.opening = opening
    return opening
  }

  /** Counts the whole press as a use of this connection, so no idle close lands inside it. */
  private async hold<T>(open: Open, press: (connection: PressConnection) => Promise<T>): Promise<T> {
    open.uses++
    clearTimeout(open.timer); open.timer = undefined
    try { return await press(this.view(open)) }
    finally { open.uses--; this.idle(open) }
  }

  /** Closes the connection once no press has used it for the idle time. A connection already replaced is left alone. */
  private idle(open: Open): void {
    if (this.current !== open || open.uses > 0) return
    clearTimeout(open.timer)
    open.timer = setTimeout(() => {
      if (this.current !== open || open.uses > 0) return
      this.end(open)
      void this.options.close().catch(() => undefined)
    }, this.options.idleMs ?? ADMIN_IDLE_MS)
    open.timer.unref?.()
  }

  /** Forgets the connection, so the next press opens another. */
  private end(open: Open): void {
    clearTimeout(open.timer); open.timer = undefined
    if (this.current === open) this.current = undefined
  }

  /** The connection as a press sees it. Stop host ends the SSH connection it ran on, so the next press opens another. */
  private view(open: Open): PressConnection {
    const connection = open.connection
    return {
      url: connection.url, hostId: connection.hostId, owned: connection.owned, ...(connection.bootStart ? { bootStart: connection.bootStart } : {}),
      revokeClient: clientId => connection.revokeClient(clientId),
      hostAdminToken: () => connection.hostAdminToken(),
      stopHost: async () => { try { return await connection.stopHost() } finally { this.end(open) } },
      updateHost: (operation, options) => connection.updateHost(operation, options),
      boot: operation => connection.boot(operation),
    }
  }
}

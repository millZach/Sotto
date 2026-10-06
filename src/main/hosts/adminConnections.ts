import { AdminConnection, type PressConnection } from './adminConnection'
import { SshHostLauncher, type SshApproval, type SshHostConfiguration, type SshPrompt } from './sshLauncher'

/** A saved host as its admin connection signs in to it. */
export interface AdminHost {
  /** The saved host's ID. */
  readonly id: string
  readonly route: SshHostConfiguration
  /** The host's own ID, once this computer has met it: a host that answers with another one is refused. */
  readonly hostId?: string | undefined
  /** Forget's connection: a host that is not running has its boot unit taken away before the sign-in fails (ADR-0054). */
  readonly removeBoot?: boolean
}

/** What an admin connection's sign-in reports to the host's row, which shows it wherever the user is. */
export interface AdminSignInReport {
  /** True while the sign-in runs, false once it opened or failed. */
  readonly signingIn?: boolean
  /** SSH's question, or (null) none any more. */
  readonly prompt?: SshPrompt | null
  /** Tailscale's approval, or (null) none any more. */
  readonly approval?: SshApproval | null
}

export interface AdminConnectionsOptions {
  readonly launcher?: () => SshHostLauncher
  readonly report: (id: string, report: AdminSignInReport) => void
  /** The Node the host's launch script ran under, for the command that revokes this computer there by hand. */
  readonly node: (id: string, node: string) => void
  /** A host whose ID is not the one saved: the error the press fails with. */
  readonly identityChanged: () => Error
  readonly idleMs?: number
}

/** One host's admin connection, the launcher it signs in with, and the SSH question that sign-in is asking, if any. */
interface Entry { readonly connection: AdminConnection; readonly launcher: SshHostLauncher; readonly sign: { asking?: string | undefined; live: boolean } }

/**
 * Each saved host's admin connection (ADR-0053), while one is open or opening. The row shows a sign-in's SSH question and
 * Tailscale approval, and the window's answer goes back to the sign-in that asked.
 */
export class AdminConnections {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly options: AdminConnectionsOptions) {}

  /** Runs one press over the host's admin connection, opening it when it is not open. */
  run<T>(host: AdminHost, press: (connection: PressConnection) => Promise<T>): Promise<T> { return this.entry(host).connection.run(press) }

  /** Runs one press over the host's admin connection only if it is open now. Undefined when it is not. */
  runIfOpen<T>(id: string, press: (connection: PressConnection) => Promise<T>): Promise<T | undefined> {
    return this.entries.get(id)?.connection.runIfOpen(press) ?? Promise.resolve(undefined)
  }

  /** Sends an answer to the sign-in that asked this question. False when no admin connection asked it. */
  answer(id: string, promptId: string, answer: string): boolean {
    const entry = this.entries.get(id)
    if (entry?.sign.asking !== promptId) return false
    entry.launcher.answerPrompt(promptId, answer)
    return true
  }

  /** Stops a host's sign-in under way. False when none was. */
  stopSigningIn(id: string): Promise<boolean> { return this.entries.get(id)?.connection.stopSigningIn() ?? Promise.resolve(false) }

  /** Closes a host's admin connection, and any sign-in still under way. */
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.sign.live = false
    await entry.connection.close()
  }

  async closeAll(): Promise<void> { await Promise.allSettled([...this.entries.keys()].map(id => this.close(id))) }

  private entry(host: AdminHost): Entry {
    const existing = this.entries.get(host.id)
    if (existing) return existing
    const launcher = this.options.launcher?.() ?? new SshHostLauncher()
    const sign: Entry['sign'] = { live: true }
    const connection = new AdminConnection({ open: dropped => this.signIn(host, launcher, sign, dropped), close: () => launcher.disconnect(), ...(this.options.idleMs ? { idleMs: this.options.idleMs } : {}) })
    const entry: Entry = { connection, launcher, sign }
    this.entries.set(host.id, entry)
    return entry
  }

  /** One sign-in: the launch finds the running host and starts none. What it asks reaches the row only while its entry is live. */
  private async signIn(host: AdminHost, launcher: SshHostLauncher, sign: Entry['sign'], dropped: () => void) {
    const report = (value: AdminSignInReport): void => { if (sign.live) this.options.report(host.id, value) }
    let approval = false
    report({ signingIn: true })
    try {
      const connection = await launcher.connect(host.route, {
        onPrompt: prompt => { sign.asking = prompt?.id; report({ prompt }) },
        onApproval: value => { approval = value !== null; report({ approval: value }) },
        onDisconnected: dropped,
      }, { start: false, ...(host.removeBoot ? { removeBoot: true } : {}) })
      if (host.hostId && connection.hostId !== host.hostId) { await connection.close(); throw this.options.identityChanged() }
      if (connection.node) this.options.node(host.id, connection.node)
      return connection
    } finally {
      // Whatever the sign-in left on the row goes with it.
      if (sign.asking) { sign.asking = undefined; report({ prompt: null }) }
      if (approval) report({ approval: null })
      report({ signingIn: false })
    }
  }
}

import { join } from 'node:path'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import { z } from 'zod'
import { remoteHostSchema, type HostForgotten, type HostForgottenCause, type HostPhonesView, type HostSetupChoice, type HostSetupState, type HostSetupStep, type HostsCommand, type HostsState, type HostStatus, type RemoteHost } from '../../shared/hosts'
import type { HostPhonesCommand } from '../../shared/phones'
import type { HostPhonesLink } from './hostPhones'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from '../agents/credentials'
import { HostConnectionError, SocketHostService } from '../agents/socketHostService'
import { validateSshHost } from './sshConfiguration'
import { SshFailure, SshHostLauncher, type SshBootResult, type SshCallbacks, type SshFailureCode, type SshHostConnection, type SshHostUpdateOperation, type SshHostUpdateOptions, type SshHostUpdateResult } from './sshLauncher'
import { failureStep } from './sshFailure'
import { SignInStopped, type PressConnection } from './adminConnection'
import { AdminConnections, type AdminSignInReport } from './adminConnections'
import { revokeByHandCommand } from './revokeCommand'
import { isTailscaleApprovalUrl } from './tailscaleApproval'
import type { DesktopHostConnection, DesktopHostRouter } from './desktopHostRouter'
import type { HostUpdateCandidate } from './hostUpdate'
import type { HostUpdateAction, HostUpdateState } from '../../shared/hostUpdates'
import { nameHostInRefusal, type AgentProviderStatus, type ProviderId } from '../../shared/agents'
import type { HostProviderJobSource, ProviderJobHost } from './hostProviderJob'
import { isProviderSignInPage, type HostClientUpdateRequest, type HostProviderAction, type HostProviderActionResult, type HostSignIn, type HostSignInRequest, type ProviderSignInView } from '../../shared/hostProviders'

/** Files from before the switch have no `sshPort` or `enabled` and still read: both are optional, and no `enabled` means on. */
const savedHostSchema = remoteHostSchema.extend({ hostId: z.uuid().optional(), clientId: z.string().optional() })
type SavedHost = z.infer<typeof savedHostSchema>
type Connection = Omit<RemoteHost, 'enabled'>
/** What Settings > Hosts asks of the host setup (ADR-0035), which runs beside the saved hosts and reports into them. */
export interface HostSetupSource {
  state(): HostSetupState | undefined
  choice(): HostSetupChoice | undefined
  command(command: Extract<HostsCommand, { type: 'start-setup' | 'stop-setup' | 'dismiss-setup' }>): Promise<void>
  subscribe(listener: () => void): () => void
}
/** Each remote host's phone access (ADR-0050): Settings > Hosts shows it, and its Phones dialog sends it presses. */
export interface HostPhonesSource {
  state(): HostPhonesView[]
  command(id: string, command: HostPhonesCommand): Promise<void>
  watch(id: string, watching: boolean): void
  subscribe(listener: () => void): () => void
}
/** What the Threads page's host update panel asks of the host updates (ADR-0040), which follow the saved hosts. */
export interface HostUpdateSource {
  state(): HostUpdateState[]
  command(id: string, action: HostUpdateAction): Promise<void>
  /** Why another command on this saved host must wait for its update, or nothing when none is under way. */
  busy(id: string): string | undefined
  subscribe(listener: () => void): () => void
}
/** The launch script's answers to a restart that it gave before stopping anything, so the host runs as it did. */
const UNTOUCHED_RESTARTS: ReadonlySet<string> = new Set(['update-not-owned', 'update-stop-failed', 'update-busy', 'update-missing', 'update-invalid'])
/** The launch script's answers to a start at boot change that it gave before stopping anything, so the host runs as it did. */
const UNTOUCHED_BOOT_CHANGES: ReadonlySet<string> = new Set(['boot-unit-taken', 'boot-install-failed', 'boot-stop-failed', 'update-busy', 'archive-missing'])
/** The commands that act on one saved host's connection, which wait while that host is being updated. */
const CONNECTION_COMMANDS: ReadonlySet<HostsCommand['type']> = new Set<HostsCommand['type']>(['save', 'set-enabled', 'connect', 'disconnect', 'stop-host', 'forget'])
/**
 * One connect to a saved host and what it opened. `ssh` is the SSH connection, while it is open. The socket rides its
 * forward today, but opens at an address of its own, so a socket on another connection needs no SSH connection beside it
 * (ADR-0053). A press that needs the launch script goes over `ssh` when it is there, and over an admin connection
 * otherwise (see `press()`).
 *
 * `closing` is set while Stop host or Forget runs. Both drop the socket on purpose before the SSH reply
 * arrives (the host closes its listener to stop, and a revoke closes the revoked peer), and a drop then
 * must not be read as a lost connection: reconnecting would restart the host being stopped, or pair again
 * with the host just told to forget this computer.
 */
interface LiveHost { launcher: SshHostLauncher; ssh?: SshHostConnection; sshClosed?: boolean; socket?: SocketHostService; registeredHostId?: string; generation: number; closing?: boolean }
/** Where a socket opens: the address, and the host that must answer there. */
interface SocketTarget { readonly url: string; readonly expectedHostId: string }
/** A pending reconnect. `timer` is absent while the first attempt of a launch or a switch-on runs. */
interface Retry { timer: ReturnType<typeof setTimeout> | undefined; attempt: number; active: LiveHost | undefined
  /** Set for the first attempt after a switch-on or an edit, which reads Connecting… rather than Reconnecting…. */
  first?: boolean }
/**
 * Failures only the user can resolve stop the reconnect backoff instead of retrying: SSH refused this
 * account, a host key changed or was not trusted, a prompt went unanswered, the host machine lacks what
 * the host needs. Everything else (an unreachable network, a host still starting) is retried. The code
 * decides, never the message.
 */
const FINAL_SSH_FAILURES: ReadonlySet<SshFailureCode> = new Set<SshFailureCode>(['ssh-missing', 'ssh-too-old', 'auth-failed', 'host-key-changed', 'host-key-rejected',
  'identity-file-unreadable', 'prompt-unanswered', 'tailscale-unapproved', 'node-missing', 'node-too-old', 'node-too-new', 'archive-missing', 'descriptor-invalid', 'permission-setup-failed',
  // A boot unit that would not start the host, or kept failing, needs its journal read on the host; retrying only starts it again (ADR-0054).
  'boot-start-refused', 'boot-unit-failed'])
/** A failure on this side of the connection that no retry can fix: the host is not the one saved, or pairing was lost for good. */
class FinalHostError extends Error {}
/** T3 Code's reconnect backoff: 3, 4, 8 and then every 16 seconds, until the user stops it. */
const RECONNECT_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const
export const reconnectDelayMs = (attempt: number): number => RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1)]!
const NOTHING_SAVED = 'Nothing was saved.'
/**
 * A failure sentence for Add host: what happened, then that nothing was saved, then what to do. A saved host's
 * sentence ends in "reconnect", which its row's Connect again does; in the dialog, what to do is add it again.
 */
function unsavedMessage(message: string): string {
  const next = message.replace(/,? then reconnect\.$/u, ', then add the host again.').replace(/ and reconnect\.$/u, ' and add the host again.')
    .replace(/ before reconnecting\.$/u, ' before adding the host again.').replace(/Connect again (to|when)/u, 'Add the host again $1')
  const end = next.search(/[.!?]\s/u)
  return end < 0 ? `${next} ${NOTHING_SAVED}` : `${next.slice(0, end + 1)} ${NOTHING_SAVED} ${next.slice(end + 2)}`
}
/** The host part of an SSH target, which names a new host until the user renames it. */
const targetHost = (target: string): string => target.split('@').at(-1) ?? target
/** Checks a connection the way the launcher will, so a mistyped one is refused before anything starts. */
function validateConnection(host: Connection): void {
  validateSshHost({ target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory,
    ...(host.sshPort ? { sshPort: host.sshPort } : {}), ...(host.identityFile ? { identityFile: host.identityFile } : {}) })
}

/** Configuration contains no credentials; tokens use the desktop's existing OS-encrypted store. */
export class DesktopHosts {
  private readonly store: AtomicJsonStore<SavedHost[]>
  private saved: SavedHost[] = []
  private readonly status = new Map<string, HostStatus>()
  private readonly live = new Map<string, LiveHost>()
  private readonly retries = new Map<string, Retry>()
  private readonly listeners = new Set<(state: HostsState) => void>()
  /**
   * The host Add host is connecting to. Its status, connection and prompt are keyed by its ID like a saved
   * host's, and it joins the saved hosts only once the host answers and this computer pairs.
   */
  private adding: SavedHost | undefined
  /**
   * The host setup's check or add (ADR-0035), kept apart from Add host's so neither cancels the other: the user can
   * add another machine in the dialog while an agent sets one up. It is keyed by its ID the same way.
   */
  private setupAttempt: SavedHost | undefined
  /** Add host's and the setup's connects, which close() waits for so a quit does not leave a credential behind. */
  private pendingAdd: Promise<void> = Promise.resolve()
  private pendingSetup: Promise<void> = Promise.resolve()
  private generation = 0
  /** The host setup, once main has one; Settings > Hosts shows it and sends it its commands. */
  private setup: HostSetupSource | undefined
  private unsubscribeSetup: (() => void) | undefined
  /** The provider job, once main has one (ADR-0035): the tiles show it and send it their Start and Stop. */
  private providerJob: HostProviderJobSource | undefined
  private unsubscribeProviderJob: (() => void) | undefined
  /** The host updates, once main has them (ADR-0040): the Threads page shows them and sends them its presses. */
  private updates: HostUpdateSource | undefined
  private unsubscribeUpdates: (() => void) | undefined
  /** Each host's phone access, once main has it (ADR-0050). */
  private phones: HostPhonesSource | undefined
  private unsubscribePhones: (() => void) | undefined
  /**
   * A host restarting for an update keeps its place on the Threads page, by saved host, under the host's own ID: its
   * threads read Reconnecting and their drafts stay, until this computer connects to it again and the new connection
   * takes its place, or a failure only the user can fix takes it away.
   */
  private readonly held = new Map<string, string>()
  /** Each saved host's admin connection, while one is open or opening (ADR-0053). */
  private readonly admins: AdminConnections
  /** The Node each host's launch script last ran under, for the command that revokes this computer there by hand. Memory only. */
  private readonly nodePaths = new Map<string, string>()
  /** Each not-revoked notice Forget left, oldest first, until dismissed. */
  private forgotten: HostForgotten[] = []
  /** Set by close(): Sotto is quitting, so no retry may start an SSH session the quit drain would leave behind. */
  private closed = false
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    directory: string; credentials: AgentCredentials; router: DesktopHostRouter;
    localHostRunning: boolean; localHostEnabled: () => boolean; restart: () => void;
    launcher?: () => SshHostLauncher;
    retryDelayMs?: (attempt: number) => number;
    /** Opens a Tailscale approval page in the default browser, on the user's press. */
    openExternal?: (url: string) => Promise<void>;
  }) {
    this.store = new AtomicJsonStore(join(options.directory, 'remote-hosts.json'), z.array(savedHostSchema).max(20).parse, () => [])
    this.admins = new AdminConnections({ ...(options.launcher ? { launcher: options.launcher } : {}), report: (id, report) => this.adminSignIn(id, report),
      node: (id, node) => this.nodePaths.set(id, node), identityChanged: () => new FinalHostError('The host identity changed. Check its data folder before connecting again.') })
  }
  /**
   * Reads the saved hosts and starts connecting every host that is switched on, in the background, the way a
   * dropped connection reconnects: Reconnecting… on the row, the same backoff, and a stop at a failure only
   * the user can fix. Nothing here waits for a host to answer.
   */
  async start(): Promise<void> {
    this.saved = await this.store.read()
    for (const host of this.saved) this.status.set(host.id, { ...this.fields(host), ...(host.hostId ? { hostId: host.hostId } : {}), ...(host.clientId ? { clientId: host.clientId } : {}), phase: 'disconnected' })
    for (const host of this.saved) if (host.enabled !== false) this.keepConnected(host, true)
  }
  get(): HostsState {
    const state = this.options.router.shell(); const local = state.connections?.find(item => item.kind === 'local')
    const adding = this.adding ? this.status.get(this.adding.id) : undefined
    const setup = this.setup?.state(), setupChoice = this.setup?.choice(), providerJob = this.providerJob?.state()
    return { ...(state.hostId ? { activeHostId: state.hostId } : {}), ...(local ? { localHostId: local.hostId } : {}),
      hosts: this.saved.map(host => ({ ...this.status.get(host.id)!, ...this.fields(host) })),
      ...(adding ? { adding: { ...adding, ...this.fields(this.adding!) } } : {}),
      ...(setup ? { setup } : {}), ...(setupChoice ? { setupChoice } : {}), ...(providerJob ? { providerJob } : {}),
      ...(this.updates ? { updates: this.updates.state() } : {}),
      // A forgotten host's last answer is left out with its row.
      ...(this.phones ? { phones: this.phones.state().filter(view => this.saved.some(host => host.id === view.id)) } : {}),
      ...(this.forgotten.length ? { forgotten: [...this.forgotten] } : {}),
      localHostRunning: this.options.localHostRunning, localHostEnabled: this.options.localHostEnabled() }
  }
  /** Gives Settings > Hosts the host setup: its state joins every published state, and its commands go to it. */
  useSetup(setup: HostSetupSource): void {
    this.unsubscribeSetup?.()
    this.setup = setup
    this.unsubscribeSetup = setup.subscribe(() => this.emit())
    this.emit()
  }
  /** Gives the tiles the provider job: its state joins every published state, and its Start and Stop go to it. */
  useProviderJob(job: HostProviderJobSource): void {
    this.unsubscribeProviderJob?.()
    this.providerJob = job
    this.unsubscribeProviderJob = job.subscribe(() => this.emit())
    this.emit()
  }
  /** Gives the Threads page the host updates: their state joins every published state, and the panel's presses go to them. */
  useUpdates(updates: HostUpdateSource): void {
    this.unsubscribeUpdates?.()
    this.updates = updates
    this.unsubscribeUpdates = updates.subscribe(() => this.emit())
    this.emit()
  }
  /** Gives Settings > Hosts each host's phone access: its state joins every published state, and the dialog's presses go to it. */
  usePhones(phones: HostPhonesSource): void {
    this.unsubscribePhones?.()
    this.phones = phones
    this.unsubscribePhones = phones.subscribe(() => this.emit())
    this.emit()
  }
  /** Saved hosts connected now, each with the connection it is on and the way its phone access is reached (ADR-0050, ADR-0053). */
  phonesLinks(): HostPhonesLink[] {
    return this.saved.flatMap(host => {
      const active = this.live.get(host.id), status = this.status.get(host.id)
      // A press queued behind another runs only while this link's connect is still the host's: after a Disconnect or a drop
      // it would otherwise open a sign-in nobody asked for.
      const current = (): boolean => this.live.get(host.id) === active
      return active && status?.phase === 'connected' && status.hostId ? [{ id: host.id, name: host.name, hostId: status.hostId, generation: active.generation,
        press: request => current() ? this.press(host, request) : Promise.reject(new Error(`${host.name} is not connected. Nothing was changed.`)),
        pressIfOpen: request => this.pressIfOpen(host, request) }] : []
    })
  }
  /** Saved hosts an update can reach now, with the Sotto version each said it runs (ADR-0040). */
  updateCandidates(): HostUpdateCandidate[] {
    return this.saved.flatMap(host => {
      const status = this.status.get(host.id)
      if (!status?.version || !status.hostId || !this.live.has(host.id) || !this.reachable(host.id)) return []
      return [{ id: host.id, name: host.name, hostId: status.hostId, version: status.version, owned: status.owned === true, installPath: host.installPath, dataDirectory: host.dataDirectory }]
    })
  }
  /** One operation of a host update, over the SSH connection the host is on or an admin connection. */
  async runUpdate(id: string, operation: SshHostUpdateOperation, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult> {
    const host = this.saved.find(item => item.id === id)
    if (!host || !this.live.has(id) || !this.reachable(id)) throw new Error(`${host?.name ?? 'This host'} is not connected. Nothing was changed.`)
    return this.press(host, connection => connection.updateHost(operation, options))
  }
  /**
   * An update's restart: the launch script starts `version` in place of the running host, or the old one again, and this
   * computer then connects again. The host stops on purpose, so its drop is not a lost connection, and its threads stay on
   * the Threads page, reading Reconnecting with their drafts kept, until the new connection takes their place. The promise
   * waits for the first connect.
   */
  async restartForUpdate(id: string, version: string, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult> {
    const host = this.saved.find(item => item.id === id)
    if (!host) throw new Error('This host is no longer saved. Nothing was changed.')
    this.requireOwnedConnection(host)
    let signedIn = false
    try { return await this.press(host, connection => { signedIn = true; return this.restartOver(host, connection, version, options) }) }
    catch (error) {
      // An admin connection that cannot open sends nothing, so the update says the restart never went.
      if (!signedIn) throw new SshFailure('not-connected', error instanceof Error ? error.message : undefined)
      throw error
    }
  }
  private restartOver(host: SavedHost, connection: PressConnection, version: string, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult> {
    return this.restartOnPurpose(host, () => connection.updateHost({ op: 'update-restart', version }, options),
      result => result.type === 'error' && UNTOUCHED_RESTARTS.has(result.reason))
  }
  /**
   * Start at boot for a saved host (ADR-0054): installs its unit, or removes it, over the SSH connection the host is on or
   * an admin connection. Removing starts the host again only when the saved host is switched on, so a host that is
   * switched off stays stopped. Either may stop the host this computer is connected to on purpose, so its drop is not a
   * lost connection: its threads stay on the Threads page reading Reconnecting, and this computer connects again, as after
   * an update's restart. A failure the host reports comes back as its `error` result.
   */
  async setBootStart(id: string, action: 'install' | 'remove'): Promise<SshBootResult> {
    const host = this.saved.find(item => item.id === id)
    if (!host) throw new Error('This host is no longer saved. Nothing was changed.')
    const busy = this.updates?.busy(id)
    if (busy) throw new Error(busy)
    if (!this.live.has(id) || this.status.get(id)?.phase !== 'connected') throw new Error(`Connect to ${host.name} before changing whether its host starts at boot. Nothing was changed.`)
    return this.press(host, connection => this.restartOnPurpose(host, async () => {
      const result = await connection.boot(action === 'install' ? { op: 'boot-install' } : { op: 'boot-remove', restart: host.enabled !== false })
      if (result.type !== 'error') this.update(id, { bootStart: result.bootStart })
      return result
    }, result => result.type === 'error' ? UNTOUCHED_BOOT_CHANGES.has(result.reason) : result.type === 'boot-status' || !result.stopped))
  }
  /**
   * Runs an operation that may stop the host this computer is connected to on purpose: an update's restart, or a change to
   * start at boot. Its drop is not a lost connection, so the host's threads stay on the Threads page reading Reconnecting
   * until a new connection takes their place, and the promise waits for the first connect. When nothing was stopped,
   * because the operation was never sent or `untouched` says the host answered before stopping anything, the same
   * connection carries on and the threads read as they did.
   */
  private async restartOnPurpose<T>(host: SavedHost, operation: () => Promise<T>, untouched: (result: T) => boolean): Promise<T> {
    const id = host.id
    const active = this.live.get(id)
    if (!active) throw new SshFailure('not-connected', `${host.name} is not connected. Nothing was changed.`)
    active.closing = true
    this.clearRetry(id)
    const registered = active.registeredHostId
    this.hold(id, active)
    let result: { readonly value: T } | undefined, unsent = false
    try { result = { value: await operation() }; return result.value }
    catch (error) { unsent = error instanceof SshFailure && (error.code === 'request-busy' || error.code === 'not-connected'); throw error }
    finally {
      if ((unsent || (result !== undefined && untouched(result.value))) && this.live.get(id) === active && this.status.get(id)?.phase === 'connected') {
        active.closing = false
        if (registered) { this.held.delete(id); active.registeredHostId = registered; this.options.router.setReconnecting(registered, false) }
      } else if (!this.closed && this.saved.includes(host) && host.enabled !== false) {
        // A reconnect, with the backoff behind it: the row reads Reconnecting…, as it does after a drop.
        this.retries.set(id, { timer: undefined, attempt: 0, active: undefined })
        await this.open(host).catch(() => undefined)
      } else this.releaseHeld(id)
    }
  }
  /**
   * Keeps a host's threads on the Threads page, reading Reconnecting with their drafts kept, while its connection is
   * replaced: after a drop, or through an update's restart. The next connection to the same host takes their place.
   */
  private hold(id: string, active: LiveHost): void {
    const registered = active.registeredHostId
    if (!registered) return
    delete active.registeredHostId
    this.held.set(id, registered)
    this.options.router.setReconnecting(registered, true)
  }
  /** Takes a held host's threads off the Threads page, once no connection will take its place. */
  private releaseHeld(id: string): void {
    const held = this.held.get(id)
    if (!held) return
    this.held.delete(id)
    this.options.router.remove(held)
  }
  /** A saved host as a provider job needs it. */
  jobHost(id: string): ProviderJobHost | undefined {
    const host = this.saved.find(item => item.id === id)
    return host ? { name: host.name, target: host.target, ...(host.sshPort ? { sshPort: host.sshPort } : {}), connected: this.status.get(id)?.phase === 'connected' } : undefined
  }
  /** One of a connected saved host's providers, as that host last published it (ADR-0037). */
  providerStatus(id: string, provider: ProviderId): AgentProviderStatus | undefined {
    const hostId = this.status.get(id)?.phase === 'connected' ? this.status.get(id)?.hostId : undefined
    if (!hostId) return undefined
    return this.options.router.shell().host.clientHosts?.find(item => item.hostId === hostId)?.providers?.find(item => item.id === provider)
  }
  /** Check again for a provider job: the host's refresh for one provider, and the status the host answered with. */
  async refreshProvider(id: string, provider: ProviderId): Promise<{ status?: AgentProviderStatus; error?: string }> {
    const { host, socket } = this.connectedSocket(id)
    const state = await socket.command({ type: 'refresh', provider })
    const status = state.host.providers?.find(item => item.id === provider)
    return { ...(status ? { status } : {}), ...(state.error ? { error: nameHostInRefusal(state.error, host.name) } : {}) }
  }
  /** Where a check or an add stands: Add host's attempt, or the saved host it became. */
  attempt(id: string): HostStatus | undefined {
    const status = this.status.get(id)
    if (!status) return undefined
    const host = this.attemptHost(id) ?? this.saved.find(item => item.id === id)
    return host ? { ...status, ...this.fields(host) } : undefined
  }
  /** Add host's attempt or the setup's with this ID. */
  private attemptHost(id: string): SavedHost | undefined {
    return this.adding?.id === id ? this.adding : this.setupAttempt?.id === id ? this.setupAttempt : undefined
  }
  /** Whether this host is being added or checked, by Add host or the setup, and not saved yet. */
  private isAttempt(host: SavedHost): boolean { return this.adding === host || this.setupAttempt === host }
  /** The saved host a connection would duplicate, by target and port, as Add host refuses it. */
  savedAs(target: string, sshPort: number | undefined): string | undefined {
    return this.saved.find(item => item.target === target && (item.sshPort ?? 22) === (sshPort ?? 22))?.name
  }
  /** Drops Add host's or the setup's attempt when it is this one, as Cancel and Change do: nothing of it is kept. */
  cancelAttempt(id: string): Promise<void> { return this.cancelAdd(id) }
  /** The host setup's add (ADR-0035): Add host's add, in the setup's own slot. */
  async setupAdd(input: Connection): Promise<void> { await this.add(input, 'setup') }
  /**
   * Forgets a saved host the way its row's Forget does, for a setup stopped just as its add saved the host.
   * False when the host is not saved, so there was nothing to forget.
   */
  async forgetSaved(id: string): Promise<boolean> {
    if (!this.saved.some(item => item.id === id)) return false
    await this.command({ type: 'forget', id })
    return true
  }
  subscribe(listener: (state: HostsState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** What a row shows of a saved host: its connection, with `enabled` read as on when an older file left it out. */
  private fields(host: SavedHost): Omit<HostStatus, 'phase'> {
    const { enabled, ...fields } = remoteHostSchema.strip().parse(host)
    return { ...fields, enabled: enabled !== false }
  }
  private emit(): void { const state = this.get(); for (const listener of this.listeners) listener(state) }
  private update(id: string, patch: Partial<HostStatus>): void { const current = this.status.get(id); if (current) { this.status.set(id, { ...current, ...patch }); this.emit() } }
  private save(): Promise<void> {
    const value = structuredClone(this.saved)
    const pending = this.writing.then(() => this.store.write(value))
    this.writing = pending.catch(() => undefined)
    return pending
  }
  async command(command: HostsCommand): Promise<HostsState> {
    if (command.type === 'select') { this.options.router.select(command.hostId); this.emit(); return this.get() }
    if (command.type === 'restart') { this.options.restart(); return this.get() }
    if (command.type === 'add') return this.add(command.host)
    if (command.type === 'cancel-add') { await this.cancelAdd(command.id); return this.get() }
    if (command.type === 'open-approval') { await this.openApproval(command.id); return this.get() }
    if (command.type === 'dismiss-forgotten') {
      const left = this.forgotten.filter(item => item.id !== command.id)
      if (left.length !== this.forgotten.length) { this.forgotten = left; this.emit() }
      return this.get()
    }
    if (command.type === 'stop-admin-sign-in') { await this.admins.stopSigningIn(command.id); return this.get() }
    if (command.type === 'start-setup' || command.type === 'stop-setup' || command.type === 'dismiss-setup') {
      if (!this.setup) throw new Error('An agent cannot set up a host from this window. Nothing was started.')
      await this.setup.command(command)
      return this.get()
    }
    if (command.type === 'start-provider-job' || command.type === 'stop-provider-job') {
      if (!this.providerJob) throw new Error("An agent cannot work on a host's providers from this window. Nothing was started.")
      await this.providerJob.command(command)
      return this.get()
    }
    if (command.type === 'host-phones' || command.type === 'watch-host-phones') {
      if (!this.phones) throw new Error('Phone access on hosts cannot be changed from this window. Nothing was changed.')
      if (!this.saved.some(host => host.id === command.id)) throw new Error('This host is no longer saved. Add it again in Settings > Hosts.')
      if (command.type === 'watch-host-phones') this.phones.watch(command.id, command.watching)
      else await this.phones.command(command.id, command.command)
      return this.get()
    }
    if (command.type === 'host-update') {
      if (!this.updates) throw new Error('Hosts cannot be updated from this window. Nothing was changed.')
      await this.updates.command(command.id, command.action)
      return this.get()
    }
    if (this.attemptHost('id' in command ? command.id : command.host.id)) {
      // Add host's own questions, and the setup's, are answered where the attempt shows, and Cancel ends it.
      if (command.type === 'ssh-answer') { this.answerPrompt(command.id, command.promptId, command.answer); return this.get() }
      if (command.type === 'disconnect') { await this.cancelAdd(command.id); return this.get() }
    }
    if (CONNECTION_COMMANDS.has(command.type)) {
      const busy = this.updates?.busy('id' in command ? command.id : command.host.id)
      if (busy) throw new Error(busy)
    }
    if (command.type === 'save') return this.edit(command.host)
    const host = this.saved.find(item => item.id === command.id)
    if (!host) throw new Error('This host is no longer saved. Add it again in Settings > Hosts.')
    if (command.type === 'ssh-answer') {
      this.answerPrompt(host.id, command.promptId, command.answer)
      return this.get()
    }
    if (command.type === 'rename') {
      host.name = command.name
      const registered = this.live.get(host.id)?.registeredHostId
      if (registered) this.options.router.rename(registered, host.name)
      this.update(host.id, { name: host.name })
      await this.save(); return this.get()
    }
    // Switched off keeps the row, its pairing and a host Sotto started running; it only stops this computer
    // connecting, now and at launch. Switched on connects now and at every launch, retrying like a drop.
    if (command.type === 'set-enabled') {
      if (command.enabled) delete host.enabled; else host.enabled = false
      await this.save()
      if (!command.enabled) { this.clearRetry(host.id); await this.disconnect(host.id); this.update(host.id, { enabled: false }); return this.get() }
      this.update(host.id, { enabled: true })
      // Switching on again is also how a host that needs attention is tried again once its cause is fixed.
      if (!this.live.has(host.id) || this.status.get(host.id)?.phase === 'error') this.keepConnected(host)
      return this.get()
    }
    // Disconnect only closes this computer's connection. A host Sotto started keeps running, the same as
    // when Sotto quits, until Stop host or Forget stops it, because another paired client may still be using it.
    if (command.type === 'disconnect') { this.clearRetry(host.id); await this.disconnect(host.id); return this.get() }
    if (command.type === 'stop-host') {
      this.clearRetry(host.id)
      this.requireOwnedConnection(host)
      const active = this.live.get(host.id)
      if (active) active.closing = true
      const stopped = await this.press(host, connection => this.stopOwnedHost(connection)).catch(() => false)
      await this.disconnect(host.id)
      if (!stopped) throw new Error(this.notStopped(host))
      // A stopped host is switched off, so the next launch does not start it again; switching it on does.
      host.enabled = false
      this.update(host.id, { enabled: false })
      await this.save()
      return this.get()
    }
    if (command.type === 'forget') return this.forget(host)
    if (this.closed) return this.get()
    await this.open(host)
    return this.get()
  }
  /**
   * Forget (ADR-0053): revoke this computer's pairing on the host, stop a host Sotto started there, then remove the host
   * here. The revoke goes over the SSH connection the socket is on, or over an admin connection when it is on none, and
   * comes first, since it goes through the running host's administrative route and so cannot follow a stop. A host the
   * admin connection cannot reach or finds stopped, or one that refuses the revoke, is still removed here, and a
   * not-revoked notice names the command that revokes this computer on the host by hand. A host that refused is left
   * running, so that command can run there now. Only a stop that may have failed keeps the host saved, and so does a
   * sign-in the user stopped, which changes nothing.
   */
  private async forget(host: SavedHost): Promise<HostsState> {
    this.clearRetry(host.id)
    const active = this.live.get(host.id)
    // The revoke drops this computer's socket, and the stop closes the host under it: neither may reconnect or pair again.
    if (active) active.closing = true
    // A connect still under way, or one already lost, ends first: the revoke goes over a connection of its own. A connect
    // past its SSH sign-in but still pairing or opening its socket is under way too, and would close that SSH under the press.
    // Read before the disconnect below, which clears what the row knew of start at boot.
    const unit = this.status.get(host.id)?.bootStart?.installed === true
    if (!(this.reachable(host.id) && this.onSsh(host.id))) await this.disconnect(host.id)
    let cause: HostForgottenCause | undefined, stopFailed = false
    try {
      // A host that is not running has its boot unit taken away by the admin connection's own launch, which then fails
      // with `host-not-running`: there is nothing to revoke on, but the forgotten host must not start at the next boot.
      await this.press(host, async connection => {
        // Any answer is a revoke: `revoked: false` says the host no longer knew this computer. Only the launch script's own
        // failure is the host refusing, which leaves it running; a request that never got an answer is the host not reached,
        // and a host Sotto started is still stopped, or kept here if that fails too.
        const failure = host.clientId ? await connection.revokeClient(host.clientId).then(() => undefined, (error: unknown) => error ?? new Error('The revoke failed.')) : undefined
        if (failure instanceof SshFailure && failure.code === 'revoke-failed') { cause = 'refused'; return }
        if (failure) cause = 'unreachable'
        // Then its boot unit, so a forgotten host does not come back at the next boot (ADR-0054). Removing it starts nothing
        // and stops a host the unit runs. One that could not be removed stays on the host; Forget does not say so yet,
        // which item 7 of the tailnet plan, Start at boot's own surface, takes on.
        if (unit || connection.bootStart?.installed) await connection.boot({ op: 'boot-remove', restart: false }).catch(() => undefined)
        if (connection.owned) stopFailed = !(await this.stopOwnedHost(connection))
      }, { removeBoot: true })
    } catch (error) {
      // Forget's admin connection goes with its stopped sign-in: it signs in to take a stopped host's boot unit away, and
      // the next press, which wants no such thing, opens one of its own.
      if (error instanceof SignInStopped) { await this.admins.close(host.id); return this.keepAfterForget(host, active) }
      cause = error instanceof SshFailure && error.code === 'host-not-running' ? 'not-running' : 'unreachable'
    }
    if (stopFailed) { await this.disconnect(host.id); throw new Error(this.notStopped(host)) }
    await this.disconnect(host.id)
    await this.options.credentials.set(`remote-host:${host.id}`, '')
    this.saved = this.saved.filter(item => item.id !== host.id)
    await this.save()
    this.status.delete(host.id)
    if (cause && host.clientId) {
      const command = revokeByHandCommand({ installPath: host.installPath, dataDirectory: host.dataDirectory, clientId: host.clientId, node: this.nodePaths.get(host.id) })
      this.forgotten = [...this.forgotten.filter(item => item.id !== host.id), { id: host.id, name: host.name, cause, command }]
    }
    this.nodePaths.delete(host.id)
    this.emit()
    return this.get()
  }
  /** The user stopped Forget's sign-in: nothing was sent, so the host stays saved and connects again if it is on. */
  private keepAfterForget(host: SavedHost, active: LiveHost | undefined): HostsState {
    if (active && this.live.get(host.id) === active) active.closing = false
    else if (host.enabled !== false && !this.closed && this.saved.includes(host)) this.keepConnected(host)
    return this.get()
  }
  /**
   * Add host: connect first, from inside the dialog, and save the host only when it answers and this computer
   * pairs. On any failure nothing is saved, no credential is kept, and the dialog says what happened. One
   * exception: a host that answers but runs another Sotto version is saved, so its row can say which side to
   * update and offer Stop host for a host Sotto started.
   */
  private async add(input: Connection, slot: 'dialog' | 'setup' = 'dialog'): Promise<HostsState> {
    if (this.closed) return this.get()
    this.refuseBusySlot(input, slot)
    if (this.saved.some(item => item.id === input.id)) throw new Error('This host is already saved.')
    validateConnection(input)
    const duplicate = this.saved.find(item => item.target === input.target && (item.sshPort ?? 22) === (input.sshPort ?? 22))
    if (duplicate) throw new Error(`${input.target} is already saved as ${duplicate.name}. ${NOTHING_SAVED} Switch it on in the list instead.`)
    const previous = slot === 'dialog' ? this.adding : this.setupAttempt
    if (previous) await this.cancelAdd(previous.id)
    const host: SavedHost = { ...input }
    if (slot === 'dialog') this.adding = host; else this.setupAttempt = host
    this.status.set(host.id, { ...this.fields(host), phase: 'connecting' })
    this.emit()
    const pending = this.open(host)
    if (slot === 'dialog') this.pendingAdd = pending.catch(() => undefined); else this.pendingSetup = pending.catch(() => undefined)
    await pending
    return this.get()
  }
  /**
   * Add host and the setup each connect to one machine at a time, and never both to the same one, so two adds
   * cannot save it twice. Anything else runs side by side: neither cancels the other's attempt.
   */
  private refuseBusySlot(input: Connection, slot: 'dialog' | 'setup'): void {
    const own = slot === 'dialog' ? this.adding : this.setupAttempt, other = slot === 'dialog' ? this.setupAttempt : this.adding
    const connecting = (host: SavedHost | undefined): host is SavedHost => host !== undefined && this.status.get(host.id)?.phase === 'connecting'
    if (connecting(own)) throw new Error(`Sotto is still connecting to ${targetHost(own.target)}. Wait for it, or cancel it first.`)
    if (connecting(other) && other.target === input.target && (other.sshPort ?? 22) === (input.sshPort ?? 22)) {
      throw new Error(slot === 'dialog'
        ? `An agent is connecting to ${targetHost(input.target)} for its host setup right now. ${NOTHING_SAVED} Wait for it, or stop the setup first.`
        : `Add host is connecting to ${targetHost(input.target)} right now. ${NOTHING_SAVED} Wait for it to finish, then try again.`)
    }
  }
  private async cancelAdd(id: string): Promise<void> {
    const host = this.attemptHost(id)
    if (!host) return
    if (this.adding === host) this.adding = undefined; else this.setupAttempt = undefined
    // Pairing already finished, so the host holds a record of this computer that nothing will use. Revoke it
    // while the connection is still open; `closing` keeps the drop the revoke causes from being read as a failure.
    const active = this.live.get(id)
    if (host.clientId && active && this.onSsh(id)) { active.closing = true; await this.press(host, connection => connection.revokeClient(host.clientId!)).catch(() => false) }
    await this.disconnect(id)
    this.status.delete(id)
    this.nodePaths.delete(id)
    await this.forgetCredential(id)
    this.emit()
  }
  /**
   * Opens the approval page Tailscale SSH gave for a connect it is holding, in the default browser. Main holds
   * the URL and opens only Tailscale's own page, only while the connect still waits for it.
   */
  private async openApproval(id: string): Promise<void> {
    const url = this.status.get(id)?.tailscale?.url
    if (!this.status.get(id)?.tailscale?.waiting || !url || !isTailscaleApprovalUrl(url)) throw new Error('Tailscale is no longer waiting for this approval. Nothing was opened.')
    if (!this.options.openExternal) throw new Error('The approval page could not be opened from this window. Approve the connection in Tailscale on this computer.')
    try { await this.options.openExternal(url) }
    catch { throw new Error('The approval page could not open in your browser. Nothing was changed. Try Open approval page again.') }
  }
  /**
   * The host's own connect, disconnect or refresh for one of its providers, from its tile in Settings > Hosts (ADR-0037).
   * It goes to that host and nowhere else: nothing about this computer's providers changes. A refusal comes back to the
   * tile, named for the host, rather than to the Threads page.
   */
  async providerAction(action: HostProviderAction): Promise<HostProviderActionResult> {
    const { host, socket } = this.connectedSocket(action.id)
    const state = await socket.command({ type: action.action, provider: action.provider })
    return state.error ? { error: nameHostInRefusal(state.error, host.name) } : {}
  }
  /**
   * Update from a provider tile, or Update all (#480): the clients join that host's own update line, which runs them one
   * at a time and answers at once. How each goes comes back in the host's shell. A host that does not list
   * `client-updates` shows no update on its tiles; if one is asked for anyway, nothing is sent to it.
   */
  async updateClients(request: HostClientUpdateRequest): Promise<HostProviderActionResult> {
    const { host, socket } = this.connectedSocket(request.id)
    if (!socket.offersClientUpdates()) throw new Error(`The host on ${host.name} cannot update its clients from here. Nothing was changed. Put this computer's version of the host on ${host.name}, stop the host and connect again.`)
    const state = await socket.command({ type: request.action === 'cancel' ? 'cancel-client-updates' : 'queue-client-updates', providers: request.providers })
    return state.error ? { error: nameHostInRefusal(state.error, host.name) } : {}
  }
  /**
   * A provider's sign-in on a connected host (ADR-0037), for Settings > Hosts. The host runs the client and holds what it
   * printed; the window gets the code to show and never the page's address. Open sign-in page asks the host for the page
   * again, checks it is one of that provider's own, and opens it in the default browser, keeping nothing here.
   */
  async signIn(request: HostSignInRequest): Promise<ProviderSignInView | null> {
    const { host, socket } = this.connectedSocket(request.id)
    if (!socket.offersSignIn()) throw new Error(`The host on ${host.name} cannot sign in its providers from here. Nothing was changed. Put this computer's version of the host on ${host.name}, stop the host and connect again.`)
    let view: HostSignIn | null
    if (request.type === 'start') view = await socket.signIn({ op: 'sign-in-start', provider: request.provider })
    else if (request.type === 'read') view = await socket.signIn({ op: 'sign-in-read', signInId: request.signInId })
    else if (request.type === 'code') view = await socket.signIn({ op: 'sign-in-code', signInId: request.signInId, code: request.code })
    else if (request.type === 'cancel') { await socket.signIn({ op: 'sign-in-cancel', signInId: request.signInId }); return null }
    else {
      view = await socket.signIn({ op: 'sign-in-read', signInId: request.signInId })
      if (!view || view.stage !== 'waiting' || !view.url || !isProviderSignInPage(view.provider, view.url)) throw new Error('This sign-in is no longer waiting for you. Nothing was opened. Start it again.')
      if (!this.options.openExternal) throw new Error('The sign-in page could not be opened from this window. Nothing was changed.')
      try { await this.options.openExternal(view.url) }
      catch { throw new Error('The sign-in page could not open in your browser. Nothing was changed. Try Open sign-in page again.') }
    }
    if (!view) return null
    const shown: HostSignIn = { ...view }
    delete shown.url
    return shown
  }
  /** The live connection to a saved host that is connected now, for what its tiles ask of it. */
  private connectedSocket(id: string): { host: SavedHost; socket: SocketHostService } {
    const host = this.saved.find(item => item.id === id)
    const socket = this.live.get(id)?.socket
    if (!host || !socket || this.status.get(id)?.phase !== 'connected') throw new Error(`${host?.name ?? 'This host'} is not connected. Nothing was changed. Switch it on, then try again.`)
    return { host, socket }
  }
  /** Removes a credential a failed or cancelled add left behind; the desktop keeps nothing for a host it did not save. */
  private async forgetCredential(id: string): Promise<void> {
    if (this.options.credentials.has(`remote-host:${id}`)) await this.options.credentials.set(`remote-host:${id}`, '')
  }
  /** Moves the host Add host connected to into the saved list, switched on. */
  private async commitAdd(host: SavedHost): Promise<void> {
    if (!this.isAttempt(host)) return
    if (this.adding === host) this.adding = undefined; else this.setupAttempt = undefined
    delete host.enabled
    this.saved = [...this.saved, host]
    await this.save()
    this.emit()
  }
  /**
   * Edit connection. The new connection takes effect on a fresh connect, so a live one closes first, including
   * a host of another version whose SSH session is kept only for Stop host; a host that is on connects again.
   */
  private async edit(input: Connection): Promise<HostsState> {
    const existing = this.saved.find(item => item.id === input.id)
    if (!existing) throw new Error('This host is no longer saved. Add it again in Settings > Hosts.')
    validateConnection(input)
    await this.disconnect(existing.id)
    // Editing a route must not silently transfer a credential to a different host: the saved host identity stays
    // and is checked on the next connect. The switch is not part of the connection, so it stays as it was.
    const next: SavedHost = { ...existing, ...input }
    if (input.sshPort === undefined) delete next.sshPort
    this.saved = this.saved.map(item => item.id === next.id ? next : item)
    this.status.set(next.id, { ...this.status.get(next.id)!, ...this.fields(next), phase: 'disconnected' })
    await this.save(); this.emit()
    if (next.enabled !== false) this.keepConnected(next)
    return this.get()
  }
  /**
   * Connects now and keeps the host connected: a failure a retry can fix is retried on the reconnect backoff,
   * as a dropped connection is. At launch the row reads Reconnecting… from the first attempt; after a switch-on
   * or an edit, the first attempt reads Connecting… and only a retry reads Reconnecting….
   */
  private keepConnected(host: SavedHost, atLaunch = false): void {
    if (this.closed) return
    this.clearRetry(host.id)
    this.retries.set(host.id, { timer: undefined, attempt: 0, active: undefined, ...(atLaunch ? {} : { first: true }) })
    void this.open(host).catch(() => undefined)
  }
  private async open(host: SavedHost): Promise<void> {
    const adding = this.isAttempt(host)
    const wasOn = host.enabled !== false
    if (this.live.has(host.id)) await this.disconnect(host.id, true)
    // Tearing down the previous session takes a moment. A switch-off, Forget, edit or cancelled add in that
    // moment already cleared the row, so this attempt has nothing left to connect for.
    if (this.closed || (adding ? !this.isAttempt(host) : !this.saved.includes(host)) || (wasOn && host.enabled === false)) return
    const active: LiveHost = { launcher: this.options.launcher?.() ?? new SshHostLauncher(), generation: ++this.generation }
    this.live.set(host.id, active)
    this.status.set(host.id, { ...this.status.get(host.id), ...this.fields(host), phase: 'connecting', reconnecting: this.retries.has(host.id) && !this.retries.get(host.id)!.first, error: undefined,
      step: 'reach', tailscale: undefined, fix: undefined, reason: undefined, checked: undefined, version: undefined }); this.emit()
    try {
      const ssh = active.ssh = await active.launcher.connect(this.route(host), {
        ...this.progress(host, active),
        onDisconnected: () => { active.sshClosed = true; if (this.live.get(host.id) === active && !active.closing) this.dropped(host, active) },
      })
      if (this.live.get(host.id) !== active) { await ssh.close(); return }
      if (ssh.node) this.nodePaths.set(host.id, ssh.node)
      this.update(host.id, { step: 'pair' })
      if (host.hostId && host.hostId !== ssh.hostId) throw new FinalHostError('The host identity changed. Check its data folder before connecting again.')
      const same = adding ? this.saved.find(item => item.hostId === ssh.hostId) : undefined
      if (same) throw new FinalHostError(`This is the same host as ${same.name}, which is already saved. Switch ${same.name} on in the list instead.`)
      this.update(host.id, { hostId: ssh.hostId })
      if (!this.options.credentials.has(`remote-host:${host.id}`)) await this.pairOverSsh(host, active)
      await this.openSocket(host, active, { url: ssh.url, expectedHostId: ssh.hostId })
      if (adding) {
        if (this.isAttempt(host) && this.live.get(host.id) === active) await this.commitAdd(host)
        // Cancelled while the socket opened: the credential it paired with belongs to nothing.
        else await this.forgetCredential(host.id)
      }
    } catch (error) {
      let failure = error instanceof Error ? error : new Error('The host could not connect. Check its SSH settings and try again.')
      const otherVersion = error instanceof HostConnectionError && error.code === 'version_mismatch' && this.live.get(host.id) === active
      // A host that answers with another version is the right host, so Add host keeps it (see add()).
      if (otherVersion && this.isAttempt(host)) await this.commitAdd(host)
      if (otherVersion && active.ssh) {
        const newer = active.socket?.hostIsNewer() ?? false
        const version = active.socket?.sottoVersion()
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        // An older host Sotto started keeps its SSH session, so Stop host can reach the host the sentence
        // names. Connect closes that session first. A host Sotto did not start, or one newer than this
        // computer, has nothing to keep it for: the sentence already says what to do instead.
        if (active.ssh.owned && !newer) {
          this.clearRetry(host.id)
          this.releaseHeld(host.id)
          // Its version, when it said one, is what lets the Threads page offer to update it (ADR-0040).
          this.update(host.id, { phase: 'error', reconnecting: false, owned: true, error: failure.message, version, bootStart: active.ssh.bootStart })
          return
        }
      }
      if (!adding && error instanceof HostConnectionError && error.pairingRequired && this.live.get(host.id) === active && !active.closing && active.ssh) {
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        await this.options.credentials.set(`remote-host:${host.id}`, '')
        try {
          await this.pairOverSsh(host, active)
          await this.openSocket(host, active, { url: active.ssh.url, expectedHostId: active.ssh.hostId })
          this.clearRetry(host.id)
          return
        } catch (repair) {
          // A busy host refused the pairing for a minute; that passes by itself, so it is not a final failure.
          failure = repair instanceof HostConnectionError && repair.code === 'busy' ? repair : new FinalHostError('This device is no longer paired and could not pair again. Check the host, then connect again.')
        }
      }
      const { step, fix, reason, waited } = this.failureFields(host, active, failure)
      const unsaved = adding && !this.saved.includes(host)
      if (unsaved && host.clientId && active.ssh && this.live.get(host.id) === active) {
        // Pairing finished before the failure, so the host holds a record of this computer that nothing will
        // use. Revoke it while the connection is open; failing that, it stays revocable on the host.
        await active.ssh.revokeClient(host.clientId).catch(() => false)
      }
      await active.socket?.close().catch(() => undefined)
      await active.launcher.disconnect().catch(() => undefined)
      // Superseded: switched off, disconnected, stopped or replaced by a newer attempt while this one ran. Whatever
      // did that has already set the row, and a cancelled connect is not something to report or retry.
      const current = this.live.get(host.id) === active
      if (current) this.live.delete(host.id)
      if (unsaved) {
        delete host.hostId; delete host.clientId
        this.nodePaths.delete(host.id)
        await this.forgetCredential(host.id)
        // A cancelled add has no dialog left to tell.
        if (this.isAttempt(host)) this.update(host.id, { phase: 'error', reconnecting: false, error: unsavedMessage(failure.message), step, fix, reason, tailscale: waited })
        return
      }
      // A host forgotten or edited while it connected has no row left for this attempt to report to.
      if (!this.saved.includes(host) || !current) return
      if (this.retries.has(host.id) && !this.final(failure) && !this.status.get(host.id)?.prompt) {
        this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
        this.scheduleReconnect(host, undefined)
      } else {
        this.clearRetry(host.id)
        this.releaseHeld(host.id)
        this.update(host.id, { phase: 'error', reconnecting: false, error: failure.message, step, fix, reason, tailscale: waited })
      }
    }
  }
  /** The SSH connection the launcher is asked for: the saved route and folders. */
  private route(host: SavedHost): Parameters<SshHostLauncher['connect']>[0] {
    return { target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory,
      ...(host.sshPort ? { sshPort: host.sshPort } : {}), ...(host.identityFile ? { identityFile: host.identityFile } : {}) }
  }
  /** What a connect reports as it goes: SSH's questions, the checklist step, and Tailscale's approval. */
  private progress(host: SavedHost, active: LiveHost): Pick<SshCallbacks, 'onPrompt' | 'onStep' | 'onApproval'> {
    return {
      onPrompt: prompt => { if (this.live.get(host.id) !== active) return; const state = this.status.get(host.id); if (state) { if (prompt) state.prompt = prompt; else delete state.prompt; this.emit() } },
      onStep: step => { if (this.live.get(host.id) === active) this.update(host.id, { step }) },
      // The approval page reaches the window's state and the browser on a press, and nowhere else.
      onApproval: approval => { if (this.live.get(host.id) === active) this.update(host.id, { tailscale: approval ? { waiting: true, ...(approval.url ? { url: approval.url } : {}) } : this.status.get(host.id)?.tailscale ? { waiting: false } : undefined }) },
    }
  }
  /** The checklist step a failure belongs to, the command that fixes it where there is one, and its code. */
  private failureFields(host: SavedHost, active: LiveHost, failure: Error): { step: HostSetupStep; fix: HostStatus['fix']; reason: string | undefined; waited: HostStatus['tailscale'] } {
    const reached = this.status.get(host.id)?.step
    const step: HostSetupStep = failure instanceof SshFailure ? failureStep(failure.code) ?? reached ?? 'reach' : active.ssh ? 'pair' : reached ?? 'reach'
    const fix = failure instanceof SshFailure && failure.fix ? { text: failure.fix.text, command: failure.fix.command } : undefined
    const reason = failure instanceof SshFailure ? failure.code : failure instanceof HostConnectionError ? failure.code : undefined
    return { step, fix, reason, waited: this.status.get(host.id)?.tailscale ? { waiting: false } : undefined }
  }
  /**
   * A host setup check (ADR-0035): Add host's own connect on a device, as far as the host answering through the
   * forward, and nothing more. It pairs nothing and saves nothing. It runs in the setup's own slot, beside any
   * attempt of Add host's, so neither cancels the other; the setup's checklist shows it, and SSH's questions and
   * Tailscale's approval are answered there.
   */
  async check(input: Connection): Promise<HostStatus | undefined> {
    if (this.closed) throw new Error('Sotto is closing. Nothing was checked.')
    this.refuseBusySlot(input, 'setup')
    validateConnection(input)
    if (this.setupAttempt) await this.cancelAdd(this.setupAttempt.id)
    const host: SavedHost = { ...input }
    this.setupAttempt = host
    this.status.set(host.id, { ...this.fields(host), phase: 'connecting', step: 'reach' })
    this.emit()
    const pending = this.runCheck(host)
    this.pendingSetup = pending.catch(() => undefined)
    await pending
    return this.attempt(host.id)
  }
  private async runCheck(host: SavedHost): Promise<void> {
    const active: LiveHost = { launcher: this.options.launcher?.() ?? new SshHostLauncher(), generation: ++this.generation }
    this.live.set(host.id, active)
    try {
      active.ssh = await active.launcher.connect(this.route(host), this.progress(host, active))
      // Reached, signed in, installed and started: everything a check asks. The forward closes unpaired.
      active.closing = true
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) !== active) return
      this.live.delete(host.id)
      if (this.setupAttempt === host) this.update(host.id, { phase: 'disconnected', step: 'pair', checked: true, owned: active.ssh.owned })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('The host could not connect. Check its SSH settings and try again.')
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) !== active) return
      this.live.delete(host.id)
      const { step, fix, reason, waited } = this.failureFields(host, active, failure)
      // A cancelled check has no dialog left to tell.
      if (this.setupAttempt === host) this.update(host.id, { phase: 'error', reconnecting: false, error: unsavedMessage(failure.message), step, fix, reason, tailscale: waited })
    }
  }
  /** Pairs this computer over the SSH connection's forward, the only place a desktop pairs (ADR-0053). */
  private async pairOverSsh(host: SavedHost, active: LiveHost): Promise<void> {
    if (!this.options.credentials.available()) throw new FinalHostError('Secure credential storage is unavailable. Unlock it before connecting again.')
    const ssh = active.ssh!
    const code = await ssh.showHostPairingCode()
    const pairing = await SocketHostService.pair(ssh.url, code.code, 'Sotto desktop')
    // Cancelled or quit while pairing: keep no credential. The record the host made stays revocable there.
    if (this.live.get(host.id) !== active) throw new Error('The connection was closed while this computer paired.')
    if (pairing.hostId !== ssh.hostId || host.hostId && pairing.hostId !== host.hostId) throw new Error('This is a different host. Check the address before pairing.')
    try { await this.options.credentials.set(`remote-host:${host.id}`, pairing.token) }
    catch (error) {
      await ssh.revokeClient(pairing.clientId).catch(() => false)
      throw error
    }
    host.hostId = pairing.hostId; host.clientId = pairing.clientId
    if (this.saved.includes(host)) await this.save()
  }
  /** Final by its code: a failure on this side, an SSH failure only the user can fix, or a host of another Sotto version. */
  private final(error: Error): boolean {
    return error instanceof FinalHostError || (error instanceof SshFailure && FINAL_SSH_FAILURES.has(error.code)) || (error instanceof HostConnectionError && error.code === 'version_mismatch')
  }
  private clearRetry(id: string): void { const entry = this.retries.get(id); if (entry) { clearTimeout(entry.timer); this.retries.delete(id) } }
  private scheduleReconnect(host: SavedHost, active: LiveHost | undefined): void {
    if (this.closed) return
    const previous = this.retries.get(host.id)
    if (previous) clearTimeout(previous.timer)
    const entry: Retry = { attempt: previous?.attempt ?? 0, active, timer: undefined }
    entry.timer = setTimeout(() => {
      if (this.retries.get(host.id) !== entry) return
      if (entry.active && (this.live.get(host.id) !== entry.active || entry.active.closing)) return
      // A host switched off is not reconnected, whatever scheduled this.
      if (host.enabled === false) { this.retries.delete(host.id); return }
      // Sotto's own retry, not the user's Connect, so an update under way on this host does not hold it back: a connection
      // dropped partway through an update is one the update needs back.
      if (this.closed || !this.saved.includes(host)) return
      void this.open(host).catch(() => undefined)
    }, (this.options.retryDelayMs ?? reconnectDelayMs)(entry.attempt))
    entry.attempt += 1
    this.retries.set(host.id, entry)
  }
  private dropped(host: SavedHost, active: LiveHost): void {
    const status = this.status.get(host.id)
    // The SSH session kept open for Stop host has ended, so Stop host can no longer reach the host.
    if (!active.closing && status?.phase === 'error' && status.owned) { this.update(host.id, { owned: undefined }); return }
    // A host still being added is not saved yet: its drop fails the add rather than scheduling a reconnect.
    if (active.closing || status?.phase !== 'connected' || !this.saved.includes(host)) return
    // A host that is switched off is not kept connected: its drop only closes what is left of the session.
    if (host.enabled === false) { void this.disconnect(host.id).catch(() => undefined); return }
    // Its threads stay on the page, reading Reconnecting, until the next connection takes their place or a failure only
    // the user can fix takes them away (ADR-0053).
    this.hold(host.id, active)
    this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
    if (!this.status.get(host.id)!.prompt) this.scheduleReconnect(host, active)
  }
  private async openSocket(host: SavedHost, active: LiveHost, target: SocketTarget): Promise<void> {
    let connected = false, pushError: string | undefined
    // A push error stays on the row only until what it was about arrives, so a thread that was once too large
    // does not keep saying so after it fits again.
    const socket = new SocketHostService({ getSelectedThreadId: () => {
      const selected = this.options.router.shell().activeThreadId
      const picked = selected ? parseHostEntityKey(selected) : null
      return picked?.hostId === target.expectedHostId ? picked.id : null
    }, onConnectionChange: value => { connected = value; if (!value && this.live.get(host.id) === active) this.dropped(host, active) },
      onPushError: message => { if (this.live.get(host.id) === active) { pushError = message; this.update(host.id, { error: message }) } },
      onPushErrorCleared: () => { if (this.live.get(host.id) === active && pushError !== undefined && this.status.get(host.id)?.error === pushError) this.update(host.id, { error: undefined }); pushError = undefined }, url: target.url, token: this.options.credentials.get(`remote-host:${host.id}`), expectedHostId: target.expectedHostId, owned: active.ssh?.owned === true,
      // Nothing on the desktop reads a host's event log, so a connect asks for none of it.
      catchUpEvents: false })
    active.socket = socket
    const hello = await socket.connect()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    // Use the host's authenticated client identity, never a saved or renderer-supplied ID. The SSH
    // account establishes the default only when this client has no policy history (ADR-0025), and only over the SSH
    // connection this connect signed in with: a socket on no SSH connection leaves it for the next one (ADR-0053).
    if (!hello.capabilities.mayAnswer && active.ssh) await active.ssh.ensureDesktopAnswers(hello.clientId)
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    this.update(host.id, { version: hello.sottoVersion })
    host.hostId = hello.hostId; host.clientId = hello.clientId
    if (this.saved.includes(host)) await this.save()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    if (!connected) throw new Error('The host disconnected while connecting. Try connecting again.')
    const connection: DesktopHostConnection = { hostId: hello.hostId, name: host.name, kind: 'remote', service: socket,
      detail: id => socket.readThreadDetail(id), preview: request => socket.attachmentPreview(request), observe: ids => socket.observe(ids),
      stage: image => socket.stageAttachment(image), content: digest => socket.attachmentContent(digest),
      gitRefs: request => socket.gitRefs(request), gitChangedFiles: request => socket.gitChangedFiles(request), gitPullRequest: request => socket.gitPullRequest(request),
      hostFolders: request => socket.hostFolders(request), offersClientUpdates: () => socket.offersClientUpdates(),
      // A thread's Files, Changes and Agents, read on the host (ADR-0025, October 5 amendment).
      threadFiles: request => socket.threadFiles(request), threadFilePreview: request => socket.threadFilePreview(request),
      gitChanges: request => socket.gitChanges(request), gitReview: request => socket.gitReview(request),
      subagentPage: request => socket.subagentPage(request), subagentAssignments: request => socket.subagentAssignments(request),
      subscribeDetail: listener => socket.subscribeThreadDetail(listener), available: () => connected,
    }
    // Back from an update's restart: the new connection takes the place its threads kept on the page.
    const held = this.held.get(host.id)
    this.held.delete(host.id)
    if (held === hello.hostId) this.options.router.replace(connection)
    else { if (held) this.options.router.remove(held); this.options.router.add(connection) }
    active.registeredHostId = hello.hostId
    this.clearRetry(host.id)
    this.update(host.id, { phase: 'connected', reconnecting: false, hostId: hello.hostId, clientId: hello.clientId, owned: active.ssh?.owned === true, bootStart: active.ssh?.bootStart })
  }
  /** Stop host needs a live connection to a host this Sotto started; a discovered host is never stopped. */
  private requireOwnedConnection(host: SavedHost): void {
    // A host of another version leaves its SSH session open in the error phase for exactly this press.
    if (!this.live.has(host.id) || !this.reachable(host.id)) throw new Error(`Connect to ${host.name} before stopping its host.`)
    if (this.status.get(host.id)?.owned !== true) throw new Error(`Sotto did not start the host on ${host.name}, so it cannot stop it. Stop it on that machine.`)
  }
  /** The SSH connection a saved host's current connect signed in with, while it is open. */
  private onSsh(id: string): SshHostConnection | undefined {
    const active = this.live.get(id)
    return active?.ssh && !active.sshClosed ? active.ssh : undefined
  }
  /**
   * Runs one press that needs the launch script or the host's administrative routes over what it goes over (ADR-0053):
   * the SSH connection when the host is on it, which opens nothing new, and otherwise the host's admin connection, opened
   * by the first press and shared until a minute after the last. An admin connection starts no host: one that is not
   * running fails the press.
   */
  private press<T>(host: SavedHost, press: (connection: PressConnection) => Promise<T>, admin: { readonly removeBoot?: boolean } = {}): Promise<T> {
    const ssh = this.onSsh(host.id)
    if (ssh) return press(ssh)
    if (this.closed || !this.saved.includes(host)) return Promise.reject(new Error(`${host.name} is no longer saved. Nothing was changed.`))
    return this.admins.run({ id: host.id, route: this.route(host), hostId: host.hostId, ...admin }, press)
  }
  /** The same press, over a connection already open, opening none: undefined when the host has none. */
  private pressIfOpen<T>(host: SavedHost, press: (connection: PressConnection) => Promise<T>): Promise<T | undefined> {
    const ssh = this.onSsh(host.id)
    return ssh ? press(ssh) : this.admins.runIfOpen(host.id, press)
  }
  /**
   * What an admin connection reports while it signs in: SSH's questions, which the window asks wherever the user is, and
   * Tailscale's approval, which the surface that asked for the press shows. The row's checklist step stays the socket's.
   */
  private adminSignIn(id: string, report: AdminSignInReport): void {
    const state = this.status.get(id)
    if (!state) return
    if (report.prompt !== undefined) { if (report.prompt) state.prompt = report.prompt; else delete state.prompt }
    if (report.approval !== undefined) { if (report.approval) state.tailscale = { waiting: true, ...(report.approval.url ? { url: report.approval.url } : {}) }; else delete state.tailscale }
    if (report.signingIn) state.adminSignIn = true; else if (report.signingIn === false) delete state.adminSignIn
    this.emit()
  }
  /** An answer to SSH's question goes to the connection that asked it: the admin connection's sign-in, or the connect's. */
  private answerPrompt(id: string, promptId: string, answer: string): void {
    if (!this.admins.answer(id, promptId, answer)) this.live.get(id)?.launcher.answerPrompt(promptId, answer)
  }
  /** Whether the host's SSH session can reach it: connected, or kept open in the error phase for a host of another version. */
  private reachable(id: string): boolean {
    const status = this.status.get(id)
    return status?.phase === 'connected' || status?.phase === 'error' && status.owned === true
  }
  /** Asks the launch script to stop the host. False means it may still run. */
  private async stopOwnedHost(connection: PressConnection): Promise<boolean> {
    try { return await connection.stopHost() } catch { return false }
  }
  private notStopped(host: SavedHost): string { return `The host on ${host.name} could not be stopped and may still be running. Check it on that machine, then connect and try again.` }
  private async disconnect(id: string, keepRetry = false): Promise<void> {
    if (!keepRetry) { this.clearRetry(id); this.releaseHeld(id); await this.admins.close(id) }
    const active = this.live.get(id)
    this.live.delete(id)
    if (active?.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    await active?.socket?.close()
    await active?.launcher.disconnect()
    const status = this.status.get(id)
    if (status) { delete status.prompt; delete status.adminSignIn; delete status.error; delete status.reconnecting; delete status.owned; delete status.step; delete status.tailscale; delete status.fix; delete status.reason; delete status.checked; delete status.version; delete status.bootStart; status.phase = 'disconnected'; this.emit() }
  }
  /**
   * Clears every pending retry first, including those for hosts whose connect failed and so are no longer
   * live: a retry that fired during the quit drain would spawn ssh and register with a disposed router.
   */
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribeSetup?.(); this.unsubscribeProviderJob?.(); this.unsubscribeUpdates?.(); this.unsubscribePhones?.()
    for (const id of [...this.retries.keys()]) this.clearRetry(id)
    // A host still being added is cancelled as its dialog's Cancel would, and its connect is waited for, so
    // the quit drain does not end before its credential is cleared and its pairing revoked.
    if (this.adding) await this.cancelAdd(this.adding.id).catch(() => undefined)
    if (this.setupAttempt) await this.cancelAdd(this.setupAttempt.id).catch(() => undefined)
    await Promise.all([this.pendingAdd, this.pendingSetup])
    await Promise.allSettled([...this.live.keys()].map(id => this.disconnect(id)))
    await this.admins.closeAll(); await this.writing
  }
}

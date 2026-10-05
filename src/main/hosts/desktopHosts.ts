import { join } from 'node:path'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import { z } from 'zod'
import { remoteHostSchema, type HostPhonesView, type HostSetupChoice, type HostSetupState, type HostSetupStep, type HostsCommand, type HostsState, type HostStatus, type RemoteHost } from '../../shared/hosts'
import type { HostPhonesCommand } from '../../shared/phones'
import type { HostPhonesLink } from './hostPhones'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from '../agents/credentials'
import { HostConnectionError, SocketHostService } from '../agents/socketHostService'
import { validateSshHost } from './sshConfiguration'
import { SshFailure, SshHostLauncher, type SshCallbacks, type SshFailureCode, type SshHostConnection, type SshHostUpdateOperation, type SshHostUpdateOptions, type SshHostUpdateResult } from './sshLauncher'
import { failureStep } from './sshFailure'
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
/** The commands that act on one saved host's connection, which wait while that host is being updated. */
const CONNECTION_COMMANDS: ReadonlySet<HostsCommand['type']> = new Set<HostsCommand['type']>(['save', 'set-enabled', 'connect', 'disconnect', 'stop-host', 'forget'])
/**
 * `closing` is set while Stop host or Forget runs. Both drop the socket on purpose before the SSH reply
 * arrives (the host closes its listener to stop, and a revoke closes the revoked peer), and a drop then
 * must not be read as a lost connection: reconnecting would restart the host being stopped, or pair again
 * with the host just told to forget this computer.
 */
interface LiveHost { launcher: SshHostLauncher; tunnel?: SshHostConnection; socket?: SocketHostService; registeredHostId?: string; generation: number; closing?: boolean }
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
  'identity-file-unreadable', 'prompt-unanswered', 'tailscale-unapproved', 'node-missing', 'node-too-old', 'node-too-new', 'archive-missing', 'descriptor-invalid', 'permission-setup-failed'])
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
  /** Saved hosts connected now, each with the SSH connection its phone access is reached through (ADR-0050). */
  phonesLinks(): HostPhonesLink[] {
    return this.saved.flatMap(host => {
      const tunnel = this.live.get(host.id)?.tunnel
      return tunnel && this.status.get(host.id)?.phase === 'connected' ? [{ id: host.id, name: host.name, connection: tunnel }] : []
    })
  }
  /** Saved hosts an update can reach now, with the Sotto version each said it runs (ADR-0040). */
  updateCandidates(): HostUpdateCandidate[] {
    return this.saved.flatMap(host => {
      const status = this.status.get(host.id), tunnel = this.live.get(host.id)?.tunnel
      if (!status?.version || !status.hostId || !tunnel || !this.reachable(host.id)) return []
      return [{ id: host.id, name: host.name, hostId: status.hostId, version: status.version, owned: tunnel.owned, installPath: host.installPath, dataDirectory: host.dataDirectory }]
    })
  }
  /** One operation of a host update, over that host's SSH connection. */
  async runUpdate(id: string, operation: SshHostUpdateOperation, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult> {
    const host = this.saved.find(item => item.id === id), tunnel = this.live.get(id)?.tunnel
    if (!host || !tunnel || !this.reachable(id)) throw new Error(`${host?.name ?? 'This host'} is not connected. Nothing was changed.`)
    return tunnel.updateHost(operation, options)
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
    const active = this.live.get(id)
    this.requireOwnedConnection(host, active)
    active!.closing = true
    this.clearRetry(id)
    const registered = active!.registeredHostId
    if (registered) { this.held.set(id, registered); delete active!.registeredHostId; this.options.router.setReconnecting(registered, true) }
    let result: SshHostUpdateResult | undefined, unsent = false
    try { result = await active!.tunnel!.updateHost({ op: 'update-restart', version }, options); return result }
    catch (error) { unsent = error instanceof SshFailure && (error.code === 'request-busy' || error.code === 'not-connected'); throw error }
    finally {
      // Nothing was stopped: the restart was never sent, or the host refused it before stopping anything. The same
      // connection carries on, and the threads read as they did.
      const untouched = unsent || (result?.type === 'error' && UNTOUCHED_RESTARTS.has(result.reason))
      if (untouched && this.live.get(id) === active && this.status.get(id)?.phase === 'connected') {
        active!.closing = false
        if (registered) { this.held.delete(id); active!.registeredHostId = registered; this.options.router.setReconnecting(registered, false) }
      } else if (!this.closed && this.saved.includes(host) && host.enabled !== false) {
        // A reconnect, with the backoff behind it: the row reads Reconnecting…, as it does after a drop.
        this.retries.set(id, { timer: undefined, attempt: 0, active: undefined })
        await this.open(host).catch(() => undefined)
      } else this.releaseHeld(id)
    }
  }
  /** Takes a host held through its update's restart off the Threads page, once no connection will take its place. */
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
      if (command.type === 'ssh-answer') { this.live.get(command.id)?.launcher.answerPrompt(command.promptId, command.answer); return this.get() }
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
      this.live.get(host.id)?.launcher.answerPrompt(command.promptId, command.answer)
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
      const active = this.live.get(host.id)
      this.requireOwnedConnection(host, active)
      active!.closing = true
      const stopped = await this.stopOwnedHost(active!)
      await this.disconnect(host.id)
      if (!stopped) throw new Error(this.notStopped(host))
      // A stopped host is switched off, so the next launch does not start it again; switching it on does.
      host.enabled = false
      this.update(host.id, { enabled: false })
      await this.save()
      return this.get()
    }
    if (command.type === 'forget') {
      this.clearRetry(host.id)
      const active = this.live.get(host.id)
      // A host that cannot be reached is still forgotten here; the dialog says its access stays until revoked there.
      // A host of another version is reached through the SSH session kept open for Stop host.
      if (active?.tunnel && this.reachable(host.id)) {
        // Revoke first: the admin endpoint that revokes lives on the running host, so it cannot follow a stop.
        // The revoke drops this computer's socket, which `closing` keeps from reconnecting and pairing again.
        active.closing = true
        try { if (host.clientId) await active.tunnel.revokeClient(host.clientId) }
        catch (error) { await this.disconnect(host.id); throw error }
        if (active.tunnel.owned && !(await this.stopOwnedHost(active))) { await this.disconnect(host.id); throw new Error(this.notStopped(host)) }
      }
      await this.disconnect(host.id)
      await this.options.credentials.set(`remote-host:${host.id}`, '')
      this.saved = this.saved.filter(item => item.id !== host.id)
      await this.save(); this.status.delete(host.id); this.emit(); return this.get()
    }
    if (this.closed) return this.get()
    await this.open(host)
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
    if (host.clientId && active?.tunnel) { active.closing = true; await active.tunnel.revokeClient(host.clientId).catch(() => false) }
    await this.disconnect(id)
    this.status.delete(id)
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
      active.tunnel = await active.launcher.connect(this.route(host), {
        ...this.progress(host, active),
        onDisconnected: () => { if (this.live.get(host.id) === active && !active.closing) this.dropped(host, active) },
      })
      if (this.live.get(host.id) !== active) { await active.tunnel.close(); return }
      this.update(host.id, { step: 'pair' })
      if (host.hostId && host.hostId !== active.tunnel.hostId) throw new FinalHostError('The host identity changed. Check its data folder before connecting again.')
      const same = adding ? this.saved.find(item => item.hostId === active.tunnel!.hostId) : undefined
      if (same) throw new FinalHostError(`This is the same host as ${same.name}, which is already saved. Switch ${same.name} on in the list instead.`)
      this.update(host.id, { hostId: active.tunnel.hostId })
      if (!this.options.credentials.has(`remote-host:${host.id}`)) await this.pairOverTunnel(host, active)
      await this.openSocket(host, active)
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
      if (otherVersion && active.tunnel) {
        const newer = active.socket?.hostIsNewer() ?? false
        const version = active.socket?.sottoVersion()
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        // An older host Sotto started keeps its SSH session, so Stop host can reach the host the sentence
        // names. Connect closes that session first. A host Sotto did not start, or one newer than this
        // computer, has nothing to keep it for: the sentence already says what to do instead.
        if (active.tunnel.owned && !newer) {
          this.clearRetry(host.id)
          this.releaseHeld(host.id)
          // Its version, when it said one, is what lets the Threads page offer to update it (ADR-0040).
          this.update(host.id, { phase: 'error', reconnecting: false, owned: true, error: failure.message, version })
          return
        }
      }
      if (!adding && error instanceof HostConnectionError && error.pairingRequired && this.live.get(host.id) === active && active.tunnel) {
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        await this.options.credentials.set(`remote-host:${host.id}`, '')
        try {
          await this.pairOverTunnel(host, active)
          await this.openSocket(host, active)
          this.clearRetry(host.id)
          return
        } catch (repair) {
          // A busy host refused the pairing for a minute; that passes by itself, so it is not a final failure.
          failure = repair instanceof HostConnectionError && repair.code === 'busy' ? repair : new FinalHostError('This device is no longer paired and could not pair again. Check the host, then connect again.')
        }
      }
      const { step, fix, reason, waited } = this.failureFields(host, active, failure)
      const unsaved = adding && !this.saved.includes(host)
      if (unsaved && host.clientId && active.tunnel && this.live.get(host.id) === active) {
        // Pairing finished before the failure, so the host holds a record of this computer that nothing will
        // use. Revoke it while the connection is open; failing that, it stays revocable on the host.
        await active.tunnel.revokeClient(host.clientId).catch(() => false)
      }
      await active.socket?.close().catch(() => undefined)
      await active.launcher.disconnect().catch(() => undefined)
      // Superseded: switched off, disconnected, stopped or replaced by a newer attempt while this one ran. Whatever
      // did that has already set the row, and a cancelled connect is not something to report or retry.
      const current = this.live.get(host.id) === active
      if (current) this.live.delete(host.id)
      if (unsaved) {
        delete host.hostId; delete host.clientId
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
    const step: HostSetupStep = failure instanceof SshFailure ? failureStep(failure.code) ?? reached ?? 'reach' : active.tunnel ? 'pair' : reached ?? 'reach'
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
      active.tunnel = await active.launcher.connect(this.route(host), this.progress(host, active))
      // Reached, signed in, installed and started: everything a check asks. The forward closes unpaired.
      active.closing = true
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) !== active) return
      this.live.delete(host.id)
      if (this.setupAttempt === host) this.update(host.id, { phase: 'disconnected', step: 'pair', checked: true, owned: active.tunnel.owned })
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
  private async pairOverTunnel(host: SavedHost, active: LiveHost): Promise<void> {
    if (!this.options.credentials.available()) throw new FinalHostError('Secure credential storage is unavailable. Unlock it before connecting again.')
    const code = await active.tunnel!.showHostPairingCode()
    const pairing = await SocketHostService.pair(active.tunnel!.url, code.code, 'Sotto desktop')
    // Cancelled or quit while pairing: keep no credential. The record the host made stays revocable there.
    if (this.live.get(host.id) !== active) throw new Error('The connection was closed while this computer paired.')
    if (pairing.hostId !== active.tunnel!.hostId || host.hostId && pairing.hostId !== host.hostId) throw new Error('This is a different host. Check the address before pairing.')
    try { await this.options.credentials.set(`remote-host:${host.id}`, pairing.token) }
    catch (error) {
      await active.tunnel!.revokeClient(pairing.clientId).catch(() => false)
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
    if (active.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    if (!this.status.has(host.id)) return
    // A host that is switched off is not kept connected: its drop only closes what is left of the session.
    if (host.enabled === false) { void this.disconnect(host.id).catch(() => undefined); return }
    this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
    if (!this.status.get(host.id)!.prompt) this.scheduleReconnect(host, active)
  }
  private async openSocket(host: SavedHost, active: LiveHost): Promise<void> {
    let connected = false, pushError: string | undefined
    // A push error stays on the row only until what it was about arrives, so a thread that was once too large
    // does not keep saying so after it fits again.
    const socket = new SocketHostService({ getSelectedThreadId: () => {
      const selected = this.options.router.shell().activeThreadId
      const picked = selected ? parseHostEntityKey(selected) : null
      return picked?.hostId === active.tunnel!.hostId ? picked.id : null
    }, onConnectionChange: value => { connected = value; if (!value && this.live.get(host.id) === active) this.dropped(host, active) },
      onPushError: message => { if (this.live.get(host.id) === active) { pushError = message; this.update(host.id, { error: message }) } },
      onPushErrorCleared: () => { if (this.live.get(host.id) === active && pushError !== undefined && this.status.get(host.id)?.error === pushError) this.update(host.id, { error: undefined }); pushError = undefined }, url: active.tunnel!.url, token: this.options.credentials.get(`remote-host:${host.id}`), expectedHostId: active.tunnel!.hostId, owned: active.tunnel!.owned,
      // Nothing on the desktop reads a host's event log, so a connect asks for none of it.
      catchUpEvents: false })
    active.socket = socket
    const hello = await socket.connect()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    // Use the host's authenticated client identity, never a saved or renderer-supplied ID. The SSH
    // account establishes the default only when this client has no policy history (ADR-0025).
    if (!hello.capabilities.mayAnswer) await active.tunnel!.ensureDesktopAnswers(hello.clientId)
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
      subscribeDetail: listener => socket.subscribeThreadDetail(listener), available: () => connected,
    }
    // Back from an update's restart: the new connection takes the place its threads kept on the page.
    const held = this.held.get(host.id)
    this.held.delete(host.id)
    if (held === hello.hostId) this.options.router.replace(connection)
    else { if (held) this.options.router.remove(held); this.options.router.add(connection) }
    active.registeredHostId = hello.hostId
    this.clearRetry(host.id)
    this.update(host.id, { phase: 'connected', reconnecting: false, hostId: hello.hostId, clientId: hello.clientId, owned: active.tunnel!.owned })
  }
  /** Stop host needs a live connection to a host this Sotto started; a discovered host is never stopped. */
  private requireOwnedConnection(host: SavedHost, active: LiveHost | undefined): void {
    // A host of another version leaves its SSH session open in the error phase for exactly this press.
    if (!active?.tunnel || !this.reachable(host.id)) throw new Error(`Connect to ${host.name} before stopping its host.`)
    if (!active.tunnel.owned) throw new Error(`Sotto did not start the host on ${host.name}, so it cannot stop it. Stop it on that machine.`)
  }
  /** Whether the host's SSH session can reach it: connected, or kept open in the error phase for a host of another version. */
  private reachable(id: string): boolean {
    const status = this.status.get(id)
    return status?.phase === 'connected' || status?.phase === 'error' && status.owned === true
  }
  /** Asks the launch script to stop the host. False means it may still run. */
  private async stopOwnedHost(active: LiveHost): Promise<boolean> {
    try { return await active.tunnel!.stopHost() } catch { return false }
  }
  private notStopped(host: SavedHost): string { return `The host on ${host.name} could not be stopped and may still be running. Check it on that machine, then connect and try again.` }
  private async disconnect(id: string, keepRetry = false): Promise<void> {
    if (!keepRetry) { this.clearRetry(id); this.releaseHeld(id) }
    const active = this.live.get(id)
    this.live.delete(id)
    if (active?.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    await active?.socket?.close()
    await active?.launcher.disconnect()
    const status = this.status.get(id)
    if (status) { delete status.prompt; delete status.error; delete status.reconnecting; delete status.owned; delete status.step; delete status.tailscale; delete status.fix; delete status.reason; delete status.checked; delete status.version; status.phase = 'disconnected'; this.emit() }
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
    await Promise.allSettled([...this.live.keys()].map(id => this.disconnect(id))); await this.writing
  }
}

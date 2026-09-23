import { join } from 'node:path'
import { z } from 'zod'
import { remoteHostSchema, type HostsCommand, type HostsState, type HostStatus, type RemoteHost } from '../../shared/hosts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from '../agents/credentials'
import { HostConnectionError, SocketHostService } from '../agents/socketHostService'
import { validateSshHost } from './sshConfiguration'
import { SshFailure, SshHostLauncher, type SshFailureCode, type SshHostConnection } from './sshLauncher'
import type { DesktopHostRouter } from './desktopHostRouter'

/** Files from before the switch have no `sshPort` or `enabled` and still read: both are optional, and no `enabled` means on. */
const savedHostSchema = remoteHostSchema.extend({ hostId: z.uuid().optional(), clientId: z.string().optional() })
type SavedHost = z.infer<typeof savedHostSchema>
type Connection = Omit<RemoteHost, 'enabled'>
/**
 * `closing` is set while Stop host or Forget runs. Both drop the socket on purpose before the SSH reply
 * arrives (the host closes its listener to stop, and a revoke closes the revoked peer), and a drop then
 * must not be read as a lost connection: reconnecting would restart the host being stopped, or pair again
 * with the host just told to forget this computer.
 */
interface LiveHost { launcher: SshHostLauncher; tunnel?: SshHostConnection; socket?: SocketHostService; registeredHostId?: string; generation: number; closing?: boolean }
/** A pending reconnect. `timer` is absent while the first attempt of a launch or a switch-on runs. */
interface Retry { timer: ReturnType<typeof setTimeout> | undefined; attempt: number; active: LiveHost | undefined }
/**
 * Failures only the user can resolve stop the reconnect backoff instead of retrying: SSH refused this
 * account, a host key changed or was not trusted, a prompt went unanswered, the host machine lacks what
 * the host needs. Everything else (an unreachable network, a host still starting) is retried. The code
 * decides, never the message.
 */
const FINAL_SSH_FAILURES: ReadonlySet<SshFailureCode> = new Set<SshFailureCode>(['ssh-missing', 'ssh-too-old', 'auth-failed', 'host-key-changed', 'host-key-rejected',
  'identity-file-unreadable', 'prompt-unanswered', 'node-missing', 'node-too-old', 'node-too-new', 'archive-missing', 'descriptor-invalid'])
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
  private generation = 0
  /** Set by close(): Sotto is quitting, so no retry may start an SSH session the quit drain would leave behind. */
  private closed = false
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    directory: string; credentials: AgentCredentials; router: DesktopHostRouter;
    localHostRunning: boolean; localHostEnabled: () => boolean; restart: () => void;
    launcher?: () => SshHostLauncher;
    retryDelayMs?: (attempt: number) => number;
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
    for (const host of this.saved) if (host.enabled !== false) this.keepConnected(host)
  }
  get(): HostsState {
    const state = this.options.router.shell(); const local = state.connections?.find(item => item.kind === 'local')
    const adding = this.adding ? this.status.get(this.adding.id) : undefined
    return { ...(state.hostId ? { activeHostId: state.hostId } : {}), ...(local ? { localHostId: local.hostId } : {}),
      hosts: this.saved.map(host => ({ ...this.status.get(host.id)!, ...this.fields(host) })),
      ...(adding ? { adding: { ...adding, ...this.fields(this.adding!) } } : {}),
      localHostRunning: this.options.localHostRunning, localHostEnabled: this.options.localHostEnabled() }
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
    if (this.adding !== undefined && this.adding.id === ('id' in command ? command.id : command.host.id)) {
      // Add host's own questions are answered in its dialog, and its Cancel ends the attempt.
      if (command.type === 'ssh-answer') { this.live.get(command.id)?.launcher.answerPrompt(command.promptId, command.answer); return this.get() }
      if (command.type === 'disconnect') { await this.cancelAdd(command.id); return this.get() }
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
  private async add(input: Connection): Promise<HostsState> {
    if (this.closed) return this.get()
    if (this.adding && this.status.get(this.adding.id)?.phase === 'connecting') throw new Error(`Sotto is still connecting to ${targetHost(this.adding.target)}. Wait for it, or cancel it first.`)
    if (this.saved.some(item => item.id === input.id)) throw new Error('This host is already saved.')
    validateConnection(input)
    const duplicate = this.saved.find(item => item.target === input.target && (item.sshPort ?? 22) === (input.sshPort ?? 22))
    if (duplicate) throw new Error(`${input.target} is already saved as ${duplicate.name}. ${NOTHING_SAVED} Switch it on in the list instead.`)
    if (this.adding) await this.cancelAdd(this.adding.id)
    const host: SavedHost = { ...input }
    this.adding = host
    this.status.set(host.id, { ...this.fields(host), phase: 'connecting' })
    this.emit()
    await this.open(host)
    return this.get()
  }
  private async cancelAdd(id: string): Promise<void> {
    if (this.adding?.id !== id) return
    this.adding = undefined
    await this.disconnect(id)
    this.status.delete(id)
    await this.forgetCredential(id)
    this.emit()
  }
  /** Removes a credential a failed or cancelled add left behind; the desktop keeps nothing for a host it did not save. */
  private async forgetCredential(id: string): Promise<void> {
    if (this.options.credentials.has(`remote-host:${id}`)) await this.options.credentials.set(`remote-host:${id}`, '')
  }
  /** Moves the host Add host connected to into the saved list, switched on. */
  private async commitAdd(host: SavedHost): Promise<void> {
    if (this.adding !== host) return
    this.adding = undefined
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
   * as a dropped connection is, with Reconnecting… on the row from the first attempt. Used at launch, when a
   * host is switched on, and after its connection is edited.
   */
  private keepConnected(host: SavedHost): void {
    if (this.closed) return
    this.clearRetry(host.id)
    this.retries.set(host.id, { timer: undefined, attempt: 0, active: undefined })
    void this.open(host).catch(() => undefined)
  }
  private async open(host: SavedHost): Promise<void> {
    const adding = this.adding === host
    if (this.live.has(host.id)) await this.disconnect(host.id, true)
    if (this.closed) return
    const active: LiveHost = { launcher: this.options.launcher?.() ?? new SshHostLauncher(), generation: ++this.generation }
    this.live.set(host.id, active)
    this.status.set(host.id, { ...this.status.get(host.id), ...this.fields(host), phase: 'connecting', reconnecting: this.retries.has(host.id), error: undefined }); this.emit()
    try {
      active.tunnel = await active.launcher.connect({ target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory,
        ...(host.sshPort ? { sshPort: host.sshPort } : {}), ...(host.identityFile ? { identityFile: host.identityFile } : {}) }, {
        onPrompt: prompt => { if (this.live.get(host.id) !== active) return; const state = this.status.get(host.id); if (state) { if (prompt) state.prompt = prompt; else delete state.prompt; this.emit() } },
        onDisconnected: () => { if (this.live.get(host.id) === active && !active.closing) this.dropped(host, active) },
      })
      if (this.live.get(host.id) !== active) { await active.tunnel.close(); return }
      if (host.hostId && host.hostId !== active.tunnel.hostId) throw new FinalHostError('The host identity changed. Check its data folder before connecting again.')
      const same = adding ? this.saved.find(item => item.hostId === active.tunnel!.hostId) : undefined
      if (same) throw new FinalHostError(`This is the same host as ${same.name}, which is already saved. Switch ${same.name} on in the list instead.`)
      this.update(host.id, { hostId: active.tunnel.hostId })
      if (!this.options.credentials.has(`remote-host:${host.id}`)) await this.pairOverTunnel(host, active)
      await this.openSocket(host, active)
      if (adding) {
        if (this.adding === host && this.live.get(host.id) === active) await this.commitAdd(host)
        // Cancelled while the socket opened: the credential it paired with belongs to nothing.
        else await this.forgetCredential(host.id)
      }
    } catch (error) {
      let failure = error instanceof Error ? error : new Error('The host could not connect. Check its SSH settings and try again.')
      const otherVersion = error instanceof HostConnectionError && error.code === 'version_mismatch' && this.live.get(host.id) === active
      // A host that answers with another version is the right host, so Add host keeps it (see add()).
      if (otherVersion && this.adding === host) await this.commitAdd(host)
      if (otherVersion && active.tunnel) {
        const newer = active.socket?.hostIsNewer() ?? false
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        // An older host Sotto started keeps its SSH session, so Stop host can reach the host the sentence
        // names. Connect closes that session first. A host Sotto did not start, or one newer than this
        // computer, has nothing to keep it for: the sentence already says what to do instead.
        if (active.tunnel.owned && !newer) {
          this.clearRetry(host.id)
          this.update(host.id, { phase: 'error', reconnecting: false, owned: true, error: failure.message })
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
      const unsaved = adding && !this.saved.includes(host)
      if (unsaved && host.clientId && active.tunnel && this.live.get(host.id) === active) {
        // Pairing finished before the failure, so the host holds a record of this computer that nothing will
        // use. Revoke it while the connection is open; failing that, it stays revocable on the host.
        await active.tunnel.revokeClient(host.clientId).catch(() => false)
      }
      await active.socket?.close().catch(() => undefined)
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) === active) this.live.delete(host.id)
      if (unsaved) {
        delete host.hostId; delete host.clientId
        await this.forgetCredential(host.id)
        // A cancelled add has no dialog left to tell.
        if (this.adding === host) this.update(host.id, { phase: 'error', reconnecting: false, error: unsavedMessage(failure.message) })
        return
      }
      // A host forgotten or edited while it connected has no row left for this attempt to report to.
      if (!this.saved.includes(host)) return
      if (this.retries.has(host.id) && !this.final(failure) && !this.status.get(host.id)?.prompt) {
        this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
        this.scheduleReconnect(host, undefined)
      } else {
        this.clearRetry(host.id)
        this.update(host.id, { phase: 'error', reconnecting: false, error: failure.message })
      }
    }
  }
  private async pairOverTunnel(host: SavedHost, active: LiveHost): Promise<void> {
    const code = await active.tunnel!.showHostPairingCode()
    const pairing = await SocketHostService.pair(active.tunnel!.url, code.code, 'Sotto desktop')
    if (pairing.hostId !== active.tunnel!.hostId || host.hostId && pairing.hostId !== host.hostId) throw new Error('This is a different host. Check the address before pairing.')
    await this.options.credentials.set(`remote-host:${host.id}`, pairing.token)
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
      void this.command({ type: 'connect', id: host.id })
    }, (this.options.retryDelayMs ?? reconnectDelayMs)(entry.attempt))
    entry.attempt += 1
    this.retries.set(host.id, entry)
  }
  private dropped(host: SavedHost, active: LiveHost): void {
    const status = this.status.get(host.id)
    // The SSH session kept open for Stop host has ended, so Stop host can no longer reach the host.
    if (!active.closing && status?.phase === 'error' && status.owned) { this.update(host.id, { owned: undefined }); return }
    if (active.closing || status?.phase !== 'connected') return
    if (active.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    if (!this.status.has(host.id)) return
    this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
    if (!this.status.get(host.id)!.prompt) this.scheduleReconnect(host, active)
  }
  private async openSocket(host: SavedHost, active: LiveHost): Promise<void> {
    let connected = false, pushError: string | undefined
    // A push error stays on the row only until what it was about arrives, so a thread that was once too large
    // does not keep saying so after it fits again.
    const socket = new SocketHostService({ onConnectionChange: value => { connected = value; if (!value && this.live.get(host.id) === active) this.dropped(host, active) },
      onPushError: message => { if (this.live.get(host.id) === active) { pushError = message; this.update(host.id, { error: message }) } },
      onPushErrorCleared: () => { if (this.live.get(host.id) === active && pushError !== undefined && this.status.get(host.id)?.error === pushError) this.update(host.id, { error: undefined }); pushError = undefined }, url: active.tunnel!.url, token: this.options.credentials.get(`remote-host:${host.id}`), expectedHostId: active.tunnel!.hostId, owned: active.tunnel!.owned,
      // Nothing on the desktop reads a host's event log, so a connect asks for none of it.
      catchUpEvents: false })
    active.socket = socket
    const hello = await socket.connect()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    host.hostId = hello.hostId; host.clientId = hello.clientId
    if (this.saved.includes(host)) await this.save()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    this.options.router.add({ hostId: hello.hostId, name: host.name, kind: 'remote', service: socket,
      detail: id => socket.readThreadDetail(id), preview: request => socket.attachmentPreview(request), observe: ids => socket.observe(ids),
      subscribeDetail: listener => socket.subscribeThreadDetail(listener), available: () => connected,
    })
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
    if (!keepRetry) this.clearRetry(id)
    const active = this.live.get(id)
    this.live.delete(id)
    if (active?.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    await active?.socket?.close()
    await active?.launcher.disconnect()
    const status = this.status.get(id)
    if (status) { delete status.prompt; delete status.error; delete status.reconnecting; delete status.owned; status.phase = 'disconnected'; this.emit() }
  }
  /**
   * Clears every pending retry first, including those for hosts whose connect failed and so are no longer
   * live: a retry that fired during the quit drain would spawn ssh and register with a disposed router.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const id of [...this.retries.keys()]) this.clearRetry(id)
    await Promise.allSettled([...this.live.keys()].map(id => this.disconnect(id))); await this.writing
  }
}

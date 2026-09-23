import { join } from 'node:path'
import { z } from 'zod'
import { remoteHostSchema, type HostsCommand, type HostsState, type HostStatus } from '../../shared/hosts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from '../agents/credentials'
import { HostConnectionError, SocketHostService } from '../agents/socketHostService'
import { SshHostLauncher, type SshHostConnection } from './sshLauncher'
import type { DesktopHostRouter } from './desktopHostRouter'

const savedHostSchema = remoteHostSchema.extend({ hostId: z.uuid().optional(), clientId: z.string().optional() })
type SavedHost = z.infer<typeof savedHostSchema>
/**
 * `closing` is set while Stop host or Forget runs. Both drop the socket on purpose before the SSH reply
 * arrives (the host closes its listener to stop, and a revoke closes the revoked peer), and a drop then
 * must not be read as a lost connection: reconnecting would restart the host being stopped, or pair again
 * with the host just told to forget this computer.
 */
interface LiveHost { launcher: SshHostLauncher; tunnel?: SshHostConnection; socket?: SocketHostService; registeredHostId?: string; generation: number; closing?: boolean }
interface Retry { timer: ReturnType<typeof setTimeout>; attempt: number; active: LiveHost | undefined }
/** Drops that only the user can resolve stop the reconnect backoff instead of retrying. */
const FINAL_FAILURES = ['identity changed', 'host key changed', 'installation was not found', 'connection record could not be read', 'identity file could not be read', 'could not pair again']

/** Configuration contains no credentials; tokens use the desktop's existing OS-encrypted store. */
export class DesktopHosts {
  private readonly store: AtomicJsonStore<SavedHost[]>
  private saved: SavedHost[] = []
  private readonly status = new Map<string, HostStatus>()
  private readonly live = new Map<string, LiveHost>()
  private readonly retries = new Map<string, Retry>()
  private readonly listeners = new Set<(state: HostsState) => void>()
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
  async start(): Promise<void> { this.saved = await this.store.read(); for (const host of this.saved) this.status.set(host.id, { ...remoteHostSchema.strip().parse(host), ...(host.hostId ? { hostId: host.hostId } : {}), ...(host.clientId ? { clientId: host.clientId } : {}), phase: 'disconnected' }) }
  get(): HostsState { const state = this.options.router.shell(); const local = state.connections?.find(item => item.kind === 'local'); return { ...(state.hostId ? { activeHostId: state.hostId } : {}), ...(local ? { localHostId: local.hostId } : {}), hosts: this.saved.map(host => ({ ...this.status.get(host.id)!, ...remoteHostSchema.strip().parse(host) })), localHostRunning: this.options.localHostRunning, localHostEnabled: this.options.localHostEnabled() } }
  subscribe(listener: (state: HostsState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
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
    if (command.type === 'save') {
      const host = command.host
      this.clearRetry(host.id)
      if (this.live.has(host.id)) throw new Error('Disconnect this host before changing its connection.')
      const existing = this.saved.find(item => item.id === host.id)
      // Editing a route must not silently transfer a credential to a different host.
      const next = existing ? { ...existing, ...host } : host
      this.saved = [...this.saved.filter(item => item.id !== host.id), next]
      this.status.set(host.id, { ...host, phase: 'disconnected' })
      await this.save(); this.emit(); return this.get()
    }
    const host = this.saved.find(item => item.id === command.id)
    if (!host) throw new Error('This host is no longer saved. Add it again in Settings > Hosts.')
    if (command.type === 'ssh-answer') {
      this.live.get(host.id)?.launcher.answerPrompt(command.promptId, command.answer)
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
      return this.get()
    }
    if (command.type === 'forget') {
      this.clearRetry(host.id)
      const active = this.live.get(host.id)
      // A host that cannot be reached is still forgotten here; the dialog says its access stays until revoked there.
      if (active?.tunnel && this.status.get(host.id)?.phase === 'connected') {
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
    if (this.live.has(host.id)) await this.disconnect(host.id, true)
    const active: LiveHost = { launcher: this.options.launcher?.() ?? new SshHostLauncher(), generation: ++this.generation }
    this.live.set(host.id, active)
    this.status.set(host.id, { ...remoteHostSchema.strip().parse(host), phase: 'connecting' }); this.emit()
    try {
      active.tunnel = await active.launcher.connect({ target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory,
        ...(host.identityFile ? { identityFile: host.identityFile } : {}) }, {
        onPrompt: prompt => { if (this.live.get(host.id) !== active) return; const state = this.status.get(host.id); if (state) { if (prompt) state.prompt = prompt; else delete state.prompt; this.emit() } },
        onDisconnected: () => { if (this.live.get(host.id) === active && !active.closing) this.dropped(host, active) },
      })
      if (this.live.get(host.id) !== active) { await active.tunnel.close(); return this.get() }
      if (host.hostId && host.hostId !== active.tunnel.hostId) throw new Error('The host identity changed. Check its data folder before connecting again.')
      this.update(host.id, { hostId: active.tunnel.hostId })
      if (!this.options.credentials.has(`remote-host:${host.id}`)) await this.pairOverTunnel(host, active)
      await this.openSocket(host, active)
    } catch (error) {
      let failure = error instanceof Error ? error : new Error('The host could not connect. Check its SSH settings and try again.')
      if (error instanceof HostConnectionError && error.pairingRequired && this.live.get(host.id) === active && active.tunnel) {
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        await this.options.credentials.set(`remote-host:${host.id}`, '')
        try {
          await this.pairOverTunnel(host, active)
          await this.openSocket(host, active)
          this.clearRetry(host.id)
          return this.get()
        } catch { failure = new Error('This device is no longer paired and could not pair again. Check the host, then connect again.') }
      }
      await active.socket?.close().catch(() => undefined)
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) === active) this.live.delete(host.id)
      if (this.retries.has(host.id) && !this.final(failure) && !this.status.get(host.id)?.prompt) {
        this.update(host.id, { phase: 'connecting', reconnecting: true, error: undefined })
        this.scheduleReconnect(host, undefined)
      } else {
        this.clearRetry(host.id)
        this.update(host.id, { phase: 'error', reconnecting: false, error: failure.message })
      }
    }
    return this.get()
  }
  private async pairOverTunnel(host: SavedHost, active: LiveHost): Promise<void> {
    const code = await active.tunnel!.showHostPairingCode()
    const pairing = await SocketHostService.pair(active.tunnel!.url, code.code, 'Sotto desktop')
    if (pairing.hostId !== active.tunnel!.hostId || host.hostId && pairing.hostId !== host.hostId) throw new Error('This is a different host. Check the address before pairing.')
    await this.options.credentials.set(`remote-host:${host.id}`, pairing.token)
    host.hostId = pairing.hostId; host.clientId = pairing.clientId
    await this.save()
  }
  private final(error: Error): boolean { return FINAL_FAILURES.some(part => error.message.includes(part)) }
  private clearRetry(id: string): void { const entry = this.retries.get(id); if (entry) { clearTimeout(entry.timer); this.retries.delete(id) } }
  private scheduleReconnect(host: SavedHost, active: LiveHost | undefined): void {
    if (this.closed) return
    const previous = this.retries.get(host.id)
    if (previous) clearTimeout(previous.timer)
    const entry: Retry = { attempt: previous?.attempt ?? 0, active, timer: undefined as never }
    entry.timer = setTimeout(() => {
      if (this.retries.get(host.id) !== entry) return
      if (entry.active && (this.live.get(host.id) !== entry.active || entry.active.closing)) return
      void this.command({ type: 'connect', id: host.id })
    }, (this.options.retryDelayMs ?? (attempt => Math.min(30_000, 1_000 * 2 ** attempt)))(entry.attempt))
    entry.attempt += 1
    this.retries.set(host.id, entry)
  }
  private dropped(host: SavedHost, active: LiveHost): void {
    if (active.closing || this.status.get(host.id)?.phase !== 'connected') return
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
      onPushErrorCleared: () => { if (this.live.get(host.id) === active && pushError !== undefined && this.status.get(host.id)?.error === pushError) this.update(host.id, { error: undefined }); pushError = undefined }, url: active.tunnel!.url, token: this.options.credentials.get(`remote-host:${host.id}`), expectedHostId: active.tunnel!.hostId,
      // Nothing on the desktop reads a host's event log, so a connect asks for none of it.
      catchUpEvents: false })
    active.socket = socket
    const hello = await socket.connect()
    if (this.live.get(host.id) !== active) { await socket.close(); return }
    host.hostId = hello.hostId; host.clientId = hello.clientId
    await this.save()
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
    if (!active?.tunnel || this.status.get(host.id)?.phase !== 'connected') throw new Error(`Connect to ${host.name} before stopping its host.`)
    if (!active.tunnel.owned) throw new Error(`Sotto did not start the host on ${host.name}, so it cannot stop it. Stop it on that machine.`)
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

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
interface LiveHost { launcher: SshHostLauncher; tunnel?: SshHostConnection; socket?: SocketHostService; registeredHostId?: string; generation: number }

/** Configuration contains no credentials; tokens use the desktop's existing OS-encrypted store. */
export class DesktopHosts {
  private readonly store: AtomicJsonStore<SavedHost[]>
  private saved: SavedHost[] = []
  private readonly status = new Map<string, HostStatus>()
  private readonly live = new Map<string, LiveHost>()
  private readonly listeners = new Set<(state: HostsState) => void>()
  private generation = 0
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    directory: string; credentials: AgentCredentials; router: DesktopHostRouter;
    localHostRunning: boolean; localHostEnabled: () => boolean; restart: () => void;
    launcher?: () => SshHostLauncher;
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
    if (command.type === 'disconnect') { await this.disconnect(host.id); return this.get() }
    if (command.type === 'forget') {
      const active = this.live.get(host.id)
      if (host.clientId) {
        if (!active?.tunnel) throw new Error('Connect to this host before forgetting it so its client access can be revoked.')
        await active.tunnel.revokeClient(host.clientId)
      }
      await this.disconnect(host.id)
      await this.options.credentials.set(`remote-host:${host.id}`, '')
      this.saved = this.saved.filter(item => item.id !== host.id)
      await this.save(); this.status.delete(host.id); this.emit(); return this.get()
    }
    if (command.type === 'pair') {
      const active = this.live.get(host.id)
      if (!active?.tunnel) throw new Error('Connect the SSH host before entering its pairing code.')
      const pairing = await SocketHostService.pair(active.tunnel.url, command.code, 'Sotto desktop')
      if (pairing.hostId !== active.tunnel.hostId || host.hostId && pairing.hostId !== host.hostId) throw new Error('This is a different host. Check the address before pairing.')
      await this.options.credentials.set(`remote-host:${host.id}`, pairing.token)
      host.hostId = pairing.hostId; host.clientId = pairing.clientId
      await this.save()
      await this.openSocket(host, active)
      return this.get()
    }
    if (this.live.has(host.id)) await this.disconnect(host.id)
    const active: LiveHost = { launcher: this.options.launcher?.() ?? new SshHostLauncher(), generation: ++this.generation }
    this.live.set(host.id, active)
    this.status.set(host.id, { ...remoteHostSchema.strip().parse(host), phase: 'connecting' }); this.emit()
    try {
      active.tunnel = await active.launcher.connect({ target: host.target, installPath: host.installPath, dataDirectory: host.dataDirectory,
        ...(host.identityFile ? { identityFile: host.identityFile } : {}) }, {
        onPrompt: prompt => { if (this.live.get(host.id) !== active) return; const state = this.status.get(host.id); if (state) { if (prompt) state.prompt = prompt; else delete state.prompt; this.emit() } },
        onDisconnected: () => { if (this.live.get(host.id) !== active) return; if (active.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId } this.update(host.id, { phase: 'error', error: 'The SSH connection ended. Connect again to resume. Your threads remain on the host.' }) },
      })
      if (this.live.get(host.id) !== active) { await active.tunnel.close(); return this.get() }
      if (host.hostId && host.hostId !== active.tunnel.hostId) throw new Error('The host identity changed. Check its data folder before connecting again.')
      this.update(host.id, { hostId: active.tunnel.hostId })
      if (this.options.credentials.has(`remote-host:${host.id}`)) await this.openSocket(host, active)
      else this.update(host.id, { phase: 'pairing' })
    } catch (error) {
      if (error instanceof HostConnectionError && error.pairingRequired && this.live.get(host.id) === active && active.tunnel) {
        await active.socket?.close().catch(() => undefined)
        delete active.socket
        await this.options.credentials.set(`remote-host:${host.id}`, '')
        this.update(host.id, { phase: 'pairing', error: 'This device is no longer paired. Read a new code on the host and enter it here.' })
        return this.get()
      }
      await active.socket?.close().catch(() => undefined)
      await active.launcher.disconnect().catch(() => undefined)
      if (this.live.get(host.id) === active) this.live.delete(host.id)
      this.update(host.id, { phase: 'error', error: error instanceof Error ? error.message : 'The host could not connect. Check its SSH settings and try again.' })
    }
    return this.get()
  }
  private async openSocket(host: SavedHost, active: LiveHost): Promise<void> {
    let connected = false
    const socket = new SocketHostService({ onConnectionChange: value => { connected = value; if (!value && this.live.get(host.id) === active) this.update(host.id, { phase: 'error', error: 'The connection ended. Connect again to refresh. Unconfirmed commands are not sent again.' }) }, url: active.tunnel!.url, token: this.options.credentials.get(`remote-host:${host.id}`), expectedHostId: active.tunnel!.hostId })
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
    this.update(host.id, { phase: 'connected', hostId: hello.hostId, clientId: hello.clientId })
  }
  private async disconnect(id: string): Promise<void> {
    const active = this.live.get(id)
    this.live.delete(id)
    if (active?.registeredHostId) { this.options.router.remove(active.registeredHostId); delete active.registeredHostId }
    await active?.socket?.close()
    await active?.launcher.disconnect()
    const status = this.status.get(id)
    if (status) { delete status.prompt; delete status.error; status.phase = 'disconnected'; this.emit() }
  }
  async close(): Promise<void> { await Promise.allSettled([...this.live.keys()].map(id => this.disconnect(id))); await this.writing }
}

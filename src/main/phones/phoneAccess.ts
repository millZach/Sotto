import { createServer, type Server } from 'node:net'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { startSocketServer, type SocketServerOptions, type TailnetAdmission } from '../../host/socketServer'
import type { ClientIdentity, HostService } from '../agents/hostService'
import { PairedClients } from '../agents/pairing'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { PHONE_ACCESS_SERVE_PORT, type PhonesCommand, type PhonesState, type ServeCheck, type TailscaleCheck } from '../../shared/phones'
import { servePortOwner, TailscaleAccessDenied, type ServeConfig, type ServeResult, type TailscaleStatus } from './tailscale'

/**
 * Phone access (ADR-0033): while the `phoneAccess` setting is on and the local host runs, the desktop
 * opens the host protocol listener over its own host service, on loopback, and asks Tailscale Serve
 * to carry HTTPS port 8443 on the tailnet to it. Paired phones then see exactly this window's threads.
 *
 * Only this computer's own Serve setting is ever changed: one Sotto put on 8443 itself, proxying to a
 * loopback port Sotto remembers. Anything else on 8443 is left alone and the Phones page says so. The
 * setting is removed when phone access turns off and when Sotto quits, and put back at the next start.
 *
 * Pairing codes are issued here, from the Phones page, and nowhere else. The listener's administrative
 * routes are off: the desktop administers it in-process, so no admin token exists on disk or on the wire.
 * A phone's answers count only after the owner turns on Can answer for it, which writes the policy record.
 *
 * A headless host runs the same phone access over its own host service (ADR-0050). It shares the host's pairing
 * store, so a phone and a desktop pair with one set of clients, and the desktop it is connected to administers it
 * through the host's own administrative routes rather than a Phones page.
 *
 * On a headless host the listener is the host's tailnet listener, and carries desktops too (ADR-0053): it runs, and Serve
 * carries it, while phone access or the host's `tailnetConnections` setting is on. With phone access off and the listener
 * up for desktops, it takes no pairing, opens nothing for a client that is not a desktop, and shows no code.
 */

/** What phone access logs: stable event names only, never a name, a code or an address. */
export type PhoneAccessEvent =
  | 'phone-access-on' | 'phone-access-failed' | 'phone-access-start-failed' | 'phone-access-close-failed'
  | 'phone-access-record-unreadable' | 'phone-access-record-write-failed' | 'phone-access-pairing-unreadable'
  | 'phone-access-phones-unreadable' | 'phone-access-phones-write-failed'
  | 'phone-access-listener-failed' | 'phone-access-listener-close-failed' | 'phone-access-policy-revoke-failed'
  | 'phone-access-serve-status-failed' | 'phone-access-serve-not-enabled' | 'phone-access-serve-denied' | 'phone-access-serve-failed' | 'phone-access-serve-remove-failed'

export interface PhoneAccessTailscale {
  status(): Promise<TailscaleStatus>
  serveStatus(): Promise<ServeConfig>
  serve(port: number, loopbackPort: number): Promise<ServeResult>
  unserve(port: number): Promise<boolean>
}

export interface PhoneAccessPolicy {
  mayGrant(client: ClientIdentity): { readonly allowed: boolean }
  setRemoteAnswers(clientId: string, allowed: boolean, note: string): void
}

type Listener = Awaited<ReturnType<typeof startSocketServer>>

export interface PhoneAccessOptions {
  /** The desktop's user data folder: `paired-clients.json` and `phone-access.json` live here. */
  readonly directory: string
  /** The local host's service, or nothing when the local host is off. */
  readonly service: HostService | undefined
  readonly tailscale: PhoneAccessTailscale
  /**
   * `tailnetConnections` is a headless host's own (ADR-0053), and is honoured only with `listener.desktops`, which only
   * the headless host gives: a desktop's settings file naming it never raises the desktop's own phone listener.
   */
  readonly settings: () => { readonly phoneAccess: boolean; readonly phoneAccessName: string; readonly tailnetConnections?: boolean | undefined }
  readonly policy?: PhoneAccessPolicy | undefined
  readonly openExternal: (url: string) => Promise<void>
  readonly hostname?: () => string
  /** Stable event names only; nothing a phone or the owner typed. */
  readonly log?: (event: PhoneAccessEvent) => void
  readonly startServer?: typeof startSocketServer
  /**
   * A pairing store that is already loaded, shared with another listener over the same folder: the headless host's
   * own. Without one, phone access keeps its own over `directory`.
   */
  readonly pairing?: PairedClients
  /** How long to wait before looking for Tailscale again after it was not running. */
  readonly retryMs?: number
  /** The longest quitting waits for the Serve setting to be removed. */
  readonly quitTimeoutMs?: number
  /**
   * What a headless host's tailnet listener takes beyond a phone listener's (ADR-0053): which clients are desktops, the
   * features only they are offered, the receipts it shares with the host's other listener, and what health and hello say.
   */
  readonly listener?: Pick<SocketServerOptions, 'signIns' | 'clientUpdates' | 'receipts' | 'about' | 'phoneAccess' | 'onRevoked'>
    & { readonly desktops?: TailnetAdmission['desktops'] | undefined }
}

/** What health and hello read of phone access: whether it is on, the phase and address `get()` reports, and how many phones are paired. */
export type PhoneAccessBrief = Pick<PhonesState, 'enabled' | 'phase' | 'address'> & { readonly phones: number }

const recordSchema = z.object({
  /** The loopback port last listened on, tried first next time so the Serve setting stays recognisably Sotto's. */
  port: z.number().int().min(1).max(65535).nullable(),
  /** Set before Sotto asks for the Serve setting and cleared once it is gone, so a crash is cleaned up at the next start. */
  mapped: z.boolean(),
}).strict()
type PhoneAccessRecord = z.infer<typeof recordSchema>

const ANSWERS_NOTE = 'The user turned on Can answer for this paired phone on the Phones page.'
const WAITING = { status: 'waiting' } as const

export class PhoneAccess {
  private readonly pairing: PairedClients
  private readonly store: AtomicJsonStore<PhoneAccessRecord>
  private record: PhoneAccessRecord = { port: null, mapped: false }
  private recordUncertain = false
  private reservation: { close(): Promise<void> } | undefined
  private pairingReady = false
  private listener: Listener | undefined
  private listenerStopped = false
  private phase: PhonesState['phase'] = 'off'
  private tailscaleCheck: TailscaleCheck = WAITING
  private serveCheck: ServeCheck = WAITING
  private address: string | null = null
  private enableUrl: string | undefined
  private readonly formerPorts = new Set<number>()
  private code: { code: string; expiresAt: string } | null = null
  private codeTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private readonly listeners = new Set<(state: PhonesState) => void>()
  private readonly watchers = new Set<(brief: PhoneAccessBrief) => void>()
  /**
   * With a shared pairing store, the clients that paired through phone access, which are the phones: the desktops that
   * pair with the same host are not phones, and the Phones dialog must never offer to remove one. Kept in
   * `phone-clients.json`. Without a shared store, every client in phone access's own store is a phone.
   */
  private readonly phoneStore: AtomicJsonStore<string[]> | undefined
  private phoneIds: Set<string> | undefined

  constructor(private readonly options: PhoneAccessOptions) {
    this.pairing = options.pairing ?? new PairedClients(options.directory)
    this.pairingReady = options.pairing !== undefined
    if (options.pairing) this.phoneStore = new AtomicJsonStore(join(options.directory, 'phone-clients.json'), z.array(z.string().min(1).max(512)).max(1000).parse, () => [])
    this.store = new AtomicJsonStore(join(options.directory, 'phone-access.json'), recordSchema.parse, () => { this.recordUncertain = true; return { port: null, mapped: true } })
  }

  /** Reads the saved pairings and record, then brings phone access in line with the setting. */
  async start(): Promise<void> {
    // Keep an invalid primary until an atomic replacement preserves pending cleanup.
    try { if (await this.store.exists()) this.record = await this.store.peek() } catch { this.recordUncertain = true }
    if (this.record.mapped && this.record.port === null) this.recordUncertain = true
    if (this.recordUncertain) {
      this.record.mapped = true
      this.options.log?.('phone-access-record-unreadable')
    }
    if (this.record.mapped) {
      await this.reservePort()
      this.phase = 'cleanup-failed'
    }
    if (this.options.service) await this.loadPairing()
    if (this.phoneStore) {
      try { this.phoneIds = new Set(await this.phoneStore.read()) }
      catch { this.phoneIds = new Set(); this.options.log?.('phone-access-phones-unreadable') }
    }
    this.settingsChanged()
    await this.queue
  }

  /** The paired clients that are phones (see `phoneIds`). */
  private paired() {
    return this.pairing.list().filter(client => !this.phoneIds || this.phoneIds.has(client.clientId))
  }

  private async rememberPhones(): Promise<void> {
    if (!this.phoneStore || !this.phoneIds) return
    try { await this.phoneStore.write([...this.phoneIds]) } catch { this.options.log?.('phone-access-phones-write-failed') }
  }

  /** Called when any setting changed: turns phone access on or off to match, and republishes the name. */
  settingsChanged(): void {
    if (!this.phonesWanted()) {
      this.cancelCode()
      // The listener stays up for desktops; the phones on it go now.
      this.listener?.dropRevoked()
    }
    if (!this.listenerWanted()) {
      if (this.listener) { this.listener.stopServing(); this.listenerStopped = true }
    }
    this.enqueue(() => this.reconcile())
    this.publish()
  }

  subscribe(listener: (state: PhonesState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Told the brief state (see `brief()`) on every change `subscribe` is told of. A socket opening or closing is one, so
   * a watcher that needs only the phase and address costs no per-phone policy lookups.
   */
  watch(watcher: (brief: PhoneAccessBrief) => void): () => void {
    this.watchers.add(watcher)
    return () => { this.watchers.delete(watcher) }
  }

  get(): PhonesState {
    const settings = this.options.settings()
    const defaultName = this.defaultName()
    const connected = new Set(!this.listenerStopped && this.listenerWanted() ? this.listener?.connectedClients() ?? [] : [])
    const phones = this.pairingReady ? this.paired().map(client => ({
      clientId: client.clientId, name: client.name, pairedAt: client.pairedAt, connected: connected.has(client.clientId),
      canAnswer: this.options.policy?.mayGrant({ clientId: client.clientId, user: '', transport: 'socket' }).allowed ?? false,
    })) : []
    return {
      enabled: settings.phoneAccess, localHostRunning: this.options.service !== undefined,
      phase: this.listenerStopped && this.phase === 'on' && this.listenerWanted() ? 'starting' : this.phase,
      tailscale: this.tailscaleCheck, serve: this.serveCheck, address: this.listenerStopped ? null : this.address,
      computerName: this.computerName(), defaultName,
      code: this.code, phones, answersAvailable: this.options.policy !== undefined,
    }
  }

  async command(command: PhonesCommand): Promise<PhonesState> {
    switch (command.type) {
      case 'retry':
        this.enqueue(async () => { if (this.phase === 'cleanup-failed') await this.reconcile(); else if (this.listenerWanted()) await this.turnOn() })
        await this.queue
        break
      case 'show-code': {
        if (this.phase !== 'on' || !this.phonesWanted() || this.listenerStopped || !this.pairingReady) throw new Error('Turn on Let phones connect first, then show a pairing code.')
        this.cancelCode()
        const code = this.pairing.issuePairingCode()
        this.code = code
        this.codeTimer = setTimeout(() => { if (this.code === code) { this.code = null; this.publish() } }, Math.max(0, Date.parse(code.expiresAt) - Date.now()))
        this.codeTimer.unref?.()
        break
      }
      case 'cancel-code':
        this.cancelCode()
        break
      case 'set-can-answer': {
        const policy = this.options.policy
        if (!policy) throw new Error('Permission policies are unavailable on this computer, so a phone cannot be allowed to answer. Nothing was changed.')
        if (!this.paired().some(client => client.clientId === command.clientId)) throw new Error('That phone is no longer paired. Nothing was changed.')
        policy.setRemoteAnswers(command.clientId, command.allowed, ANSWERS_NOTE)
        this.listener?.refreshCapabilities()
        break
      }
      case 'remove':
        if (!this.pairingReady) throw new Error('Paired phones could not be read. Nothing was changed. Restart Sotto and try again.')
        // Only a phone: a desktop paired with the same host is removed from that desktop, by Forget.
        if (this.phoneIds && !this.phoneIds.has(command.clientId)) throw new Error('That phone is no longer paired. Nothing was changed.')
        await this.pairing.revoke(command.clientId)
        if (this.phoneIds?.delete(command.clientId)) await this.rememberPhones()
        // A record naming a client that no longer exists grants nothing, but it is tidier gone.
        try { this.options.policy?.setRemoteAnswers(command.clientId, false, ANSWERS_NOTE) } catch { this.options.log?.('phone-access-policy-revoke-failed') }
        this.listener?.dropRevoked()
        break
      case 'open-serve-setup': {
        const url = this.serveSetupUrl()
        if (!url) throw new Error('Tailscale did not give a page to open. Open the Tailscale admin console to turn on Serve.')
        await this.options.openExternal(url)
        break
      }
    }
    this.publish()
    return this.get()
  }

  /**
   * The page Tailscale gave for turning Serve on, while the last setup stopped there. A headless host has no browser,
   * so the desktop administering it opens this page on its own computer instead (ADR-0050).
   */
  serveSetupUrl(): string | undefined { return this.serveCheck.status === 'failed' && this.serveCheck.reason === 'not-enabled' ? this.enableUrl : undefined }

  /**
   * On quit: ends phone access and makes a bounded cleanup attempt; the next start finishes it.
   */
  async close(): Promise<void> {
    if (this.closed) return this.queue
    this.closed = true
    this.cancelCode()
    this.clearRetry()
    await this.reservePort()
    this.enqueue(() => this.turnOff())
    const limit = this.options.quitTimeoutMs ?? 8000
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.queue, new Promise<void>(resolve => { timer = setTimeout(resolve, limit); timer.unref?.() })])
    clearTimeout(timer)
    await this.reservePort()
    if (!this.record.mapped) { await this.closeListener(); await this.releasePort() }
  }

  private defaultName(): string {
    return this.tailscaleCheck.status === 'ok' ? this.tailscaleCheck.hostName : (this.options.hostname ?? osHostname)()
  }

  /** The name health sends and the page shows: the owner's, or the machine's. */
  private computerName(): string {
    return this.options.settings().phoneAccessName.trim() || this.defaultName()
  }

  private async loadPairing(): Promise<boolean> {
    if (this.pairingReady) return true
    try { await this.pairing.load(); this.pairingReady = true } catch { this.options.log?.('phone-access-pairing-unreadable') }
    return this.pairingReady
  }

  /**
   * Whether the listener and the Serve setting are wanted: for phones, or on a headless host, the only phone access told
   * which clients are desktops, for desktops too.
   */
  private listenerWanted(): boolean {
    const settings = this.options.settings()
    const desktops = this.options.listener?.desktops !== undefined && settings.tailnetConnections === true
    return !this.closed && (settings.phoneAccess || desktops) && this.options.service !== undefined
  }

  /** Whether phones may pair and connect: phone access itself is on. */
  private phonesWanted(): boolean {
    return !this.closed && this.options.settings().phoneAccess && this.options.service !== undefined
  }

  /** Waits for the changes in progress, so an answer can say how Serve came out. */
  settled(): Promise<void> { return this.queue }

  /**
   * The parts of `get()` health and hello read, without the per-phone policy lookups: whether phone access is on, the
   * phase and address as `get()` reports them, and how many phones are paired.
   */
  brief(): PhoneAccessBrief {
    return {
      enabled: this.options.settings().phoneAccess,
      phase: this.listenerStopped && this.phase === 'on' && this.listenerWanted() ? 'starting' : this.phase,
      address: this.listenerStopped ? null : this.address,
      phones: this.pairingReady ? this.paired().length : 0,
    }
  }

  /** How many paired clients hold an open socket on the listener now, phones and desktops alike. */
  peers(): number { return this.listenerStopped ? 0 : this.listener?.peers() ?? 0 }

  private async reconcile(): Promise<void> {
    if (this.phase === 'cleanup-failed' || this.listenerStopped) {
      await this.turnOff()
      if (this.phase === 'cleanup-failed') return
    }
    if (this.listenerWanted()) { if (this.phase === 'off') await this.turnOn() }
    else if (this.phase !== 'off' || this.listener || this.record.mapped) await this.turnOff()
  }

  private async turnOn(): Promise<void> {
    if (this.listenerStopped || !this.listenerWanted()) {
      await this.turnOff()
      if (this.phase === 'cleanup-failed' || !this.listenerWanted()) return
    }
    this.clearRetry()
    this.reset('starting')
    this.publish()
    let status: TailscaleStatus
    try { status = await this.options.tailscale.status() } catch { status = { state: 'not-running' } }
    if (status.state !== 'running') {
      this.tailscaleCheck = { status: 'failed', reason: status.state }
      await this.fail()
      // Tailscale often starts after Sotto at sign-in, so look again in a while rather than wait for Try again.
      if (status.state === 'not-running') this.scheduleRetry()
      return
    }
    this.tailscaleCheck = { status: 'ok', hostName: status.hostName, dnsName: status.dnsName }
    this.publish()
    let owner: ReturnType<typeof servePortOwner>
    try { owner = servePortOwner(await this.options.tailscale.serveStatus(), PHONE_ACCESS_SERVE_PORT, this.ourPorts()) }
    catch (error) { this.options.log?.('phone-access-serve-status-failed'); await this.failServe(error instanceof TailscaleAccessDenied ? 'denied' : 'failed'); return }
    if (owner === 'ours') this.record.mapped = true
    if (owner === 'taken') { await this.failServe('port-taken'); return }
    if (this.listenerStopped || !this.listenerWanted()) { await this.turnOff(); return }
    if (!this.listener) {
      // Paired phones that cannot be read are never replaced: the listener stays shut until they can be.
      if (!await this.loadPairing()) { await this.failServe('listener'); return }
      try { this.listener = await this.listen() }
      catch { this.options.log?.('phone-access-listener-failed'); await this.failServe('listener'); return }
    }
    if (this.listenerStopped || !this.listenerWanted()) { await this.turnOff(); return }
    const port = this.listener.descriptor.port
    if (!await this.save({ port, mapped: true })) { await this.failServe('record'); return }
    if (this.listenerStopped || !this.listenerWanted()) { await this.turnOff(); return }
    let result: ServeResult
    try { result = await this.options.tailscale.serve(PHONE_ACCESS_SERVE_PORT, port) } catch { result = { ok: false, reason: 'failed' } }
    if (!result.ok) {
      this.options.log?.(result.reason === 'not-enabled' ? 'phone-access-serve-not-enabled' : result.reason === 'denied' ? 'phone-access-serve-denied' : 'phone-access-serve-failed')
      this.enableUrl = result.reason === 'not-enabled' ? result.enableUrl : undefined
      // A consent request or a refusal made no new setting. Other failures keep cleanup pending until Serve is checked.
      if (result.reason !== 'failed') await this.save({ port, mapped: owner === 'ours' })
      await this.failServe(result.reason)
      return
    }
    if (this.listenerStopped || !this.listenerWanted()) { await this.turnOff(); return }
    this.serveCheck = { status: 'ok' }
    this.address = `https://${status.dnsName}:${PHONE_ACCESS_SERVE_PORT}`
    this.phase = 'on'
    this.options.log?.('phone-access-on')
    this.publish()
  }

  private reset(phase: PhonesState['phase']): void {
    if (phase === 'off') this.listenerStopped = false
    this.phase = phase; this.tailscaleCheck = WAITING; this.serveCheck = WAITING; this.address = null; this.enableUrl = undefined
  }

  private async failServe(reason: 'port-taken' | 'not-enabled' | 'denied' | 'listener' | 'failed' | 'record'): Promise<void> {
    this.serveCheck = { status: 'failed', reason, ...(this.enableUrl ? { canOpenSetup: true } : {}) }
    await this.fail()
  }

  /**
   * A failed step: say which one, remove a Serve setting of Sotto's that is still there (a crash's, say),
   * and stop the host protocol if it opened. Pending cleanup reserves the saved loopback port.
   */
  private async fail(): Promise<void> {
    this.phase = 'failed'
    await this.reservePort()
    if (!await this.removeMapping()) { this.cleanupFailed(); return }
    await this.releasePort()
    await this.closeListener()
    this.publish()
  }

  private async turnOff(): Promise<void> {
    this.clearRetry()
    this.cancelCode()
    await this.reservePort()
    if (!await this.removeMapping()) { this.cleanupFailed(); return }
    await this.releasePort()
    await this.closeListener()
    this.reset('off')
    this.publish()
  }

  /** Removes Sotto's own Serve setting when the record says one may be there. Anyone else's on 8443 is never touched. */
  private async removeMapping(): Promise<boolean> {
    if (!this.record.mapped) return true
    try {
      if (this.recordUncertain) {
        let readable = false
        try {
          const recovered = await this.store.peek()
          readable = true
          if (recovered.port !== null) { this.record = { ...recovered, mapped: true }; this.recordUncertain = false; await this.reservePort() }
        } catch { /* Still check Serve, even when the saved record remains unreadable. */ }
        if (this.recordUncertain && readable) await this.save(this.record)
      }
      const owner = servePortOwner(await this.options.tailscale.serveStatus(), PHONE_ACCESS_SERVE_PORT, this.ourPorts())
      if (owner === 'ours' && !await this.options.tailscale.unserve(PHONE_ACCESS_SERVE_PORT)) { this.options.log?.('phone-access-serve-remove-failed'); return false }
      // Without a readable record, an occupied mapping cannot be attributed to Sotto.
      if (this.recordUncertain && owner !== 'free') return false
      if (!await this.save({ ...this.record, mapped: false })) return false
      this.recordUncertain = false
      return true
    } catch { this.options.log?.('phone-access-serve-remove-failed'); return false }
  }

  private cleanupFailed(): void {
    this.phase = 'cleanup-failed'
    this.address = null
    this.cancelCode()
    this.serveCheck = { status: 'failed', reason: this.recordUncertain ? 'cleanup-record' : 'cleanup' }
    if (!this.closed) this.scheduleRetry()
    this.publish()
  }

  /** Stops the protocol without releasing a live port; a restart reserves the saved port directly. */
  private async reservePort(): Promise<void> {
    if (this.listener) {
      this.listener.stopServing()
      this.reservation = this.listener
      this.listener = undefined
    }
    if (this.reservation || this.record.port === null || !this.record.mapped) return
    const server: Server = createServer(socket => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.record.port!, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      server.unref()
      this.reservation = { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    } catch { this.options.log?.('phone-access-listener-failed') }
  }

  private async releasePort(): Promise<void> {
    const reservation = this.reservation
    this.reservation = undefined
    await reservation?.close().catch(() => this.options.log?.('phone-access-listener-close-failed'))
  }

  private async listen(): Promise<Listener> {
    const start = this.options.startServer ?? startSocketServer
    const { desktops, ...listener } = this.options.listener ?? {}
    const base = {
      ...listener,
      ...(desktops ? { tailnet: { desktops, phonesAdmitted: () => this.phonesWanted() } } : {}),
      service: this.options.service!, pairing: this.pairing, admin: false,
      // Its own key: on a headless host the listener with the administrative routes observes threads over the same service.
      observationKey: 'tailnet-observations',
      name: () => this.computerName(),
      mayAnswer: (client: ClientIdentity) => this.options.policy?.mayGrant(client).allowed ?? false,
      onPaired: (clientId: string) => {
        this.cancelCode()
        if (this.phoneIds) { this.phoneIds.add(clientId); void this.rememberPhones() }
        this.publish()
      },
      onPeersChanged: () => this.publish(),
    }
    // The remembered port first, so the Serve setting a crash left behind still reads as Sotto's; any free port otherwise.
    if (this.record.port !== null) {
      try { return await start({ ...base, port: this.record.port }) } catch { /* taken by something else now */ }
    }
    return start({ ...base, port: 0 })
  }

  private async closeListener(): Promise<void> {
    const listener = this.listener
    this.listener = undefined
    // Closing drops every phone's socket with it.
    await listener?.close().catch(() => this.options.log?.('phone-access-listener-close-failed'))
  }

  /** Every loopback port Sotto has served phones from in this run, so its own older setting still reads as its own. */
  private ourPorts(): number[] {
    return [...new Set([...this.formerPorts, this.record.port, this.listener?.descriptor.port].filter((port): port is number => typeof port === 'number'))]
  }

  private async save(record: PhoneAccessRecord): Promise<boolean> {
    try { await this.store.write(record) } catch { this.options.log?.('phone-access-record-write-failed'); return false }
    if (this.record.port !== null && this.record.port !== record.port) this.formerPorts.add(this.record.port)
    this.record = record
    return true
  }

  private cancelCode(): void {
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.codeTimer = undefined
    if (this.code && this.pairingReady) this.pairing.cancelPairingCode(this.code.code)
    this.code = null
  }

  private scheduleRetry(): void {
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.enqueue(async () => { if (!this.closed && this.phase === 'cleanup-failed') await this.reconcile(); else if (this.listenerWanted() && this.phase === 'failed' && this.tailscaleCheck.status === 'failed') await this.turnOn() })
    }, this.options.retryMs ?? 30_000)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(() => { this.options.log?.('phone-access-failed') })
  }

  private publish(): void {
    if (this.watchers.size > 0) {
      const brief = this.brief()
      for (const watcher of this.watchers) watcher(brief)
    }
    if (this.listeners.size === 0) return
    const state = this.get()
    for (const listener of this.listeners) listener(state)
  }
}

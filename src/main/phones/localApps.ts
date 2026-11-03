import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { startSocketServer, type SocketServerOptions } from '../../host/socketServer'
import type { ClientIdentity, HostService } from '../agents/hostService'
import { PairedClients } from '../agents/pairing'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { LocalAppsState } from '../../shared/localApps'
import type { PhoneAccessPolicy } from './phoneAccess'

/**
 * Local apps (ADR-0180, the Owl feature `local-apps`): while the `localApps` setting is on and the local host runs, main
 * opens the host protocol listener a second time over the desktop's own host service, on loopback only, with the
 * features a phone's listener offers. One client, Apps on this computer, is paired in a store of its own
 * (`local-apps/paired-clients.json`) without a code, and its token is written to `local-apps.json`, which only this user
 * can read. An app on this computer reads that file and then speaks host protocol v1 as a paired phone does.
 *
 * The client may answer questions and permissions: turning the switch on writes its remote-answer policy record, and
 * turning it off revokes the record and the client and deletes the file (ADR-0004). Quitting only closes the listener,
 * so the next start keeps the same client and token and tries the same port first. Tailscale is never touched.
 */

/** What local apps log: stable event names only, never the token, the port or the client ID. */
export type LocalAppsEvent =
  | 'local-apps-on' | 'local-apps-off' | 'local-apps-failed' | 'local-apps-pairing-replaced' | 'local-apps-pairing-unreadable'
  | 'local-apps-pair-failed' | 'local-apps-listener-failed' | 'local-apps-listener-close-failed' | 'local-apps-file-write-failed'
  | 'local-apps-file-remove-failed' | 'local-apps-revoke-failed' | 'local-apps-policy-grant-failed' | 'local-apps-policy-revoke-failed'

export interface LocalAppsOptions {
  /** The desktop's user data folder: `local-apps.json` and the `local-apps` pairing folder live here. */
  readonly directory: string
  /** The local host's service, or nothing when the local host is off. */
  readonly service: HostService | undefined
  readonly settings: () => { readonly localApps: boolean }
  readonly policy?: PhoneAccessPolicy | undefined
  /** What the desktop's phone listener is given as well, so an app is offered what a phone is. */
  readonly listener?: Pick<SocketServerOptions, 'sottoVersion' | 'delegation'>
  /** Stable event names only. */
  readonly log?: (event: LocalAppsEvent) => void
  readonly startServer?: typeof startSocketServer
}

/** The name the one client is paired under. */
export const LOCAL_APPS_CLIENT_NAME = 'Apps on this computer'
const ANSWERS_NOTE = 'The user turned on Let apps on this computer connect, which lets those apps answer.'

const fileSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1).max(512),
  clientId: z.string().min(1).max(512),
}).strict()
type LocalAppsFile = z.infer<typeof fileSchema>

type Listener = Awaited<ReturnType<typeof startSocketServer>>

export class LocalApps {
  private readonly filePath: string
  private readonly pairingPath: string
  private readonly storePath: string
  private readonly file: AtomicJsonStore<LocalAppsFile>
  private pairing: PairedClients | undefined
  private listener: Listener | undefined
  private phase: LocalAppsState['phase'] = 'off'
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(state: LocalAppsState) => void>()

  constructor(private readonly options: LocalAppsOptions) {
    this.filePath = join(options.directory, 'local-apps.json')
    this.pairingPath = join(options.directory, 'local-apps')
    this.storePath = join(this.pairingPath, 'paired-clients.json')
    // Written through the store, which makes the file 0600 and replaces it whole; read directly, since a missing or
    // damaged file is simply replaced.
    this.file = new AtomicJsonStore(this.filePath, fileSchema.parse, () => { throw new Error('The local apps file is never read through its store.') })
  }

  /** Brings local apps in line with the setting. */
  async start(): Promise<void> {
    this.settingsChanged()
    await this.queue
  }

  /** Called when the switch changed. */
  settingsChanged(): void {
    this.enqueue(() => this.reconcile())
  }

  get(): LocalAppsState {
    return { phase: this.phase, localHostRunning: this.options.service !== undefined }
  }

  subscribe(listener: (state: LocalAppsState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** On quit: closes the listener and every app's socket. The file and the client stay for the next start. */
  async close(): Promise<void> {
    this.closed = true
    this.enqueue(() => this.closeListener())
    await this.queue
  }

  /** Waits for the changes in progress. */
  settled(): Promise<void> { return this.queue }

  private async reconcile(): Promise<void> {
    if (this.closed) return
    if (!this.options.settings().localApps) { await this.turnOff(); return }
    // A failure waits for the switch to be turned off and on again, or for the next start.
    if (this.options.service && this.phase === 'off') await this.turnOn()
  }

  private async turnOn(): Promise<void> {
    const pairing = await this.loadPairing()
    if (!pairing) { this.fail(); return }
    const saved = await this.readFile()
    try { this.listener = await this.listen(pairing, saved?.port) }
    catch { this.options.log?.('local-apps-listener-failed'); this.fail(); return }
    const port = this.listener.descriptor.port
    // The token is kept only in the file; the store holds its hash. It is kept while it still opens a session and the
    // listener got the file's port back; otherwise an app may have sent it to whatever holds that port now.
    const kept = saved && saved.port === port && pairing.verifyToken(saved.token) === saved.clientId ? { clientId: saved.clientId, token: saved.token } : undefined
    if (!await this.admit(pairing, port, kept ?? await this.pairAgain(pairing, saved?.clientId))) { await this.closeListener(); this.fail(); return }
    this.phase = 'on'
    this.options.log?.('local-apps-on')
    this.publish()
  }

  /** The app unpaired itself (`/v1/revoke`). The switch is still on, so a new client and file replace it on the same listener. */
  private async revoked(clientId: string): Promise<void> {
    if (!this.listener || !this.pairing) return
    if (await this.admit(this.pairing, this.listener.descriptor.port, await this.pairAgain(this.pairing, clientId))) return
    await this.closeListener()
    this.fail()
  }

  /** Revokes the clients there were and pairs Apps on this computer again, without a code. */
  private async pairAgain(pairing: PairedClients, named: string | undefined): Promise<{ clientId: string; token: string } | undefined> {
    if (!await this.revokeAll(pairing, named)) return undefined
    try { return await pairing.redeem(pairing.issuePairingCode().code, LOCAL_APPS_CLIENT_NAME) }
    catch { this.options.log?.('local-apps-pair-failed'); return undefined }
  }

  /** Lets the client answer and writes the file that names it. */
  private async admit(pairing: PairedClients, port: number, granted: { clientId: string; token: string } | undefined): Promise<boolean> {
    if (!granted || !pairing.isPaired(granted.clientId)) return false
    if (this.options.policy) {
      try { this.options.policy.ensureRemoteAnswers(granted.clientId, ANSWERS_NOTE) } catch { this.options.log?.('local-apps-policy-grant-failed') }
    }
    try { await this.file.write({ version: 1, port, ...granted }); return true }
    catch { this.options.log?.('local-apps-file-write-failed'); return false }
  }

  private async turnOff(): Promise<void> {
    await this.closeListener()
    const saved = await this.readFile()
    // Read the store only when there is one: a switch never turned on leaves no folder behind.
    const pairing = this.pairing ?? (await exists(this.storePath) ? await this.loadPairing() : undefined)
    await this.revokeAll(pairing, saved?.clientId)
    try { await rm(this.filePath, { force: true }) } catch { this.options.log?.('local-apps-file-remove-failed') }
    const wasOn = this.phase !== 'off'
    this.phase = 'off'
    if (wasOn) this.options.log?.('local-apps-off')
    this.publish()
  }

  /**
   * Unpairs every client in the store, which holds only Apps on this computer, and the one the file names, and revokes
   * each one's record. The record goes first, so a client whose record could not be revoked stays to be found again.
   */
  private async revokeAll(pairing: PairedClients | undefined, named: string | undefined): Promise<boolean> {
    let done = true
    for (const clientId of new Set([...pairing?.list().map(client => client.clientId) ?? [], ...named ? [named] : []])) {
      try { this.options.policy?.setRemoteAnswers(clientId, false, ANSWERS_NOTE) } catch { this.options.log?.('local-apps-policy-revoke-failed'); done = false; continue }
      try { await pairing?.revoke(clientId) } catch { this.options.log?.('local-apps-revoke-failed'); done = false }
    }
    return done
  }

  private async loadPairing(): Promise<PairedClients | undefined> {
    if (this.pairing) return this.pairing
    let pairing = new PairedClients(this.pairingPath)
    try { await pairing.load() } catch {
      // Unlike the phones' store, this one holds only the client the switch pairs, which is paired again when it is lost,
      // so a damaged file is replaced rather than leaving apps shut out for good.
      this.options.log?.('local-apps-pairing-replaced')
      try { await rm(this.storePath, { force: true }); pairing = new PairedClients(this.pairingPath); await pairing.load() }
      catch { this.options.log?.('local-apps-pairing-unreadable'); return undefined }
    }
    this.pairing = pairing
    return pairing
  }

  private async readFile(): Promise<LocalAppsFile | undefined> {
    try { return fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8'))) } catch { return undefined }
  }

  private async listen(pairing: PairedClients, port: number | undefined): Promise<Listener> {
    const start = this.options.startServer ?? startSocketServer
    const base = {
      ...this.options.listener,
      service: this.options.service!, pairing, admin: false,
      // Its own key: the phone listener observes threads over the same service.
      observationKey: 'local-apps-observations',
      // And its own clients: a phone's follow-up for Watcher is the phone listener's to admit or refuse.
      ownClientsOnly: true as const,
      mayAnswer: (client: ClientIdentity) => this.options.policy?.mayGrant(client).allowed ?? false,
      onRevoked: (clientId: string) => this.enqueue(() => this.revoked(clientId)),
    }
    // The port in the file first, so an app that read it before this start finds the listener there again.
    if (port !== undefined) {
      try { return await start({ ...base, port }) } catch { /* taken by something else now */ }
    }
    return start({ ...base, port: 0 })
  }

  private async closeListener(): Promise<void> {
    const listener = this.listener
    this.listener = undefined
    await listener?.close().catch(() => this.options.log?.('local-apps-listener-close-failed'))
  }

  private fail(): void {
    this.phase = 'failed'
    this.publish()
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch(() => { this.options.log?.('local-apps-failed') })
  }

  private publish(): void {
    if (this.listeners.size === 0) return
    const state = this.get()
    for (const listener of this.listeners) listener(state)
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

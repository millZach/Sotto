import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { AtomicJsonStore } from '../storage/atomicJsonStore'

/**
 * Pairing: how a client beyond loopback is admitted (ADR-0016). The user reads a short code off this
 * PC, the client redeems it once for a token, and the token is kept only as a hash. Admission is not
 * authority: a paired client may speak to the host, and a policy record decides whether its answers
 * count as grants (ADR-0004, `Authority.mayGrant`).
 *
 * The loopback listener admits clients through this store; the separate permission policy still
 * decides whether an admitted client may answer. See ADR-0022 for the shipped connection path.
 */

/** How long a pairing code is good for. Long enough to read out, short enough to be worth nothing later. */
export const PAIRING_CODE_LIFETIME_MS = 5 * 60_000
/** How long one signed session lasts before the client signs a new one with its token. */
export const SESSION_LIFETIME_MS = 12 * 60 * 60_000
/** Codes read aloud, so no letters a reader confuses: no I, L, O, U, and no 0 or 1. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

export const pairedClientSchema = z.object({
  clientId: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  pairedAt: z.iso.datetime(),
  tokenHash: z.string().min(1).max(512),
}).strict()
export type PairedClient = z.infer<typeof pairedClientSchema>

const pairedClientsFileSchema = z.object({
  /** Base64url; generated once per install and never leaves this machine. */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  clients: z.array(pairedClientSchema).max(1_000),
}).strict()
type PairedClientsFile = z.infer<typeof pairedClientsFileSchema>

export interface PairingCode {
  readonly code: string
  readonly expiresAt: string
}

/** Said when a code is wrong, spent or too old. One sentence for all three: guessing learns nothing. */
export const PAIRING_CODE_REJECTED = 'This pairing code is not valid any more. Make a new one on this PC.'

function newSecret(): string { return randomBytes(32).toString('base64url') }

function hash(secret: string, value: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(value).digest('base64url')
}

function equals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return code
}

/**
 * The paired clients and the secret their tokens and sessions are signed with. Held in
 * `paired-clients.json` beside the other stores, written through `AtomicJsonStore`, which creates the
 * file 0600 where the platform has file modes.
 *
 * A pairing code lives in memory only. Sotto forgetting an unredeemed code when it quits is the
 * behaviour wanted, not a gap.
 */
export class PairedClients {
  private readonly store: AtomicJsonStore<PairedClientsFile>
  private file: PairedClientsFile = { secret: '', clients: [] }
  private loaded = false
  private mutations: Promise<unknown> = Promise.resolve()
  private readonly filePath: string
  private readonly codes = new Map<string, { expiresAt: number }>()
  private readonly now: () => number
  private readonly createId: () => string

  constructor(directory: string, options: { now?: () => number; createId?: () => string } = {}) {
    this.filePath = join(directory, 'paired-clients.json')
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.store = new AtomicJsonStore(join(directory, 'paired-clients.json'), pairedClientsFileSchema.parse,
      () => ({ secret: newSecret(), clients: [] }))
  }

  /** Reads the file, minting the per-install secret on the first run. Call before anything else. */
  async load(): Promise<void> {
    // Authentication state fails closed. Recovery must never silently replace the signing secret.
    try { this.file = pairedClientsFileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Paired devices could not be read. Restore the host pairing file before starting it.', { cause: error })
      this.file = { secret: newSecret(), clients: [] }
      await this.store.write(this.file)
    }
    this.loaded = true
  }

  list(): readonly PairedClient[] { return this.file.clients.map(client => ({ ...client })) }

  /** A short-lived, single-use code for the user to read to the machine being paired. */
  issuePairingCode(): PairingCode {
    this.requireLoaded()
    const at = this.now()
    for (const [code, entry] of this.codes) if (entry.expiresAt <= at) this.codes.delete(code)
    if (this.codes.size >= 100) throw new Error('Too many pairing codes are open. Wait five minutes and try again.')
    let code = randomCode()
    while (this.codes.has(code)) code = randomCode()
    const expiresAt = at + PAIRING_CODE_LIFETIME_MS
    this.codes.set(code, { expiresAt })
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Spends a code and pairs the client behind it. The token is returned once and kept only as a hash,
   * so a copy of `paired-clients.json` does not let anyone speak as a paired client.
   */
  async redeem(code: string, name: string): Promise<{ clientId: string; token: string }> {
    this.requireLoaded()
    const entry = this.codes.get(code)
    // Spend the code whatever happens next: one read is all a code is worth.
    this.codes.delete(code)
    if (entry === undefined || entry.expiresAt <= this.now()) throw new Error(PAIRING_CODE_REJECTED)
    const clientId = this.createId()
    const token = randomBytes(32).toString('base64url')
    const client = pairedClientSchema.parse({
      clientId, name: name.trim() || 'Paired client',
      pairedAt: new Date(this.now()).toISOString(), tokenHash: hash(this.file.secret, `token:${token}`),
    })
    await this.mutate(async () => {
      if (this.file.clients.length >= 1000) throw new Error('Remove a paired device before adding another.')
      await this.write({ ...this.file, clients: [...this.file.clients, client] })
    })
    return { clientId, token }
  }

  /** The client this token belongs to, or nothing. Never says which of the two it failed on. */
  verifyToken(token: string): string | undefined {
    if (!this.loaded || !token) return undefined
    const candidate = hash(this.file.secret, `token:${token}`)
    return this.file.clients.find(client => equals(client.tokenHash, candidate))?.clientId
  }

  /**
   * A signed session for a client that has already shown its token, so the token is not on every
   * request. `<clientId>.<expiry>.<signature>`; the signature is over the first two parts.
   */
  signSession(clientId: string, at: number = this.now()): string {
    this.requireLoaded()
    if (!this.file.clients.some(client => client.clientId === clientId)) throw new Error('This client is not paired with Sotto. Pair it on this PC first.')
    const body = `${clientId}.${at + SESSION_LIFETIME_MS}`
    return `${body}.${hash(this.file.secret, `session:${body}`)}`
  }

  /** The client a session belongs to while the signature holds, the client is still paired and it has not expired. */
  verifySession(session: string, at: number = this.now()): string | undefined {
    if (!this.loaded || !session) return undefined
    const parts = session.split('.')
    if (parts.length !== 3) return undefined
    const [clientId, expiry, signature] = parts as [string, string, string]
    if (!equals(signature, hash(this.file.secret, `session:${clientId}.${expiry}`))) return undefined
    const expiresAt = Number(expiry)
    if (!Number.isFinite(expiresAt) || expiresAt <= at) return undefined
    return this.file.clients.some(client => client.clientId === clientId) ? clientId : undefined
  }

  /** Unpairs a client. Its token and every session signed for it stop working at once. */
  async revoke(clientId: string): Promise<boolean> {
    this.requireLoaded()
    return this.mutate(async () => {
      const clients = this.file.clients.filter(client => client.clientId !== clientId)
      if (clients.length === this.file.clients.length) return false
      await this.write({ ...this.file, clients })
      return true
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation)
    this.mutations = task.catch(() => undefined)
    return task
  }
  async settled(): Promise<void> { await this.mutations }

  private async write(file: PairedClientsFile): Promise<void> {
    await this.store.write(file)
    this.file = file
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('Paired clients have not been read yet.')
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether a browser origin may speak to a local socket. Loopback over http, plus whatever the user
 * configured, and nothing else — an origin check belongs on the local socket too (ADR-0016). The host
 * listener in `src/host/socketServer.ts` asks it on every HTTP request and upgrade that carries an origin.
 */
export function originAllowed(origin: string | undefined, configured: readonly string[] = []): boolean {
  if (!origin) return false
  if (configured.includes(origin)) return true
  let url: URL
  try { url = new URL(origin) } catch { return false }
  if (url.username || url.password || url.search || url.hash) return false
  if (url.pathname !== '/' && url.pathname !== '') return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname)
}

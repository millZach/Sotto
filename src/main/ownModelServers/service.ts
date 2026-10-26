import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  addRequestSchema, checkRequestSchema, checkSavedRequestSchema, OWN_SERVER_ID_PREFIX, OWN_SERVER_WORDS, ownServerAddress, ownServerListSchema, ownServerSchema,
  ownServerRefusalWords, removeRequestSchema, type AddResult, type CheckResult, type FoundModel, type OwnServer, type OwnServerModel,
  type OwnServerRefusal, type RemoveResult,
} from '../../shared/ownModelServers'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { checkOwnServer, type OwnServerCheckOptions } from './check'

/** Stable event names the user's own model servers are logged by. No address, name, model, key or server answer ever is. */
export type OwnServerEvent = 'own-server-checked' | 'own-server-check-refused' | 'own-server-added' | 'own-server-add-refused'
  | 'own-server-removed' | 'own-server-remove-refused' | 'own-server-sign-in-failed' | 'own-server-sign-out-failed' | 'own-server-catalog-unread'

/** The most servers Sotto keeps. */
export const OWN_SERVERS_MAX = 32
/** Where the record is kept, under Sotto's user data. */
export const OWN_SERVERS_FILE = 'own-model-servers.json'

/**
 * What the record needs of Sotto's OpenCode, the one provider that runs the user's servers in this phase. The key passes
 * through `signInWithKey` once, to OpenCode's own `connect/key`, and is never kept here.
 */
export interface OwnServersOpenCode {
  /** Whether OpenCode is connected, so its processes may be started. */
  running(): boolean
  /** The list changed: every OpenCode process started with the old one is outdated, as after a sign-in change. */
  outdated(): void
  /** Reads the catalog again on a fresh process, so the model menu has what changed; false when it could not. */
  catalogAgain(): Promise<boolean>
  /** Signs the server's source in with its key on a process started after the record has it; false when OpenCode refused. */
  signInWithKey(sourceId: string, key: string): Promise<boolean>
  /** Deletes the key OpenCode holds for the server's source; false when it could not. */
  signOut(sourceId: string): Promise<boolean>
}

/**
 * DeepSeek Harness as the record reaches it (ADR-0138): a nudge on every save. While its adapter runs, a keyless Add may
 * land on it alone, connected or not, since it reads the record when it connects and connects only once one is saved.
 */
export interface OwnServersDeepSeek {
  changed(): void
}

export interface OwnServersOptions {
  /** Sotto's user data folder. */
  readonly directory: string
  /** Sotto's OpenCode, or undefined while it is held off this run. */
  readonly openCode: () => OwnServersOpenCode | undefined
  /** Sotto's DeepSeek Harness (ADR-0138), or undefined while its adapter does not run. Read afresh, as OpenCode's is. */
  readonly deepSeek?: () => OwnServersDeepSeek | undefined
  /** The check, which a test replaces. */
  readonly check?: (address: string, key: string | undefined) => Promise<CheckResult>
  readonly checkOptions?: OwnServerCheckOptions
  readonly log?: (event: OwnServerEvent) => void
  /** A new server's ID suffix for its address, which a test fixes. */
  readonly newId?: (address: string) => string
  /** The clock Check again times a server by, which a test fixes. */
  readonly now?: () => number
}

/**
 * A server's ID suffix, from its address as Sotto saves it: the same address always gives the same ID, so a server removed
 * and added again, such as to give it the right key, is the same model source, and a thread on one of its models carries
 * on (ADR-0124). Servers saved before keep the random IDs they were given.
 */
export function addressSuffix(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 12)
}
/** Why a check, an add or a remove went no further, in the shape every one of their answers shares. */
interface Refusal { readonly status: 'refused'; readonly reason: OwnServerRefusal; readonly message: string }
const refusal = (reason: OwnServerRefusal, message: string): Refusal => ({ status: 'refused', reason, message })

/**
 * The user's own model servers (ADR-0124): the record main keeps in `own-model-servers.json`, the check, and adding and
 * removing a server with Sotto's OpenCode told each time. Adds and removes take turns, so two never interleave.
 */
export class OwnServers {
  private readonly store: AtomicJsonStore<OwnServer[]>
  private loaded: Promise<OwnServer[]> | undefined
  private turn: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: OwnServersOptions) {
    this.store = new AtomicJsonStore(join(options.directory, OWN_SERVERS_FILE), ownServerListSchema.parse, () => [])
  }

  private log(event: OwnServerEvent): void { this.options.log?.(event) }
  private servers(): Promise<OwnServer[]> {
    if (!this.loaded) {
      const reading = this.store.read()
      this.loaded = reading
      // A record that could not be read is read again next time, rather than taken as empty for good.
      reading.catch(() => { if (this.loaded === reading) this.loaded = undefined })
    }
    return this.loaded
  }
  private async save(servers: OwnServer[]): Promise<void> {
    await this.store.write(servers)
    this.loaded = Promise.resolve(servers)
    // Every write is an add, a remove, or one of their rollbacks: DeepSeek Harness rebuilds from the new record.
    try { this.options.deepSeek?.()?.changed() } catch { /* A consumer's trouble never fails the save. */ }
  }
  /** Runs `work` once every add or remove before it has finished. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.turn.then(work, work)
    this.turn = run.catch(() => undefined)
    return run
  }

  /** The servers as they are saved, in the order they were added. */
  async list(): Promise<OwnServer[]> { return [...await this.servers()] }

  /** Checks the server at an address the user typed, with the key they gave. Nothing is saved. */
  async check(request: unknown): Promise<CheckResult> {
    const { address, key } = checkRequestSchema.parse(request)
    return this.checked(await this.run(address, key))
  }

  /**
   * Check again: the saved server as it is saved. Sotto keeps no key, so a server added with one that asks for it has
   * answered, and says so with `keyKept`: its models could not be read again, so they are the saved ones. The time is
   * how long it took to ask, since a check that is asked for a key sends nothing more.
   */
  async checkSaved(request: unknown): Promise<CheckResult> {
    const { id } = checkSavedRequestSchema.parse(request)
    const server = (await this.servers()).find(item => item.id === id)
    if (!server) return this.checked(refusal('not-found', OWN_SERVER_WORDS.notFound))
    const now = this.options.now ?? Date.now
    const started = now()
    const result = await this.run(server.address, undefined)
    if (server.keyed && result.status === 'refused' && (result.reason === 'key-needed' || result.reason === 'key-refused')) {
      const answeredMs = Math.min(600_000, Math.max(0, Math.round(now() - started)))
      return this.checked({ status: 'ok', address: server.address, kind: 'openai-compatible', models: server.models.map(savedAsFound), answeredMs, keyKept: true })
    }
    return this.checked(result)
  }
  private run(address: string, key: string | undefined): Promise<CheckResult> {
    return this.options.check ? this.options.check(address, key) : checkOwnServer(address, key, this.options.checkOptions)
  }
  private checked(result: CheckResult): CheckResult {
    this.log(result.status === 'ok' ? 'own-server-checked' : 'own-server-check-refused')
    return result
  }

  /**
   * Adds a server: the record first, then OpenCode is told, and with a key the new source is signed in on a process
   * started after the record had it. When OpenCode does not take the key, the record is taken out again.
   */
  add(request: unknown): Promise<AddResult> {
    const parsed = addRequestSchema.parse(request)
    return this.inTurn(async () => {
      const result = await this.adding(parsed)
      if (result.status === 'refused') this.log('own-server-add-refused')
      return result
    })
  }
  private async adding(request: ReturnType<typeof addRequestSchema.parse>): Promise<AddResult> {
    const place = ownServerAddress(request.address)
    if (!place.ok) return refusal(place.reason, ownServerRefusalWords(place.reason, place.host))
    const servers = await this.servers()
    if (servers.length >= OWN_SERVERS_MAX) return refusal('full', OWN_SERVER_WORDS.full)
    const openCode = this.options.openCode()
    // A keyless server needs no key kept anywhere, so DeepSeek Harness's adapter can take it on its own (ADR-0138).
    const keyless = !(request.key?.trim())
    if (!openCode?.running() && !(keyless && this.options.deepSeek?.())) return refusal('opencode-not-running', OWN_SERVER_WORDS.openCodeNotRunning)
    const saved = servers.find(server => server.address.toLowerCase() === place.address.toLowerCase())
    if (saved) return refusal('already-added', ownServerRefusalWords('already-added', place.host))
    const key = request.key?.trim() || undefined
    const taken = new Set(servers.map(server => server.id))
    const base = `${OWN_SERVER_ID_PREFIX}${(this.options.newId ?? addressSuffix)(place.address)}`
    // Another address that came to the same ID, which twelve hex digits make all but impossible, gets the next free one.
    let id = base
    for (let next = 2; taken.has(id); next++) id = `${base}-${next}`
    // A model listed twice is declared once, as OpenCode keys them by ID.
    const models = [...new Map(request.models.map(model => [model.id, model])).values()]
    // Checked whole before it is written, so the record never holds what it could not read back.
    const server: OwnServer = ownServerSchema.parse({ id, name: request.name, address: place.address, keyed: key !== undefined, models })
    await this.save([...servers, server])
    openCode?.outdated()
    if (key !== undefined) {
      // A keyed add passed the gate above only with OpenCode running: it is the one that keeps the key.
      const keeper = openCode!
      const signedIn = await keeper.signInWithKey(id, key).catch(() => false)
      if (!signedIn) {
        this.log('own-server-sign-in-failed')
        // OpenCode may have kept the key all the same, such as when its answer was lost; it is asked to forget it while
        // the record still declares the source, so no key is left behind for a source nothing lists.
        if (!await keeper.signOut(id).catch(() => false)) this.log('own-server-sign-out-failed')
        // Nothing is kept: the record goes, and the processes started with it are outdated again. A record that cannot be
        // written now still lists the server, without its key, and the answer says so rather than that nothing changed.
        try { await this.save((await this.servers()).filter(item => item.id !== id)) } catch { return refusal('added-partly', OWN_SERVER_WORDS.addPartly(server.name)) }
        keeper.outdated()
        void keeper.catalogAgain().catch(() => false)
        return refusal('sign-in-failed', OWN_SERVER_WORDS.signInFailed(server.name))
      }
    } else if (openCode && !await openCode.catalogAgain().catch(() => false)) this.log('own-server-catalog-unread')
    this.log('own-server-added')
    return { status: 'ok', server }
  }

  /**
   * Removes a server: OpenCode forgets its key first, so no key is left behind for a source nothing lists, then the record
   * goes and OpenCode is told. When the record could not be written after the key went, the answer says so; removing it
   * again then signs out a source with no key left, which OpenCode takes as done.
   */
  remove(request: unknown): Promise<RemoveResult> {
    const { id } = removeRequestSchema.parse(request)
    return this.inTurn(async () => {
      const result = await this.removing(id)
      this.log(result.status === 'ok' ? 'own-server-removed' : 'own-server-remove-refused')
      return result
    })
  }
  private async removing(id: string): Promise<RemoveResult> {
    const servers = await this.servers()
    const server = servers.find(item => item.id === id)
    if (!server) return refusal('not-found', OWN_SERVER_WORDS.notFound)
    const openCode = this.options.openCode()
    const running = openCode?.running() === true
    if (server.keyed) {
      if (!running) return refusal('opencode-not-running', OWN_SERVER_WORDS.removeNeedsOpenCode(server.name))
      if (!await openCode!.signOut(id).catch(() => false)) {
        this.log('own-server-sign-out-failed')
        return refusal('sign-in-failed', OWN_SERVER_WORDS.signOutFailed(server.name))
      }
      try { await this.save(servers.filter(item => item.id !== id)) } catch {
        return refusal('removed-partly', OWN_SERVER_WORDS.removePartly(server.name))
      }
    } else await this.save(servers.filter(item => item.id !== id))
    if (running) {
      openCode!.outdated()
      if (!await openCode!.catalogAgain().catch(() => false)) this.log('own-server-catalog-unread')
    }
    return { status: 'ok' }
  }
}

/** A saved model as a check would have found it. */
function savedAsFound(model: OwnServerModel): FoundModel {
  return { id: model.id, name: model.name, context: model.context, ...(model.output !== undefined ? { output: model.output } : {}), thinking: model.thinking, images: model.images }
}

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  chooseModelsSchema, replaceKeySchema, addRequestSchema, checkRequestSchema, checkSavedRequestSchema, OWN_SERVER_ID_PREFIX, OWN_SERVER_WORDS, ownServerAddress, ownServerListSchema, ownServerSchema,
  ownServerRefusalWords, removeRequestSchema, type AddResult, type CheckResult, type FoundModel, type OwnServer, type OwnServerModel,
  type OwnServerRefusal, type RemoveResult,
} from '../../shared/ownModelServers'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { checkOwnServer, type OwnServerCheckOptions } from './check'
import { ModelCatalogue, mergeModelFacts } from './catalogue'

/** Stable event names the user's own model servers are logged by. No address, name, model, key or server answer ever is. */
export type OwnServerEvent = 'own-server-checked' | 'own-server-check-refused' | 'own-server-added' | 'own-server-add-refused'
  | 'own-server-removed' | 'own-server-remove-refused' | 'own-server-sign-in-failed' | 'own-server-sign-out-failed' | 'own-server-catalog-unread'

/** The most servers Sotto keeps. */
export const OWN_SERVERS_MAX = 32
/** Where the record is kept, under Sotto's user data. */
export const OWN_SERVERS_FILE = 'own-model-servers.json'

/**
 * What the record needs of Sotto's OpenCode. The key passes
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
 * DeepSeek as the record reaches it (ADR-0138): a nudge on every save. While its adapter runs, a keyless Add may
 * land on it alone, connected or not, since it reads the record when it connects and connects only once one is saved.
 */
export interface OwnServersDeepSeek {
  changed(): void
}

/**
 * Sotto's Hermes as the record reaches it: it can keep a key on its own or beside OpenCode's copy, and forgets it on
 * Remove. Its saves are nudged through `deepSeek.changed` like DeepSeek's.
 */
export interface OwnServersHermes {
  keepKey(sourceId: string, key: string): Promise<void>
  forgetKey(sourceId: string): Promise<void>
}

export interface OwnServersOptions {
  /** Sotto's user data folder. */
  readonly directory: string
  /** Sotto's OpenCode, or undefined while it is held off this run. */
  readonly openCode: () => OwnServersOpenCode | undefined
  /** Sotto's DeepSeek (ADR-0138), or undefined while its adapter does not run. Read afresh, as OpenCode's is. */
  readonly deepSeek?: () => OwnServersDeepSeek | undefined
  /** Sotto's Hermes, only while its adapter runs and can keep a key. It need not be connected yet. */
  readonly hermes?: () => OwnServersHermes | undefined
  /** Deletes Hermes's saved key and profile copies while its adapter does not run. */
  readonly forgetHermesKey?: (sourceId: string) => Promise<void>
  /** The check, which a test replaces. */
  readonly check?: (address: string, key: string | undefined) => Promise<CheckResult>
  readonly catalogue?: ModelCatalogue
  readonly readKey?: (id: string) => Promise<string | undefined>
  /** Replaces an existing Hermes file copy while its adapter is held, without creating a new keeper. */
  readonly replaceHeldHermesKey?: (id: string, key: string) => Promise<void>
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
  private readonly catalogueSource: ModelCatalogue
  private readonly store: AtomicJsonStore<OwnServer[]>
  private loaded: Promise<OwnServer[]> | undefined
  private turn: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: OwnServersOptions) {
    this.catalogueSource = options.catalogue ?? new ModelCatalogue()
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
    // Every write is an add, a remove, or one of their rollbacks: DeepSeek rebuilds from the new record.
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

  catalogue(): ReturnType<ModelCatalogue['load']> { return this.catalogueSource.load() }

  private enrich(result: CheckResult, catalogueId?: string, previous: readonly FoundModel[] = []): CheckResult {
    if (result.status !== 'ok') return result
    const catalogue = this.catalogueSource.provider(result.address, catalogueId)
    const known = new Map(previous.map(model => [model.id, model]))
    return { ...result, models: result.models.map(model => mergeModelFacts(model, catalogue?.models.get(model.id) ?? known.get(model.id))) }
  }

  /** Checks the server at an address the user typed, with the key they gave. Nothing is saved. */
  async check(request: unknown): Promise<CheckResult> {
    const { address, key, catalogueId } = checkRequestSchema.parse(request)
    return this.checked(this.enrich(await this.run(address, key), catalogueId))
  }

  /**
   * Check again: the saved server using a readable Hermes key when available. A server that asks for a key has
   * answered, and says so with `keyKept`: its models could not be read again, so they are the saved ones. The time is
   * how long it took to ask, since a check that is asked for a key sends nothing more.
   */
  async checkSaved(request: unknown): Promise<CheckResult> {
    const { id } = checkSavedRequestSchema.parse(request)
    return this.inTurn(async () => {
      const servers = await this.servers(), server = servers.find(item => item.id === id)
      if (!server) return this.checked(refusal('not-found', OWN_SERVER_WORDS.notFound))
      // A hosted API's saved facts come from the catalogue too, and Check again may be pressed before Add ever opened.
      if (server.address.startsWith('https://')) await this.catalogueSource.load()
      const now = this.options.now ?? Date.now, started = now()
      const key = server.keyed ? await this.options.readKey?.(id) : undefined
      const result = this.enrich(await this.run(server.address, key), server.catalogueId, server.inventory ?? server.models)
      if (server.keyed && !key && result.status === 'refused' && (result.reason === 'key-needed' || result.reason === 'key-refused')) {
        const answeredMs = Math.min(600_000, Math.max(0, Math.round(now() - started)))
        return this.checked({ status: 'ok', address: server.address, kind: 'openai-compatible', models: (server.inventory ?? server.models).map(savedAsFound), answeredMs, keyKept: true })
      }
      if (result.status === 'ok') {
        const before = new Set((server.inventory ?? server.models).map(model => model.id))
        const models = new Map(server.models.map(model => [model.id, model]))
        for (const model of result.models) if (model.context !== undefined) models.set(model.id, runnable(model))
        const updated: OwnServer = { ...server, models: [...models.values()], inventory: result.models,
          keptModelIds: server.keptModelIds ?? server.models.map(model => model.id),
          newModelIds: result.models.filter(model => !before.has(model.id)).map(model => model.id), checkedAt: new Date(now()).toISOString() }
        await this.save(servers.map(item => item.id === id ? updated : item))
        this.options.openCode()?.outdated()
        void this.options.openCode()?.catalogAgain().catch(() => false)
      }
      return this.checked(result)
    })
  }

  private run(address: string, key: string | undefined): Promise<CheckResult> {
    return this.options.check ? this.options.check(address, key) : checkOwnServer(address, key, this.options.checkOptions)
  }
  private checked(result: CheckResult): CheckResult {
    this.log(result.status === 'ok' ? 'own-server-checked' : 'own-server-check-refused')
    return result
  }

  /**
   * Adds a server: the record first, then its provider takes the key. OpenCode signs in on a process started after the
   * record had it; Hermes can keep the key alone. A refused add clears the key before taking the record out again.
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
    const candidate = this.options.openCode()
    const openCode = candidate?.running() ? candidate : undefined
    const hermes = this.options.hermes?.()
    // A keyless server needs no key kept anywhere, so DeepSeek's adapter can take it on its own (ADR-0138).
    const keyless = !(request.key?.trim())
    if (!openCode && !hermes && !(keyless && this.options.deepSeek?.())) return refusal('opencode-not-running', OWN_SERVER_WORDS.openCodeNotRunning)
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
    if (request.keptModelIds?.some(id => !models.some(model => model.id === id))) return refusal('failed', OWN_SERVER_WORDS.failed)
    // Checked whole before it is written, so the record never holds what it could not read back.
    const server: OwnServer = ownServerSchema.parse({ id, name: request.name, address: place.address, keyed: key !== undefined, models,
      ...(request.catalogueId ? { catalogueId: request.catalogueId } : {}),
      ...(this.catalogueSource.provider(place.address, request.catalogueId)?.doc ? { helpUrl: this.catalogueSource.provider(place.address, request.catalogueId)!.doc } : {}),
      ...(request.inventory ? { inventory: request.inventory, checkedAt: new Date((this.options.now ?? Date.now)()).toISOString() } : {}),
      ...(request.keptModelIds ? { keptModelIds: request.keptModelIds } : {}),
      ...(key !== undefined ? { keyKeeper: openCode ? 'opencode' : 'hermes' } : {}) })
    await this.save([...servers, server])
    openCode?.outdated()
    if (key !== undefined) {
      const signedIn = openCode
        ? await openCode.signInWithKey(id, key).catch(() => false)
        : await hermes!.keepKey(id, key).then(() => true, () => false)
      if (!signedIn) {
        this.log('own-server-sign-in-failed')
        // The keeper may have saved the key before failing. Keep the server listed until that copy is gone.
        const forgotten = openCode ? await openCode.signOut(id).catch(() => false) : await this.forgetHermes(server)
        if (!forgotten) {
          this.log('own-server-sign-out-failed')
          return refusal('added-partly', OWN_SERVER_WORDS.addPartly(server.name))
        }
        try { await this.save((await this.servers()).filter(item => item.id !== id)) } catch { return refusal('added-partly', OWN_SERVER_WORDS.addPartly(server.name)) }
        openCode?.outdated()
        void openCode?.catalogAgain().catch(() => false)
        return refusal('sign-in-failed', OWN_SERVER_WORDS.signInFailed(server.name))
      }
      // Hermes's copy is a second keeper's, not the add's: without it the server runs in OpenCode alone.
      if (openCode) await hermes?.keepKey(id, key).catch(() => { this.log('own-server-sign-in-failed') })
    } else if (openCode && !await openCode.catalogAgain().catch(() => false)) this.log('own-server-catalog-unread')
    this.log('own-server-added')
    return { status: 'ok', server }
  }

  chooseModels(request: unknown): Promise<AddResult> {
    const parsed = chooseModelsSchema.parse(request)
    return this.inTurn(async () => {
      const servers = await this.servers(), server = servers.find(item => item.id === parsed.id)
      if (!server) return refusal('not-found', OWN_SERVER_WORDS.notFound)
      const models = new Map(server.models.map(model => [model.id, model]))
      for (const model of parsed.models ?? []) {
        const before = models.get(model.id)
        // Choosing models changes a missing context only. Discovery, not this dialog, owns saved capabilities.
        models.set(model.id, before ? { ...before, context: model.context } : model)
      }
      if (parsed.keptModelIds.some(id => !models.has(id))) return refusal('failed', OWN_SERVER_WORDS.failed)
      const updated = ownServerSchema.parse({ ...server, models: [...models.values()], keptModelIds: [...new Set(parsed.keptModelIds)] })
      await this.save(servers.map(item => item.id === parsed.id ? updated : item))
      this.options.openCode()?.outdated()
      void this.options.openCode()?.catalogAgain().catch(() => false)
      return { status: 'ok', server: updated }
    })
  }

  replaceKey(request: unknown): Promise<AddResult> {
    const { id, key } = replaceKeySchema.parse(request)
    return this.inTurn(async () => {
      const server = (await this.servers()).find(item => item.id === id)
      if (!server || !server.keyed) return refusal('not-found', OWN_SERVER_WORDS.notFound)
      // Validation precedes any write to either keeper. A refused new key cannot overwrite the old one.
      const result = await this.run(server.address, key)
      if (result.status !== 'ok') return result
      const openCode = this.options.openCode(), hermes = this.options.hermes?.()
      if (server.keyKeeper === 'hermes') {
        if (!hermes) return refusal('opencode-not-running', OWN_SERVER_WORDS.openCodeNotRunning)
        await hermes.keepKey(id, key)
      } else {
        if (!openCode?.running()) return refusal('opencode-not-running', OWN_SERVER_WORDS.openCodeNotRunning)
        if (!await openCode.signInWithKey(id, key)) return refusal('sign-in-failed', OWN_SERVER_WORDS.signInFailed(server.name))
        try {
          if (hermes) await hermes.keepKey(id, key)
          else await this.options.replaceHeldHermesKey?.(id, key)
        } catch {
          this.log('own-server-sign-in-failed')
          return refusal('replaced-partly', ownServerRefusalWords('replaced-partly', '', server.name))
        }
      }
      return { status: 'ok', server }
    })
  }

  /**
   * Removes a server: each keeper forgets its key before the record goes, so no key is left for a source nothing lists.
   * OpenCode is needed only for a key it took. A failed cleanup keeps the server listed for another Remove.
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
      if (server.keyKeeper !== 'hermes') {
        if (!running) return refusal('opencode-not-running', OWN_SERVER_WORDS.removeNeedsOpenCode(server.name))
        if (!await openCode!.signOut(id).catch(() => false)) {
          this.log('own-server-sign-out-failed')
          return refusal('sign-in-failed', OWN_SERVER_WORDS.signOutFailed(server.name))
        }
      }
      // Hermes's copy goes only once OpenCode's has, so a refused sign-out leaves the server whole on both. One Hermes
      // cannot delete stays listed with the server, and a second Remove finishes both, as after a record that cannot be written.
      if (!await this.forgetHermes(server)) {
        this.log('own-server-sign-out-failed')
        return refusal('removed-partly', OWN_SERVER_WORDS.removePartly(server.name))
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

  private async forgetHermes(server: OwnServer): Promise<boolean> {
    const hermes = this.options.hermes?.()
    const forget = hermes ? (id: string) => hermes.forgetKey(id) : this.options.forgetHermesKey
    if (!forget) return server.keyKeeper !== 'hermes'
    return forget(server.id).then(() => true, () => false)
  }
}

/** A saved model as a check would have found it. */
function savedAsFound(model: FoundModel): FoundModel { return { ...model } }

export function runnable(model: FoundModel): OwnServerModel {
  if (model.context === undefined) throw new Error('A kept model needs its context.')
  return { ...model, context: model.context, thinking: model.thinking !== false, images: model.images === true,
    reasoningEfforts: model.reasoningEfforts ?? (model.thinking === false ? [] : ['default']) }
}

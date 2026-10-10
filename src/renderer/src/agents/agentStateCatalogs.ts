import { clientCatalogKey, hostCatalogKey } from '../../../shared/agents'
import type { AgentBridge, AgentClientHost, AgentCommandReceipt, AgentModel, AgentState, AgentWireBridge } from '../../../shared/agents'

interface CachedCatalog {
  revision: number
  models: AgentModel[]
}

/** What this window holds of each catalog, keyed by `hostCatalogKey` and `clientCatalogKey`, as main keys it. */
type CatalogCache = Map<string, CachedCatalog>

/** The catalogs the last whole state read through `get()` listed, by the same keys, with no revision. */
type LastRead = Map<string, AgentModel[]>

const wrapped = new WeakMap<AgentWireBridge, AgentBridge>()

/**
 * Puts a model catalog main left out back before any consumer reads the state: one the `AGENT_STATE`
 * broadcast omitted because this window was already sent it (issue #286, ADR-0028), and every one a command
 * receipt names by catalog revision (issue #323). Reassembly lives here, in the page, not in the preload:
 * `contextBridge` copies every argument a main-world listener is called with back across the isolated-world
 * boundary, so putting the catalog back together on the preload side would clone the whole thing again on
 * the way out — exactly the cost omitting it was for. Only the small `{ revision, omitted: true }` marker
 * needs to make that crossing; this wrapper turns it back into the array every consumer already expects.
 *
 * Broadcasts and receipts share one cache, because their revisions come from the same counter in main: a
 * catalog the broadcast sent in full is what a receipt resolves from, and a catalog recovered for a receipt
 * serves the next broadcast that names it. The cache lives as long as the page does — a reload runs the
 * page fresh, so it empties exactly when the window's own memory of what it was sent does. Every catalog a
 * whole state read through `get()` listed is kept apart from it, with no revision, as the last resort for a
 * receipt whose recovery fails (`createReceiptCompleter`).
 *
 * `bridge` is `window.sotto.agents`. Wrapping is
 * memoized by the underlying bridge's own identity, so calling this again on the same bridge — as a
 * component that re-renders would — returns the same wrapped bridge rather than a new one, which keeps
 * the object stable for callers that key their own effects on it.
 */
export function wrapAgentBridge(bridge: AgentWireBridge): AgentBridge {
  const existing = wrapped.get(bridge)
  if (existing) return existing
  const catalogs: CatalogCache = new Map()
  const lastRead: LastRead = new Map()
  const get = async (): Promise<AgentState> => {
    const full = await bridge.get()
    lastRead.set(hostCatalogKey(full.host.hostId), full.host.models)
    for (const client of full.host.clientHosts ?? []) {
      lastRead.set(clientCatalogKey(client.hostId), client.models)
      lastRead.set(hostCatalogKey(client.hostId), client.models)
    }
    return full
  }
  const completeReceipt = createReceiptCompleter({ get }, catalogs, lastRead)
  const result: AgentBridge = {
    ...bridge,
    get,
    onState: listener => bridge.onState(createReassembler({ get }, catalogs, listener)),
    command: async request => completeReceipt(await bridge.command(request)),
  }
  wrapped.set(bridge, result)
  return result
}

function isStateLike(raw: unknown): raw is AgentState {
  return typeof raw === 'object' && raw !== null && 'host' in raw
}

/**
 * One catalog as it crossed: a full catalog is cached under its revision, and a revision alone is read back
 * from the cache when the window holds that revision. Anything else is unresolved, a bare array included:
 * main never sends one on either channel, so the page recovers through `get()` rather than trusting it.
 *
 * `newer` lets a held revision newer than the one named stand in for it. A command receipt asks for that:
 * main's revisions only advance, so a receipt naming an older revision than the window holds was built
 * before a broadcast the window already has, and the newer catalog is the one to show. A broadcast does not:
 * main sends each window its broadcasts in order, so one naming a revision the window does not hold exactly
 * is one the window missed.
 */
function resolveCatalog(catalogs: CatalogCache, key: string, catalog: unknown, newer = false): AgentModel[] | undefined {
  if (catalog && typeof catalog === 'object') {
    const record = catalog as { revision?: unknown; models?: unknown; omitted?: unknown }
    if (typeof record.revision === 'number' && Array.isArray(record.models)) {
      const models = record.models as AgentModel[]
      catalogs.set(key, { revision: record.revision, models })
      return models
    }
    if (typeof record.revision === 'number' && record.omitted === true) {
      const cached = catalogs.get(key)
      return cached && (cached.revision === record.revision || (newer && cached.revision > record.revision)) ? cached.models : undefined
    }
  }
  return undefined
}

function revisionOf(catalog: unknown): number | undefined {
  return catalog && typeof catalog === 'object' && typeof (catalog as { revision?: unknown }).revision === 'number'
    ? (catalog as { revision: number }).revision : undefined
}

/** Each catalog `state` names, as `key@revision` under the keys main counts revisions by. */
function catalogRevisions(state: AgentState | AgentCommandReceipt): string[] {
  const named = (key: string, catalog: unknown): string => `${key}@${revisionOf(catalog) ?? '?'}`
  return [named(hostCatalogKey(state.host.hostId), state.host.models),
    ...(state.host.clientHosts ?? []).map(client => named(clientCatalogKey(client.hostId), client.models))]
}

/**
 * `state` with every catalog put back, or undefined when one names a revision this window does not hold.
 * `options.newer` is `resolveCatalog`'s; `options.fallback` answers for an unresolved catalog instead, once
 * a recovery has been tried.
 */
function assembleState(catalogs: CatalogCache, state: AgentState | AgentCommandReceipt, options: { newer?: boolean; fallback?: (key: string) => AgentModel[] | undefined } = {}): AgentState | undefined {
  const find = (key: string, catalog: unknown): AgentModel[] | undefined => resolveCatalog(catalogs, key, catalog, options.newer) ?? options.fallback?.(key)
  // Reused as the actual array on both fields when they name the same catalog, so this window holds one
  // copy of it, the way the wire itself does (DesktopHostRouter.shell()).
  // Every catalog is looked at before any is found missing, so one carried in full is cached either way.
  const primary = find(hostCatalogKey(state.host.hostId), state.host.models)
  const clientHosts = state.host.clientHosts?.map(client => ({ client, models: find(clientCatalogKey(client.hostId), client.models) }))
  if (primary === undefined || clientHosts?.some(entry => entry.models === undefined)) return undefined
  return { ...state, host: { ...state.host, models: primary, clientHosts: clientHosts?.map(({ client, models }): AgentClientHost => ({ ...client, models: models! })) } }
}

/**
 * Remembers what a recovery's `get()` answered under the revisions `named` sent the window looking for, so
 * an immediate repeat of them is read from the cache instead of asked for again. Main answers `get()` after
 * it sent `named`, so the answer is never older than those revisions.
 */
function rememberRecovered(catalogs: CatalogCache, named: AgentState | AgentCommandReceipt, full: AgentState): void {
  // Revisions only advance, so a newer one the window already holds is never filed over.
  const remember = (key: string, revision: number | undefined): void => {
    const models = catalogIn(full, key)
    if (models !== undefined && revision !== undefined && !((catalogs.get(key)?.revision ?? 0) > revision)) catalogs.set(key, { revision, models })
  }
  remember(hostCatalogKey(named.host.hostId), revisionOf(named.host.models))
  for (const client of named.host.clientHosts ?? []) remember(clientCatalogKey(client.hostId), revisionOf(client.models))
}

/**
 * The catalog `full` lists under `key`, keyed as main keys it. A selected host's catalog is found by its
 * host ID even when `full` was read after another host was selected: the shell lists every host's catalog
 * in `clientHosts`, and the selected one's entry is the same catalog as `host.models`.
 */
function catalogIn(full: AgentState, key: string): AgentModel[] | undefined {
  if (key === hostCatalogKey(full.host.hostId)) return full.host.models
  return full.host.clientHosts?.find(client => key === clientCatalogKey(client.hostId) || key === hostCatalogKey(client.hostId))?.models
}

/**
 * A command's reply as its caller reads it: the receipt main sent (issue #323) with every catalog put back.
 * Nearly always they come from the cache the broadcast filled. A receipt naming a revision older than one
 * the window holds takes the newer catalog, since the receipt was built before a broadcast the window
 * already has. A receipt naming a revision this window does not hold at all (nothing broadcast yet, or a
 * catalog that changed with this command and whose broadcast has not landed) recovers through
 * `bridge.get()`, and receipts naming the same hosts at the same revisions while that is in flight wait for
 * the same answer rather than asking again. Only an answer asked for after the receipt arrived is
 * remembered under its revisions, so older content is never filed under a newer revision.
 *
 * The receipt's own fields are what the caller gets, never the recovery's: the draft store reads the
 * draft revision it acknowledged and the settings card the settings it applied. A catalog the cache still
 * cannot name after a recovery is taken from the recovery's own answer; a host that answer no longer lists
 * has no models. A recovery that fails is asked once more, because main has already run the command and
 * failing the reply tells the user it may not have. When that fails too, the reply still resolves: the
 * catalog this window last held for that host stands in, or the one the last `get()` listed, until the next
 * broadcast. A window that holds neither has no models on screen for that host to keep, and main has
 * recorded no catalog as sent to it, so the next broadcast carries the catalog in full; until then that
 * host has no models, which is what the window already showed.
 */
function createReceiptCompleter(bridge: Pick<AgentBridge, 'get'>, catalogs: CatalogCache, lastRead: LastRead): (reply: AgentCommandReceipt) => Promise<AgentState> {
  const recoveries = new Map<string, Promise<AgentState>>()
  const recover = (reply: AgentCommandReceipt): Promise<AgentState> => {
    // Main counts revisions per catalog key, so the key names each catalog by the key main files it under.
    const named = catalogRevisions(reply).join(' ')
    let recovery = recoveries.get(named)
    if (recovery === undefined) {
      recovery = bridge.get().catch(() => bridge.get()).then(full => { rememberRecovered(catalogs, reply, full); return full })
      recoveries.set(named, recovery)
      const forget = (): void => { recoveries.delete(named) }
      recovery.then(forget, forget)
    }
    return recovery
  }
  return async reply => {
    const assembled = assembleState(catalogs, reply, { newer: true })
    if (assembled !== undefined) return assembled
    let recovered: AgentState | null = null
    try { recovered = await recover(reply) } catch { /* main ran the command; the fallback below answers */ }
    const fallback = (key: string): AgentModel[] => (recovered === null ? undefined : catalogIn(recovered, key))
      ?? catalogs.get(key)?.models ?? lastRead.get(key) ?? []
    // With a fallback that always answers, every catalog resolves.
    return assembleState(catalogs, reply, { newer: true, fallback })!
  }
}

/**
 * One subscription's delivery of broadcasts: a catalog delivered in full is cached under its revision, and
 * one only named by revision is read back from the cache. A broadcast this window cannot resolve on its own
 * — nothing cached yet, or a revision that does not match — asks `bridge.get()` for the whole state instead
 * of showing no models, and seeds the cache with what comes back so an immediate repeat of that same
 * omission needs no second fetch.
 *
 * A broadcast that arrives while a recovery is in flight is kept, the newest replacing any earlier one.
 * When the recovery succeeds, its answer is newer than anything kept, so the kept broadcast only lends
 * the cache any catalog it carried in full. When the recovery fails, the kept broadcast gets its own
 * attempt: from the cache, or a recovery of its own. Nothing but a broadcast ever starts a recovery, so
 * a `get()` that keeps failing is retried at most once per broadcast, never on a timer.
 */
function createReassembler(bridge: Pick<AgentBridge, 'get'>, catalogs: CatalogCache, listener: (state: AgentState) => void): (raw: unknown) => void {
  let recovering = false
  let pending: unknown = null

  /** Caches whatever catalogs a broadcast carried in full, without delivering it. */
  const seed = (raw: unknown): void => {
    if (!isStateLike(raw)) return
    resolveCatalog(catalogs, hostCatalogKey(raw.host.hostId), raw.host.models)
    for (const client of raw.host.clientHosts ?? []) resolveCatalog(catalogs, clientCatalogKey(client.hostId), client.models)
  }

  const process = (raw: unknown): void => {
    if (!isStateLike(raw)) return
    const assembled = assembleState(catalogs, raw)
    if (assembled !== undefined) { listener(assembled); return }
    // This window cannot name every catalog the broadcast referred to: a fresh window, a reload, or a
    // revision it never received. `get()` always answers in full, so recovering there restores what the
    // broadcast could not carry, tagged with the revision that sent us looking so an immediate repeat of
    // it is read from cache instead of asking again. Every catalog the broadcast carried in full is cached
    // by the attempt above.
    recovering = true
    bridge.get().then(full => {
      rememberRecovered(catalogs, raw, full)
      listener(full)
      // Main answers `get()` in order with its broadcasts, so one kept while this was in flight was sent
      // before the answer and is older than it. Delivering it now would put an older state on screen after
      // a newer one; only a catalog it carried in full is worth keeping.
      if (pending !== null) { seed(pending); pending = null }
    }).catch(() => undefined).finally(() => {
      recovering = false
      if (pending !== null) { const next = pending; pending = null; process(next) }
    })
  }

  return raw => { if (recovering) pending = raw; else process(raw) }
}

import type { AgentBridge, AgentClientHost, AgentModel, AgentState } from '../../../shared/agents'

const PRIMARY_CATALOG_KEY = '__primary__'

interface CachedCatalog {
  revision: number
  models: AgentModel[]
}

function hostCatalogKey(hostId: string | undefined): string {
  return `host:${hostId ?? PRIMARY_CATALOG_KEY}`
}

function clientCatalogKey(hostId: string): string {
  return `client:${hostId}`
}

const wrapped = new WeakMap<AgentBridge, AgentBridge>()

/**
 * Puts a model catalog the `AGENT_STATE` broadcast omitted back before any consumer reads the state
 * (issue #286, ADR-0028). Reassembly lives here, in the page, not in the preload: `contextBridge` copies
 * every argument a main-world listener is called with back across the isolated-world boundary, so putting
 * the catalog back together on the preload side would clone the whole thing again on the way out —
 * exactly the cost omitting it was for. Only the small `{ revision, omitted: true }` marker needs to make
 * that crossing when nothing changed; this wrapper turns it back into the array every consumer already
 * expects, using a cache that lives only as long as this call's subscription does — a reload runs the
 * page fresh, so the cache empties exactly when the window's own memory of what it was sent does.
 *
 * `bridge` is `window.sotto.agents` or `window.sottoWidget.agents`, whichever a window has. Wrapping is
 * memoized by the underlying bridge's own identity, so calling this again on the same bridge — as a
 * component that re-renders would — returns the same wrapped bridge rather than a new one, which keeps
 * the object stable for callers that key their own effects on it.
 */
export function wrapAgentBridge(bridge: AgentBridge): AgentBridge {
  const existing = wrapped.get(bridge)
  if (existing) return existing
  const result: AgentBridge = {
    ...bridge,
    onState: listener => bridge.onState(createReassembler(bridge, listener)),
  }
  wrapped.set(bridge, result)
  return result
}

/**
 * One subscription's memory of what it was sent: a catalog delivered in full is cached under its
 * revision, and one only named by revision is read back from that cache. A broadcast this window cannot
 * resolve on its own — nothing cached yet, or a revision that does not match — asks `bridge.get()` for
 * the whole state instead of showing no models, and seeds the cache with what comes back so an immediate
 * repeat of that same omission needs no second fetch.
 *
 * A broadcast that arrives while a recovery is in flight is kept, the newest replacing any earlier one.
 * When the recovery succeeds, its answer is newer than anything kept, so the kept broadcast only lends
 * the cache any catalog it carried in full. When the recovery fails, the kept broadcast gets its own
 * attempt: from the cache, or a recovery of its own. Nothing but a broadcast ever starts a recovery, so
 * a `get()` that keeps failing is retried at most once per broadcast, never on a timer.
 */
function createReassembler(bridge: Pick<AgentBridge, 'get'>, listener: (state: AgentState) => void): (raw: unknown) => void {
  const catalogs = new Map<string, CachedCatalog>()
  let recovering = false
  let pending: unknown = null

  const resolve = (key: string, catalog: unknown): AgentModel[] | undefined => {
    // A bare array is a whole `AgentState` read some other way than the coalesced broadcast — a test
    // fixture standing in for main, or a state whose catalogs were never encoded — and is always
    // already complete.
    if (Array.isArray(catalog)) return catalog as AgentModel[]
    if (catalog && typeof catalog === 'object') {
      const record = catalog as { revision?: unknown; models?: unknown; omitted?: unknown }
      if (typeof record.revision === 'number' && Array.isArray(record.models)) {
        const models = record.models as AgentModel[]
        catalogs.set(key, { revision: record.revision, models })
        return models
      }
      if (typeof record.revision === 'number' && record.omitted === true) {
        const cached = catalogs.get(key)
        return cached && cached.revision === record.revision ? cached.models : undefined
      }
    }
    return undefined
  }

  const revisionOf = (catalog: unknown): number | undefined =>
    catalog && typeof catalog === 'object' && typeof (catalog as { revision?: unknown }).revision === 'number'
      ? (catalog as { revision: number }).revision : undefined

  const resolveClientHost = (client: AgentClientHost): { client: AgentClientHost; models: AgentModel[] | undefined } =>
    ({ client, models: resolve(clientCatalogKey(client.hostId), client.models) })

  /** Caches whatever catalogs a broadcast carried in full, without delivering it. */
  const seed = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null || !('host' in raw)) return
    const state = raw as AgentState
    resolve(hostCatalogKey(state.host.hostId), state.host.models)
    state.host.clientHosts?.forEach(resolveClientHost)
  }

  const process = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null || !('host' in raw)) return
    const state = raw as AgentState
    const primaryKey = hostCatalogKey(state.host.hostId)
    // Reused as the actual array on both fields when they name the same catalog, so this window holds
    // one copy of it, the way the wire itself does (DesktopHostRouter.shell()).
    const primary = resolve(primaryKey, state.host.models)
    const clientHosts = state.host.clientHosts?.map(resolveClientHost)
    if (primary !== undefined && (clientHosts === undefined || clientHosts.every(entry => entry.models !== undefined))) {
      listener({
        ...state,
        host: { ...state.host, models: primary, clientHosts: clientHosts?.map(({ client, models }) => ({ ...client, models: models! })) },
      })
      return
    }
    // This window cannot name every catalog the broadcast referred to: a fresh window, a reload, or a
    // revision it never received. `get()` always answers in full, so recovering there restores what the
    // broadcast could not carry, tagged with the revision that sent us looking so an immediate repeat of
    // it is read from cache instead of asking again.
    const primaryRevision = revisionOf(state.host.models)
    const clientRevisions = state.host.clientHosts?.map(client => [client.hostId, revisionOf(client.models)] as const)
    recovering = true
    bridge.get().then(full => {
      if (primaryRevision !== undefined) catalogs.set(primaryKey, { revision: primaryRevision, models: full.host.models })
      for (const [hostId, revision] of clientRevisions ?? []) {
        if (revision === undefined) continue
        const client = full.host.clientHosts?.find(candidate => candidate.hostId === hostId)
        if (client) catalogs.set(clientCatalogKey(hostId), { revision, models: client.models })
      }
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

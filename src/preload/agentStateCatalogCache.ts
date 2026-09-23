import { AGENT_GET, agentStateSchema, type AgentClientHost, type AgentModel, type AgentState } from '../shared/agents'

/** What `invoke` needs to look like for a recovery fetch; the real preload adapter satisfies it. */
export interface AgentGetInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

const PRIMARY_CATALOG_KEY = '__primary__'

interface CachedCatalog {
  revision: number
  models: AgentModel[]
}

/**
 * Turns a broadcast on `sotto:agents:state` back into the `AgentState` every consumer already reads
 * (issue #286): a catalog the broadcast sent in full is cached under its revision, and one it only named
 * by revision is read back from that cache. A window that cannot resolve every catalog a broadcast names
 * -- nothing cached yet, or a revision that does not match what is cached -- has no way to tell an
 * omission from an empty catalog on its own, so it asks `AGENT_GET` for the whole state instead of
 * showing the thread with none. One instance belongs to one window: a reload runs this module fresh, so
 * the cache empties exactly when the window's own memory of what it was sent does. See ADR-0027.
 */
export function createAgentStateCatalogCache(renderer: AgentGetInvoker): (raw: unknown, deliver: (state: AgentState) => void) => void {
  const catalogs = new Map<string, CachedCatalog>()
  let recovering = false

  const resolve = (key: string, catalog: unknown): AgentModel[] | undefined => {
    // A bare array is a whole `AgentState` read some other way than the coalesced broadcast -- AGENT_GET's
    // own reply, a command's answer, or a fixture standing in for main -- and is always already complete.
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
    ({ client, models: resolve(client.hostId, client.models) })

  return (raw, deliver) => {
    if (typeof raw !== 'object' || raw === null || !('host' in raw) || recovering) return
    const state = raw as AgentState
    const primaryKey = typeof state.host.hostId === 'string' ? state.host.hostId : PRIMARY_CATALOG_KEY
    const primary = resolve(primaryKey, state.host.models)
    const clientHosts = state.host.clientHosts?.map(resolveClientHost)
    if (primary !== undefined && (clientHosts === undefined || clientHosts.every(entry => entry.models !== undefined))) {
      deliver({
        ...state,
        host: {
          ...state.host,
          models: primary,
          clientHosts: clientHosts?.map(({ client, models }) => ({ ...client, models: models! })),
        },
      })
      return
    }
    // This window cannot name every catalog the broadcast referred to: a fresh window, a reload, or a
    // revision it never received. AGENT_GET always answers in full, so recovering there restores what the
    // broadcast could not carry, tagged with the revision that sent us looking so the next repeat of it
    // is read from cache instead of asking again.
    const primaryRevision = revisionOf(state.host.models)
    const clientRevisions = state.host.clientHosts?.map(client => [client.hostId, revisionOf(client.models)] as const)
    recovering = true
    renderer.invoke(AGENT_GET).then(response => {
      const full = agentStateSchema.parse(response)
      if (primaryRevision !== undefined) catalogs.set(primaryKey, { revision: primaryRevision, models: full.host.models })
      for (const [hostId, revision] of clientRevisions ?? []) {
        if (revision === undefined) continue
        const client = full.host.clientHosts?.find(candidate => candidate.hostId === hostId)
        if (client) catalogs.set(hostId, { revision, models: client.models })
      }
      deliver(full)
    }).catch(() => undefined).finally(() => { recovering = false })
  }
}

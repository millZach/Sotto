import { isDeepStrictEqual } from 'node:util'
import type { AgentClientHost, AgentClientHostBroadcast, AgentModel, AgentModelCatalogBroadcast, AgentState, AgentStateBroadcast } from '../../shared/agents'

export type AgentStateBroadcastDestination = 'main' | 'widget'

const PRIMARY_CATALOG_KEY = '__primary__'

interface CatalogSnapshot {
  revision: number
  models: readonly AgentModel[]
}

/**
 * Turns a shell into what actually crosses `sotto:agents:state` for one destination window, omitting a
 * model catalog that window was already sent and nothing has changed since (issue #286): `models` is
 * rebuilt into new arrays and objects on every publish even when its content is unchanged (`clientAgentState`
 * deep-clones for its ID projection), so identity cannot tell a repeat from a change -- content, compared
 * with `isDeepStrictEqual`, can. A catalog's revision is a counter bumped only when its content actually
 * changes, shared by every destination; what each destination has already been sent is tracked apart, and
 * only once delivery of it is confirmed, so a window that never actually received a revision is not skipped
 * on the next attempt.
 */
export class AgentStateBroadcaster {
  private readonly catalogs = new Map<string, CatalogSnapshot>()
  private readonly sent: Record<AgentStateBroadcastDestination, Map<string, number>> = { main: new Map(), widget: new Map() }

  /** Encodes `state` for `destination` and hands it to `deliver`; only a delivery `deliver` reports as
   * successful (its return value) is remembered, so a window that was not actually listening is sent the
   * catalog in full again next time rather than being assumed caught up. */
  send(state: AgentState, destination: AgentStateBroadcastDestination, deliver: (payload: AgentStateBroadcast) => boolean): boolean {
    const sentRevisions = this.sent[destination]
    const confirmed: Array<[string, number]> = []
    const encode = (key: string, models: readonly AgentModel[]): AgentModelCatalogBroadcast => {
      const revision = this.revisionFor(key, models)
      if (sentRevisions.get(key) === revision) return { revision, omitted: true }
      confirmed.push([key, revision])
      return { revision, models: models as AgentModel[] }
    }
    const encodeClientHost = (client: AgentClientHost): AgentClientHostBroadcast => ({ ...client, models: encode(client.hostId, client.models) })
    const payload: AgentStateBroadcast = {
      ...state,
      host: {
        ...state.host,
        models: encode(hostCatalogKey(state), state.host.models),
        clientHosts: state.host.clientHosts?.map(encodeClientHost),
      },
    }
    const delivered = deliver(payload)
    if (delivered) for (const [key, revision] of confirmed) sentRevisions.set(key, revision)
    return delivered
  }

  private revisionFor(key: string, models: readonly AgentModel[]): number {
    const existing = this.catalogs.get(key)
    if (existing && isDeepStrictEqual(existing.models, models)) return existing.revision
    const revision = (existing?.revision ?? 0) + 1
    this.catalogs.set(key, { revision, models })
    return revision
  }
}

function hostCatalogKey(state: AgentState): string {
  return state.host.hostId ?? PRIMARY_CATALOG_KEY
}

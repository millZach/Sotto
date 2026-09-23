import { clientAgentState, hostEntityKey, mapHostReferences, parseHostEntityKey } from '../shared/clientIdentity'
import type { AgentState } from '../shared/agents'

/** One local host transport. Remote transports use the same projection, with their own host binding. */
export function hostClientBridge<T extends object>(bridge: T): T {
  let hostId: string | undefined
  let routed = false
  const decode = (id: string): string => {
    if (hostId === undefined) { if (routed && parseHostEntityKey(id)) throw new Error('This action runs on the host machine. Open it there.'); return id }
    const key = parseHostEntityKey(id)
    if (key === null) return id // New local drafts and pre-upgrade references have no host yet.
    if (key.hostId !== hostId) throw new Error('This action belongs to another host. Select that host before trying again.')
    return key.id
  }
  const receive = (value: unknown): unknown => {
    if (value && typeof value === 'object' && 'host' in value && 'configuration' in value) {
      const state = value as AgentState
      if (state.clientScoped) { routed = true; hostId = state.connections?.find(item => item.kind === 'local')?.hostId; return state }
      const nextHost = state.hostId ?? state.host.hostId
      if (hostId !== undefined && nextHost !== undefined && hostId !== nextHost) throw new Error('The host identity changed. Reconnect before continuing.')
      hostId = nextHost ?? hostId
      return clientAgentState(state)
    }
    return hostId === undefined ? value : mapHostReferences(value, id => parseHostEntityKey(id) ? id : hostEntityKey(hostId, id))
  }
  const domains = new Set(['agents', 'terminal', 'terminals', 'browser', 'gitChanges', 'files', 'subagents', 'requestDrafts', 'memory'])
  const wrap = (object: object, domain?: string): object => Object.freeze(Object.fromEntries(Object.entries(object).map(([name, member]) => {
    if (!domain) return [name, domains.has(name) && member && typeof member === 'object' ? wrap(member as object, name) : member]
    if (typeof member !== 'function') return [name, member]
    return [name, (...args: unknown[]): unknown => {
      const outgoing = args.map(arg => {
        if (typeof arg === 'function') return (value: unknown) => (arg as (value: unknown) => void)(routed && domain === 'agents' && name !== 'onState' ? value : receive(value))
        if (routed && domain === 'agents') return arg
        if (typeof arg === 'string' && domain === 'agents' && (name === 'threadDetail' || name === 'workingCopyOptions')) return decode(arg)
        const request = mapHostReferences(arg, id => routed && domain === 'requestDrafts' && parseHostEntityKey(id)?.hostId !== hostId ? id : decode(id))
        // Attention IDs, unlike follow-up IDs, are keyed globally by the client.
        if (request && typeof request === 'object' && 'type' in request && request.type === 'select-attention' && 'itemId' in request && typeof request.itemId === 'string') return { ...request, itemId: decode(request.itemId) }
        return request
      })
      const result: unknown = Reflect.apply(member, object, outgoing)
      return result instanceof Promise ? result.then(value => routed && domain === 'agents' && name !== 'get' && name !== 'command' ? value : receive(value)) : result
    }]
  })))
  return Object.freeze(wrap(bridge)) as T
}

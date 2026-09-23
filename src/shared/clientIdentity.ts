import type { AgentState } from './agents'

/** Client-only keys. The host continues to address its entities by their original Sotto IDs. */
export function hostEntityKey(hostId: string | undefined, id: string): string {
  return hostId === undefined ? id : `host:${hostId}:${id}`
}

export function parseHostEntityKey(key: string): { hostId: string; id: string } | null {
  const match = /^host:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}):([\s\S]+)$/iu.exec(key)
  return match ? { hostId: match[1]!, id: match[2]! } : null
}

const references = new Set(['threadId', 'projectId', 'activeThreadId', 'activeProjectId', 'draftThreadId'])
const referenceLists = new Set(['threadIds', 'busyThreadIds'])
// These are provider observations or user content, never client routing references.
const opaque = new Set(['messages', 'activities', 'messageDeltas', 'activityDeltas', 'attachments', 'draftAttachments', 'questionAnswers', 'payload'])

/** Only named Sotto references cross the identity boundary; arbitrary strings are never rewritten. */
export function mapHostReferences<T>(value: T, map: (id: string) => string): T {
  function visit(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(visit)
    if (input === null || typeof input !== 'object' || Object.prototype.toString.call(input) !== '[object Object]') return input
    return Object.fromEntries(Object.entries(input).map(([name, child]) => [name,
      (references.has(name) || name === 'itemId' && 'type' in input && input.type === 'select-attention' || name === 'ownerId' && 'kind' in input && input.kind === 'thread') && typeof child === 'string' ? map(child)
        : referenceLists.has(name) && Array.isArray(child) ? child.map(id => typeof id === 'string' ? map(id) : id)
          : opaque.has(name) ? child : visit(child)]))
  }
  return visit(value) as T
}

/** Project one host's state before combining it with other hosts or putting it in client stores. */
export function clientAgentState(state: AgentState): AgentState {
  const hostId = state.hostId ?? state.host.hostId
  if (hostId === undefined) return state
  const key = (id: string): string => hostEntityKey(hostId, id)
  const mapped = mapHostReferences(state, key)
  return { ...mapped, hostId,
    host: { ...mapped.host,
      projects: mapped.host.projects.map(project => ({ ...project, id: hostEntityKey(project.hostId ?? hostId, project.id) })),
      threads: state.host.threads.map(thread => ({ ...thread, id: hostEntityKey(thread.hostId ?? hostId, thread.id), projectId: hostEntityKey(thread.hostId ?? hostId, thread.projectId) })) },
    queue: mapped.queue.map(item => ({ ...item, id: key(item.id) })) }
}

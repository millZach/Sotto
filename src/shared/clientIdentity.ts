import type { AgentState } from './agents'

/** Client-only keys. The host continues to address its entities by their original Sotto IDs. */
export function hostEntityKey(hostId: string | undefined, id: string): string {
  return hostId === undefined ? id : `host:${hostId}:${id}`
}

export function parseHostEntityKey(key: string): { hostId: string; id: string } | null {
  const match = /^host:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}):([\s\S]+)$/iu.exec(key)
  return match ? { hostId: match[1]!, id: match[2]! } : null
}

/**
 * Whether a tool request names its thread by a client key. The window's bridge hands this computer's own threads to
 * main by their own IDs, so a key that reaches main names a thread on a paired host, which only that host can read.
 */
export function namesHostThread(request: unknown): boolean {
  return request !== null && typeof request === 'object' && 'threadId' in request && typeof request.threadId === 'string' && parseHostEntityKey(request.threadId) !== null
}

/** Local project defaults use the host's own ID; remote defaults keep their client routing key. */
export function projectWorkingCopyDefaultKey(state: AgentState | null | undefined, projectId: string): string {
  const localHostId = state?.connections ? state.connections.find(host => host.kind === 'local')?.hostId : state?.hostId
  const key = parseHostEntityKey(projectId)
  return key && key.hostId === localHostId ? key.id : projectId
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
      (references.has(name) || name === 'ownerId' && 'kind' in input && input.kind === 'thread') && typeof child === 'string' ? map(child)
        : referenceLists.has(name) && Array.isArray(child) ? child.map(id => typeof id === 'string' ? map(id) : id)
          : opaque.has(name) ? child : visit(child)]))
  }
  return visit(value) as T
}

/**
 * Project one host's state before combining it with other hosts or putting it in client stores. Threads are keyed from
 * the host's own list and models name no Sotto entity, so neither is walked: the router projects every host's state at
 * its broadcast rate, and the catalog keeps its identity for the revision check at the IPC boundary (#917).
 */
export function clientAgentState(state: AgentState): AgentState {
  const hostId = state.hostId ?? state.host.hostId
  if (hostId === undefined) return state
  const key = (id: string): string => hostEntityKey(hostId, id)
  const { threads, models, ...host } = state.host
  const mapped = mapHostReferences({ ...state, host }, key)
  return { ...mapped, hostId,
    host: { ...mapped.host, models,
      projects: mapped.host.projects.map(project => ({ ...project, id: hostEntityKey(project.hostId ?? hostId, project.id) })),
      // The thread that delegated to this one (ADR-0081), and the threads a continuation links (ADR-0089), are named as the
      // window names threads, so their links find them.
      threads: threads.map(thread => {
        const own = thread.hostId ?? hostId
        return { ...thread, id: hostEntityKey(own, thread.id), projectId: hostEntityKey(own, thread.projectId),
          ...(thread.delegatedBy ? { delegatedBy: hostEntityKey(own, thread.delegatedBy) } : {}),
          ...(thread.continuedFrom ? { continuedFrom: keyedLinks(thread.continuedFrom, own) } : {}),
          ...(thread.continuedIn ? { continuedIn: keyedLinks(thread.continuedIn, own) } : {}) }
      }) } }
}

/**
 * A continuation's links (ADR-0089) as the window names threads. Each record's links are keyed once and the copy reused
 * while the record holds the same links, so a broadcast copies none of them and the window's memoised notes stay put.
 */
const keyedLinkCopies = new WeakMap<object, { readonly hostId: string; readonly keyed: unknown }>()
function keyedLinks<T extends { readonly threadId: string } | readonly { readonly threadId: string }[]>(links: T, hostId: string): T {
  const held = keyedLinkCopies.get(links)
  if (held?.hostId === hostId) return held.keyed as T
  const key = <L extends { readonly threadId: string }>(link: L): L => ({ ...link, threadId: hostEntityKey(hostId, link.threadId) })
  const keyed = (Array.isArray(links) ? links.map(key) : key(links as { readonly threadId: string })) as T
  keyedLinkCopies.set(links, { hostId, keyed })
  return keyed
}

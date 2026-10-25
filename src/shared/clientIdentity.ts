import { noteThreadsReplaced, threadsReplacedSince } from './threadListPatches'
import type { AgentState, AgentThread } from './agents'

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
  return mapValue(value, map) as T
}
function mapValue(input: unknown, map: (id: string) => string): unknown {
  if (Array.isArray(input)) return input.map(item => mapValue(item, map))
  if (input === null || typeof input !== 'object' || Object.prototype.toString.call(input) !== '[object Object]') return input
  return Object.fromEntries(Object.entries(input).map(([name, child]) => [name, mapEntry(input, name, child, map)]))
}
/** One field of `parent` as `mapHostReferences` writes it: a reference keyed, a list of references keyed, anything else walked. */
function mapEntry(parent: object, name: string, child: unknown, map: (id: string) => string): unknown {
  return (references.has(name) || name === 'ownerId' && 'kind' in parent && parent.kind === 'thread') && typeof child === 'string' ? map(child)
    : referenceLists.has(name) && Array.isArray(child) ? child.map(id => typeof id === 'string' ? map(id) : id)
      : opaque.has(name) ? child : mapValue(child, map)
}

/**
 * The ID a client gives a thread of a host whose state names `hostId`: keyed by the host the thread names, else that host,
 * and left as it is when the state names no host. `clientAgentState` gives every thread this ID, and the router finds one
 * thread by it without projecting the state.
 */
export function clientThreadId(hostId: string | undefined, id: string, threadHostId?: string): string {
  return hostId === undefined ? id : hostEntityKey(threadHostId ?? hostId, id)
}

/**
 * Project one host's state before combining it with other hosts or putting it in client stores. Threads are keyed from
 * the host's own list and models name no Sotto entity, so neither is walked: the router projects every host's state at
 * its broadcast rate, and the catalog keeps its identity for the revision check at the IPC boundary (#917).
 */
export function clientAgentState(state: AgentState): AgentState {
  return projectClientAgentState(state).output
}

/**
 * One host's state projected for clients (`clientAgentState`), with what it was projected from, so the next projection
 * of that host can reuse each part whose input holds the same values.
 */
export interface ClientAgentStateProjection {
  readonly hostId: string | undefined
  readonly input: AgentState
  readonly output: AgentState
  /** The state's own fields and its host's across the identity boundary, before the host's projects and threads are keyed. */
  readonly fields: Readonly<Record<string, unknown>>
  readonly hostFields: Readonly<Record<string, unknown>>
  /** The records the output's threads were made from, in order: a list of its own, so reading it visits no host's list. */
  readonly threads: readonly AgentThread[]
}

type Fields = Readonly<Record<string, unknown>>

/**
 * `clientAgentState(state)`, reusing what `previous`, a projection of the same host, made wherever the input holds the
 * same values: each field of the state and of its host that is the same object or the same plain data, the projects
 * when those are, and each thread whose record holds the same values field for field. The router projects every host
 * on every broadcast, and a host that had not changed was rewritten whole each time (#1335). The values are the ones
 * `clientAgentState` gives; only unchanged parts keep their identity, and nothing in a projection is written into.
 */
export function projectClientAgentState(state: AgentState, previous?: ClientAgentStateProjection): ClientAgentStateProjection {
  const hostId = state.hostId ?? state.host.hostId
  if (hostId === undefined) return { hostId, input: state, output: state, fields: {}, hostFields: {}, threads: [] }
  const last = previous?.hostId === hostId ? previous : undefined
  if (last?.input === state) return last
  const key = (id: string): string => hostEntityKey(hostId, id)
  const field = (before: Fields | undefined, made: Fields | undefined, parent: Fields, name: string): unknown =>
    before && made && Object.hasOwn(before, name) && samePlainData(before[name], parent[name]) ? made[name] : mapEntry(parent, name, parent[name], key)
  const host = state.host as unknown as Fields
  const hostFields: Record<string, unknown> = {}
  for (const name of Object.keys(host)) if (name !== 'threads' && name !== 'models') hostFields[name] = field(last?.input.host as unknown as Fields | undefined, last?.hostFields, host, name)
  const fields: Record<string, unknown> = {}
  for (const name of Object.keys(state)) fields[name] = name === 'host' ? hostFields : field(last?.input as unknown as Fields | undefined, last?.fields, state as unknown as Fields, name)
  const mapped = fields as unknown as AgentState, mappedHost = hostFields as unknown as AgentState['host']
  const projects = last && mappedHost.projects === last.hostFields.projects ? last.output.host.projects
    : mappedHost.projects.map(project => ({ ...project, id: hostEntityKey(project.hostId ?? hostId, project.id) }))
  // A host whose list is the one it had keeps every record of it: nothing in a published list is written into.
  const kept = last && state.host.threads === last.input.host.threads
  // One whose list was made from the last one's in place is projected again only where it was (#925).
  const replaced = !kept && last ? threadsReplacedSince(state.host, last.input.host) : undefined
  let threads: AgentThread[], projected: AgentThread[], moved: number[] | undefined
  if (kept) { threads = last.threads as AgentThread[]; projected = last.output.host.threads }
  else if (replaced && last) ({ threads, projected, moved } = projectReplaced(state.host.threads, replaced, hostId, last))
  else { threads = [...state.host.threads]; projected = projectThreads(threads, hostId, last) }
  const output = { ...mapped, hostId, host: { ...mappedHost, models: state.host.models, projects, threads: projected } }
  if (kept && last) noteThreadsReplaced(output.host, last.output.host, [])
  else if (moved && last) noteThreadsReplaced(output.host, last.output.host, moved)
  return { hostId, input: state, fields, hostFields, threads, output }
}

/**
 * The host's threads as clients name them, from a list that is the last projection's input with the records at `replaced`
 * replaced in place: only those are read and projected again, each as `projectThreads` would, and every other is the last
 * projection's record. `moved` names the positions whose projected record changed.
 */
function projectReplaced(input: readonly AgentThread[], replaced: ReadonlySet<number>, hostId: string, last: ClientAgentStateProjection): { threads: AgentThread[]; projected: AgentThread[]; moved: number[] } {
  const made = last.output.host.threads, before = last.threads
  const threads = before.slice(), moved: number[] = []
  let projected: AgentThread[] | undefined
  for (const position of replaced) {
    const thread = input[position]!
    threads[position] = thread
    const prior = before[position]!
    if (prior.id === thread.id && sameThreadRecord(prior, thread)) continue
    ;(projected ??= made.slice())[position] = clientThread(thread, hostId)
    moved.push(position)
  }
  return { threads, projected: projected ?? made, moved }
}

/** The host's threads as clients name them, each reused from `last` while its record holds the same values. */
function projectThreads(threads: readonly AgentThread[], hostId: string, last: ClientAgentStateProjection | undefined): AgentThread[] {
  const made = last?.output.host.threads
  const before = last?.threads
  let positions: Map<string, number> | undefined
  let unchanged = before !== undefined && made !== undefined && threads.length === made.length
  const projected = threads.map((thread, position) => {
    if (before && made) {
      let at = position
      if (before[at]?.id !== thread.id) at = (positions ??= new Map(before.map((item, index) => [item.id, index]))).get(thread.id) ?? -1
      const prior = at < 0 ? undefined : before[at]
      if (prior && sameThreadRecord(prior, thread)) {
        if (at !== position) unchanged = false
        return made[at]!
      }
    }
    unchanged = false
    return clientThread(thread, hostId)
  })
  return unchanged ? made! : projected
}

/** One thread as clients name it, from a host whose state names `hostId`. */
function clientThread(thread: AgentThread, hostId: string): AgentThread {
  const own = thread.hostId ?? hostId
  return { ...thread, id: clientThreadId(hostId, thread.id, thread.hostId), projectId: hostEntityKey(own, thread.projectId),
    // The thread that delegated to this one (ADR-0081), and the threads a continuation links (ADR-0089), are named as the
    // window names threads, so their links find them.
    ...(thread.delegatedBy ? { delegatedBy: hostEntityKey(own, thread.delegatedBy) } : {}),
    ...(thread.continuedFrom ? { continuedFrom: keyedLinks(thread.continuedFrom, own) } : {}),
    ...(thread.continuedIn ? { continuedIn: keyedLinks(thread.continuedIn, own) } : {}),
    // So is the thread one began from (#1028), so its note opens it.
    ...(thread.startedFrom ? { startedFrom: keyedLinks(thread.startedFrom, own) } : {}) }
}

/**
 * Whether two thread records hold the same fields with the same values: each the same value, or two empty lists. A
 * host builds a new record around the same fields for every thread on each broadcast, and what a published field holds
 * is never written into, so the same object holds the same values.
 */
function sameThreadRecord(left: AgentThread, right: AgentThread): boolean {
  if (left === right) return true
  const a = left as unknown as Fields, b = right as unknown as Fields
  // Counted rather than listed, so the comparison makes nothing: each of one record's fields is on the other with the
  // same value, and the other has no more fields than it.
  let fields = 0
  for (const name in a) {
    fields++
    const value = a[name], other = b[name]
    if (value !== other && !(Array.isArray(value) && Array.isArray(other) && value.length === 0 && other.length === 0)) return false
    if (other === undefined && !Object.hasOwn(b, name)) return false
  }
  for (const name in b) { void name; if (--fields < 0) return false }
  return fields === 0
}

/**
 * Whether two values are the same plain data: equal primitives, the same object, or lists and plain objects whose
 * entries are, under the same names in the same order. Anything else, such as a date or a map, must be the same object.
 */
function samePlainData(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) if ((index in left) !== (index in right) || !samePlainData(left[index], right[index])) return false
    return true
  }
  if (Array.isArray(right) || Object.prototype.toString.call(left) !== '[object Object]' || Object.prototype.toString.call(right) !== '[object Object]') return false
  const names = Object.keys(left), others = Object.keys(right)
  if (names.length !== others.length) return false
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!
    if (name !== others[index] || !samePlainData((left as Fields)[name], (right as Fields)[name])) return false
  }
  return true
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

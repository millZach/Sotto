import { randomUUID } from 'node:crypto'
import type { AgentState } from '../../src/shared/agents'

const AT = '2026-11-10T12:00:00.000Z'

/**
 * The parts of a shell around its threads as a host that has run for a few hours holds them, in the sizes forge's host
 * sent on November 10, 2026 (`docs/perf/2026-11-10-performance-and-data-audit.md`, finding 2): a skill list for each of
 * twenty threads, 115 KB together; the delivery ledger and the two draft ledgers at their limit of 128; and a draft and
 * its save evidence for a few threads. Every word is made up, and the threads named are not the host's.
 */
export function hostSizedShellParts(): Partial<AgentState> {
  // Threads of its own, by Sotto thread IDs as a host names them, so the sizes do not move with the fixture's threads.
  const threadIds = Array.from({ length: 20 }, () => randomUUID())
  const thread = (index: number): string => threadIds[index % threadIds.length]!
  const skill = (index: number) => ({ id: `skill-${index}`, name: `synthetic-skill-${index}`, source: 'user' as const, enabled: true,
    description: `A made-up skill that says in a sentence or two what it is for, as a real one does. Number ${index}.` })
  const receipts = (count: number) => Array.from({ length: count }, (_, index) => ({ threadId: thread(index), draftId: randomUUID() }))
  return {
    skillCatalogs: Array.from({ length: 20 }, (_, index) => ({ threadId: thread(index), providerId: 'codex', cwd: `/home/synthetic/project-${index}`, status: 'ready',
      skills: Array.from({ length: 30 }, (_, at) => skill(at)), errors: [] })) as unknown as AgentState['skillCatalogs'],
    deliveries: Array.from({ length: 128 }, (_, index) => ({ threadId: thread(index), draftId: randomUUID(), status: 'accepted', createdAt: AT, updatedAt: AT,
      commandId: randomUUID(), messageId: randomUUID(), packetDigest: 'a'.repeat(64), localFeedbackMs: 12, providerLatencyMs: 340 })) as unknown as AgentState['deliveries'],
    deliveredDrafts: receipts(128), obsoleteDrafts: receipts(128),
    threadDrafts: Array.from({ length: 4 }, (_, index) => ({ threadId: thread(index), draftId: randomUUID(), text: 'A made-up draft of a sentence.', attachments: [],
      requestId: null, updatedAt: AT })) as unknown as AgentState['threadDrafts'],
    threadDraftPersistence: Array.from({ length: 4 }, (_, index) => ({ threadId: thread(index), draftId: randomUUID(), state: 'saved', updatedAt: AT })) as unknown as AgentState['threadDraftPersistence'],
    clientUpdates: [{ provider: 'codex', installed: '0.1.0', published: '0.1.1', channel: 'npm', state: 'available' }] as unknown as AgentState['clientUpdates'],
  }
}

/**
 * `service` with `parts` laid over every state it reads or publishes, so a socket server over it sends shells that hold
 * them. Everything else is the service's own.
 */
export function withShellParts<Service extends { shell(): AgentState; subscribe(listener: (state: AgentState) => void): () => void }>(service: Service, parts: Partial<AgentState>): Service {
  return new Proxy(service, { get(target, name) {
    if (name === 'shell') return () => ({ ...target.shell(), ...parts })
    if (name === 'subscribe') return (listener: (state: AgentState) => void) => target.subscribe(state => { listener({ ...state, ...parts }) })
    const value = Reflect.get(target, name, target) as unknown
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
}

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { agentStateSchema, type AgentState } from '../../src/shared/agents'

const AT = '2026-11-10T12:00:00.000Z'

/** The parts of the state this fixture makes, read with the state's own schemas so each stays a part a host could hold. */
const partsSchema = z.object({
  skillCatalogs: agentStateSchema.shape.skillCatalogs, deliveries: agentStateSchema.shape.deliveries, deliveredDrafts: agentStateSchema.shape.deliveredDrafts,
  obsoleteDrafts: agentStateSchema.shape.obsoleteDrafts, threadDrafts: agentStateSchema.shape.threadDrafts,
  threadDraftPersistence: agentStateSchema.shape.threadDraftPersistence, clientUpdates: agentStateSchema.shape.clientUpdates,
}).strict()

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
  const receipts = (count: number) => Array.from({ length: count }, (_, index) => ({ threadId: thread(index), draftId: randomUUID() }))
  const drafts = Array.from({ length: 4 }, (_, index) => ({ threadId: thread(index), draftId: randomUUID() }))
  return partsSchema.parse({
    skillCatalogs: Array.from({ length: 20 }, (_, index) => ({ threadId: thread(index), providerId: 'codex', cwd: `/home/synthetic/project-${index}`, status: 'ready',
      skills: Array.from({ length: 25 }, (_, at) => ({ name: `synthetic-skill-${at}`, path: `/home/synthetic/.skills/synthetic-skill-${at}/SKILL.md`, scope: 'user', enabled: true,
        description: `A made-up skill that says in a sentence what it is for, as a real one does. Number ${at}.` })), errors: [] })),
    deliveries: Array.from({ length: 128 }, (_, index) => ({ threadId: thread(index), draftId: randomUUID(), status: 'accepted', createdAt: AT, updatedAt: AT,
      commandId: randomUUID(), messageId: randomUUID(), packetDigest: 'a'.repeat(64), localFeedbackMs: 12, providerLatencyMs: 340 })),
    deliveredDrafts: receipts(128), obsoleteDrafts: receipts(128),
    threadDrafts: drafts.map(draft => ({ ...draft, text: 'A made-up draft of a sentence.', attachments: [], requestId: null, updatedAt: AT })),
    threadDraftPersistence: drafts.map(draft => ({ ...draft, status: 'saved' })),
    clientUpdates: [{ id: 'codex', installed: '0.1.0', published: '0.1.1', behind: true, channel: 'npm', canInstall: true, checkedAt: AT, state: 'idle' }],
  })
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

/**
 * Every part of a shell a phone is sent: the state's own parts but `PHONE_UNREAD_SHELL_PARTS`, and what the host's
 * projections add on the wire (protocol version 1's retired fields, the client's capabilities, Watcher's page, the count
 * of settled threads held back, and the revision a hello's thread records are held under). A part is on this list or on
 * that one; `tests/unit/shared/phoneShellParts.test.ts` holds the state's schema to that, and
 * `tests/integration/socketPhoneStreaming.test.ts` holds what a listener really sends to it.
 */
export const PHONE_SENT_STATE_PARTS = ['legacyManagement', 'worktreeReclaimPreview', 'threadDeletePreview', 'threadClearPreview', 'threadClearResult', 'checkoutHold',
  'clientScoped', 'connections', 'hostId', 'configuration', 'providerUpgrade', 'clientUpdateRun', 'clientUpdatesDismissedAt', 'installedProviders', 'connection',
  'host', 'activeThreadId', 'activeProjectId', 'draft', 'draftThreadId', 'composing', 'draftAttachments', 'deliveredDrafts', 'deliveries', 'followups',
  'followupReceipts', 'draftRequestId', 'globalLaneBusy', 'notice', 'error', 'busyThreadIds', 'unconfirmedSettings', 'nextTurnSettings', 'credentials',
  'reasoningAccounts', 'historyEnabled', 'stale'] as const
export const PHONE_SENT_WIRE_PARTS = ['membership', 'assignments', 'queue', 'pendingRequest', 'speech', 'voice', 'clientCapabilities', 'terminals', 'watcher',
  'settledHeldBack', 'threadRecordsRevision'] as const

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { watcherRecordSchema } from '../../shared/watcher'
import { migrateWatcherRecord } from '../agents/watcherRecords'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentState } from '../../shared/agents'
import { HELD_PROVIDER_ENTRIES, type HeldProviders } from '../../shared/heldProviders'
import type { createAgentRuntime } from '../agents/runtime'
import { loadHostIdentity } from '../agents/hostIdentity'
import { ShortTextWriter } from '../llm/shortTextWriter'
import type { WorktreeCleanup } from '../agents/worktreeCleanup'

export function emptyDesktopState(hostId?: string): AgentState {
  return {
    ...(hostId ? { hostId } : {}), configuration: defaultAgentConfiguration(), connection: 'disconnected',
    host: { ...structuredClone(EMPTY_AGENT_HOST), ...(hostId ? { hostId } : {}) },
    activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, globalLaneBusy: false, notice: '', error: null,
    credentials: { reasoning: false, secure: false }, reasoningAccounts: [],
  }
}

/** Main's local-only tool adapters remain registered but cannot reach a disabled provider stack.
 * No coordinator, provider, history database, timer or workspace migration is constructed here.
 * Unsupported operations fail closed; this adapter never fabricates a successful host command.
 */
/** `parked` names the providers whose saved threads stay dormant: every provider an Owl feature holds, on either track. */
export async function inactiveLocalHost(directory: string,
  parked: HeldProviders = new Set(HELD_PROVIDER_ENTRIES.map(entry => entry.provider))): Promise<Awaited<ReturnType<typeof createAgentRuntime>>> {
  const state = emptyDesktopState(await loadHostIdentity(directory))
  // Ownership remains readable while providers are off. No saved data is migrated or written here.
  const retained = new Set<string>()
  const dormant = new Set<string>()
  let retentionError: unknown
  const read = async (name: string): Promise<unknown> => {
    try { return JSON.parse(await readFile(join(directory, name), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  try {
    const [agents, workspace] = await Promise.all([read('agents.json'), read('workspace.json')])
    const watcher = z.object({ watcher: z.preprocess(migrateWatcherRecord, watcherRecordSchema).optional() }).parse(agents).watcher
    if (watcher) for (const identity of [watcher.current, watcher.creation?.identity, ...watcher.history]) {
      if (identity) retained.add(identity.target.threadId)
    }
    const threads = z.object({ snapshot: z.object({ threads: z.array(z.object({ id: z.string(), kind: z.string().optional(), providerId: z.string().optional() })).optional() }).optional() }).parse(workspace).snapshot?.threads ?? []
    for (const thread of threads) if (thread.kind === 'watcher' || thread.kind === 'watcher-history') retained.add(thread.id)
    for (const id of retained) dormant.add(id)
    for (const thread of threads) if (thread.providerId !== undefined && (parked as ReadonlySet<string>).has(thread.providerId)) dormant.add(thread.id)
  } catch (error) { retentionError = error }
  const watcherThreadIds = (): readonly string[] => {
    // Unreadable ownership blocks answer cleanup rather than treating a saved Watcher answer as ordinary.
    if (retentionError) throw new Error('Saved thread ownership could not be read. Your saved answers have not changed.')
    return [...retained]
  }
  const unavailable = (): never => { throw new Error('The local host is off. Turn it on in Settings > Hosts and restart Sotto.') }
  const idle = () => undefined
  const unsubscribe = () => idle
  const shell = () => structuredClone(state)
  const control = {
    get: shell, shell, hostId: () => state.hostId, configuration: () => state.configuration, command: async () => unavailable(),
    threadDetail: () => null, attachmentPreview: unavailable, stageAttachment: async () => unavailable(), attachmentContent: async () => null, gitRefs: async () => unavailable(), gitChangedFiles: async () => unavailable(), gitPullRequest: async () => unavailable(),
    subscribe: unsubscribe, subscribeThreadDetail: unsubscribe, dispose: idle, closed: async () => undefined,
    privacyChanged: async () => undefined, hasPendingThreadWork: () => false, watcherObservationsEnabled: () => false, useSottoRequests: idle,
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }), refreshRequestDraft: async () => unavailable(),
    requestDraftView: () => ({ host: state.host, provider: state.configuration.provider }),
  }
  const host = {
    watcherThreadIds,
    dormantThreadIds: (): readonly string[] => { watcherThreadIds(); return [...dormant] },
    workspaceSnapshot: () => structuredClone(state.host), snapshot: async () => structuredClone(state.host),
    subscribe: unsubscribe, subscribeSubagents: unsubscribe, setCheckpointHooks: idle,
    useBrowserTools: idle, useThreadTools: idle,
    // Git actions are wired at start whichever host runs. With no local threads there is nothing to guard or to refresh.
    setMutationGuard: idle, gitActionFinished: async () => undefined,
    dispose: idle, disconnect: idle, close: async () => undefined,
  }
  const refuseMissing = <T extends object>(value: T): T => new Proxy(value, {
    get: (target, property, receiver): unknown => Reflect.has(target, property) ? Reflect.get(target, property, receiver) : unavailable,
  })
  // Existing local-only integration points accept concrete classes; their supported inactive methods
  // are enumerated above. All remaining methods synchronously refuse without touching local data.
  return {
    agentControl: refuseMissing(control), agentHost: refuseMissing(host), threadRegistry: null,
    turns: { path: () => join(directory, 'turns.jsonl'), recent: async () => [] },
    hostService: { state: shell, shell, events: () => [], subscribe: unsubscribe, threadDetail: () => null, command: async () => unavailable(), setWindowFocused: () => undefined,
      // No local thread here has Files, Changes or Agents to read.
      threadFiles: async () => unavailable(), threadFilePreview: async () => unavailable(), gitChanges: async () => unavailable(),
      gitReview: async () => unavailable(), subagentPage: async () => unavailable(), subagentAssignments: async () => unavailable() },
    // With the local host off there is no thread here whose provider could write anything.
    shortTextWriter: new ShortTextWriter({ write: async () => null }),
    // No worktrees are owned here, so the cleanup has nothing to sweep and every call does nothing.
    worktreeCleanup: { start: idle, settingsChanged: idle, dispose: idle, request: async () => undefined, close: async () => undefined } satisfies Pick<WorktreeCleanup, 'start' | 'settingsChanged' | 'dispose' | 'request' | 'close'>,
    close: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof createAgentRuntime>>
}

/** Refuse an explicit privacy change before saving settings if its local cleanup cannot run. */
export function requireLocalHistoryCleanup(localHostRunning: boolean, historyEnabled: boolean, requestedHistoryEnabled: boolean | undefined): void {
  if (!localHostRunning && historyEnabled && requestedHistoryEnabled === false) throw new Error('Turn on the local host in Settings > Hosts and restart Sotto before turning off local history. Your saved history has not changed.')
}

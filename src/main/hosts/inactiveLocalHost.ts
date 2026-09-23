import { join } from 'node:path'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentState } from '../../shared/agents'
import type { createAgentRuntime } from '../agents/runtime'
import { loadHostIdentity } from '../agents/hostIdentity'
import { ShortTextWriter } from '../llm/shortTextWriter'
import type { WorktreeCleanup } from '../agents/worktreeCleanup'

export function emptyDesktopState(hostId?: string): AgentState {
  return {
    ...(hostId ? { hostId } : {}), configuration: defaultAgentConfiguration(), connection: 'disconnected',
    host: { ...structuredClone(EMPTY_AGENT_HOST), ...(hostId ? { hostId } : {}) },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [],
    membership: { status: 'free', label: 'Local host off', expiresAt: null },
  }
}

/** Main's local-only tool adapters remain registered but cannot reach a disabled provider stack.
 * No coordinator, provider, history database, timer or workspace migration is constructed here.
 * Unsupported operations fail closed; this adapter never fabricates a successful host command.
 */
export async function inactiveLocalHost(directory: string): Promise<Awaited<ReturnType<typeof createAgentRuntime>>> {
  const state = emptyDesktopState(await loadHostIdentity(directory))
  const unavailable = (): never => { throw new Error('The local host is off. Turn it on in Settings > Hosts and restart Sotto.') }
  const idle = () => undefined
  const unsubscribe = () => idle
  const shell = () => structuredClone(state)
  const control = {
    get: shell, shell, configuration: () => state.configuration, command: async () => unavailable(),
    threadDetail: () => null, attachmentPreview: unavailable,
    subscribe: unsubscribe, subscribeThreadDetail: unsubscribe, dispose: idle, closed: async () => undefined,
    privacyChanged: async () => undefined, hasPendingThreadWork: () => false,
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }), refreshRequestDraft: async () => unavailable(),
  }
  const host = {
    workspaceSnapshot: () => structuredClone(state.host), snapshot: async () => structuredClone(state.host),
    subscribe: unsubscribe, subscribeSubagents: unsubscribe, setCheckpointHooks: idle,
    useBrowserTools: idle,
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
    hostService: { state: shell, shell, events: () => [], subscribe: unsubscribe, threadDetail: () => null, command: async () => unavailable() },
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

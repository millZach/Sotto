import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import type { AgentHost, ThreadReadPurpose } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { publicProviderEntityId, type AgentCommand } from '../../src/shared/agents'
import type { AdapterFixture } from '../integration/adapterContract'
import { claudeFixture } from './claudeFixture'
import { codexFixture, type RecordedRpc } from './codexFixture'
import { grokFixture } from './fakeGrokThreadFixture'

export type SendStackProvider = 'claude' | 'codex' | 'grok'

/** Long enough that no poll timer reads a thread during a case: what is counted is what the send itself read. */
export const QUIET_POLL_MS = 600_000
/** A provider's real adapter over its fake client, with no poll timer reading in between. */
export function nativeFixture(provider: SendStackProvider) {
  return provider === 'claude' ? claudeFixture(undefined, undefined, undefined, { pollIntervalMs: QUIET_POLL_MS })
    : provider === 'codex' ? codexFixture(undefined, false, undefined, { pollIntervalMs: QUIET_POLL_MS })
      : grokFixture(undefined, undefined, QUIET_POLL_MS)
}

/** The request that hands each provider the prompt, and the requests that read a thread's history back from it. */
const PROMPT: Record<SendStackProvider, string> = { claude: 'user', codex: 'turn/start', grok: 'session/prompt' }
function historyRequest(provider: SendStackProvider, record: RecordedRpc): boolean {
  if (provider === 'codex') return record.method === 'thread/turns/list' || record.method === 'thread/read' && record.params?.includeTurns === true
  return provider === 'grok' && record.method === '_x.ai/session/updates'
}

/** What one send cost, by count and time. Nothing a thread says is read. */
export interface SendCost {
  error: string | null
  elapsedMs: number
  /**
   * Each call of the adapter's own `refreshThread`, by what it was for. Those are the reads that reach the adapter
   * from the hosts above it; the adapter's own reads inside a send are not calls of it, and `history` counts them.
   */
  reads: ('beforeSend' | 'afterSend' | 'other')[]
  /**
   * Reads of the thread's history from the provider: Codex's `thread/turns/list` and whole `thread/read`, Grok's
   * `_x.ai/session/updates` pages, Claude Code's transcript polls. `before` is up to the request that hands the
   * provider the prompt, `after` from it on. Claude's transcript is a file Sotto reads in process, so its polls
   * are all counted as `before`; nothing after the prompt reads it in a send.
   */
  history: { before: number; after: number }
  /** The adapter's publishes, `workspace.json` writes and workspace publishes the send set going. */
  emits: number
  workspaceWrites: number
  workspacePublishes: number
}

/**
 * One provider's real adapter under the whole host stack, as a headless host runs it: the coordinator, the
 * workspace, provider selection and Sotto's thread identities. A thread that has had one exchange is on screen,
 * and `send` sends it another prompt from the Threads page and waits for the reply, counting what the send read
 * at each boundary it crosses (#765). Give the adapter a long poll interval, so its timer reads nothing in between.
 */
export async function sendStack(provider: SendStackProvider, native: AdapterFixture & { adapter: AgentHost },
  /** Grow the thread's history in the provider after its first exchange; a second exchange then takes it in. */
  seed?: (sessionId: string) => Promise<void>) {
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: native.host }
  const host = await startHeadlessHost({ dataDirectory: native.root, providers, reasoner: e2eAgentReasoner })
  const client = desktopWindowClient('send-reads')
  const command = async (value: AgentCommand) => {
    const state = await host.service.command(value, client)
    if (state.error) throw new Error(state.error)
    return state
  }
  await command({ type: 'configure', patch: { enabledProviders: [provider], provider } })
  await command({ type: 'connect', provider })
  const created = await command({ type: 'create-project', provider, title: 'Send project', path: native.root, useExisting: true })
  const projectId = created.host.projects.find(project => project.path === native.root)!.id
  const thread = await command({ type: 'create-thread', projectId, title: 'Send thread', modelId: publicProviderEntityId(provider, 'model', native.modelId), workingCopy: 'shared' })
  const threadId = thread.activeThreadId!
  await command({ type: 'select-thread', threadId })
  await command({ type: 'observe-threads', threadIds: [threadId] })
  const session = async (): Promise<string> => {
    const registry = JSON.parse(await readFile(join(native.root, 'threads.json'), 'utf8')) as { bindings: { threadId: string; sessionId: string }[] }
    return registry.bindings.find(item => item.threadId === threadId)!.sessionId
  }
  const idle = async (): Promise<void> => {
    await vi.waitFor(() => { if (host.service.state().host.threads.find(item => item.id === threadId)?.status !== 'idle') throw new Error('Still running') }, { timeout: 30_000, interval: 10 })
  }
  /** Send `text` from the Threads page and finish its turn, as the user's next send would find it. */
  const exchange = async (text: string): Promise<string | null> => {
    const state = await host.service.command({ type: 'manual-send', threadId, text }, client)
    if (state.error) return state.error
    await native.driver.completeTurn(await session(), 'Completed reply')
    await idle()
    return null
  }
  const first = await exchange('Synthetic prompt')
  if (first) throw new Error(first)
  if (seed) {
    await seed(await session())
    const second = await exchange('Synthetic prompt')
    if (second) throw new Error(second)
  }

  // Counters, by kind and number alone.
  const counts = { emits: 0, workspaceWrites: 0, workspacePublishes: 0, polls: 0 }
  const reads: SendCost['reads'] = []
  const adapter = native.adapter as unknown as Record<string, (...args: unknown[]) => unknown>
  const refresh = adapter.refreshThread!.bind(adapter)
  const readSpy = vi.spyOn(native.adapter, 'refreshThread').mockImplementation(async (id: string, purpose?: ThreadReadPurpose) => {
    reads.push(purpose?.beforeSend ? 'beforeSend' : purpose?.afterSend ? 'afterSend' : 'other')
    return refresh(id, purpose) as ReturnType<NonNullable<AgentHost['refreshThread']>>
  })
  const emit = adapter.emit!
  const emitSpy = vi.spyOn(adapter, 'emit').mockImplementation(function (this: unknown, ...args: unknown[]) { counts.emits += 1; return emit.apply(native.adapter, args) })
  const poll = ClaudeSessionLog.prototype.poll
  const pollSpy = vi.spyOn(ClaudeSessionLog.prototype, 'poll').mockImplementation(function (this: ClaudeSessionLog) { counts.polls += 1; return poll.call(this) })
  const write = AtomicJsonStore.prototype.write
  const writeSpy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (basename((this as unknown as { filePath: string }).filePath) === 'workspace.json') counts.workspaceWrites += 1
    return write.call(this, value)
  })
  type Publishing = { publish(): void }
  const publish = (WorkspaceHost.prototype as unknown as Publishing).publish
  const publishSpy = vi.spyOn(WorkspaceHost.prototype as unknown as Publishing, 'publish').mockImplementation(function (this: Publishing) {
    counts.workspacePublishes += 1; publish.call(this)
  })

  /** One send from the Threads page, counted from the press to the coordinator's answer. The turn is finished after. */
  const send = async (text = 'Synthetic prompt'): Promise<SendCost> => {
    const from = (await native.driver.requests()).length
    reads.length = 0
    const before = { ...counts }
    const started = performance.now()
    const state = await host.service.command({ type: 'manual-send', threadId, text }, client)
    const elapsedMs = performance.now() - started
    const after = { ...counts }
    const requests = (await native.driver.requests()).slice(from)
    const prompt = requests.findIndex(record => record.method === PROMPT[provider])
    const split = prompt === -1 ? requests.length : prompt
    const history = provider === 'claude' ? { before: after.polls - before.polls, after: 0 }
      : { before: requests.slice(0, split).filter(record => historyRequest(provider, record)).length, after: requests.slice(split).filter(record => historyRequest(provider, record)).length }
    const cost: SendCost = { error: state.error, elapsedMs, reads: [...reads], history, emits: after.emits - before.emits,
      workspaceWrites: after.workspaceWrites - before.workspaceWrites, workspacePublishes: after.workspacePublishes - before.workspacePublishes }
    if (!state.error) { await native.driver.completeTurn(await session(), 'Completed reply'); await idle() }
    return cost
  }
  return { host, threadId, session, send, command,
    cleanup: async () => {
      readSpy.mockRestore(); emitSpy.mockRestore(); pollSpy.mockRestore(); writeSpy.mockRestore(); publishSpy.mockRestore()
      await host.close(); await native.cleanup()
    } }
}

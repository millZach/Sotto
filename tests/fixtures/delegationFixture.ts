// ADR-0081's fixture over fake providers: a workspace with Claude Code, Codex and Grok Build, a coordinator, and
// delegation running on them as the app runs it.
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { DelegationService } from '../../src/main/agents/delegation'
import { DelegationToolServer } from '../../src/main/agents/delegationTools'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { firstMessageTitleWriter } from '../../src/main/llm/threadTitle'
import { workspaceFixture } from './workspaceFixture'
import { agentControlFixture } from './agentControlFixture'

export type DelegationResult = { status: 'ok'; delegation: { id: string; thread: string; outcome: string; note: string; reply?: { from: string; text: string }; replyUnavailable?: string; refusal?: string; userSentSince?: boolean }; limits: { inFlight: number; prompts?: number } }
export type DelegationRefused = { status: 'refused'; code: string; message: string }

/** Delegation over a workspace of fake providers. Each cleanup it needs is pushed onto `cleanups`, to run in reverse. */
export async function delegationFixture(cleanups: (() => Promise<void>)[], options: { limit?: number; otherStarts?: number; history?: boolean; titles?: boolean } = {}) {
  const history = options.history ?? true
  const workspace = await workspaceFixture(undefined, { history, watcherEnabled: false })
  cleanups.push(workspace.remove)
  // Codex offers every mode, so only the ceiling can refuse a wider one.
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: false,
      // Sotto's own naming, as the app runs it: the first message's opening words, then a generated name after the first reply.
      ...options.titles ? { writeFirstMessageTitle: firstMessageTitleWriter(() => DEFAULT_SETTINGS), writeThreadTitle: async () => 'Synthetic generated name' } : {} } })
  const make = () => new DelegationService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => history,
    limit: () => options.limit ?? 4, otherStartsInFlight: () => options.otherStarts ?? 0 })
  let service = make()
  let tools = new DelegationToolServer(service)
  workspace.host.useThreadTools([tools])
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  await service.recover()
  const model = (provider: ProviderId) => f.control.shell().host.models.find(item => item.providerId === provider)!
  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  const adapterOf = (threadId: string) => workspace.adapters[workspace.registry.byThread(threadId)!.provider as keyof typeof workspace.adapters]
  const emit = async (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters[binding.provider as keyof typeof workspace.adapters].emit()
    await f.control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
  }
  /** The provider ends the running turn, naming it by the user message it began with. */
  const endTurn = async (threadId: string, reply: string, status: 'completed' | 'interrupted' | 'failed' = 'completed') => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')!.id, status }
    thread.status = 'idle'
    await emit(threadId)
  }
  /** A thread the user opened on `provider` and sent a message, as the user's own. */
  const userThread = async (provider: ProviderId) => {
    const project = f.control.shell().host.projects.find(item => item.providerId === provider) ?? f.control.shell().host.projects[0]!
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: `Synthetic ${provider} thread`, modelId: model(provider).id })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user request' })).error).toBeNull()
    return threadId
  }
  // A new thread names its effort and permission, as delegate requires; a send to a delegated thread names neither.
  const delegate = async (threadId: string, input: Record<string, unknown>) => await service.delegate(threadId, { work: 'code-review', brief: 'Synthetic brief',
    ...input.thread === undefined ? { effort: 'low', permission: 'approval-required' } : {}, ...input }) as DelegationResult | DelegationRefused
  const read = async (threadId: string, delegation: string) => await service.read(threadId, { delegation }) as DelegationResult
  const ok = (result: DelegationResult | DelegationRefused): DelegationResult => { if (result.status !== 'ok') throw new Error(`refused ${result.code}: ${result.message}`); return result }
  /** Delegation stops and starts again over the same record, as it does when Sotto restarts. */
  const restart = async () => {
    service.close(); await tools.close()
    service = make(); tools = new DelegationToolServer(service)
    workspace.host.useThreadTools([tools])
    await service.recover()
  }
  return { ...f, workspace, model, native, adapterOf, emit, endTurn, userThread, delegate, read, ok, restart, get service() { return service }, get tools() { return tools } }
}

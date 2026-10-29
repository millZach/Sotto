// ADR-0081's fixture over fake providers: a workspace with Claude Code, Codex and Grok Build, a coordinator, and
// delegation running on them as the app runs it.
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { AgentControl } from '../../src/main/agents/control'
import { DelegationService, type DelegationServiceOptions } from '../../src/main/agents/delegation'
import { DelegationToolServer } from '../../src/main/agents/delegationTools'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { firstMessageTitleWriter } from '../../src/main/llm/threadTitle'
import { workspaceFixture } from './workspaceFixture'
import { agentControlFixture } from './agentControlFixture'
import { join } from 'node:path'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { DesktopBranchMoves, foldersOfSnapshot } from '../../src/main/agents/branchMoves'
import { CheckQueue } from '../../src/main/agents/checkQueue'
import type { PackageInstaller } from '../../src/main/agents/checkWorktree'

export type DelegationResult = { status: 'ok'; delegation: { id: string; thread: string; outcome: string; note: string; reply?: { from: string; text: string }; replyUnavailable?: string; refusal?: string; userSentSince?: boolean }; limits: { prompts?: number }; warning?: string }
export type DelegationRefused = { status: 'refused'; code: string; message: string }

/** Delegation over a workspace of fake providers. Each cleanup it needs is pushed onto `cleanups`, to run in reverse. */
/** `branchStarts` gives delegation the desktop's mover over this computer's own threads and projects (#1033); `checks`, This computer's check queue (#1312), new at each restart as it is in the app; `checkWorktrees`, its check worktree. */
export async function delegationFixture(cleanups: (() => Promise<void>)[], options: { history?: boolean; titles?: boolean; delegation?: Pick<DelegationServiceOptions, 'now' | 'schedule' | 'machines' | 'clockTime' | 'checkReplies'>; branchStarts?: boolean; checks?: boolean; checkWorktrees?: PackageInstaller } = {}) {
  const history = options.history ?? true
  let workspace = await workspaceFixture(undefined, { history, watcherEnabled: false })
  cleanups.push(workspace.remove)
  // Codex offers every mode, so only the ceiling can refuse a wider one.
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  const root = workspace.root
  const controlFor = async (): Promise<AgentControl> => (await agentControlFixture({ directory: root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: false,
      // Sotto's own naming, as the app runs it: the first message's opening words, then a generated name after the first reply.
      ...options.titles ? { writeFirstMessageTitle: firstMessageTitleWriter(() => DEFAULT_SETTINGS), writeThreadTitle: async () => 'Synthetic generated name' } : {} } })).control
  let control = await controlFor()
  const branchMoves = options.branchStarts ? new DesktopBranchMoves({ bundles: new BranchBundles({ stagingDirectory: join(root, 'branch-moves'), recordsPath: join(root, 'branch-moves.json') }),
    folders: foldersOfSnapshot(() => control.watcherSnapshot()), host: () => undefined, hostName: () => 'That machine' }) : undefined
  const make = () => new DelegationService({ directory: root, control, host: workspace.host, historyEnabled: () => history, ...options.delegation, ...branchMoves ? { branchMoves } : {},
    ...options.checks ? { checks: new CheckQueue('This computer') } : {} })
  // The check worktree, as main turns it on with Work across machines (#1312, third part), installing with the test's own installer.
  if (options.checkWorktrees) workspace.host.allowCheckWorktrees(options.checkWorktrees)
  let service = make()
  let tools = new DelegationToolServer(service)
  workspace.host.useThreadTools([tools])
  // Whatever is running when the test ends is closed, after a restart the ones it started.
  cleanups.push(async () => { service.close(); await tools.close(); control.dispose(); await control.closed(); await workspace.stop() })
  const start = async () => {
    await control.start()
    for (const provider of ['claude', 'codex', 'grok'] as const) await control.commandShell({ type: 'connect', provider })
    await service.recover()
  }
  await start()
  const model = (provider: ProviderId) => control.shell().host.models.find(item => item.providerId === provider)!
  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  const adapterOf = (threadId: string) => workspace.adapters[workspace.registry.byThread(threadId)!.provider as keyof typeof workspace.adapters]
  const emit = async (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters[binding.provider as keyof typeof workspace.adapters].emit()
    await control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
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
    const project = control.shell().host.projects.find(item => item.providerId === provider) ?? control.shell().host.projects[0]!
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: `Synthetic ${provider} thread`, modelId: model(provider).id })).error).toBeNull()
    expect((await control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user request' })).error).toBeNull()
    return threadId
  }
  // A new thread names its effort and permission, as delegate requires; a send to a delegated thread names neither.
  const delegate = async (threadId: string, input: Record<string, unknown>) => await service.delegate(threadId, { work: 'code-review', brief: 'Synthetic brief',
    ...input.thread === undefined ? { effort: 'low', permission: 'approval-required' } : {}, ...input }) as DelegationResult | DelegationRefused
  const read = async (threadId: string, delegation: string) => await service.read(threadId, { delegation }) as DelegationResult
  const ok = (result: DelegationResult | DelegationRefused): DelegationResult => { if (result.status !== 'ok') throw new Error(`refused ${result.code}: ${result.message}`); return result }
  /** Delegation alone stops and starts again over the same record. */
  const restart = async () => {
    service.close(); await tools.close()
    service = make(); tools = new DelegationToolServer(service)
    workspace.host.useThreadTools([tools])
    await service.recover()
  }
  /**
   * Sotto stops and starts again whole over the same folder: the workspace, the coordinator with its queue and outbox,
   * and delegation, each recovering from what it saved. The fake providers keep their threads, as real ones do.
   */
  const restartAll = async () => {
    service.close(); await tools.close(); control.dispose(); await control.closed(); await workspace.stop()
    workspace = await workspaceFixture(root, { history, watcherEnabled: false, adapters: workspace.adapters })
    control = await controlFor()
    service = make(); tools = new DelegationToolServer(service)
    workspace.host.useThreadTools([tools])
    await control.start()
    for (const provider of ['claude', 'codex', 'grok'] as const) await control.commandShell({ type: 'connect', provider })
    // A real provider names a thread's newest user message without its history; a fake one does not, so every thread's
    // history is read before anything is sent, as a window open on each would have it.
    await control.command({ type: 'observe-threads', threadIds: control.shell().host.threads.map(thread => thread.id) })
    await service.recover()
  }
  return { root, model, native, adapterOf, emit, endTurn, userThread, delegate, read, ok, restart, restartAll,
    get control() { return control }, get workspace() { return workspace }, get service() { return service }, get tools() { return tools } }
}

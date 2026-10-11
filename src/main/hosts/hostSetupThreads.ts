import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defaultNewThreadModelId, type AgentCommand, type AgentModel, type AgentState } from '../../shared/agents'
import { hostEntityKey } from '../../shared/clientIdentity'
import type { HostSetupChoice } from '../../shared/hosts'
import { resolveModel } from '../../shared/modelCatalog'
import { isThreadArchived } from '../../shared/threadActivity'
import type { HostSetupThreads } from './hostSetup'

/** The project every host setup thread goes in, at a folder of Sotto's own (ADR-0035). */
export const HOST_SETUP_PROJECT_TITLE = 'Host setup'
/** What the setup needs of the coordinator: its shell, its commands and its broadcasts. */
export interface HostSetupCoordinator {
  shell(): AgentState
  command(command: AgentCommand): Promise<unknown>
  subscribe(listener: (state: AgentState) => void): () => void
}

/**
 * The setup's threads, over this computer's coordinator. The setup thread is a normal thread: created by the same
 * commands New thread sends, in the Host setup project at `folder`, sharing that folder rather than taking a
 * worktree, and starting in the permission mode that asks before everything.
 */
export function coordinatorSetupThreads(options: { coordinator: HostSetupCoordinator; folder: string; localHostRunning: boolean }): HostSetupThreads {
  const { coordinator, folder } = options
  let latest: AgentState | undefined
  const state = (): AgentState => latest ??= coordinator.shell()
  const sameFolder = (left: string, right: string): boolean => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
  const project = (providerId: string | undefined) => state().host.projects.find(item => sameFolder(item.path, folder) && (!item.providerId || !providerId || item.providerId === providerId))
  /** A model the tool can reach: ready, and not Devin, whose client ignores the tool servers Sotto offers. */
  const usable = (model: AgentModel): boolean => model.ready && model.providerId !== 'devin'
  return {
    choice(): HostSetupChoice {
      if (!options.localHostRunning) return { unavailable: 'An agent sets a host up from a thread on this computer, which needs the local host. Turn on Run the local host above and restart Sotto.', models: [] }
      const current = state()
      const models = current.host.models.filter(usable)
      if (!models.length) return { unavailable: 'No model is ready on this computer yet. Connect Claude Code, Codex or Grok Build in Settings > Providers first.', models: [] }
      // The model the user uses most: the one with the most threads here, else the new-thread default.
      const counts = new Map<string, number>()
      for (const thread of current.host.threads) {
        const model = resolveModel(models, thread.modelId)
        if (model) counts.set(model.id, (counts.get(model.id) ?? 0) + 1)
      }
      const most = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0]
      const fallback = resolveModel(models, defaultNewThreadModelId(current.configuration, models, current.reasoningAccounts))?.id ?? models[0]!.id
      return { models: models.map(model => ({ id: model.id, name: model.name, provider: model.provider })), modelId: most ?? fallback }
    },
    async start({ title, modelId, brief, created }) {
      await mkdir(folder, { recursive: true })
      const model = resolveModel(state().host.models, modelId)
      if (!model) throw new Error('That model is not ready on this computer. Choose another one.')
      if (!project(model.providerId)) {
        await coordinator.command({ type: 'create-project', ...(model.providerId ? { provider: model.providerId } : {}), title: HOST_SETUP_PROJECT_TITLE, path: folder, useExisting: true })
        latest = coordinator.shell()
      }
      const home = project(model.providerId)
      if (!home) throw new Error('The Host setup project could not be made.')
      // The mode that asks before everything: the provider's own that allows nothing, or Sotto's approval-required.
      const asking = model.providerModes?.find(mode => mode.allows === 'nothing')
      const permission = asking ? { providerMode: asking.id } : model.runtimeModes?.includes('approval-required') ? { runtimeMode: 'approval-required' as const } : {}
      const threadId = randomUUID()
      // Creating a thread only records it in the workspace; the provider's own session starts with the first send
      // (WorkspaceHost), which is when a client reads its tool servers. So the tool is admitted between the two.
      await coordinator.command({ type: 'create-thread', threadId, projectId: home.id, title, titleSource: 'user', modelId: model.id, workingCopy: 'shared', ...permission })
      created(threadId)
      await coordinator.command({ type: 'manual-send', threadId, text: brief })
    },
    async interrupt(threadId) { await coordinator.command({ type: 'interrupt', threadId }) },
    thread(threadId) {
      const thread = state().host.threads.find(item => item.id === threadId)
      return thread ? { requestIds: thread.requests.map(request => request.id), archived: isThreadArchived(thread) } : undefined
    },
    windowId: threadId => hostEntityKey(state().hostId ?? state().host.hostId, threadId),
    subscribe(listener) { return coordinator.subscribe(value => { latest = value; listener() }) },
  }
}

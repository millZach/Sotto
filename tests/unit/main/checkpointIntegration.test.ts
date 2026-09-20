// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { connectCheckpoints } from '../../../src/main/tools/checkpointIntegration'
import { FilesService } from '../../../src/main/files/service'
import { resolveFilesBinding } from '../../../src/main/files/binding'
import type { AgentControl } from '../../../src/main/agents/control'
import type { GitChangesService } from '../../../src/main/tools/gitChanges'

it('excludes an unallocated worktree from shared-folder checkpoint guards while retaining active shared-thread protection', async () => {
  const f = await workspaceFixture()
  let integration: ReturnType<typeof connectCheckpoints> | undefined
  try {
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'ready', threadId: 'ready', projectId: project.id, modelId: model.id, title: 'Ready' })
    await f.host.execute({ type: 'create-thread', commandId: 'pending', threadId: 'pending', projectId: project.id, modelId: model.id, title: 'Pending', workingCopy: 'independent' })
    const files = new FilesService({ resolveBinding: id => resolveFilesBinding(f.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
    const pending = vi.fn(() => false)
    const hooks = vi.spyOn(f.host, 'setCheckpointHooks')
    integration = connectCheckpoints({ files, directory: f.root, host: f.host, registry: f.registry,
      control: { subscribe: () => () => undefined, hasPendingThreadWork: pending } as unknown as AgentControl,
      git: () => ({ isMutating: async () => false }) as unknown as GitChangesService, report: vi.fn() })
    await expect(Promise.resolve(hooks.mock.calls[0]![0].isBlocked('pending'))).resolves.toBe(false)
    await expect(integration.canMutate('pending')).resolves.toBe(false)
    await expect(integration.canMutate('ready')).resolves.toBe(true)
    expect(pending).not.toHaveBeenCalledWith('pending')
    f.adapters.codex.state.threads[0]!.status = 'running'; f.adapters.codex.emit()
    await expect(integration.canMutate('ready')).resolves.toBe(false)
  } finally {
    integration?.dispose()
    await f.stop(); await f.remove()
  }
})

// @vitest-environment node
// A delegated thread's new worktree starts from the delegating thread's branch (#1030), as continue and fork already do,
// so its commits can be brought back to that branch, while Work across machines is on. Off, it starts as any new worktree
// does, as before. Real Git in a temporary folder, fake providers.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationService } from '../../src/main/agents/delegation'
import { bringBackTarget } from '../../src/shared/bringChangesBack'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it.each([true, false])('starts a delegated thread’s new worktree from the branch the delegating thread is on only while bringing back is on (%s)', async on => {
  const workspace = await workspaceFixture(undefined, { watcherEnabled: false })
  cleanups.push(workspace.remove)
  const projectPath = workspace.adapters.codex.state.projects[0]!.path
  await initializeGitRepository(projectPath, { files: { 'work.txt': 'one\n' }, message: 'Baseline' })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: false } })
  const service = new DelegationService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => true, ...on ? { bringBack: true } : {} })
  cleanups.push(async () => { service.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const shell = () => f.control.shell().host
  const project = shell().projects.find(item => item.providerId === 'codex')!
  const model = shell().models.find(item => item.providerId === 'codex')!
  // The delegating thread works in a worktree of its own, on a branch the project folder is not on.
  const parent = randomUUID()
  expect((await f.control.commandShell({ type: 'create-thread', threadId: parent, projectId: project.id, title: 'Synthetic parent', modelId: model.id, workingCopy: 'independent', baseBranch: 'main' })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: parent, draftId: randomUUID(), text: 'Synthetic user request' })).error).toBeNull()
  await vi.waitFor(() => expect(shell().threads.find(item => item.id === parent)?.worktree).toMatchObject({ status: 'ready', branch: expect.stringMatching(/^sotto\//u) }))
  const parentBranch = shell().threads.find(item => item.id === parent)!.worktree!.branch!
  const result = await service.delegate(parent, { work: 'code-review', brief: 'Synthetic brief', provider: 'codex', model: model.id, effort: model.reasoningEfforts?.[0], permission: 'approval-required',
    working_copy: 'independent', wait_seconds: 0 }) as { status: string; delegation: { thread: string } }
  expect(result.status).toBe('ok')
  await vi.waitFor(() => expect(shell().threads.find(item => item.id === result.delegation.thread)?.worktree?.status).toBe('ready'))
  const threads = shell().threads
  const child = threads.find(item => item.id === result.delegation.thread)!
  if (!on) {
    expect(child.worktree?.baseBranch).toBeUndefined()
    expect(bringBackTarget(child, threads)).toBeNull()
    return
  }
  expect(child.worktree).toMatchObject({ mode: 'independent', baseBranch: parentBranch })
  expect(bringBackTarget(child, threads)).toMatchObject({ parentId: parent, target: parentBranch, where: 'worktree', away: false })
})

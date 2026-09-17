// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSkillScope } from '../../../src/main/agents/host'
import { runWorktreeGit } from '../../../src/main/agents/threadWorktrees'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const fixtures: Awaited<ReturnType<typeof workspaceFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })
it('routes a local unstarted thread catalog to its provider without creating native sessions or changing focus/ownership', async () => {
  const f = await workspaceFixture(); fixtures.push(f)
  const list = vi.fn(async (threadId: string, _forceReload?: boolean, scope?: AgentSkillScope) => ({ threadId, cwd: scope?.workingDirectory ?? '', providerId: 'codex' as const, status: 'ready' as const, skills: [], errors: [] }))
  Object.assign(f.adapters.codex, { listThreadSkills: list })
  f.adapters.codex.state.capabilities.skills = true
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Local', modelId: model.id })
  expect(await f.host.listThreadSkills('local', true)).toMatchObject({ threadId: 'local', status: 'ready', cwd: project.path })
  expect(list).toHaveBeenCalledWith('local', true, { providerId: 'codex', workingDirectory: project.path })
  expect(f.registry.byThread('local')).toBeUndefined()
  expect(f.adapters.codex.commands).toEqual([])
  const claude = snapshot.models.find(model => model.providerId === 'claude')!
  await f.host.execute({ type: 'configure-thread', commandId: 'switch', threadId: 'local', modelId: claude.id })
  await expect(f.host.listThreadSkills('local')).rejects.toThrow('does not expose skills')
  await expect(f.host.execute({ type: 'send', commandId: 'send', threadId: 'local', messageId: 'message', text: '$native-review Check', skills: [{ name: 'native-review', path: '/skill/SKILL.md' }] })).rejects.toThrow('another provider')
  expect(f.adapters.claude.commands).toEqual([])
})

it('loads unstarted skills from the independent project subfolder and rejects its missing working copy', async () => {
  const f = await workspaceFixture(); fixtures.push(f)
  const repository = f.adapters.codex.state.projects[0]!.path
  const subfolder = join(repository, 'packages', 'app')
  await mkdir(subfolder, { recursive: true })
  await writeFile(join(subfolder, 'README.md'), 'Independent project fixture')
  await runWorktreeGit(repository, ['init'])
  await runWorktreeGit(repository, ['add', '.'])
  await runWorktreeGit(repository, ['-c', 'user.name=Sotto Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'])
  f.adapters.codex.state.projects[0]!.path = subfolder
  const list = vi.fn(async (threadId: string, _reload?: boolean, scope?: AgentSkillScope) => ({
    threadId, cwd: scope?.workingDirectory ?? '', providerId: 'codex' as const, status: 'ready' as const, skills: [], errors: [],
  }))
  Object.assign(f.adapters.codex, { listThreadSkills: list })
  f.adapters.codex.state.capabilities.skills = true
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'isolated', threadId: 'isolated', projectId: project.id, title: 'Independent', modelId: model.id })
  // Creation returns before the checkout; asking for the folder waits for the setup it started.
  expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'isolated')?.worktree?.status).toBe('pending')
  await f.host.threadWorkingDirectory('isolated')
  const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'isolated')!
  expect(thread.worktree?.status).toBe('ready')
  expect(thread.workingDirectory).toBe(join(thread.worktree!.path!, 'packages', 'app'))
  expect(thread.projectId).toBe(project.id)
  expect(await f.host.listThreadSkills(thread.id, true)).toMatchObject({ cwd: thread.workingDirectory })
  expect(list).toHaveBeenLastCalledWith(thread.id, true, { providerId: 'codex', workingDirectory: thread.workingDirectory })
  expect(f.registry.byThread(thread.id)).toBeUndefined()
  expect(f.adapters.codex.commands).toEqual([])
  await rename(thread.workingDirectory!, join(thread.worktree!.path!, 'packages', 'app-preserved'))
  list.mockClear()
  await expect(f.host.listThreadSkills(thread.id)).rejects.toThrow()
  expect(list).not.toHaveBeenCalled()
})

it('does not browse the project catalog when independent worktree setup failed', async () => {
  const f = await workspaceFixture(); fixtures.push(f)
  await runWorktreeGit(f.adapters.codex.state.projects[0]!.path, ['init'])
  const list = vi.fn()
  Object.assign(f.adapters.codex, { listThreadSkills: list })
  f.adapters.codex.state.capabilities.skills = true
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'failed', threadId: 'failed', projectId: project.id, title: 'Recoverable', modelId: model.id })
  await expect(f.host.listThreadSkills('failed')).rejects.toThrow('no commit')
  expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'failed')?.worktree?.status).toBe('error')
  expect(list).not.toHaveBeenCalled()
  expect(f.registry.byThread('failed')).toBeUndefined()
})

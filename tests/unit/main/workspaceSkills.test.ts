// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSkillScope } from '../../../src/main/agents/host'
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
